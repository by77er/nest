//! `Read`: text (cat -n), images, PDFs, notebooks; records full reads for Write/Edit.
//!
//! Bounded: only regular files are read (FIFOs and devices could block forever), whole-file reads
//! check the size first, `offset`/`limit` reads stream with a scan cap and honor cancellation, and
//! helpers (pdftotext, vips, convert) run as the sandbox user with a deadline and an output cap.

use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use nest_protocol::guest::{HandsDetail, HandsResult, ReadInput, ToolContent};
use nest_protocol::model::{AgentId, ErrorBody};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{require_absolute, text};
use crate::exec::{PreExec, agent_env, run_helper, which};
use crate::hands::files::{Refusal, open_regular, record_digest, record_read};
use crate::state::Guest;

pub const DEFAULT_LIMIT: u64 = 2000;
pub const MAX_LINE_CHARS: usize = 2000;
pub const WHOLE_FILE_MAX_BYTES: u64 = 256 * 1024;
pub const MAX_OUTPUT_CHARS: usize = 100_000;
pub const MAX_IMAGE_BYTES: u64 = 3_932_160; // 3.75 MiB
pub const MAX_PDF_PAGES: u32 = 20;
/// `offset`/`limit` reads stop counting lines after scanning this much.
pub const MAX_SCAN_BYTES: u64 = 1024 * 1024 * 1024;
/// Bytes of one line kept in memory (the shown part is cut at [`MAX_LINE_CHARS`] anyway).
const MAX_LINE_BYTES: usize = 64 * 1024;
const HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const PDF_TEXT_CAP: usize = 8 * 1024 * 1024;

fn detail(kind: &str, total_lines: u64, partial: bool) -> HandsDetail {
    HandsDetail::Read { file_kind: kind.into(), total_lines, partial }
}

fn fail(msg: impl Into<String>) -> Result<HandsResult, ErrorBody> {
    Ok(text(true, msg, detail("text", 0, false)))
}

fn interrupted() -> Result<HandsResult, ErrorBody> {
    Ok(text(true, "[Interrupted]", detail("text", 0, true)))
}

pub fn run(guest: &Guest, agent: &AgentId, input: ReadInput, cancel: &CancellationToken) -> Result<HandsResult, ErrorBody> {
    let path = require_absolute(&input.file_path)?;
    let (mut file, meta) = match open_regular(&path, false) {
        Ok(v) => v,
        Err(Refusal::Missing) => return fail("File does not exist."),
        Err(Refusal::Directory) => {
            return fail(format!("{} is a directory, not a file. Use Glob or `ls` via Bash to list it.", path.display()));
        }
        Err(Refusal::NotRegular) => {
            return fail(format!(
                "{} is not a regular file (FIFO, socket or device), so Read could block forever. Use Bash (e.g. `head -c`) instead.",
                path.display()
            ));
        }
        Err(Refusal::Io(e)) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return fail(format!("Permission denied: {}", path.display()));
        }
        Err(Refusal::Io(e)) => return fail(format!("Could not read file: {e}")),
    };
    let mut head = [0u8; 16];
    let n = match file.read(&mut head).and_then(|n| file.rewind().map(|_| n)) {
        Ok(n) => n,
        Err(e) => return fail(format!("Could not read file: {e}")),
    };
    let head = &head[..n];
    if let Some(mime) = image_type(head) {
        return read_image(guest, agent, &path, file, &meta, mime);
    }
    if head.starts_with(b"%PDF-") {
        return read_pdf(guest, agent, &path, input.pages.as_deref());
    }
    if path.extension().and_then(|e| e.to_str()) == Some("ipynb") {
        return read_notebook(guest, agent, &path, file, &meta);
    }
    if input.offset.is_none() && input.limit.is_none() {
        if meta.len() > WHOLE_FILE_MAX_BYTES {
            return fail(format!(
                "File content ({} KB) exceeds maximum allowed size ({} KB). Use offset and limit to read specific \
                 portions of the file, or use Grep to search for specific content.",
                meta.len() / 1024,
                WHOLE_FILE_MAX_BYTES / 1024
            ));
        }
        if meta.len() == 0 {
            record_read(guest, agent, &path, &meta, &[]);
            return Ok(text(false, "Warning: the file exists but is empty.", detail("empty", 0, false)));
        }
    }
    read_text(guest, agent, &path, file, &meta, input.offset, input.limit, cancel)
}

