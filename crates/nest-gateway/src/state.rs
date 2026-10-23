//! What nestd tells the gateway, and the open connections it may have to cut.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use nest_protocol::gateway::{GuestInfo, close_code};
use nest_protocol::model::{Epoch, SandboxId};
use tokio::sync::watch;

/// One sandbox this host runs, as nestd last described it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxEntry {
    pub epoch: Epoch,
    pub vsock_uds_path: PathBuf,
    /// Clients with a configured slot in the guest; a binding for anyone else is refused.
    pub clients: BTreeSet<String>,
    /// `None` until the guest's hello arrived: bindings get `busy`.
    pub guest: Option<GuestInfo>,
    /// Resync generation this entry was last (re)sent in; entries older than the current one
    /// are dropped at `resync_done`.
    generation: u64,
}

/// One read of everything a bind check needs, taken under one lock.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub key: Option<Vec<u8>>,
    pub entry: Option<SandboxEntry>,
    pub resyncing: bool,
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

    /// Everything one bind check needs, read under one lock.
    pub fn snapshot(&self, kid: &str, sandbox: &SandboxId) -> Snapshot {
        let g = self.read();
        Snapshot { key: g.keys.get(kid).cloned(), entry: g.sandboxes.get(sandbox).cloned(), resyncing: g.resyncing }
    }

    /// Add or replace a sandbox. A changed epoch cuts every connection of the old epoch
    /// (`close_code::MOVED`): their bindings named an epoch that is no longer current.
    pub fn upsert_sandbox(
        &self,
        sandbox: SandboxId,
        epoch: Epoch,
        vsock_uds_path: PathBuf,
        clients: impl IntoIterator<Item = impl Into<String>>,
        guest: Option<GuestInfo>,
    ) {
        let clients: BTreeSet<String> = clients.into_iter().map(Into::into).collect();
        let mut g = self.write();
        let generation = g.generation;
        let old_epoch = g.sandboxes.get(&sandbox).map(|e| e.epoch);
        g.sandboxes.insert(sandbox.clone(), SandboxEntry { epoch, vsock_uds_path, clients, guest, generation });
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

    /// Register an open connection so a later epoch change, removal or `clear` can cut it. The
    /// check that the sandbox is still here at this epoch happens under the same lock, so a
    /// change between the bind check and this call cannot slip through: `None` means refuse.
    pub fn register_conn(self: &Arc<Self>, sandbox: SandboxId, epoch: Epoch) -> Option<ConnGuard> {
        let (tx, rx) = watch::channel(None);
        let mut g = self.write();
        if g.sandboxes.get(&sandbox).map(|e| e.epoch) != Some(epoch) {
            return None;
        }
        let id = g.next_conn;
        g.next_conn += 1;
        g.conns.insert(id, Conn { sandbox, epoch, close: tx });
        Some(ConnGuard { id, state: Arc::clone(self), rx })
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

    fn sbx() -> SandboxId {
        SandboxId("sbx_1".into())
    }

    #[test]
    fn registration_is_refused_once_the_sandbox_left_or_changed_epoch() {
        let state = State::new();
        assert!(state.register_conn(sbx(), Epoch(4)).is_none(), "unknown sandbox");
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_a"], None);
        assert!(state.register_conn(sbx(), Epoch(3)).is_none(), "old epoch");
        assert!(state.register_conn(sbx(), Epoch(5)).is_none(), "epoch not placed yet");
        let guard = state.register_conn(sbx(), Epoch(4)).expect("current epoch");
        assert_eq!(state.open_connections(), 1);
        state.remove_sandbox(&sbx());
        assert!(state.register_conn(sbx(), Epoch(4)).is_none(), "removed");
        drop(guard);
        assert_eq!(state.open_connections(), 0);
        // A link loss keeps the keys and forgets the sandboxes.
        state.set_key("k", &[4u8; 65]);
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v"), ["agt_a"], None);
        state.clear();
        assert_eq!((state.key_count(), state.sandbox_count()), (1, 0));
    }
}
