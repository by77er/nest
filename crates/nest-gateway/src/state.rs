//! What nestd tells the gateway, and the open connections it may have to cut.

use std::collections::{BTreeMap, BTreeSet, HashMap};
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
    /// The sandbox's per-client agent-epoch floors (see [`State::raise_floors`]).
    pub floors: BTreeMap<String, Epoch>,
}

struct Conn {
    sandbox: SandboxId,
    epoch: Epoch,
    /// The binding's client and agent epoch (absent: 0), so a raised floor can cut it.
    client: String,
    agent_epoch: Epoch,
    close: watch::Sender<Option<u16>>,
}

#[derive(Default)]
struct Inner {
    /// `kid` → raw uncompressed P-256 point. Kept across a link loss: a key is public and
    /// stable, and a bind after the loss must be `moved`, not `unknown_key`.
    keys: HashMap<String, Vec<u8>>,
    sandboxes: HashMap<SandboxId, SandboxEntry>,
    /// Per sandbox, per client, the lowest agent epoch a binding may carry. Only ever raised;
    /// dropped with the sandbox. Kept apart from the entry, which every upsert replaces.
    floors: HashMap<SandboxId, BTreeMap<String, Epoch>>,
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
        Snapshot {
            key: g.keys.get(kid).cloned(),
            entry: g.sandboxes.get(sandbox).cloned(),
            resyncing: g.resyncing,
            floors: g.floors.get(sandbox).cloned().unwrap_or_default(),
        }
    }

    /// Raise clients' agent-epoch floors on a sandbox (a lower value than the one held changes
    /// nothing). A raise cuts that client's open connections whose binding is below it
    /// (`close_code::MOVED`: the call may have run): a superseded brain loses its hands at once.
    pub fn raise_floors(&self, sandbox: &SandboxId, floors: impl IntoIterator<Item = (String, Epoch)>) {
        raise_locked(&mut self.write(), sandbox, floors);
    }

    /// The floor for one client (0 when none was set).
    pub fn floor(&self, sandbox: &SandboxId, client: &str) -> Epoch {
        self.read().floors.get(sandbox).and_then(|f| f.get(client)).copied().unwrap_or(Epoch(0))
    }

    /// Add or replace a sandbox. A newer epoch cuts every connection of the old one
    /// (`close_code::MOVED`): their bindings named an epoch that is no longer current. An older
    /// epoch than the one held is refused (logged, the entry kept): accepting it would cut the
    /// current calls and admit the old epoch's bindings again. Only a `remove` (or a lost nestd
    /// link) first lets a sandbox come back at a lower epoch.
    pub fn upsert_sandbox(
        &self,
        sandbox: SandboxId,
        epoch: Epoch,
        vsock_uds_path: PathBuf,
        clients: impl IntoIterator<Item = impl Into<String>>,
        guest: Option<GuestInfo>,
    ) {
        self.upsert_sandbox_with_floors(sandbox, epoch, vsock_uds_path, clients, guest, BTreeMap::new());
    }

    /// [`State::upsert_sandbox`] with the clients' agent-epoch floors, raised under the same lock
    /// before the entry is (re)inserted: no bind can see the entry without its floors.
    pub fn upsert_sandbox_with_floors(
        &self,
        sandbox: SandboxId,
        epoch: Epoch,
        vsock_uds_path: PathBuf,
        clients: impl IntoIterator<Item = impl Into<String>>,
        guest: Option<GuestInfo>,
        floors: BTreeMap<String, Epoch>,
    ) {
        let clients: BTreeSet<String> = clients.into_iter().map(Into::into).collect();
        let mut g = self.write();
        if !floors.is_empty() {
            raise_locked(&mut g, &sandbox, floors);
        }
        let generation = g.generation;
        let old_epoch = g.sandboxes.get(&sandbox).map(|e| e.epoch);
        if let Some(old) = old_epoch
            && epoch.0 < old.0
        {
            tracing::error!(sandbox = %sandbox.0, held = old.0, sent = epoch.0, "refusing an epoch older than the one held");
            return;
        }
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
        g.floors.remove(sandbox);
        close_matching(&mut g, |c| &c.sandbox == sandbox, close_code::MOVED);
        tracing::info!(sandbox = %sandbox.0, "sandbox removed");
    }

    /// nestd is gone (or the process is stopping): forget every sandbox and cut every
    /// connection. The keys stay: they are public, and the next bind must be `moved`.
    pub fn clear(&self) {
        let mut g = self.write();
        g.sandboxes.clear();
        g.floors.clear();
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
            g.floors.remove(&id);
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
        self.register_client_conn(sandbox, epoch, "", Epoch(u64::MAX))
    }

    /// [`State::register_conn`] for a binding's client and agent epoch: also refused when a
    /// floor raised since the bind check is above `agent_epoch`, and cut by a later raise.
    pub fn register_client_conn(self: &Arc<Self>, sandbox: SandboxId, epoch: Epoch, client: &str, agent_epoch: Epoch) -> Option<ConnGuard> {
        let (tx, rx) = watch::channel(None);
        let mut g = self.write();
        if g.sandboxes.get(&sandbox).map(|e| e.epoch) != Some(epoch) {
            return None;
        }
        if g.floors.get(&sandbox).and_then(|f| f.get(client)).is_some_and(|floor| agent_epoch.0 < floor.0) {
            return None;
        }
        let id = g.next_conn;
        g.next_conn += 1;
        g.conns.insert(id, Conn { sandbox, epoch, client: client.to_string(), agent_epoch, close: tx });
        Some(ConnGuard { id, state: Arc::clone(self), rx })
    }

    pub fn open_connections(&self) -> usize {
        self.read().conns.len()
    }
}

