//! `Bash`, `TaskOutput`, `TaskStop`.

use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nest_protocol::guest::{
    BashInput, HandsDetail, HandsResult, TaskInfo, TaskOutputInput, TaskStatus, TaskStopInput, error_code,
};
use nest_protocol::model::{AgentId, ErrorBody};
use tokio::io::AsyncReadExt;
use tokio::net::unix::pipe;
use tokio::process::Child;

use super::{CallCtx, text};
use crate::exec::{self, Leaf, Spawn};
use crate::framed::err;
use crate::output::{OutputSink, OutputView, read_output, tail_chars};
use crate::state::{Guest, now_ms};
use crate::tasks::{self, Adopt, Task};

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_BG_LIMIT_MS: u64 = 1_800_000;
pub const MAX_BG_LIMIT_MS: u64 = 7_200_000;
pub const INLINE_SUCCESS_CHARS: usize = 30_000;
pub const PREVIEW_CHARS: usize = 2_000;
pub const FAILURE_EXCERPT_CHARS: usize = 10_000;
pub const TASK_TAIL_CHARS: usize = 30_000;

/// `$1` = cwd, `$2` = command, `$3` = fallback cwd. fd 3 receives `$PWD` at exit; the command
/// itself runs with fd 3 closed so background children can't hold it open.
const SCRIPT: &str = r#"trap 'printf "%s\n" "$PWD" >&3' EXIT
if ! cd -- "$1" 2>/dev/null; then
  if cd -- "$3" 2>/dev/null; then
    printf 'nest: working directory %s does not exist; running in %s\n' "$1" "$3" >&2
  else
    cd / && printf 'nest: working directories %s and %s do not exist; running in /\n' "$1" "$3" >&2
  fi
fi
eval "$2" 3>&-"#;

struct Running {
    child: Child,
    leaf: Leaf,
    sink: OutputSink,
    pwd: Option<pipe::Receiver>,
}

fn safe_name(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '_' }).collect()
}

fn bash_path() -> PathBuf {
    exec::which("bash").unwrap_or_else(|| PathBuf::from("/bin/bash"))
}

/// Start `command` through bash in the agent's context, output captured to `out`.
fn spawn_shell(
    guest: &Guest,
    agent: &AgentId,
    command: &str,
    out: &Path,
    cg_kind: &str,
    cg_name: &str,
    want_pwd: bool,
) -> Result<Running, ErrorBody> {
    let ctx = guest.exec_ctx(agent)?;
    let internal = |e: std::io::Error| err(error_code::INTERNAL, e.to_string(), false);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(internal)?;
    }
    let (out_r, out_w) = exec::pipe().map_err(internal)?;
    let (pwd_r, pwd_w) = if want_pwd {
        let (r, w) = exec::pipe().map_err(internal)?;
        (Some(r), Some(w))
    } else {
        (None, None)
    };
    let cgroup = guest.cgroups.leaf(&agent.0, cg_kind, cg_name);
    let spawn_dir = if Path::new(&ctx.cwd).is_dir() { PathBuf::from(&ctx.cwd) } else { PathBuf::from("/") };
    let child = exec::spawn(Spawn {
        argv: vec![
            bash_path().display().to_string(),
            "--noprofile".into(),
            "--norc".into(),
            "-c".into(),
            SCRIPT.into(),
            "nest-bash".into(),
            ctx.cwd,
            command.to_string(),
            ctx.slot.cwd,
        ],
        cwd: &spawn_dir,
        env: ctx.env,
        output: Some(out_w),
        fd3: pwd_w,
        cgroup: cgroup.clone(),
        run_as: guest.config.run_as,
    })
    .map_err(internal)?;
    let leaf = Leaf { cgroup, pgid: child.id() };
    let overflow = leaf.clone();
    let sink = OutputSink::capture(out_r, out, Box::new(move || overflow.kill()))
        .map_err(internal)?;
    let pwd = match pwd_r {
        Some(r) => Some(pipe::Receiver::from_owned_fd(r).map_err(internal)?),
        None => None,
    };
    Ok(Running { child, leaf, sink, pwd })
}

