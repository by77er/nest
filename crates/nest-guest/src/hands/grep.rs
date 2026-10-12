//! `Grep`, implemented with ripgrep (falls back to `grep -r` if `rg` is missing).
//!
//! Runs as the sandbox user in the agent's environment and cgroup; output is capped at
//! [`MAX_OUTPUT_BYTES`] and the search at [`TIMEOUT`] (the process tree is killed at either).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use nest_protocol::guest::{GrepInput, GrepOutputMode, HandsDetail, HandsResult};
use nest_protocol::model::{AgentId, ErrorBody};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::{CallCtx, resolve, text};
use crate::exec::{PreExec, agent_env, kill_tree, which};
use crate::framed::err;
use crate::state::Guest;

pub const DEFAULT_HEAD_LIMIT: u32 = 250;
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(120);

fn detail(n: u32, truncated: bool) -> HandsDetail {
    HandsDetail::Grep { num_entries: n, truncated }
}

pub async fn run(guest: &Arc<Guest>, agent: &AgentId, input: GrepInput, ctx: &CallCtx) -> Result<HandsResult, ErrorBody> {
    let path = resolve(guest, agent, input.path.as_deref());
    let mode = input.output_mode.unwrap_or_default();
    let (prog, args) = match which("rg") {
        Some(rg) => (rg, rg_args(&input, mode, &path)),
        None => (which("grep").unwrap_or_else(|| PathBuf::from("grep")), grep_args(&input, mode, &path)),
    };
    let (cwd, env) = {
        let inner = guest.inner.lock().unwrap();
        let rt = inner.agents.get(agent);
        (
            rt.map(|r| r.cwd.clone()).unwrap_or_else(|| "/".into()),
            rt.map(|r| agent_env(&r.slot, guest.config.run_as)).unwrap_or_else(|| crate::exec::base_env(guest.config.run_as)),
        )
    };
    let mut cmd = Command::new(&prog);
    cmd.args(&args).env_clear().envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.current_dir(&cwd);
    }
    let cgroup = guest.cgroups.leaf(&agent.0, "calls", &format!("grep-{}", crate::state::random_hex(4)));
    PreExec { new_pgrp: true, cgroup: cgroup.clone(), fd3: None, run_as: guest.config.run_as }.apply_tokio(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| err("internal", format!("could not run {}: {e}", prog.display()), false))?;
    let pgid = child.id();
    let mut so = child.stdout.take().expect("piped");
    let mut se = child.stderr.take().expect("piped");
    let kill_cg = cgroup.clone();
    let collect = async {
        let stdout = async {
            let mut out = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut capped = false;
            loop {
                match so.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) if out.len() + n > MAX_OUTPUT_BYTES => {
                        out.extend_from_slice(&buf[..MAX_OUTPUT_BYTES - out.len()]);
                        capped = true;
                        // Stop the search so stderr closes too.
                        kill_tree(kill_cg.as_deref(), pgid);
                        break;
                    }
                    Ok(n) => out.extend_from_slice(&buf[..n]),
                }
            }
            (out, capped)
        };
        let stderr = async {
            // Drain everything (so the search never blocks on a full pipe), keep 64 KiB.
            let mut keep = Vec::new();
            let mut buf = vec![0u8; 16 * 1024];
            while let Ok(n) = se.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let room = (64 * 1024usize).saturating_sub(keep.len()).min(n);
                keep.extend_from_slice(&buf[..room]);
            }
            keep
        };
        let ((out, capped), err_bytes) = tokio::join!(stdout, stderr);
        (out, err_bytes, capped)
    };
    enum End {
        Done((Vec<u8>, Vec<u8>, bool)),
        Cancelled,
        TimedOut,
    }
    let end = tokio::select! {
        r = collect => End::Done(r),
        _ = ctx.cancel.cancelled() => End::Cancelled,
        _ = tokio::time::sleep(TIMEOUT) => End::TimedOut,
    };
    let finish = |cg: Option<PathBuf>| {
        kill_tree(cg.as_deref(), pgid);
        if let Some(cg) = cg {
            tokio::spawn(crate::cgroup::Cgroups::remove_later(cg));
        }
    };
    let (stdout_bytes, stderr_bytes, capped) = match end {
        End::Done(r) => r,
        End::Cancelled => {
            finish(cgroup);
            return Ok(text(true, "[Search interrupted]", detail(0, false)));
        }
        End::TimedOut => {
            finish(cgroup);
            return Ok(text(true, format!("Search did not finish within {}s; narrow the path or pattern.", TIMEOUT.as_secs()), detail(0, false)));
        }
    };
    let status = child.wait().await.map_err(|e| err("internal", e.to_string(), false))?;
    if let Some(cg) = cgroup {
        tokio::spawn(crate::cgroup::Cgroups::remove_later(cg));
    }
    let output = std::process::Output { status, stdout: stdout_bytes, stderr: stderr_bytes };
    let code = output.status.code().unwrap_or(2);
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !capped && (code == 1 || (code == 0 && stdout.trim().is_empty())) {
        let msg = if mode == GrepOutputMode::FilesWithMatches { "No files found" } else { "No matches found" };
        return Ok(text(false, msg, detail(0, false)));
    }
    if !capped && code != 0 && stdout.trim().is_empty() {
        return Ok(text(true, String::from_utf8_lossy(&output.stderr).trim().to_string(), detail(0, false)));
    }
    let mut entries: Vec<String> = stdout.lines().map(str::to_string).collect();
    if capped {
        entries.pop(); // possibly cut mid-line
    }
    let mut footer = None;
    match mode {
        GrepOutputMode::FilesWithMatches => {
            // Newest first, like Claude Code.
            let mut with_time: Vec<(SystemTime, String)> = entries
                .into_iter()
                .map(|p| {
                    let t = std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                    (t, p)
                })
                .collect();
            with_time.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            entries = with_time.into_iter().map(|(_, p)| p).collect();
        }
        GrepOutputMode::Count => {
            entries.retain(|l| !l.ends_with(":0"));
            let total: u64 =
                entries.iter().filter_map(|l| l.rsplit_once(':').and_then(|(_, n)| n.trim().parse::<u64>().ok())).sum();
            footer = Some(format!("Total: {total}"));
        }
        GrepOutputMode::Content => {}
    }
    let offset = input.offset.unwrap_or(0) as usize;
    let limit = match input.head_limit {
        Some(0) => usize::MAX,
        Some(n) => n as usize,
        None => DEFAULT_HEAD_LIMIT as usize,
    };
    let total = entries.len();
    if offset >= total {
        return Ok(text(false, "No entries at this offset", detail(0, false)));
    }
    let page: Vec<String> = entries.into_iter().skip(offset).take(limit).collect();
    let truncated = offset + page.len() < total;
    let mut out = page.join("\n");
    out.push('\n');
    if truncated {
        out.push_str(&format!(
            "\n(Showing entries {}-{} of {total}. Use offset to see more.)\n",
            offset + 1,
            offset + page.len()
        ));
    }
    if let Some(f) = footer {
        out.push_str(&format!("\n{f}\n"));
    }
    if capped {
        out.push_str(&format!(
            "\n(Search output exceeded {} MB and was cut off; results are incomplete. Narrow the path or pattern.)\n",
            MAX_OUTPUT_BYTES >> 20
        ));
    }
    Ok(text(false, out, detail(page.len() as u32, truncated || capped)))
}

