//! `Write` and `Edit`, plus the per-agent read records they depend on.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use nest_protocol::guest::{EditInput, HandsDetail, HandsResult, WriteInput};
use nest_protocol::model::{AgentId, ErrorBody};
use sha2::{Digest, Sha256};

use super::{require_absolute, text};
use crate::state::{Guest, ReadRecord};

pub const NOT_READ: &str = "File has not been read yet. Read it first before writing to it.";
pub const MODIFIED_SINCE_READ: &str =
    "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
pub const STALE_NOTE: &str =
    "Note: the file had changed since you last read it; re-read before edits that depend on surrounding content.";
/// Edit reads the whole file; larger files go through Bash.
pub const EDIT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const SNIPPET_CONTEXT: usize = 4;

fn mtime_ns(m: &std::fs::Metadata) -> i128 {
    m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128
}

/// Remember that `agent` has fully read `path` with this content digest.
pub fn record_digest(guest: &Guest, agent: &AgentId, path: &Path, sha256: [u8; 32]) {
    let Ok(m) = std::fs::metadata(path) else { return };
    let rec = ReadRecord { mtime_ns: mtime_ns(&m), size: m.len(), sha256 };
    if let Some(rt) = guest.inner.lock().unwrap().agents.get_mut(agent) {
        rt.reads.insert(path.to_path_buf(), rec);
    }
}

/// Remember that `agent` has fully read `path` with these contents.
pub fn record_read(guest: &Guest, agent: &AgentId, path: &Path, bytes: &[u8]) {
    record_digest(guest, agent, path, Sha256::digest(bytes).into());
}

fn read_record(guest: &Guest, agent: &AgentId, path: &Path) -> Option<ReadRecord> {
    guest.inner.lock().unwrap().agents.get(agent).and_then(|rt| rt.reads.get(path).cloned())
}

/// Has `path` changed since `rec`? Size or (same-size) content decides; an mtime change alone
/// (e.g. `touch`) doesn't count.
fn changed_since(rec: &ReadRecord, path: &Path, current: Option<&[u8]>) -> bool {
    let Ok(m) = std::fs::metadata(path) else { return true };
    if m.len() != rec.size {
        return true;
    }
    if mtime_ns(&m) == rec.mtime_ns {
        return false;
    }
    let digest: [u8; 32] = match current {
        Some(b) => Sha256::digest(b).into(),
        None => {
            if m.len() > EDIT_MAX_BYTES {
                return true;
            }
            match std::fs::read(path) {
                Ok(b) => Sha256::digest(&b).into(),
                Err(_) => return true,
            }
        }
    };
    digest != rec.sha256
}

fn write_detail(created: bool, bytes: u64) -> HandsDetail {
    HandsDetail::Write { created, bytes }
}

fn edit_detail(replacements: u32, changed_since_read: bool) -> HandsDetail {
    HandsDetail::Edit { replacements, changed_since_read }
}

pub fn write(guest: &Guest, agent: &AgentId, input: WriteInput) -> Result<HandsResult, ErrorBody> {
    let path = require_absolute(&input.file_path)?;
    let existing = match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => {
            return Ok(text(true, format!("{} is a directory.", path.display()), write_detail(false, 0)));
        }
        Ok(m) if !m.is_file() => {
            return Ok(text(true, format!("{} is not a regular file; use Bash.", path.display()), write_detail(false, 0)));
        }
        Ok(m) => Some(m),
        Err(_) => None,
    };
    if let Some(m) = &existing {
        let Some(rec) = read_record(guest, agent, &path) else { return Ok(text(true, NOT_READ, write_detail(false, 0))) };
        if changed_since(&rec, &path, None) {
            return Ok(text(true, MODIFIED_SINCE_READ, write_detail(false, 0)));
        }
        if input.content.contains('\u{FFFD}') && m.len() <= EDIT_MAX_BYTES {
            let mut old = Vec::new();
            let _ = std::fs::File::open(&path).and_then(|f| f.take(EDIT_MAX_BYTES).read_to_end(&mut old));
            if std::str::from_utf8(&old).is_err() {
                return Ok(text(
                    true,
                    "Refusing to write: the content contains U+FFFD replacement characters and the original file is \
                     not valid UTF-8, so writing would corrupt it. Edit it with Bash instead.",
                    write_detail(false, 0),
                ));
            }
        }
    }
    let bytes = input.content.as_bytes();
    if let Err(e) = write_file(&path, bytes) {
        return Ok(text(true, format!("Could not write file: {e}"), write_detail(false, 0)));
    }
    record_read(guest, agent, &path, bytes);
    let created = existing.is_none();
    let msg = if created {
        format!("File created successfully at: {}", path.display())
    } else {
        format!("The file {} has been updated successfully.", path.display())
    };
    Ok(text(false, msg, write_detail(created, bytes.len() as u64)))
}

enum Encoding {
    Utf8,
    Utf16Le,
}

fn decode(bytes: &[u8]) -> Option<(String, Encoding)> {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        if rest.len() % 2 != 0 {
            return None;
        }
        let units: Vec<u16> = rest.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16(&units).ok().map(|s| (s, Encoding::Utf16Le));
    }
    std::str::from_utf8(bytes).ok().map(|s| (s.to_string(), Encoding::Utf8))
}

