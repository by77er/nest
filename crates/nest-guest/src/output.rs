//! Combined stdout/stderr capture into an output file, capped at 64 MiB (truncated beyond), with
//! a kill switch when a command produces more than 5 GB.

use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::pipe;
use tokio::sync::watch;

pub const FILE_CAP: u64 = 64 * 1024 * 1024;
/// Foreground call outputs kept per agent (newest first), and their total size budget. Output
/// files live on tmpfs, i.e. in guest RAM.
pub const KEEP_CALL_OUTPUTS: usize = 64;
pub const CALL_OUTPUT_BUDGET: u64 = 256 * 1024 * 1024;
/// Finished background tasks (and their outputs) kept per agent.
pub const KEEP_FINISHED_TASKS: usize = 32;
pub const KILL_AFTER: u64 = 5 * 1024 * 1024 * 1024;

pub struct OutputSink {
    pub path: PathBuf,
    /// Bytes produced so far (including bytes past the file cap).
    pub total: Arc<AtomicU64>,
    eof: watch::Receiver<bool>,
}

impl OutputSink {
    /// Copy `read` (the read end of the child's stdout/stderr pipe) into `path`.
    pub fn capture(read: OwnedFd, path: &Path, on_overflow: Box<dyn Fn() + Send>) -> io::Result<OutputSink> {
        let mut rx = pipe::Receiver::from_owned_fd(read)?;
        let file = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
        let mut file = tokio::fs::File::from_std(file);
        let total = Arc::new(AtomicU64::new(0));
        let (eof_tx, eof) = watch::channel(false);
        let t = total.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            let mut written = 0u64;
            let mut killed = false;
            loop {
                let n = match rx.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let before = t.fetch_add(n as u64, Ordering::Relaxed);
                if written < FILE_CAP {
                    let take = (FILE_CAP - written).min(n as u64) as usize;
                    if file.write_all(&buf[..take]).await.is_ok() {
                        written += take as u64;
                    }
                }
                if !killed && before + n as u64 > KILL_AFTER {
                    killed = true;
                    on_overflow();
                }
            }
            let _ = file.flush().await;
            let _ = eof_tx.send(true);
        });
        Ok(OutputSink { path: path.to_path_buf(), total, eof })
    }

    /// Wait for the pipe to close (all writers gone), at most `max`. Returns true on EOF.
    pub async fn wait_eof(&self, max: Duration) -> bool {
        let mut rx = self.eof.clone();
        if *rx.borrow() {
            return true;
        }
        tokio::time::timeout(max, rx.wait_for(|v| *v)).await.is_ok()
    }

    pub fn total(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }
}

/// A command's captured output as shown to the model: the whole file when it's small, otherwise
/// its first and last [`VIEW_HALF`] bytes around a marker (never the whole 64 MiB in memory).
#[derive(Default)]
pub struct OutputView {
    pub text: String,
    pub total_bytes: u64,
    pub complete: bool,
}

pub const VIEW_HALF: u64 = 512 * 1024;

pub fn read_output(path: &Path) -> OutputView {
    use std::io::{Read, Seek, SeekFrom};
    let total_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let Ok(mut f) = std::fs::File::open(path) else { return OutputView { text: String::new(), total_bytes: 0, complete: true } };
    if total_bytes <= 2 * VIEW_HALF {
        let mut b = Vec::with_capacity(total_bytes as usize);
        let _ = f.take(2 * VIEW_HALF).read_to_end(&mut b);
        return OutputView { text: String::from_utf8_lossy(&b).into_owned(), total_bytes, complete: true };
    }
    let mut head = Vec::new();
    let _ = (&mut f).take(VIEW_HALF).read_to_end(&mut head);
    let mut tail = Vec::new();
    if f.seek(SeekFrom::End(-(VIEW_HALF as i64))).is_ok() {
        let _ = f.take(VIEW_HALF).read_to_end(&mut tail);
    }
    let text = format!(
        "{}\n... [{} bytes omitted] ...\n{}",
        String::from_utf8_lossy(&head),
        total_bytes - 2 * VIEW_HALF,
        String::from_utf8_lossy(&tail)
    );
    OutputView { text, total_bytes, complete: false }
}

/// Last `max_chars` characters of a file (reads at most `4 * max_chars` bytes).
pub fn tail_chars(path: &Path, max_chars: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let want = (4 * max_chars as u64).min(len);
    if f.seek(SeekFrom::Start(len - want)).is_err() {
        return String::new();
    }
    let mut b = Vec::with_capacity(want as usize);
    let _ = f.take(want).read_to_end(&mut b);
    let s = String::from_utf8_lossy(&b);
    let n = s.chars().count();
    if n <= max_chars { s.into_owned() } else { s.chars().skip(n - max_chars).collect() }
}

/// Delete the oldest `*.out` files in `dir` beyond `keep` files or `budget` bytes, never `protect`.
pub fn prune_dir(dir: &Path, keep: usize, budget: u64, protect: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "out"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    let mut used = 0u64;
    for (i, (_, len, path)) in files.into_iter().enumerate() {
        used += len;
        if path != protect && (i >= keep || used > budget) {
            let _ = std::fs::remove_file(&path);
        }
    }
}
