//! Small shared helpers.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Wall clock in Unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Normalize a hostname for comparisons: lowercase, no trailing dot, no port.
pub fn norm_host(host: &str) -> String {
    let h = strip_port(host);
    h.trim_end_matches('.').to_ascii_lowercase()
}

/// `host:port` / `[v6]:port` / `host` → host.
pub fn strip_port(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match authority.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => authority,
    }
}

/// Split `host:port`, defaulting the port.
pub fn split_authority(authority: &str, default_port: u16) -> (String, u16) {
    let host = strip_port(authority).to_string();
    let port = authority
        .rsplit_once(':')
        .filter(|(h, _)| !h.contains(':') || h.ends_with(']'))
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(default_port);
    (host, port)
}

/// Is `host` (already normalized: lowercase, no port, no trailing dot) a plausible DNS name or
/// IP literal? Guest-controlled names are validated before they reach policy, upstream
/// resolution, audit or events, which also bounds their length.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    host.split('.').all(|l| {
        !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

/// Truncate a guest-influenced string to at most `max` bytes (on a char boundary), marking it.
pub fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(3);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

/// In-place clip for owned strings.
pub fn clip_in_place(s: &mut String, max: usize) {
    if s.len() > max {
        *s = clip(s, max);
    }
}

/// Replace every occurrence of each needle in `hay` with `*` of the same length. Length-preserving
/// so `Content-Length` stays valid. Returns true if anything changed.
pub fn mask_all(hay: &mut [u8], needles: &[Vec<u8>]) -> bool {
    let mut changed = false;
    for n in needles {
        if n.is_empty() || n.len() > hay.len() {
            continue;
        }
        let mut i = 0;
        while i + n.len() <= hay.len() {
            if &hay[i..i + n.len()] == n.as_slice() {
                hay[i..i + n.len()].fill(b'*');
                changed = true;
                i += n.len();
            } else {
                i += 1;
            }
        }
    }
    changed
}

/// A stream that first replays bytes already read (e.g. a peeked ClientHello).
pub struct Prefixed<S> {
    prefix: Bytes,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: impl Into<Bytes>, inner: S) -> Self {
        Prefixed { prefix: prefix.into(), inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let n = self.prefix.len().min(buf.remaining());
            let chunk = self.prefix.split_to(n);
            buf.put_slice(&chunk);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_parsing() {
        assert_eq!(strip_port("github.com:443"), "github.com");
        assert_eq!(strip_port("github.com"), "github.com");
        assert_eq!(strip_port("[::1]:8080"), "::1");
        assert_eq!(norm_host("GitHub.COM.:443"), "github.com");
        assert_eq!(split_authority("example.com:8443", 443), ("example.com".into(), 8443));
        assert_eq!(split_authority("example.com", 80), ("example.com".into(), 80));
        assert_eq!(split_authority("[::1]:22", 80), ("::1".into(), 22));
    }

    #[test]
    fn host_validation_and_clipping() {
        assert!(valid_host("api.github.com"));
        assert!(valid_host("_dmarc.example.com"));
        assert!(valid_host("10.0.0.1") && valid_host("::1"));
        assert!(!valid_host(""));
        assert!(!valid_host(&"a".repeat(300)));
        assert!(!valid_host("a..b"));
        assert!(!valid_host("evil.test/x"));
        assert!(!valid_host("a b"));
        assert_eq!(clip("héllo world", 6), "hé...");
        assert_eq!(clip("short", 10), "short");
        let mut s = "x".repeat(100);
        clip_in_place(&mut s, 10);
        assert_eq!(s.len(), 10);
    }

    #[test]
    fn masking_preserves_length() {
        let mut b = b"token=SECRET; again SECRET".to_vec();
        assert!(mask_all(&mut b, &[b"SECRET".to_vec()]));
        assert_eq!(b, b"token=******; again ******".to_vec());
        let mut b = b"nothing here".to_vec();
        assert!(!mask_all(&mut b, &[b"SECRET".to_vec(), Vec::new()]));
    }

    #[tokio::test]
    async fn prefixed_replays_then_reads() {
        use tokio::io::AsyncReadExt;
        let (mut a, b) = tokio::io::duplex(64);
        tokio::io::AsyncWriteExt::write_all(&mut a, b"world").await.unwrap();
        drop(a);
        let mut p = Prefixed::new(Bytes::from_static(b"hello "), b);
        let mut s = String::new();
        p.read_to_string(&mut s).await.unwrap();
        assert_eq!(s, "hello world");
    }
}