/// Read one line (including its `\n`) keeping at most `cap` bytes of it in `out`. Returns the
/// number of bytes consumed (0 at EOF).
fn read_line_capped<R: BufRead>(r: &mut R, out: &mut Vec<u8>, cap: usize, hasher: &mut Sha256) -> std::io::Result<usize> {
    let mut consumed = 0;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(consumed);
        }
        let (take, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        hasher.update(&buf[..take]);
        if out.len() < cap {
            let keep = (cap - out.len()).min(take);
            out.extend_from_slice(&buf[..keep]);
        }
        r.consume(take);
        consumed += take;
        if done {
            return Ok(consumed);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn read_text(
    guest: &Guest,
    agent: &AgentId,
    path: &Path,
    file: File,
    meta: &Metadata,
    offset: Option<u64>,
    limit: Option<u64>,
    cancel: &CancellationToken,
) -> Result<HandsResult, ErrorBody> {
    let start = offset.unwrap_or(1).max(1);
    let count = limit.unwrap_or(DEFAULT_LIMIT).max(1);
    let end = start.saturating_add(count - 1);
    let mut r = BufReader::with_capacity(256 * 1024, file);
    let mut hasher = Sha256::new();
    let mut line = Vec::new();
    let (mut total, mut scanned) = (0u64, 0u64);
    let mut complete = true;
    let mut out = String::new();
    let mut out_chars = 0usize;
    loop {
        line.clear();
        let n = match read_line_capped(&mut r, &mut line, MAX_LINE_BYTES, &mut hasher) {
            Ok(n) => n,
            Err(e) => return fail(format!("Could not read file: {e}")),
        };
        if n == 0 {
            break;
        }
        total += 1;
        scanned += n as u64;
        if total >= start && total <= end {
            let s = String::from_utf8_lossy(&line);
            let s = s.trim_end_matches('\n').trim_end_matches('\r');
            let shown: String = if s.chars().count() > MAX_LINE_CHARS {
                format!("{}... [truncated]", s.chars().take(MAX_LINE_CHARS).collect::<String>())
            } else {
                s.to_string()
            };
            let l = format!("{total:>6}\t{shown}\n");
            out_chars += l.chars().count();
            if out_chars > MAX_OUTPUT_CHARS {
                return fail(format!(
                    "The requested range (over {MAX_OUTPUT_CHARS} characters) exceeds the maximum output size. Read \
                     fewer lines with offset and limit, or use Grep."
                ));
            }
            out.push_str(&l);
        }
        if total % 4096 == 0 && cancel.is_cancelled() {
            return interrupted();
        }
        if scanned > MAX_SCAN_BYTES {
            complete = false;
            break;
        }
    }
    if total == 0 {
        record_read(guest, agent, path, meta, &[]);
        return Ok(text(false, "Warning: the file exists but is empty.", detail("empty", 0, false)));
    }
    let total_note = if complete { total.to_string() } else { format!("at least {total}") };
    if start > total {
        return Ok(text(
            false,
            format!("Warning: the file has only {total_note} lines, but offset {start} was requested."),
            detail("text", total, true),
        ));
    }
    let shown_end = end.min(total);
    let partial = start > 1 || shown_end < total || !complete;
    if limit.is_none() && (shown_end < total || !complete) {
        out.push_str(&format!(
            "\n[PARTIAL view: showing lines {start}-{shown_end} of {total_note}. Use offset and limit to read the rest.]\n"
        ));
    }
    if !partial {
        record_digest(guest, agent, path, meta, hasher.finalize().into());
    }
    Ok(text(false, out, detail("text", total, partial)))
}

/// Media type from magic bytes.
pub fn image_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Environment and pre-exec settings for a helper run on the agent's behalf.
fn helper_ctx(guest: &Guest, agent: &AgentId) -> (Vec<(String, String)>, PreExec) {
    let env = guest
        .inner
        .lock()
        .unwrap()
        .agents
        .get(agent)
        .map(|rt| agent_env(&rt.slot, guest.config.run_as))
        .unwrap_or_else(|| crate::exec::base_env(guest.config.run_as));
    let cgroup = guest.cgroups.leaf(&agent.0, "calls", &format!("helper-{}", crate::state::random_hex(4)));
    (env, PreExec { new_pgrp: true, cgroup, fd3: None, run_as: guest.config.run_as })
}

fn cleanup(pre: &PreExec) {
    if let Some(cg) = &pre.cgroup {
        crate::cgroup::Cgroups::kill(cg);
        let _ = std::fs::remove_dir(cg);
    }
}

fn hash_file(mut f: &File) -> std::io::Result<[u8; 32]> {
    f.rewind()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(h.finalize().into());
        }
        h.update(&buf[..n]);
    }
}