fn raise_locked(g: &mut Inner, sandbox: &SandboxId, floors: impl IntoIterator<Item = (String, Epoch)>) {
    let mut raised = vec![];
    let held = g.floors.entry(sandbox.clone()).or_default();
    for (client, floor) in floors {
        let cur = held.entry(client.clone()).or_insert(Epoch(0));
        if floor.0 > cur.0 {
            *cur = floor;
            raised.push((client, floor));
        }
    }
    for (client, floor) in raised {
        tracing::info!(sandbox = %sandbox.0, client = %client, floor = floor.0, "client floor raised");
        close_matching(g, |c| &c.sandbox == sandbox && c.client == client && c.agent_epoch.0 < floor.0, close_code::MOVED);
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

    #[test]
    fn an_epoch_going_backwards_is_refused_until_the_sandbox_is_removed() {
        let state = State::new();
        state.upsert_sandbox(sbx(), Epoch(5), PathBuf::from("/v5"), ["agt_a"], None);
        let mut guard = state.register_conn(sbx(), Epoch(5)).expect("current epoch");
        // A late update for epoch 4: the entry, and the call on epoch 5, stay.
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v4"), ["agt_a"], None);
        let e = state.sandbox(&sbx()).unwrap();
        assert_eq!((e.epoch, e.vsock_uds_path), (Epoch(5), PathBuf::from("/v5")));
        assert!(state.register_conn(sbx(), Epoch(4)).is_none(), "the old epoch is not admitted again");
        assert!(guard.rx.borrow().is_none(), "the current call was not cut");
        // The same epoch updates in place (clients, guest); a newer one cuts the old calls.
        state.upsert_sandbox(sbx(), Epoch(5), PathBuf::from("/v5"), ["agt_a", "agt_b"], None);
        assert!(guard.rx.borrow().is_none());
        assert_eq!(state.sandbox(&sbx()).unwrap().clients.len(), 2);
        state.upsert_sandbox(sbx(), Epoch(6), PathBuf::from("/v6"), ["agt_a"], None);
        assert_eq!(*guard.rx.borrow_and_update(), Some(close_code::MOVED));
        // After a remove, any epoch is a fresh placement.
        state.remove_sandbox(&sbx());
        state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/v4"), ["agt_a"], None);
        assert_eq!(state.sandbox(&sbx()).unwrap().epoch, Epoch(4));
    }
}