pub async fn run(guest: &Arc<Guest>, input: BashInput, ctx: &CallCtx) -> Result<HandsResult, ErrorBody> {
    let agent = &ctx.agent_id;
    let started = Instant::now();
    if input.run_in_background {
        return start_background(guest, agent, input, ctx).await;
    }
    let timeout_ms = input.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS);
    let name = safe_name(&ctx.call_id);
    let out = guest.agent_dir(agent).join("calls").join(format!("{name}.out"));
    let mut r = spawn_shell(guest, agent, &input.command, &out, "calls", &name, true)?;
    ctx.started();
    let before_cwd = super::agent_cwd(guest, agent);

    enum End {
        Exited(std::process::ExitStatus),
        Cancelled,
        TimedOut,
    }
    let end = tokio::select! {
        s = r.child.wait() => End::Exited(s.map_err(|e| err(error_code::INTERNAL, e.to_string(), false))?),
        _ = ctx.cancel.cancelled() => End::Cancelled,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => End::TimedOut,
    };

    let mut cwd = before_cwd;
    let ending = match end {
        End::Exited(status) => {
            let _ = r.sink.wait_eof(Duration::from_millis(200)).await;
            if let Some(p) = r.pwd.as_mut()
                && let Some(new) = read_pwd(p).await.filter(|d| Path::new(d).is_dir())
            {
                if new != cwd {
                    guest.set_cwd(agent, &new);
                }
                cwd = new;
            }
            r.leaf.release();
            if let Some(dir) = out.parent() {
                crate::output::prune_dir(dir, crate::output::KEEP_CALL_OUTPUTS, crate::output::CALL_OUTPUT_BUDGET, &out);
            }
            Ending::Exited(status)
        }
        End::Cancelled => {
            r.leaf.kill();
            let status = tokio::time::timeout(Duration::from_secs(2), r.child.wait()).await.ok().and_then(|s| s.ok());
            let _ = r.sink.wait_eof(Duration::from_millis(200)).await;
            r.leaf.release();
            Ending::Interrupted(status)
        }
        End::TimedOut if starts_with_sleep(&input.command) => {
            r.leaf.kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), r.child.wait()).await;
            r.leaf.release();
            Ending::Killed
        }
        End::TimedOut => {
            let id = tasks::new_task_id();
            // A task's output lives in tasks/, kept per task: calls/ keeps only the newest call
            // outputs and would delete it while it runs. Same tmpfs, so the sink's open fd follows.
            let moved = guest.agent_dir(agent).join("tasks").join(format!("{id}.out"));
            match std::fs::rename(&out, &moved) {
                Ok(()) => r.sink.path = moved,
                Err(e) => tracing::warn!(error = %e, "could not move {} to tasks/", out.display()),
            }
            let report = Report {
                output_path: r.sink.path.clone(),
                output_bytes: r.sink.total(),
                cwd,
                timeout_ms,
                duration_ms: started.elapsed().as_millis() as u64,
            };
            // Keep the $PWD pipe open: the shell's EXIT trap writes to it, and a closed reader
            // would kill the shell with SIGPIPE and lose its exit status.
            if let Some(mut p) = r.pwd.take() {
                tokio::spawn(async move {
                    let mut sink = Vec::new();
                    let _ = p.read_to_end(&mut sink).await;
                });
            }
            tasks::adopt(
                guest,
                Adopt {
                    id: id.clone(),
                    agent_id: agent.clone(),
                    description: input.description.clone(),
                    child: r.child,
                    leaf: r.leaf,
                    sink: r.sink,
                    started_ms: now_ms() - started.elapsed().as_millis() as i64,
                    time_limit: Duration::from_millis(DEFAULT_BG_LIMIT_MS),
                },
            );
            return Ok(bash_result(Ending::Moved(id), &OutputView::default(), &input.command, report));
        }
    };
    let view = read_output(&out);
    let report = Report {
        output_path: out,
        output_bytes: r.sink.total(),
        cwd,
        timeout_ms,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    Ok(bash_result(ending, &view, &input.command, report))
}

