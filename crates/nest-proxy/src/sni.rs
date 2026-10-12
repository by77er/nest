//! Minimal TLS ClientHello parser: just enough to route a connection (SNI + ALPN) before
//! deciding whether to terminate TLS, splice it, or refuse.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

/// Largest ClientHello we buffer before giving up (post-quantum key shares make these big).
pub const MAX_CLIENT_HELLO: usize = 64 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientHelloInfo {
    pub sni: Option<String>,
    pub alpn: Vec<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parse {
    NeedMore,
    NotTls,
    Invalid,
    Hello(ClientHelloInfo),
}

/// Parse a (possibly fragmented) ClientHello from the start of a TLS stream.
pub fn parse_client_hello(buf: &[u8]) -> Parse {
    if buf.is_empty() {
        return Parse::NeedMore;
    }
    if buf[0] != 0x16 {
        return Parse::NotTls;
    }
    // Reassemble handshake bytes from consecutive handshake records.
    let mut hs = Vec::new();
    let mut pos = 0;
    loop {
        if buf.len() < pos + 5 {
            return Parse::NeedMore;
        }
        if buf[pos] != 0x16 {
            return Parse::Invalid;
        }
        let len = u16::from_be_bytes([buf[pos + 3], buf[pos + 4]]) as usize;
        if len == 0 || len > 1 << 14 {
            return Parse::Invalid;
        }
        if buf.len() < pos + 5 + len {
            return Parse::NeedMore;
        }
        hs.extend_from_slice(&buf[pos + 5..pos + 5 + len]);
        pos += 5 + len;
        if hs.len() >= 4 {
            if hs[0] != 0x01 {
                return Parse::Invalid;
            }
            let body_len = ((hs[1] as usize) << 16) | ((hs[2] as usize) << 8) | hs[3] as usize;
            if body_len > MAX_CLIENT_HELLO {
                return Parse::Invalid;
            }
            if hs.len() >= 4 + body_len {
                return match parse_body(&hs[4..4 + body_len]) {
                    Some(info) => Parse::Hello(info),
                    None => Parse::Invalid,
                };
            }
        }
    }
}

struct Reader<'a> {
    b: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.b.len() < n {
            return None;
        }
        let (h, t) = self.b.split_at(n);
        self.b = t;
        Some(h)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    fn vec8(&mut self) -> Option<&'a [u8]> {
        let n = self.u8()? as usize;
        self.take(n)
    }
    fn vec16(&mut self) -> Option<&'a [u8]> {
        let n = self.u16()? as usize;
        self.take(n)
    }
}

fn parse_body(body: &[u8]) -> Option<ClientHelloInfo> {
    let mut r = Reader { b: body };
    r.take(2)?; // legacy_version
    r.take(32)?; // random
    r.vec8()?; // session id
    r.vec16()?; // cipher suites
    r.vec8()?; // compression
    let mut info = ClientHelloInfo::default();
    if r.b.is_empty() {
        return Some(info);
    }
    let mut exts = Reader { b: r.vec16()? };
    while !exts.b.is_empty() {
        let ty = exts.u16()?;
        let mut data = Reader { b: exts.vec16()? };
        match ty {
            0 => {
                let mut list = Reader { b: data.vec16()? };
                while !list.b.is_empty() {
                    let name_type = list.u8()?;
                    let name = list.vec16()?;
                    if name_type == 0 && info.sni.is_none() {
                        let s = std::str::from_utf8(name).ok()?;
                        info.sni = Some(s.trim_end_matches('.').to_ascii_lowercase());
                    }
                }
            }
            16 => {
                let mut list = Reader { b: data.vec16()? };
                while !list.b.is_empty() {
                    info.alpn.push(list.vec8()?.to_vec());
                }
            }
            _ => {}
        }
    }
    Some(info)
}

