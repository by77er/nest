//! The control link's event side: unsolicited events to the host (`ports`, `task_exited`),
//! buffered while no configured control connection exists, and the CLI relay's pending replies.
//! One lock owns the link, the latest port set and the backlog, so an event can't slip between
//! "flush the backlog" and "mark ready".

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use nest_protocol::guest::{CliCommand, CliResult, ControlBody, ControlFrame, ListeningPort, error_code};
use nest_protocol::model::AgentId;
use tokio::sync::{mpsc, oneshot};

use crate::framed::err;
use crate::state::now_ms;

const MAX_BUFFERED_TASK_EVENTS: usize = 1000;

type Tx = mpsc::UnboundedSender<ControlFrame>;

/// The control connection, by generation: events flow only once it is `Ready` (configured).
#[derive(Default)]
enum Link {
    #[default]
    Down,
    Up { generation: u64, tx: Tx },
    Ready { generation: u64, tx: Tx },
}

#[derive(Default)]
struct Sink {
    link: Link,
    generations: u64,
    /// The latest port scan, re-announced whenever a connection becomes ready.
    ports: Vec<ListeningPort>,
    /// Other events awaiting a ready connection; the oldest go beyond the cap.
    backlog: VecDeque<ControlFrame>,
    next_cli: u64,
    pending_cli: HashMap<u64, oneshot::Sender<CliResult>>,
}

impl Sink {
    fn ready_tx(&self) -> Option<&Tx> {
        match &self.link {
            Link::Ready { tx, .. } => Some(tx),
            _ => None,
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        matches!(&self.link, Link::Up { generation: g, .. } | Link::Ready { generation: g, .. } if *g == generation)
    }
}

#[derive(Default)]
pub struct Events(Mutex<Sink>);

impl Events {
    /// A new control connection: returns its generation. Not ready until `configure`.
    pub fn attach(&self, tx: Tx) -> u64 {
        let mut s = self.0.lock().unwrap();
        s.generations += 1;
        let generation = s.generations;
        s.link = Link::Up { generation, tx };
        generation
    }

    /// The control connection with this generation went away.
    pub fn detach(&self, generation: u64) {
        let mut s = self.0.lock().unwrap();
        if !s.is_current(generation) {
            return;
        }
        s.link = Link::Down;
        for (_, waiter) in s.pending_cli.drain() {
            let _ = waiter.send(CliResult::Error { error: err(error_code::BUSY, "control connection to the host was lost", true) });
        }
    }

    /// `configure` succeeded on connection `generation`: flush the backlog, re-announce ports.
    pub fn ready(&self, generation: u64) {
        let mut s = self.0.lock().unwrap();
        let tx = match std::mem::take(&mut s.link) {
            Link::Up { generation: g, tx } | Link::Ready { generation: g, tx } if g == generation => tx,
            other => {
                s.link = other;
                return;
            }
        };
        for f in s.backlog.drain(..) {
            let _ = tx.send(f);
        }
        let _ = tx.send(event(ControlBody::Ports { listening: s.ports.clone(), ts_ms: now_ms() }));
        s.link = Link::Ready { generation, tx };
    }

    /// Send an unsolicited event, or keep it until a configured control connection exists.
    pub fn emit(&self, body: ControlBody) {
        let mut s = self.0.lock().unwrap();
        if let ControlBody::Ports { listening, .. } = &body {
            s.ports = listening.clone();
            if let Some(tx) = s.ready_tx() {
                let _ = tx.send(event(body));
            }
            return;
        }
        let frame = event(body);
        if s.ready_tx().is_some_and(|tx| tx.send(frame.clone()).is_ok()) {
            return;
        }
        if s.backlog.len() >= MAX_BUFFERED_TASK_EVENTS {
            s.backlog.pop_front();
        }
        s.backlog.push_back(frame);
    }

    /// Relay a CLI command to the host and wait for `cli_result` (or `timeout`).
    pub async fn relay_cli(&self, agent_id: Option<AgentId>, command: CliCommand, timeout: Duration) -> CliResult {
        let (tx_res, rx_res) = oneshot::channel();
        let id = {
            let mut s = self.0.lock().unwrap();
            s.next_cli += 1;
            let id = s.next_cli;
            let frame = ControlFrame { id: Some(id), reply_to: None, body: ControlBody::Cli { agent_id, command } };
            if !s.ready_tx().is_some_and(|tx| tx.send(frame).is_ok()) {
                return CliResult::Error { error: err(error_code::BUSY, "not connected to the host", true) };
            }
            s.pending_cli.insert(id, tx_res);
            id
        };
        match tokio::time::timeout(timeout, rx_res).await {
            Ok(Ok(r)) => r,
            _ => {
                self.0.lock().unwrap().pending_cli.remove(&id);
                CliResult::Error { error: err(error_code::INTERNAL, "host did not answer in time", true) }
            }
        }
    }

    /// A reply (`cli_result` or `error`) to one of our CLI relays.
    pub fn resolve_cli(&self, reply_to: u64, result: CliResult) {
        if let Some(w) = self.0.lock().unwrap().pending_cli.remove(&reply_to) {
            let _ = w.send(result);
        }
    }
}

pub fn event(body: ControlBody) -> ControlFrame {
    ControlFrame { id: None, reply_to: None, body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::guest::PortProto;

    fn ports(port: u16) -> Vec<ListeningPort> {
        vec![ListeningPort { port, proto: PortProto::Tcp, bind: "any".into(), pid: None, process: None }]
    }

    fn sent_ports(rx: &mut mpsc::UnboundedReceiver<ControlFrame>) -> Vec<Vec<ListeningPort>> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|f| match f.body {
                ControlBody::Ports { listening, .. } => Some(listening),
                _ => None,
            })
            .collect()
    }

    /// B7: a scan that lands after attach but before `configure` is the one announced on ready,
    /// exactly once; a scan before attach is superseded.
    #[test]
    fn ready_announces_the_latest_ports_once() {
        let ev = Events::default();
        ev.emit(ControlBody::Ports { listening: ports(1), ts_ms: 0 });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let generation = ev.attach(tx);
        ev.emit(ControlBody::Ports { listening: ports(2), ts_ms: 0 });
        assert!(sent_ports(&mut rx).is_empty(), "nothing flows before configure");
        ev.ready(generation);
        assert_eq!(sent_ports(&mut rx), vec![ports(2)]);
        ev.emit(ControlBody::Ports { listening: ports(3), ts_ms: 0 });
        assert_eq!(sent_ports(&mut rx), vec![ports(3)]);
    }

    /// A stale connection's detach or ready doesn't touch the current one.
    #[test]
    fn only_the_current_generation_moves_the_link() {
        let ev = Events::default();
        let (old_tx, mut old_rx) = mpsc::unbounded_channel();
        let old = ev.attach(old_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let current = ev.attach(tx);
        ev.detach(old);
        ev.ready(old);
        assert!(sent_ports(&mut old_rx).is_empty() && sent_ports(&mut rx).is_empty());
        ev.ready(current);
        assert_eq!(sent_ports(&mut rx).len(), 1);
    }
}
