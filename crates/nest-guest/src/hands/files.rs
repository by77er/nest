//! `Write` and `Edit`, plus the per-agent read records they depend on.

use std::fs::{File, Metadata};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
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

/// Why a path can't be used as a regular file.
#[derive(Debug)]
pub enum Refusal {
    Missing,
    Directory,
    /// A FIFO, socket or device.
    NotRegular,
    Io(std::io::Error),
}

/// Open `path` for reading, or for writing (created if missing, not truncated), without ever
/// blocking: `O_NONBLOCK` makes the open of a FIFO or device return at once, the opened fd's own
/// metadata decides (no separate stat a sandbox process could race), and only a regular file is
/// handed back, blocking again.
pub fn open_regular(path: &Path, write: bool) -> Result<(File, Metadata), Refusal> {
    let mut o = std::fs::OpenOptions::new();
    if write {
        o.write(true).create(true);
    } else {
        o.read(true);
    }
    let f = o.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY).open(path).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT | libc::ENOTDIR) => Refusal::Missing,
        Some(libc::EISDIR) => Refusal::Directory,
        // A FIFO opened for writing with no reader, or a device without a driver.
        Some(libc::ENXIO) => Refusal::NotRegular,
        _ => Refusal::Io(e),
    })?;
    let m = f.metadata().map_err(Refusal::Io)?;
    if m.is_dir() {
        return Err(Refusal::Directory);
    }
    if !m.is_file() {
        return Err(Refusal::NotRegular);
    }
    nix::fcntl::fcntl(&f, nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::empty()))
        .map_err(|e| Refusal::Io(e.into()))?;
    Ok((f, m))
}

impl From<Refusal> for std::io::Error {
    fn from(r: Refusal) -> Self {
        match r {
            Refusal::Missing => std::io::ErrorKind::NotFound.into(),
            Refusal::Directory => std::io::Error::new(std::io::ErrorKind::IsADirectory, "is a directory"),
            Refusal::NotRegular => std::io::Error::other("not a regular file"),
            Refusal::Io(e) => e,
        }
    }
}

/// Remember that `agent` has fully read `path`, as `m` (its metadata before the read) with this
/// content digest. A change landing during the read then shows as a newer mtime.
pub fn record_digest(guest: &Guest, agent: &AgentId, path: &Path, m: &Metadata, sha256: [u8; 32]) {
    let rec = ReadRecord { mtime_ns: mtime_ns(m), size: m.len(), sha256 };
    if let Some(rt) = guest.inner.lock().unwrap().agents.get_mut(agent) {
        rt.reads.insert(path.to_path_buf(), rec);
    }
}

/// Remember that `agent` has fully read `path` with these contents.
pub fn record_read(guest: &Guest, agent: &AgentId, path: &Path, m: &Metadata, bytes: &[u8]) {
    record_digest(guest, agent, path, m, Sha256::digest(bytes).into());
}

/// Up to `max` bytes of a regular file (never blocking on a FIFO swapped in for it).
fn read_regular(path: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    let (f, _) = open_regular(path, false)?;
    let mut b = Vec::new();
    f.take(max).read_to_end(&mut b)?;
    Ok(b)
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
            match read_regular(path, EDIT_MAX_BYTES) {
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
            let old = read_regular(&path, EDIT_MAX_BYTES).unwrap_or_default();
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
    let written = match write_file(&path, bytes) {
        Ok(m) => m,
        Err(e) => return Ok(text(true, format!("Could not write file: {e}"), write_detail(false, 0))),
    };
    record_read(guest, agent, &path, &written, bytes);
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
    let (file, meta) = match open_regular(&path, false) {
        Ok(v) => v,
        Err(Refusal::Missing) if input.old_string.is_empty() => {
            let bytes = input.new_string.as_bytes();
            let written = match write_file(&path, bytes) {
                Ok(m) => m,
                Err(e) => return fail(format!("Could not write file: {e}")),
            };
            record_read(guest, agent, &path, &written, bytes);
            return Ok(text(false, format!("File created successfully at: {}", path.display()), edit_detail(1, false)));
        }
        Err(Refusal::Missing) => return fail("File does not exist.".into()),
        Err(Refusal::Directory) => return fail(format!("{} is a directory.", path.display())),
        Err(Refusal::NotRegular) => return fail(format!("{} is not a regular file; use Bash.", path.display())),
        Err(Refusal::Io(e)) => return fail(format!("Could not read file: {e}")),
    };
    if meta.len() > EDIT_MAX_BYTES {
        return fail(format!("File is larger than {} MB; edit it with Bash (e.g. sed) instead.", EDIT_MAX_BYTES >> 20));
    }
    let Some(rec) = read_record(guest, agent, &path) else { return fail(NOT_READ.into()) };
    if input.old_string == input.new_string {
        return fail("No changes to make: old_string and new_string are exactly the same.".into());
    }
    if input.old_string.is_empty() {
        return fail("Cannot create new file - file already exists.".into());
    }
    let mut bytes = Vec::new();
    (&file).read_to_end(&mut bytes).map_err(|e| crate::framed::err("internal", e.to_string(), false))?;
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
    let written = match write_file(&path, &out) {
        Ok(m) => m,
        Err(e) => return fail(format!("Could not write file: {e}")),
    };
    record_read(guest, agent, &path, &written, &out);
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
/// Returns the file's metadata after the write.
pub fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<Metadata> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let (mut f, _) = open_regular(path, true)?;
    f.set_len(0)?;
    f.write_all(bytes)?;
    f.sync_data()?;
    f.metadata()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B6: a FIFO (here in place of a file a tool was asked for) is refused at once, for reading
    /// and for writing; a plain `File::open` would block until a writer or reader appears.
    #[test]
    fn open_regular_refuses_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        std::fs::write(dir.path().join("file"), "x").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let d = dir.path().to_path_buf();
        std::thread::spawn(move || {
            let kind = |name: &str, write: bool| match open_regular(&d.join(name), write) {
                Ok(_) => "regular",
                Err(Refusal::Missing) => "missing",
                Err(Refusal::Directory) => "directory",
                Err(Refusal::NotRegular) => "not_regular",
                Err(Refusal::Io(_)) => "io",
            };
            let got = [kind("fifo", false), kind("fifo", true), kind("file", false), kind("file", true), kind("", false), kind("none", false)];
            let _ = tx.send(got);
        });
        let got = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("open_regular blocked");
        assert_eq!(got, ["not_regular", "not_regular", "regular", "regular", "directory", "missing"]);
    }

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