fn read_image(guest: &Guest, agent: &AgentId, path: &Path, file: File, meta: &Metadata, mime: &str) -> Result<HandsResult, ErrorBody> {
    let size = meta.len();
    let (data, mime) = if size > MAX_IMAGE_BYTES {
        match shrink_image(guest, agent, path, &file) {
            Some(j) => (j, "image/jpeg"),
            None => {
                return fail(format!(
                    "Image is {} KB, over the {} KB limit, and no image tool (vips/convert) could shrink it. \
                     Crop or resize it with Bash first.",
                    size / 1024,
                    MAX_IMAGE_BYTES / 1024
                ));
            }
        }
    } else {
        let mut bytes = Vec::with_capacity(size as usize);
        if let Err(e) = (&file).take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes) {
            return fail(format!("Could not read file: {e}"));
        }
        (bytes, mime)
    };
    if let Ok(d) = hash_file(&file) {
        record_digest(guest, agent, path, meta, d);
    }
    Ok(HandsResult {
        is_error: false,
        content: vec![ToolContent::Image {
            media_type: mime.into(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(&data),
        }],
        detail: detail("image", 0, false),
    })
}

fn shrink_image(guest: &Guest, agent: &AgentId, path: &Path, file: &File) -> Option<Vec<u8>> {
    let (env, pre) = helper_ctx(guest, agent);
    let p = path.to_string_lossy().into_owned();
    let out = if which("vips").is_some() {
        run_helper(
            &["vips", "thumbnail_source", "[descriptor=0]", ".jpg[Q=80]", "2000"],
            Some(file.try_clone().ok()?),
            env,
            pre.clone(),
            HELPER_TIMEOUT,
            MAX_IMAGE_BYTES as usize,
        )
    } else if which("convert").is_some() {
        run_helper(
            &["convert", &p, "-resize", "2000x2000>", "-quality", "80", "jpeg:-"],
            None,
            env,
            pre.clone(),
            HELPER_TIMEOUT,
            MAX_IMAGE_BYTES as usize,
        )
    } else {
        cleanup(&pre);
        return None;
    };
    cleanup(&pre);
    let out = out.ok()?;
    out.success.then_some(out.stdout)
}

fn read_pdf(guest: &Guest, agent: &AgentId, path: &Path, pages: Option<&str>) -> Result<HandsResult, ErrorBody> {
    let pdf_detail = |partial| detail("pdf", 0, partial);
    if which("pdftotext").is_none() {
        return Ok(text(true, "PDF support is not available in this sandbox (pdftotext is missing).", pdf_detail(false)));
    }
    let (first, last, partial) = match pages {
        Some(r) => match parse_pages(r) {
            Some((a, b)) if b >= a && b - a < MAX_PDF_PAGES => (a, b, true),
            _ => {
                return Ok(text(
                    true,
                    format!("Invalid pages {r:?}: use \"N\" or \"N-M\" with at most {MAX_PDF_PAGES} pages."),
                    pdf_detail(false),
                ));
            }
        },
        None => {
            let n = pdf_page_count(guest, agent, path).unwrap_or(u32::MAX);
            if n > 10 {
                return Ok(text(
                    true,
                    "This PDF has more than 10 pages. Pass `pages` (e.g. \"1-5\", at most 20 per call).",
                    pdf_detail(false),
                ));
            }
            (1, n.max(1), false)
        }
    };
    let (env, pre) = helper_ctx(guest, agent);
    let p = path.to_string_lossy().into_owned();
    let (f, l) = (first.to_string(), last.to_string());
    let out = run_helper(&["pdftotext", "-layout", "-f", &f, "-l", &l, &p, "-"], None, env, pre.clone(), HELPER_TIMEOUT, PDF_TEXT_CAP);
    cleanup(&pre);
    match out {
        Ok(o) if o.success => Ok(text(false, String::from_utf8_lossy(&o.stdout), pdf_detail(partial))),
        Ok(o) if o.cut_off => Ok(text(true, "pdftotext took too long or produced too much text; request fewer pages.", pdf_detail(partial))),
        Ok(o) => Ok(text(true, format!("pdftotext failed: {}", o.stderr), pdf_detail(partial))),
        Err(e) => Ok(text(true, format!("pdftotext failed: {e}"), pdf_detail(partial))),
    }
}

