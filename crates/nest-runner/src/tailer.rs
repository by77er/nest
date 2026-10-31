//! Tails Claude Code's native session JSONL and cuts it into session-channel segments.
//!
//! - Offsets are byte offsets in the local file; only whole lines are sent (cut at the last
//!   `\n`) so redaction never straddles a segment boundary.
//! - Redaction replaces known secrets with same-length `*` runs, preserving offsets.
//! - The file shrinking or changing inode (rewrite, `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`, path
//!   rebase) restarts from offset 0 with `base: true`.
//! - After a reconnect, AgentDO's `hello_ack.durable_bytes` rewinds the send cursor, unless a base
//!   went out that AgentDO hasn't acknowledged since: then `durable_bytes` may still describe the
//!   old file, and the base goes again.

use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Max raw bytes per segment (base64 inflates by 4/3; the channel caps messages near 64 KiB).
pub const MAX_SEGMENT: usize = 46 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub offset: u64,
    pub base: bool,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct Tailer {
    path: PathBuf,
    /// Next byte to send.
    sent: u64,
    inode: Option<u64>,
    need_base: bool,
    /// A base went out and no `segment_ack` has come since: AgentDO may not have it.
    base_unconfirmed: bool,
    secrets: Vec<String>,
}

impl Tailer {
    pub fn new(path: impl Into<PathBuf>, secrets: Vec<String>) -> Self {
        let secrets = secrets.into_iter().filter(|s| s.len() >= 8).collect();
        Self { path: path.into(), sent: 0, inode: None, need_base: false, base_unconfirmed: false, secrets }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn sent(&self) -> u64 {
        self.sent
    }

    /// Current local file length (for the session hello's `local_bytes`).
    pub fn local_bytes(&self) -> Option<u64> {
        std::fs::metadata(&self.path).ok().map(|m| m.len())
    }

    /// Follow a different file (e.g. the `transcript_path` reported by `SessionStart`).
    pub fn set_path(&mut self, path: impl Into<PathBuf>) {
        let path = path.into();
        if path != self.path {
            self.path = path;
            self.inode = None;
            self.sent = 0;
            self.need_base = true;
        }
    }

    /// AgentDO acknowledged session bytes after the last base went out, so it has that base.
    pub fn confirm(&mut self) {
        self.base_unconfirmed = false;
    }

    /// AgentDO has `durable` bytes: resend from there (after a reconnect). An unacknowledged base
    /// goes again: `durable` may be the old file's, and continuing the new file from it would
    /// splice two files into one stream.
    pub fn rewind(&mut self, durable: u64) {
        if self.base_unconfirmed {
            self.need_base = true;
            return;
        }
        match std::fs::metadata(&self.path) {
            Ok(m) if durable <= m.len() => {
                self.sent = durable;
                self.inode.get_or_insert(m.ino());
            }
            Ok(_) => self.need_base = true,
            Err(_) => self.sent = durable,
        }
    }

    /// Read whatever is new. Never errors on a missing file (Claude Code creates it lazily).
    pub fn poll(&mut self) -> io::Result<Vec<Chunk>> {
        let meta = match std::fs::metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let ino = meta.ino();
        if self.inode.is_some_and(|i| i != ino) || meta.len() < self.sent {
            self.need_base = true;
        }
        let start = if self.need_base { 0 } else { self.sent };
        if !self.need_base && meta.len() <= start {
            self.inode = Some(ino);
            return Ok(Vec::new());
        }
        let mut f = std::fs::File::open(&self.path)?;
        // Re-check the inode of what we actually opened.
        let opened_ino = f.metadata()?.ino();
        if opened_ino != ino {
            self.need_base = true;
            return Ok(Vec::new());
        }
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.take(meta.len().saturating_sub(start)).read_to_end(&mut buf)?;
        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            // A partial first line: wait for more.
            return Ok(Vec::new());
        };
        buf.truncate(last_nl + 1);
        redact(&mut buf, &self.secrets);
        let base = self.need_base;
        let chunks = split(start, base, buf);
        self.sent = start + chunks.iter().map(|c| c.data.len() as u64).sum::<u64>();
        self.inode = Some(opened_ino);
        self.base_unconfirmed |= base;
        self.need_base = false;
        Ok(chunks)
    }
}

/// Split into ≤ [`MAX_SEGMENT`] chunks, preferring line boundaries. Only the first chunk of a
/// base rewrite carries `base: true`.
fn split(start: u64, base: bool, buf: Vec<u8>) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let mut end = (pos + MAX_SEGMENT).min(buf.len());
        if end < buf.len()
            && let Some(nl) = buf[pos..end].iter().rposition(|&b| b == b'\n')
        {
            end = pos + nl + 1;
        }
        out.push(Chunk { offset: start + pos as u64, base: base && out.is_empty(), data: buf[pos..end].to_vec() });
        pos = end;
    }
    out
}