fn encode(s: &str, enc: &Encoding) -> Vec<u8> {
    match enc {
        Encoding::Utf8 => s.as_bytes().to_vec(),
        Encoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for u in s.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            out
        }
    }
}

pub fn edit(guest: &Guest, agent: &AgentId, input: EditInput) -> Result<HandsResult, ErrorBody> {
    let path = require_absolute(&input.file_path)?;
    let fail = |msg: String| Ok(text(true, msg, edit_detail(0, false)));
    let meta = std::fs::metadata(&path);
    if meta.is_err() {
        if input.old_string.is_empty() {
            let bytes = input.new_string.as_bytes();
            if let Err(e) = write_file(&path, bytes) {
                return fail(format!("Could not write file: {e}"));
            }
            record_read(guest, agent, &path, bytes);
            return Ok(text(false, format!("File created successfully at: {}", path.display()), edit_detail(1, false)));
        }
        return fail("File does not exist.".into());
    }
    if meta.as_ref().is_ok_and(|m| m.is_dir()) {
        return fail(format!("{} is a directory.", path.display()));
    }
    if meta.as_ref().is_ok_and(|m| !m.is_file()) {
        return fail(format!("{} is not a regular file; use Bash.", path.display()));
    }
    if meta.as_ref().is_ok_and(|m| m.len() > EDIT_MAX_BYTES) {
        return fail(format!("File is larger than {} MB; edit it with Bash (e.g. sed) instead.", EDIT_MAX_BYTES >> 20));
    }
    let Some(rec) = read_record(guest, agent, &path) else { return fail(NOT_READ.into()) };
    if input.old_string == input.new_string {
        return fail("No changes to make: old_string and new_string are exactly the same.".into());
    }
    if input.old_string.is_empty() {
        return fail("Cannot create new file - file already exists.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| crate::framed::err("internal", e.to_string(), false))?;
    let Some((content, enc)) = decode(&bytes) else {
        return fail("This file is not UTF-8 text, so Edit can't change it safely. Use Bash (e.g. sed or a script) instead.".into());
    };
    let matches = content.matches(&input.old_string).count();
    if matches == 0 {
        return fail(format!("String to replace not found in file.\nString: {}", input.old_string));
    }
    if matches > 1 && !input.replace_all {
        return fail(format!(
            "Found {matches} matches of the string to replace, but replace_all is false. To replace all occurrences, \
             set replace_all to true. To replace only one occurrence, please provide more context to uniquely \
             identify the instance."
        ));
    }
    let changed = changed_since(&rec, &path, Some(&bytes));
    let first = content.find(&input.old_string).unwrap_or(0);
    let updated = if input.replace_all {
        content.replace(&input.old_string, &input.new_string)
    } else {
        content.replacen(&input.old_string, &input.new_string, 1)
    };
    let out = encode(&updated, &enc);
    if let Err(e) = write_file(&path, &out) {
        return fail(format!("Could not write file: {e}"));
    }
    record_read(guest, agent, &path, &out);
    let mut msg = if input.replace_all && matches > 1 {
        format!("The file {} has been updated. All {matches} occurrences were replaced.", path.display())
    } else {
        format!(
            "The file {} has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n{}",
            path.display(),
            snippet(&updated, first, input.new_string.len())
        )
    };
    if changed {
        msg.push('\n');
        msg.push_str(STALE_NOTE);
    }
    Ok(text(false, msg, edit_detail(matches as u32, changed)))
}

/// `cat -n` lines around the replaced region `[start, start+len)`.
fn snippet(content: &str, start: usize, len: usize) -> String {
    let first_line = content[..start.min(content.len())].matches('\n').count();
    let end = (start + len).min(content.len());
    let last_line = content[..end].matches('\n').count();
    let lines: Vec<&str> = content.lines().collect();
    let from = first_line.saturating_sub(SNIPPET_CONTEXT);
    let to = (last_line + SNIPPET_CONTEXT + 1).min(lines.len());
    let mut out = String::new();
    for (i, l) in lines[from..to].iter().enumerate() {
        out.push_str(&format!("{:>6}\t{}\n", from + i + 1, l));
    }
    out
}

/// Write `bytes` to `path` in place, following symlinks and keeping hardlinks, owner, mode, ACLs
/// and xattrs, like Claude Code's own Write (not atomic). Missing parent directories are created.
/// Runs with the sandbox user's filesystem identity, so new files and directories belong to it.
pub fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_window() {
        let c: String = (1..=20).map(|i| format!("line{i}\n")).collect();
        let start = c.find("line10").unwrap();
        let s = snippet(&c, start, "line10".len());
        assert!(s.starts_with("     6\tline6\n"));
        assert!(s.ends_with("    14\tline14\n"));
    }

    #[test]
    fn utf16_roundtrip() {
        let b = encode("héllo", &Encoding::Utf16Le);
        let (s, e) = decode(&b).unwrap();
        assert_eq!(s, "héllo");
        assert!(matches!(e, Encoding::Utf16Le));
    }
}
