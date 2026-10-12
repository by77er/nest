//! `Glob`: matching files, newest first, capped at 100. Does not respect `.gitignore`.
//!
//! Bounded: at most [`MAX_WALK`] directory entries are visited, only the newest
//! [`MAX_RESULTS`] matches are kept in memory, and cancellation is checked while walking.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use globset::GlobBuilder;
use nest_protocol::guest::{GlobInput, HandsDetail, HandsResult};
use nest_protocol::model::{AgentId, ErrorBody};

use tokio_util::sync::CancellationToken;

use super::{resolve, text};
use crate::framed::bad_request;
use crate::state::Guest;

pub const MAX_RESULTS: usize = 100;
/// Directory entries visited before giving up (the result says so).
pub const MAX_WALK: usize = 500_000;

pub fn run(guest: &Guest, agent: &AgentId, input: GlobInput, cancel: &CancellationToken) -> Result<HandsResult, ErrorBody> {
    let mut base = resolve(guest, agent, input.path.as_deref());
    let mut pattern = input.pattern.clone();
    // An absolute pattern: split off its literal directory prefix as the search root.
    if pattern.starts_with('/') {
        let (root, rest) = split_literal_prefix(&pattern);
        base = root;
        pattern = rest;
    }
    if !base.is_dir() {
        return Ok(text(true, format!("Directory does not exist: {}", base.display()), detail(0, false)));
    }
    let matcher = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| bad_request(&format!("invalid glob pattern: {e}")))?
        .compile_matcher();
    // Min-heap on (mtime, Reverse(path)): the root is the match that would be dropped first.
    let mut newest: BinaryHeap<Reverse<(SystemTime, Reverse<PathBuf>)>> = BinaryHeap::new();
    let mut total = 0usize;
    let mut walk_capped = false;
    for (visited, entry) in walkdir::WalkDir::new(&base).follow_links(false).into_iter().filter_map(Result::ok).enumerate() {
        if visited % 1024 == 0 && cancel.is_cancelled() {
            return Ok(text(true, "[Interrupted]", detail(0, false)));
        }
        if visited >= MAX_WALK {
            walk_capped = true;
            break;
        }
        if !entry.file_type().is_file() && !entry.file_type().is_symlink() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&base) else { continue };
        if matcher.is_match(rel) {
            total += 1;
            let mtime = entry.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
            newest.push(Reverse((mtime, Reverse(entry.path().to_path_buf()))));
            if newest.len() > MAX_RESULTS {
                newest.pop();
            }
        }
    }
    let mut found: Vec<(SystemTime, PathBuf)> = newest.into_iter().map(|Reverse((t, Reverse(p)))| (t, p)).collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let truncated = total > found.len() || walk_capped;
    if found.is_empty() {
        let msg = if walk_capped {
            format!("No files found in the first {MAX_WALK} entries; use a more specific path or pattern.")
        } else {
            "No files found".to_string()
        };
        return Ok(text(false, msg, detail(0, walk_capped)));
    }
    let mut out: String = found.iter().map(|(_, p)| format!("{}\n", p.display())).collect();
    if walk_capped {
        out.push_str(&format!(
            "(Search stopped after {MAX_WALK} entries; showing the {} most recently modified matches found. \
             Use a more specific path or pattern.)\n",
            found.len()
        ));
    } else if truncated {
        out.push_str(&format!(
            "(Results are truncated: showing the {MAX_RESULTS} most recently modified of {total} files. \
             Consider using a more specific path or pattern.)\n"
        ));
    }
    Ok(text(false, out, detail(found.len() as u32, truncated)))
}

fn detail(num_files: u32, truncated: bool) -> HandsDetail {
    HandsDetail::Glob { num_files, truncated }
}

fn split_literal_prefix(pattern: &str) -> (PathBuf, String) {
    let mut root = PathBuf::from("/");
    let mut rest = Vec::new();
    let mut literal = true;
    for c in Path::new(pattern).components() {
        let Component::Normal(s) = c else { continue };
        let s = s.to_string_lossy();
        if literal && !s.contains(['*', '?', '[', '{']) {
            root.push(&*s);
        } else {
            literal = false;
            rest.push(s.into_owned());
        }
    }
    if rest.is_empty() {
        // Fully literal: match the file itself.
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        root.pop();
        return (root, name);
    }
    (root, rest.join("/"))
}