/// Replace every occurrence of each secret with `*`s of the same length.
pub fn redact(buf: &mut [u8], secrets: &[String]) {
    for s in secrets {
        let s = s.as_bytes();
        if s.is_empty() || s.len() > buf.len() {
            continue;
        }
        let mut i = 0;
        while i + s.len() <= buf.len() {
            if &buf[i..i + s.len()] == s {
                buf[i..i + s.len()].fill(b'*');
                i += s.len();
            } else {
                i += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn append(p: &Path, s: &str) {
        std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap().write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn offsets_whole_lines_and_redaction() {
        let dir = tempdir();
        let p = dir.join("s.jsonl");
        let mut t = Tailer::new(&p, vec!["sk-SECRET-123".into()]);
        assert!(t.poll().unwrap().is_empty(), "missing file is fine");
        append(&p, "{\"a\":1}\n{\"tok\":\"sk-SECRET-123\"}\n{\"partial\"");
        let c = t.poll().unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].offset, c[0].base), (0, false));
        let s = String::from_utf8(c[0].data.clone()).unwrap();
        assert!(s.ends_with("}\n") && !s.contains("SECRET") && s.contains("*************"));
        assert_eq!(t.sent(), s.len() as u64);
        append(&p, ":2}\n");
        let c = t.poll().unwrap();
        assert_eq!(c[0].offset, s.len() as u64);
        assert_eq!(c[0].data, b"{\"partial\":2}\n");
    }

    #[test]
    fn shrink_and_inode_change_reset_to_base() {
        let dir = tempdir();
        let p = dir.join("s.jsonl");
        let mut t = Tailer::new(&p, vec![]);
        append(&p, "one\ntwo\n");
        t.poll().unwrap();
        // Rewrite in place, smaller.
        std::fs::write(&p, "x\n").unwrap();
        let c = t.poll().unwrap();
        assert_eq!((c[0].offset, c[0].base, c[0].data.as_slice()), (0, true, &b"x\n"[..]));
        // Replace with a new inode, larger.
        let tmp = dir.join("tmp");
        std::fs::write(&tmp, "a\nb\nc\nd\n").unwrap();
        std::fs::rename(&tmp, &p).unwrap();
        let c = t.poll().unwrap();
        assert!(c[0].base && c[0].offset == 0 && c[0].data == b"a\nb\nc\nd\n");
        assert!(t.poll().unwrap().is_empty());
    }

    #[test]
    fn rewind_resends_from_durable() {
        let dir = tempdir();
        let p = dir.join("s.jsonl");
        let mut t = Tailer::new(&p, vec![]);
        append(&p, "l1\nl2\nl3\n");
        t.poll().unwrap();
        t.rewind(3);
        let c = t.poll().unwrap();
        assert_eq!((c[0].offset, c[0].data.as_slice()), (3, &b"l2\nl3\n"[..]));
    }

    /// R7: a base lost with its connection is sent again after the reconnect, even when the new
    /// file is longer than what AgentDO holds of the old one. Before, the tailer had moved to the
    /// new file, rewound to the old file's durable offset and sent the new file's tail as if it
    /// continued the old one.
    #[test]
    fn an_unacknowledged_base_goes_again_after_a_reconnect() {
        let dir = tempdir();
        let p = dir.join("s.jsonl");
        let mut t = Tailer::new(&p, vec![]);
        append(&p, "old-1\nold-2\n");
        t.poll().unwrap();
        t.confirm();
        let tmp = dir.join("tmp");
        std::fs::write(&tmp, "new-1\nnew-2\nnew-3\n").unwrap();
        std::fs::rename(&tmp, &p).unwrap();
        assert!(t.poll().unwrap()[0].base, "the rewrite goes as a base");
        // The connection broke with the base unacknowledged; AgentDO still holds the old file.
        t.rewind(12);
        let c = t.poll().unwrap();
        assert_eq!((c[0].offset, c[0].base, c[0].data.as_slice()), (0, true, &b"new-1\nnew-2\nnew-3\n"[..]));
        // Once acknowledged, a reconnect resumes from AgentDO's offset.
        t.confirm();
        t.rewind(6);
        let c = t.poll().unwrap();
        assert_eq!((c[0].offset, c[0].base), (6, false));
    }

    #[test]
    fn large_appends_split_on_lines() {
        let dir = tempdir();
        let p = dir.join("s.jsonl");
        let line = format!("{}\n", "y".repeat(1000));
        append(&p, &line.repeat(100));
        let mut t = Tailer::new(&p, vec![]);
        let c = t.poll().unwrap();
        assert!(c.len() >= 3);
        let mut expect = 0u64;
        for ch in &c {
            assert_eq!(ch.offset, expect);
            assert!(ch.data.len() <= MAX_SEGMENT && ch.data.ends_with(b"\n"));
            expect += ch.data.len() as u64;
        }
        assert_eq!(expect, 100_100);
    }

    #[test]
    fn set_path_rebases() {
        let dir = tempdir();
        let a = dir.join("a.jsonl");
        let b = dir.join("b.jsonl");
        append(&a, "a\n");
        append(&b, "b1\nb2\n");
        let mut t = Tailer::new(&a, vec![]);
        t.poll().unwrap();
        t.set_path(&b);
        let c = t.poll().unwrap();
        assert!(c[0].base && c[0].data == b"b1\nb2\n");
    }

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nest-tailer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