fn parse_pages(r: &str) -> Option<(u32, u32)> {
    match r.split_once('-') {
        Some((a, b)) => Some((a.trim().parse().ok()?, b.trim().parse().ok()?)),
        None => {
            let n = r.trim().parse().ok()?;
            Some((n, n))
        }
    }
}

fn pdf_page_count(guest: &Guest, agent: &AgentId, path: &Path) -> Option<u32> {
    let (env, pre) = helper_ctx(guest, agent);
    let p = path.to_string_lossy().into_owned();
    let o = run_helper(&["pdfinfo", &p], None, env, pre.clone(), HELPER_TIMEOUT, 64 * 1024);
    cleanup(&pre);
    String::from_utf8_lossy(&o.ok()?.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("Pages:").and_then(|v| v.trim().parse().ok()))
}

fn read_notebook(guest: &Guest, agent: &AgentId, path: &Path, file: File, meta: &Metadata) -> Result<HandsResult, ErrorBody> {
    if meta.len() > WHOLE_FILE_MAX_BYTES {
        return fail("Notebook exceeds 256 KB. Use Bash (e.g. jq) to extract specific cells.");
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    if let Err(e) = file.take(WHOLE_FILE_MAX_BYTES + 1).read_to_end(&mut bytes) {
        return fail(format!("Could not read file: {e}"));
    }
    let nb: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return fail(format!("Invalid notebook JSON: {e}")),
    };
    let join = |v: &serde_json::Value| match v {
        serde_json::Value::Array(a) => a.iter().filter_map(|s| s.as_str()).collect::<String>(),
        serde_json::Value::String(s) => s.clone(),
        _ => String::new(),
    };
    let mut out = String::new();
    let cells = nb["cells"].as_array().cloned().unwrap_or_default();
    for (i, cell) in cells.iter().enumerate() {
        let kind = cell["cell_type"].as_str().unwrap_or("code");
        out.push_str(&format!("--- cell {} [{kind}] ---\n{}\n", i + 1, join(&cell["source"])));
        for o in cell["outputs"].as_array().into_iter().flatten() {
            let t = if o.get("text").is_some() { join(&o["text"]) } else { join(&o["data"]["text/plain"]) };
            if !t.is_empty() {
                out.push_str(&format!("[output]\n{t}\n"));
            }
        }
    }
    record_read(guest, agent, path, meta, &bytes);
    Ok(text(false, out, detail("notebook", cells.len() as u64, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_lines_hash_everything() {
        let data = format!("{}\nshort\n", "x".repeat(100));
        let mut r = BufReader::with_capacity(16, data.as_bytes());
        let mut h = Sha256::new();
        let mut line = Vec::new();
        let n = read_line_capped(&mut r, &mut line, 10, &mut h).unwrap();
        assert_eq!((n, line.len()), (101, 10));
        line.clear();
        assert_eq!(read_line_capped(&mut r, &mut line, 10, &mut h).unwrap(), 6);
        assert_eq!(line, b"short\n");
        line.clear();
        assert_eq!(read_line_capped(&mut r, &mut line, 10, &mut h).unwrap(), 0);
        let whole: [u8; 32] = Sha256::digest(data.as_bytes()).into();
        assert_eq!(<[u8; 32]>::from(h.finalize()), whole);
    }
}
