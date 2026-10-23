//! Async helpers for the two frame formats the runner speaks:
//! - host-internal frames (`nest_protocol::host::frame`): `[u32 BE len][JSON]`;
//! - guest frames (`nest_protocol::guest::frame`): `[u32 BE len][u8 kind][payload]`, which the
//!   runner itself no longer reads from a socket (hands go through `nest-hands-client`); the
//!   helpers serve the test double in `test_support`.

use std::io;

use nest_protocol::guest::frame::{Frame, Kind, MAX_FRAME_LEN};
use nest_protocol::host::frame::MAX_FRAME;
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// Write one host-internal frame.
pub async fn write_host<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let bytes = nest_protocol::host::frame::encode(msg)?;
    w.write_all(&bytes).await?;
    w.flush().await
}

/// Read one host-internal frame without decoding it. `Ok(None)` on clean EOF.
pub async fn read_host_raw<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Read one host-internal frame. `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_host<R: AsyncRead + Unpin, T: DeserializeOwned>(r: &mut R) -> io::Result<Option<T>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write one guest JSON frame.
pub async fn write_guest_json<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let bytes = nest_protocol::guest::frame::encode_json(msg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    w.write_all(&bytes).await?;
    w.flush().await
}

/// Read one guest frame.
pub async fn read_guest<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Frame> {
    let mut hdr = [0u8; 4];
    r.read_exact(&mut hdr).await?;
    let len = u32::from_be_bytes(hdr);
    if len == 0 || len > MAX_FRAME_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad guest frame length {len}")));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body).await?;
    let kind = Kind::from_u8(body[0])
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("unknown frame kind {}", body[0])))?;
    body.remove(0);
    Ok(Frame { kind, payload: body })
}

/// Read newline-delimited lines (used for Claude Code stdout).
pub fn lines<R: AsyncRead + Unpin>(r: R) -> tokio::io::Lines<BufReader<R>> {
    BufReader::new(r).lines()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_frame_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_host(&mut a, &serde_json::json!({"type": "ping", "nonce": 7})).await.unwrap();
        drop(a);
        let v: serde_json::Value = read_host(&mut b).await.unwrap().unwrap();
        assert_eq!(v["nonce"], 7);
        let none: Option<serde_json::Value> = read_host(&mut b).await.unwrap();
        assert!(none.is_none());
    }

    #[tokio::test]
    async fn guest_frame_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_guest_json(&mut a, &serde_json::json!({"type": "cancel"})).await.unwrap();
        let f = read_guest(&mut b).await.unwrap();
        assert_eq!(f.kind, Kind::Json);
        let v: serde_json::Value = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(v["type"], "cancel");
    }
}