fn rg_args(i: &GrepInput, mode: GrepOutputMode, path: &std::path::Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--color=never".into(),
        "--no-heading".into(),
        "--with-filename".into(),
        "--hidden".into(),
        "--max-columns=2000".into(),
        "--max-columns-preview".into(),
    ];
    a.push("--glob=!.git/".into());
    match mode {
        GrepOutputMode::FilesWithMatches => a.push("--files-with-matches".into()),
        GrepOutputMode::Count => a.push("--count".into()),
        GrepOutputMode::Content => {
            if i.line_numbers.unwrap_or(false) {
                a.push("--line-number".into());
            }
            if let Some(n) = i.after {
                a.push(format!("--after-context={n}"));
            }
            if let Some(n) = i.before {
                a.push(format!("--before-context={n}"));
            }
            if let Some(n) = i.context {
                a.push(format!("--context={n}"));
            }
        }
    }
    if i.case_insensitive.unwrap_or(false) {
        a.push("--ignore-case".into());
    }
    if i.multiline.unwrap_or(false) {
        a.push("--multiline".into());
        a.push("--multiline-dotall".into());
    }
    if let Some(g) = &i.glob {
        a.push(format!("--glob={g}"));
    }
    if let Some(t) = &i.file_type {
        a.push(format!("--type={t}"));
    }
    a.push("--regexp".into());
    a.push(i.pattern.clone());
    a.push("--".into());
    a.push(path.display().to_string());
    a
}

fn grep_args(i: &GrepInput, mode: GrepOutputMode, path: &std::path::Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-r".into(), "-E".into(), "-H".into(), "--exclude-dir=.git".into()];
    match mode {
        GrepOutputMode::FilesWithMatches => a.push("-l".into()),
        GrepOutputMode::Count => a.push("-c".into()),
        GrepOutputMode::Content => {
            if i.line_numbers.unwrap_or(false) {
                a.push("-n".into());
            }
            if let Some(n) = i.after {
                a.push(format!("-A{n}"));
            }
            if let Some(n) = i.before {
                a.push(format!("-B{n}"));
            }
            if let Some(n) = i.context {
                a.push(format!("-C{n}"));
            }
        }
    }
    if i.case_insensitive.unwrap_or(false) {
        a.push("-i".into());
    }
    if let Some(g) = &i.glob {
        a.push(format!("--include={g}"));
    }
    a.push("-e".into());
    a.push(i.pattern.clone());
    a.push("--".into());
    a.push(path.display().to_string());
    a
}