/// How a foreground call ended.
#[derive(Debug)]
enum Ending {
    Exited(std::process::ExitStatus),
    /// Cancelled (interrupt or hangup) and killed; its status if it was reaped in time.
    Interrupted(Option<std::process::ExitStatus>),
    /// Timed out running `sleep`: killed.
    Killed,
    /// Timed out: moved to the background as this task.
    Moved(String),
}

/// What a result reports besides how the call ended.
struct Report {
    output_path: PathBuf,
    output_bytes: u64,
    /// The session cwd after the call (unchanged unless it exited).
    cwd: String,
    timeout_ms: u64,
    duration_ms: u64,
}

/// Pure: the Bash result the model sees, as Claude Code's Bash tool shows it. Exit 0 (or 1 from a
/// search or diff) is success; a failure shows a head-and-tail excerpt and its exit code; an
/// interrupt or a killed `sleep` is an error; a call moved to the background names its task.
fn bash_result(ending: Ending, view: &OutputView, command: &str, r: Report) -> HandsResult {
    let path = r.output_path.display().to_string();
    let secs = r.timeout_ms as f64 / 1000.0;
    let with_excerpt = |end: &str| {
        let mut t = excerpt(&view.text, FAILURE_EXCERPT_CHARS);
        if !t.is_empty() && !t.ends_with('\n') {
            t.push('\n');
        }
        t.push_str(end);
        t
    };
    let (is_error, body, status, interrupted, task_id, truncated) = match ending {
        Ending::Exited(status) => {
            let code = status.code();
            if code == Some(0) || (code == Some(1) && lenient_exit_one(command)) {
                let (body, truncated) = success_text(view, &r.output_path);
                (false, body, Some(status), false, None, truncated)
            } else {
                let end = match (code, status.signal()) {
                    (Some(c), _) => format!("Exit code {c}"),
                    (None, Some(s)) => format!("Killed by signal {s}"),
                    _ => "Exit status unknown".to_string(),
                };
                let truncated = view.text.chars().count() > FAILURE_EXCERPT_CHARS;
                (true, with_excerpt(&end), Some(status), false, None, truncated)
            }
        }
        Ending::Interrupted(status) => (true, with_excerpt("[Command interrupted]"), status, true, None, false),
        Ending::Killed => {
            let killed = std::process::ExitStatus::from_raw(libc::SIGKILL);
            (true, format!("Command timed out after {secs}s and was killed."), Some(killed), false, None, false)
        }
        Ending::Moved(id) => {
            let body = format!(
                "Command did not complete within its {secs}s timeout and was moved to the background with ID: {id}. \
                 Output is being written to: {path}. Use TaskOutput to check on it. Session cwd remains {}.",
                r.cwd
            );
            (false, body, None, false, Some(id), false)
        }
    };
    text(
        is_error,
        body,
        HandsDetail::Bash {
            exit_code: status.and_then(|s| s.code()),
            signal: status.and_then(|s| s.signal()),
            interrupted,
            task_id,
            output_path: path,
            output_bytes: r.output_bytes,
            truncated,
            cwd: r.cwd,
            duration_ms: r.duration_ms,
        },
    )
}

async fn start_background(
    guest: &Arc<Guest>,
    agent: &AgentId,
    input: BashInput,
    ctx: &CallCtx,
) -> Result<HandsResult, ErrorBody> {
    let limit = input.timeout.unwrap_or(DEFAULT_BG_LIMIT_MS).clamp(1, MAX_BG_LIMIT_MS);
    let id = tasks::new_task_id();
    let out = guest.agent_dir(agent).join("tasks").join(format!("{id}.out"));
    let r = spawn_shell(guest, agent, &input.command, &out, "tasks", &id, false)?;
    ctx.started();
    let cwd = super::agent_cwd(guest, agent);
    let task = tasks::adopt(
        guest,
        Adopt {
            id: id.clone(),
            agent_id: agent.clone(),
            description: input.description.clone(),
            child: r.child,
            leaf: r.leaf,
            sink: r.sink,
            started_ms: now_ms(),
            time_limit: Duration::from_millis(limit),
        },
    );
    Ok(text(
        false,
        format!(
            "Command running in background with ID: {id}. Output is being written to: {}. Use TaskOutput to check on it.",
            task.output_path.display()
        ),
        HandsDetail::Bash {
            exit_code: None,
            signal: None,
            interrupted: false,
            task_id: Some(id),
            output_path: task.output_path.display().to_string(),
            output_bytes: 0,
            truncated: false,
            cwd,
            duration_ms: 0,
        },
    ))
}

