//! What nestd tells the gateway, and the open connections it may have to cut.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use nest_protocol::gateway::{BindingClaims, GuestInfo, close_code};
use nest_protocol::host::gateway_link::SandboxPause;
use nest_protocol::model::{Epoch, SandboxId};
use tokio::sync::watch;

use crate::verify::{self, Admission, Refusal};

/// One sandbox this host runs, as nestd last described it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxEntry {
    pub epoch: Epoch,
    pub vsock_uds_path: PathBuf,
    /// Clients with a configured slot in the guest; a binding for anyone else is refused.
    pub clients: BTreeSet<String>,
    /// `None` until the guest's hello arrived: bindings get `busy`.
    pub guest: Option<GuestInfo>,
    /// `Some` while nestd has the VM paused (a commit): bindings get `busy` with a short hint
    /// instead of a vsock connect that would hang until the VM runs again.
    pub paused: Option<SandboxPause>,
    /// Resync generation this entry was last (re)sent in; entries older than the current one
    /// are dropped at `resync_done`.
    generation: u64,
}

struct Conn {
    sandbox: SandboxId,
    epoch: Epoch,
    close: watch::Sender<Option<u16>>,
}

#[derive(Default)]
struct Inner {
    /// `kid` → raw uncompressed P-256 point. Kept across a link loss: a key is public and
    /// stable, and a bind after the loss must be `moved`, not `unknown_key`.
    keys: HashMap<String, Vec<u8>>,
    sandboxes: HashMap<SandboxId, SandboxEntry>,
    /// Between `hello_ack` and `resync_done`: unknown sandboxes are `busy`, not `moved`.
    resyncing: bool,
    generation: u64,
    conns: HashMap<u64, Conn>,
    next_conn: u64,
}

/// The gateway's whole state. Cheap to share; every method takes `&self`.
#[derive(Default)]
pub struct State {
    inner: RwLock<Inner>,
}

/// A registered connection. Dropping it unregisters; `closed()` resolves with a close code when
/// the sandbox leaves, changes epoch, or the gateway loses nestd.
pub struct ConnGuard {
    id: u64,
    state: Arc<State>,
    rx: watch::Receiver<Option<u16>>,
}

impl ConnGuard {
    /// Waits until the connection must close; yields the close code.
    pub async fn closed(&mut self) -> u16 {
        loop {
            if let Some(code) = *self.rx.borrow_and_update() {
                return code;
            }
            if self.rx.changed().await.is_err() {
                return close_code::MOVED;
            }
        }
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.state.inner.write().unwrap_or_else(|e| e.into_inner()).conns.remove(&self.id);
    }
}

