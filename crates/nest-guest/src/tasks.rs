//! Background tasks: `Bash{run_in_background}` and foreground commands moved to the background
//! on timeout. Polled with `TaskOutput`, stopped with `TaskStop`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::guest::{ControlBody, TaskInfo, TaskStatus};
use nest_protocol::model::AgentId;
use tokio::process::Child;
use tokio::sync::watch;

use crate::exec::Leaf;
use crate::output::OutputSink;
use crate::state::{Guest, now_ms};

pub struct Task {
    pub id: String,
    pub agent_id: AgentId,
    pub description: Option<String>,
    pub output_path: PathBuf,
    pub started_ms: i64,
    pub leaf: Leaf,
    sink: OutputSink,
    state: Mutex<TaskState>,
    done: watch::Receiver<bool>,
}

struct TaskState {
    status: TaskStatus,
    exit_code: Option<i32>,
    ended_ms: Option<i64>,
    stop_requested: bool,
}

impl Task {
    pub fn info(&self) -> TaskInfo {
        let st = self.state.lock().unwrap();
        TaskInfo {
            task_id: self.id.clone(),
            description: self.description.clone(),
            status: st.status,
            exit_code: st.exit_code,
            output_path: self.output_path.display().to_string(),
            output_bytes: self.sink.total(),
            started_ms: self.started_ms,
            ended_ms: st.ended_ms,
        }
    }

    pub fn is_running(&self) -> bool {
        self.state.lock().unwrap().status == TaskStatus::Running
    }

    /// Wait until the task has exited, at most `max`. Returns true if it has.
    pub async fn wait(&self, max: Duration) -> bool {
        let mut rx = self.done.clone();
        if *rx.borrow() {
            return true;
        }
        tokio::time::timeout(max, rx.wait_for(|v| *v)).await.is_ok()
    }

    pub fn stop(&self) {
        self.state.lock().unwrap().stop_requested = true;
        self.leaf.kill();
    }
}

pub struct Adopt {
    pub id: String,
    pub agent_id: AgentId,
    pub description: Option<String>,
    pub child: Child,
    pub leaf: Leaf,
    pub sink: OutputSink,
    pub started_ms: i64,
    pub time_limit: Duration,
}

/// Register a running child as a task and watch it until it exits or hits its time limit.
pub fn adopt(guest: &Arc<Guest>, a: Adopt) -> Arc<Task> {
    let (done_tx, done) = watch::channel(false);
    let task = Arc::new(Task {
        id: a.id.clone(),
        agent_id: a.agent_id.clone(),
        description: a.description,
        output_path: a.sink.path.clone(),
        started_ms: a.started_ms,
        leaf: a.leaf,
        sink: a.sink,
        state: Mutex::new(TaskState { status: TaskStatus::Running, exit_code: None, ended_ms: None, stop_requested: false }),
        done,
    });
    if let Some(rt) = guest.inner.lock().unwrap().agents.get_mut(&a.agent_id) {
        rt.tasks.insert(a.id.clone(), task.clone());
    }
    let guest = guest.clone();
    let t = task.clone();
    let mut child = a.child;
    let limit = a.time_limit;
    tokio::spawn(async move {
        let mut timed_out = false;
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = tokio::time::sleep(limit) => {
                timed_out = true;
                t.leaf.kill();
                child.wait().await.ok()
            }
        };
        let _ = t.sink.wait_eof(Duration::from_millis(500)).await;
        {
            let mut st = t.state.lock().unwrap();
            st.exit_code = status.and_then(|s| s.code());
            st.ended_ms = Some(now_ms());
            st.status = if timed_out {
                TaskStatus::TimedOut
            } else if st.stop_requested {
                TaskStatus::Killed
            } else {
                TaskStatus::Exited
            };
        }
        // Reap whatever else is left in the task's group before announcing it.
        if t.state.lock().unwrap().status != TaskStatus::Exited {
            t.leaf.kill();
        }
        guest.events.emit(ControlBody::TaskExited { agent_id: t.agent_id.clone(), task: t.info() });
        let _ = done_tx.send(true);
        prune_finished(&guest, &t.agent_id);
        t.leaf.release();
    });
    task
}

/// Forget finished tasks (and delete their outputs) beyond the newest
/// [`crate::output::KEEP_FINISHED_TASKS`].
pub fn prune_finished(guest: &Guest, agent: &AgentId) {
    let stale: Vec<Arc<Task>> = {
        let mut inner = guest.inner.lock().unwrap();
        let Some(rt) = inner.agents.get_mut(agent) else { return };
        let mut done: Vec<(i64, String)> = rt
            .tasks
            .values()
            .filter(|t| !t.is_running())
            .map(|t| (t.state.lock().unwrap().ended_ms.unwrap_or(0), t.id.clone()))
            .collect();
        done.sort_by_key(|d| std::cmp::Reverse(d.0));
        done.into_iter().skip(crate::output::KEEP_FINISHED_TASKS).filter_map(|(_, id)| rt.tasks.remove(&id)).collect()
    };
    for t in stale {
        let _ = std::fs::remove_file(&t.output_path);
    }
}

/// Short task id: `bg_` + 8 hex chars.
pub fn new_task_id() -> String {
    format!("bg_{}", crate::state::random_hex(4))
}