fn find_task(guest: &Guest, agent: &AgentId, id: &str) -> Result<Arc<Task>, ErrorBody> {
    let inner = guest.inner.lock().unwrap();
    let rt = inner.agents.get(agent).ok_or_else(|| err(error_code::UNKNOWN_AGENT, "agent detached", false))?;
    rt.tasks.get(id).cloned().ok_or_else(|| {
        let mut running: Vec<_> = rt.tasks.values().filter(|t| t.is_running()).map(|t| t.id.clone()).collect();
        running.sort();
        let list = if running.is_empty() { "none".to_string() } else { running.join(", ") };
        err(error_code::UNKNOWN_TASK, format!("No task with ID {id}. Running tasks: {list}"), false)
    })
}

fn status_line(info: &TaskInfo) -> String {
    let what = match info.status {
        TaskStatus::Running => "running".to_string(),
        TaskStatus::Exited => match info.exit_code {
            Some(c) => format!("exited with code {c}"),
            None => "exited (killed by a signal)".to_string(),
        },
        TaskStatus::Killed => "killed".to_string(),
        TaskStatus::TimedOut => "stopped after reaching its time limit".to_string(),
    };
    match &info.description {
        Some(d) => format!("Task {} ({d}): {what}", info.task_id),
        None => format!("Task {}: {what}", info.task_id),
    }
}

pub async fn task_output(guest: &Arc<Guest>, agent: &AgentId, input: TaskOutputInput) -> Result<HandsResult, ErrorBody> {
    let task = find_task(guest, agent, &input.task_id)?;
    if input.block {
        let max = input.timeout.unwrap_or(30_000).min(600_000);
        task.wait(Duration::from_millis(max)).await;
    }
    let info = task.info();
    let tail = tail_chars(&task.output_path, TASK_TAIL_CHARS);
    let body = if tail.is_empty() { format!("{}\n\n(no output yet)", status_line(&info)) } else { format!("{}\n\n{tail}", status_line(&info)) };
    Ok(text(false, body, HandsDetail::TaskOutput { task: info }))
}

pub async fn task_stop(guest: &Arc<Guest>, agent: &AgentId, input: TaskStopInput) -> Result<HandsResult, ErrorBody> {
    let task = find_task(guest, agent, &input.task_id)?;
    let was_running = task.is_running();
    if was_running {
        task.stop();
        task.wait(Duration::from_secs(5)).await;
    }
    let info = task.info();
    let body = if was_running {
        format!("Task {} stopped. Output kept at {}.", info.task_id, info.output_path)
    } else {
        format!("Task {} had already finished. {}", info.task_id, status_line(&info))
    };
    Ok(text(false, body, HandsDetail::TaskStop { task: info }))
}

async fn read_pwd(p: &mut pipe::Receiver) -> Option<String> {
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(200), p.read_to_end(&mut buf)).await;
    let s = String::from_utf8_lossy(&buf);
    s.lines().next().map(|l| l.to_string()).filter(|l| l.starts_with('/'))
}

/// A success: the output whole when small, else a preview and the saved path.
fn success_text(view: &OutputView, path: &Path) -> (String, bool) {
    let output = &view.text;
    let n = output.chars().count();
    if view.total_bytes == 0 || n == 0 {
        return ("(no output)".into(), false);
    }
    if view.complete && n <= INLINE_SUCCESS_CHARS {
        return (output.to_string(), false);
    }
    let preview: String = output.chars().take(PREVIEW_CHARS).collect();
    let size = if view.complete { format!("{n} characters") } else { format!("{} bytes", view.total_bytes) };
    (
        format!(
            "Output too large ({size}). Full output saved to: {}\n\nPreview (first {PREVIEW_CHARS} characters):\n{preview}",
            path.display()
        ),
        true,
    )
}