/// The attached-client set from ids, for tests and callers that hold a slice.
pub fn clients(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

impl State {
    pub fn new() -> Arc<State> {
        Arc::new(State::default())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Replace the set of verification keys (`kid` → raw public key bytes). A kid listed twice
    /// keeps the last value.
    pub fn set_keys(&self, keys: Vec<(String, Vec<u8>)>) {
        self.write().keys = keys.into_iter().collect();
    }

    /// One key, for tests and simple setups.
    pub fn set_key(&self, kid: &str, public_key: &[u8]) {
        self.set_keys(vec![(kid.to_string(), public_key.to_vec())]);
    }

    pub fn key(&self, kid: &str) -> Option<Vec<u8>> {
        self.read().keys.get(kid).cloned()
    }

    pub fn key_count(&self) -> usize {
        self.read().keys.len()
    }

    /// Add or replace a sandbox. A newer epoch cuts every connection of the old one
    /// (`close_code::MOVED`). An older epoch than the one held is refused (logged, the entry kept),
    /// or it would cut current calls and admit stale bindings; only after a `remove` (or a lost
    /// nestd link) may a sandbox come back at a lower epoch.
    pub fn upsert_sandbox(
        &self,
        sandbox: SandboxId,
        epoch: Epoch,
        vsock_uds_path: PathBuf,
        clients: impl IntoIterator<Item = impl Into<String>>,
        guest: Option<GuestInfo>,
    ) {
        self.upsert_sandbox_paused(sandbox, epoch, vsock_uds_path, clients, guest, None);
    }

    /// [`State::upsert_sandbox`] with the VM's pause, as nestd's `sandbox_upsert` carries it: one
    /// entry replaced under one lock, so no bind sees the new entry with the old pause. A pause
    /// cuts no open connection; their guest streams stall and resume with the VM.
    pub fn upsert_sandbox_paused(
        &self,
        sandbox: SandboxId,
        epoch: Epoch,
        vsock_uds_path: PathBuf,
        clients: impl IntoIterator<Item = impl Into<String>>,
        guest: Option<GuestInfo>,
        paused: Option<SandboxPause>,
    ) {
        let clients: BTreeSet<String> = clients.into_iter().map(Into::into).collect();
        let mut g = self.write();
        let generation = g.generation;
        let old_epoch = g.sandboxes.get(&sandbox).map(|e| e.epoch);
        if let Some(old) = old_epoch
            && epoch.0 < old.0
        {
            tracing::error!(sandbox = %sandbox.0, held = old.0, sent = epoch.0, "refusing an epoch older than the one held");
            return;
        }
        let was_paused = g.sandboxes.get(&sandbox).is_some_and(|e| e.epoch == epoch && e.paused.is_some());
        if was_paused != paused.is_some() {
            match &paused {
                Some(p) => tracing::info!(sandbox = %sandbox.0, epoch = epoch.0, reason = %p.reason, "sandbox paused: binds get busy"),
                None => tracing::info!(sandbox = %sandbox.0, epoch = epoch.0, "sandbox running again"),
            }
        }
        g.sandboxes.insert(sandbox.clone(), SandboxEntry { epoch, vsock_uds_path, clients, guest, paused, generation });
        if let Some(old) = old_epoch
            && old != epoch
        {
            close_matching(&mut g, |c| c.sandbox == sandbox && c.epoch == old, close_code::MOVED);
        }
    }

    /// The sandbox left this host: cut its connections, forget it.
    pub fn remove_sandbox(&self, sandbox: &SandboxId) {
        let mut g = self.write();
        g.sandboxes.remove(sandbox);
        close_matching(&mut g, |c| &c.sandbox == sandbox, close_code::MOVED);
        tracing::info!(sandbox = %sandbox.0, "sandbox removed");
    }

    /// nestd is gone (or the process is stopping): forget every sandbox and cut every
    /// connection. The keys stay: they are public, and the next bind must be `moved`.
    pub fn clear(&self) {
        let mut g = self.write();
        g.sandboxes.clear();
        g.resyncing = false;
        close_matching(&mut g, |_| true, close_code::MOVED);
    }

    /// `hello_ack` arrived: nestd replays everything. Until `end_resync`, an unknown sandbox is
    /// `busy` (it may just not have been re-sent yet).
    pub fn begin_resync(&self) {
        let mut g = self.write();
        g.generation += 1;
        g.resyncing = true;
    }

    /// `resync_done`: drop every entry nestd did not re-send since `begin_resync`.
    pub fn end_resync(&self) {
        let mut g = self.write();
        let current = g.generation;
        let stale: Vec<SandboxId> =
            g.sandboxes.iter().filter(|(_, e)| e.generation < current).map(|(id, _)| id.clone()).collect();
        for id in stale {
            g.sandboxes.remove(&id);
            close_matching(&mut g, |c| c.sandbox == id, close_code::MOVED);
        }
        g.resyncing = false;
    }

    pub fn resyncing(&self) -> bool {
        self.read().resyncing
    }

    pub fn sandbox(&self, id: &SandboxId) -> Option<SandboxEntry> {
        self.read().sandboxes.get(id).cloned()
    }

    pub fn sandbox_count(&self) -> usize {
        self.read().sandboxes.len()
    }

    /// Admit verified claims ([`verify::admit`]) and register the connection, under one write
    /// lock: a removal, epoch change, detach, guest change or link loss either happened before
    /// (and is the refusal) or happens after (and cuts the registered connection).
    pub fn admit_and_register(
        self: &Arc<Self>,
        claims: &BindingClaims,
        protocol_version: u32,
    ) -> Result<(Admission, ConnGuard), Refusal> {
        let mut g = self.write();
        let admission = verify::admit(g.sandboxes.get(&claims.sandbox), g.resyncing, claims, protocol_version)?;
        let (tx, rx) = watch::channel(None);
        let id = g.next_conn;
        g.next_conn += 1;
        g.conns.insert(id, Conn { sandbox: claims.sandbox.clone(), epoch: claims.epoch, close: tx });
        Ok((admission, ConnGuard { id, state: Arc::clone(self), rx }))
    }

    pub fn open_connections(&self) -> usize {
        self.read().conns.len()
    }
}

fn close_matching(g: &mut Inner, pred: impl Fn(&Conn) -> bool, code: u16) {
    for c in g.conns.values() {
        if pred(c) {
            let _ = c.close.send(Some(code));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::gateway::{BindingScope, error_code};

    fn sbx() -> SandboxId {
        SandboxId("sbx_1".into())
    }

    fn v1() -> Option<GuestInfo> {
        Some(GuestInfo { protocol_version: 1, capabilities: vec![] })
    }

    fn claims(epoch: u64) -> BindingClaims {
        BindingClaims { v: 1, kid: "k".into(), sandbox: sbx(), epoch: Epoch(epoch), client: "agt_a".into(), scope: BindingScope::Hands, exp_ms: i64::MAX }
    }

    fn register(state: &Arc<State>, epoch: u64) -> Result<ConnGuard, &'static str> {
        state.admit_and_register(&claims(epoch), 1).map(|(_, g)| g).map_err(|r| r.code)
    }

    #[test]
    fn registration_is_refused_once_the_sandbox_left_or_changed_epoch() {
        let state = State::new();
        assert_eq!(register(&state, 4).err(), Some(error_code::MOVED), "unknown sandbox");
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_a"], v1());
        assert_eq!(register(&state, 3).err(), Some(error_code::STALE_EPOCH));
        assert_eq!(register(&state, 5).err(), Some(error_code::BUSY), "epoch not placed yet");
        let guard = register(&state, 4).expect("current epoch");
        assert_eq!(state.open_connections(), 1);
        state.remove_sandbox(&sbx());
        assert_eq!(register(&state, 4).err(), Some(error_code::MOVED), "removed");
        drop(guard);
        assert_eq!(state.open_connections(), 0);
        // A link loss keeps the keys and forgets the sandboxes.
        state.set_key("k", &[4u8; 65]);
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_a"], v1());
        state.clear();
        assert_eq!((state.key_count(), state.sandbox_count()), (1, 0));
    }

    /// Gateway-bindings S1's caveat: the client set and the guest version were checked against a
    /// snapshot and only the epoch again at registration, so a detach or guest upgrade in between
    /// was admitted. Both are now checked under the registering lock.
    #[test]
    fn a_detach_or_guest_upgrade_before_registration_is_refused() {
        let state = State::new();
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_b"], v1());
        assert_eq!(register(&state, 4).err(), Some(error_code::UNAUTHORIZED), "detached");
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_a"], Some(GuestInfo { protocol_version: 2, capabilities: vec![] }));
        assert_eq!(register(&state, 4).err(), Some(error_code::UNSUPPORTED_VERSION), "guest upgraded");
        assert_eq!(state.open_connections(), 0);
    }

    #[test]
    fn an_epoch_going_backwards_is_refused_until_the_sandbox_is_removed() {
        let state = State::new();
        state.upsert_sandbox(sbx(), Epoch(5), PathBuf::from("/v5"), ["agt_a"], v1());
        let mut guard = register(&state, 5).expect("current epoch");
        // A late update for epoch 4: the entry, and the call on epoch 5, stay.
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v4"), ["agt_a"], v1());
        let e = state.sandbox(&sbx()).unwrap();
        assert_eq!((e.epoch, e.vsock_uds_path), (Epoch(5), PathBuf::from("/v5")));
        assert!(register(&state, 4).is_err(), "the old epoch is not admitted again");
        assert!(guard.rx.borrow().is_none(), "the current call was not cut");
        // The same epoch updates in place (clients, guest); a newer one cuts the old calls.
        state.upsert_sandbox(sbx(), Epoch(5), PathBuf::from("/v5"), ["agt_a", "agt_b"], v1());
        assert!(guard.rx.borrow().is_none());
        assert_eq!(state.sandbox(&sbx()).unwrap().clients.len(), 2);
        state.upsert_sandbox(sbx(), Epoch(6), PathBuf::from("/v6"), ["agt_a"], v1());
        assert_eq!(*guard.rx.borrow_and_update(), Some(close_code::MOVED));
        // After a remove, any epoch is a fresh placement.
        state.remove_sandbox(&sbx());
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v4"), ["agt_a"], v1());
        assert_eq!(state.sandbox(&sbx()).unwrap().epoch, Epoch(4));
    }
}