/// Read from `s` until a full ClientHello has arrived. Returns everything read (to replay into
/// the TLS acceptor or upstream) and the parsed info; `None` info means the stream isn't TLS.
pub async fn read_client_hello<S: AsyncRead + Unpin>(
    s: &mut S,
    timeout: Duration,
) -> io::Result<(Vec<u8>, Option<ClientHelloInfo>)> {
    let mut buf = Vec::with_capacity(2048);
    let fut = async {
        loop {
            match parse_client_hello(&buf) {
                Parse::Hello(info) => return Ok(Some(info)),
                Parse::NotTls => return Ok(None),
                Parse::Invalid => return Err(io::Error::new(io::ErrorKind::InvalidData, "malformed ClientHello")),
                Parse::NeedMore => {}
            }
            if buf.len() >= MAX_CLIENT_HELLO + 5 * 8 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "ClientHello too large"));
            }
            let mut chunk = [0u8; 4096];
            let n = s.read(&mut chunk).await?;
            if n == 0 {
                return if buf.is_empty() {
                    Err(io::ErrorKind::UnexpectedEof.into())
                } else {
                    Err(io::Error::new(io::ErrorKind::UnexpectedEof, "eof inside ClientHello"))
                };
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    };
    let info = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "ClientHello timeout"))??;
    Ok((buf, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Produce a real ClientHello from rustls.
    fn client_hello(sni: &str, alpn: &[&[u8]]) -> Vec<u8> {
        let roots = rustls::RootCertStore::empty();
        let mut cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        cfg.alpn_protocols = alpn.iter().map(|a| a.to_vec()).collect();
        let name = rustls_pki_types::ServerName::try_from(sni.to_string()).unwrap();
        let mut conn = rustls::ClientConnection::new(Arc::new(cfg), name).unwrap();
        let mut out = Vec::new();
        conn.write_tls(&mut out).unwrap();
        out
    }

    #[test]
    fn parses_sni_and_alpn() {
        let hello = client_hello("API.GitHub.com", &[b"h2", b"http/1.1"]);
        match parse_client_hello(&hello) {
            Parse::Hello(info) => {
                assert_eq!(info.sni.as_deref(), Some("api.github.com"));
                assert_eq!(info.alpn, vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn incremental_and_fragmented() {
        let hello = client_hello("example.com", &[]);
        for cut in [0, 1, 4, 5, 20, hello.len() - 1] {
            assert_eq!(parse_client_hello(&hello[..cut]), Parse::NeedMore, "cut {cut}");
        }
        // Re-fragment the handshake into two records.
        let hs = &hello[5..];
        let (a, b) = hs.split_at(hs.len() / 2);
        let mut frag = Vec::new();
        for part in [a, b] {
            frag.extend_from_slice(&[0x16, 0x03, 0x01]);
            frag.extend_from_slice(&(part.len() as u16).to_be_bytes());
            frag.extend_from_slice(part);
        }
        assert!(matches!(parse_client_hello(&frag), Parse::Hello(i) if i.sni.as_deref() == Some("example.com")));
    }

    #[test]
    fn not_tls_and_garbage() {
        assert_eq!(parse_client_hello(b"GET / HTTP/1.1\r\n"), Parse::NotTls);
        assert_eq!(parse_client_hello(&[0x16, 3, 1, 0, 4, 2, 0, 0, 0]), Parse::Invalid);
    }

    #[tokio::test]
    async fn reads_from_stream() {
        let hello = client_hello("x.test", &[b"http/1.1"]);
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        let h2 = hello.clone();
        tokio::spawn(async move {
            for c in h2.chunks(100) {
                tokio::io::AsyncWriteExt::write_all(&mut a, c).await.unwrap();
            }
        });
        let (raw, info) = read_client_hello(&mut b, Duration::from_secs(5)).await.unwrap();
        assert_eq!(raw, hello);
        assert_eq!(info.unwrap().sni.as_deref(), Some("x.test"));
    }
}
