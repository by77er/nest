//! Async helpers over the length-prefixed frames defined in `nest_protocol::guest::frame`.

use std::io;

use nest_protocol::guest::frame::{self, Decoder, Frame, Kind};
use nest_protocol::guest::error_code;
use nest_protocol::model::ErrorBody;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Reads frames from an async byte stream, keeping any bytes past the last frame.
pub struct FramedReader<R> {
    inner: R,
    dec: Decoder,
}

impl<R: AsyncRead + Unpin> FramedReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, dec: Decoder::new() }
    }

    /// Next frame, or `None` on a clean EOF between frames.
    pub async fn next(&mut self) -> io::Result<Option<Frame>> {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match self.dec.next_frame() {
                Ok(Some(f)) => return Ok(Some(f)),
                Ok(None) => {}
                Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidData, e)),
            }
            let n = self.inner.read(&mut buf).await?;
            if n == 0 {
                return Ok(None);
            }
            self.dec.push(&buf[..n]);
        }
    }

    /// Next frame, decoded as a JSON message. `Ok(None)` on EOF.
    pub async fn next_json<T: DeserializeOwned>(&mut self) -> io::Result<Option<Result<T, ErrorBody>>> {
        Ok(self.next().await?.map(|f| parse_json(&f)))
    }

    /// Give back the stream and any bytes already read past the last frame (raw-mode switch).
    pub fn into_parts(self) -> (R, Vec<u8>) {
        (self.inner, self.dec.into_remainder())
    }
}

/// Decode a JSON frame into `T`, mapping failures to a `bad_request` error body.
pub fn parse_json<T: DeserializeOwned>(f: &Frame) -> Result<T, ErrorBody> {
    if f.kind != Kind::Json {
        return Err(bad_request("expected a JSON frame"));
    }
    serde_json::from_slice(&f.payload).map_err(|e| bad_request(&format!("invalid message: {e}")))
}

pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let bytes = frame::encode_json(msg).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    w.write_all(&bytes).await?;
    w.flush().await
}

pub async fn write_data<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> io::Result<()> {
    let bytes = frame::encode(Kind::Data, data).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    w.write_all(&bytes).await?;
    w.flush().await
}

pub fn err(code: &str, message: impl Into<String>, retryable: bool) -> ErrorBody {
    ErrorBody { code: code.to_string(), message: message.into(), retryable }
}

pub fn bad_request(message: &str) -> ErrorBody {
    err(error_code::BAD_REQUEST, message, false)
}