/// Head-and-tail excerpt of at most `max` characters.
pub fn excerpt(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let half = max / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(n - half).collect();
    format!("{head}\n... [{} characters truncated] ...\n{tail}", n - 2 * half)
}

/// Commands whose exit code 1 means "no match / differences", not failure.
pub fn lenient_exit_one(command: &str) -> bool {
    let mut words = command
        .split_whitespace()
        .skip_while(|w| w.contains('=') && !w.starts_with('='))
        .map(|w| w.rsplit('/').next().unwrap_or(w));
    match words.next() {
        Some("grep" | "rg" | "egrep" | "fgrep" | "find" | "diff" | "test" | "[") => true,
        Some("git") => matches!(words.next(), Some("diff" | "grep")),
        _ => false,
    }
}

fn starts_with_sleep(command: &str) -> bool {
    command.split_whitespace().next() == Some("sleep")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient() {
        assert!(lenient_exit_one("grep foo bar"));
        assert!(lenient_exit_one("LC_ALL=C /usr/bin/grep -r x ."));
        assert!(lenient_exit_one("git diff --stat"));
        assert!(!lenient_exit_one("git status"));
        assert!(!lenient_exit_one("npm test"));
    }

    #[test]
    fn excerpts() {
        assert_eq!(excerpt("abc", 10), "abc");
        let s = "a".repeat(30);
        let e = excerpt(&s, 10);
        assert!(e.starts_with("aaaaa\n... [20 characters truncated] ...\naaaaa"));
    }

    /// Claude Code's Bash results (host-guest "Bash"), one row per way a call ends.
    #[test]
    fn bash_results_follow_claude_codes_bash() {
        let exited = |code: i32| Ending::Exited(std::process::ExitStatus::from_raw(code << 8));
        let big = "y".repeat(INLINE_SUCCESS_CHARS + 1);
        let rows: Vec<(Ending, &str, &str, bool, &str)> = vec![
            // (ending, output, command, is_error, the body contains)
            (exited(0), "hi\n", "echo hi", false, "hi\n"),
            (exited(0), "", "true", false, "(no output)"),
            (exited(0), &big, "yes", false, "Output too large"),
            (exited(1), "", "grep x f", false, "(no output)"),
            (exited(1), "boom\n", "npm test", true, "boom\nExit code 1"),
            (Ending::Exited(std::process::ExitStatus::from_raw(libc::SIGKILL)), "", "x", true, "Killed by signal 9"),
            (Ending::Interrupted(None), "partial", "x", true, "partial\n[Command interrupted]"),
            (Ending::Killed, "", "sleep 30", true, "timed out after 0.2s and was killed"),
            (Ending::Moved("bg_1".into()), "", "npm run dev", false, "moved to the background with ID: bg_1"),
        ];
        let mut seen = [false; 4];
        for (ending, out, command, is_error, contains) in rows {
            seen[match &ending {
                Ending::Exited(_) => 0,
                Ending::Interrupted(_) => 1,
                Ending::Killed => 2,
                Ending::Moved(_) => 3,
            }] = true;
            let label = format!("{ending:?} {command}");
            let view = OutputView { text: out.into(), total_bytes: out.len() as u64, complete: true };
            let report = Report { output_path: "/o.out".into(), output_bytes: 0, cwd: "/w".into(), timeout_ms: 200, duration_ms: 1 };
            let r = bash_result(ending, &view, command, report);
            let nest_protocol::guest::ToolContent::Text { text } = &r.content[0] else { panic!("{label}") };
            assert_eq!(r.is_error, is_error, "{label}: {text}");
            assert!(text.contains(contains), "{label}: {text}");
        }
        assert!(seen.iter().all(|s| *s), "every ending has a row");
    }

    #[test]
    fn sleep_detection() {
        assert!(starts_with_sleep("  sleep 10"));
        assert!(!starts_with_sleep("sleepy"));
    }
}
