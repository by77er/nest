//! Shared drivers for the nestd fuzz targets. Each driver feeds bytes to the production parser the
//! way nestd's reader does (same decoder, same push/pop loop, same serde type), so a target fuzzes
//! the shipped code, not a re-implementation. See README.md for the target → function map.

use std::fmt::Debug;
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use bytes::{Bytes, BytesMut};
use nest_protocol::control::FleetToHost;
use nest_protocol::guest::ControlFrame;
use nest_protocol::guest::frame::{self, Decoder, Frame, FrameError, Kind};
use nest_protocol::host::fdpass;
use nest_protocol::host::proxy::ProxyEvent;
use nestd::fleet::CoreInput;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::codec::{Decoder as _, Encoder as _, LengthDelimitedCodec};

/// Split `data` into the chunks a reader might see. `ctl == 0` is one chunk; any other value seeds
/// a small xorshift that cuts 1..=67-byte pieces, so the fuzzer controls the boundaries with one byte.
pub fn split(ctl: u8, data: &[u8]) -> Vec<&[u8]> {
    if ctl == 0 {
        return vec![data];
    }
    let mut s = u32::from(ctl) | 0x9e37_0000;
    let mut out = vec![];
    let mut rest = data;
    while !rest.is_empty() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let n = ((s % 67) as usize + 1).min(rest.len());
        let (a, b) = rest.split_at(n);
        out.push(a);
        rest = b;
    }
    out
}

/// Serialize, parse back, compare: the property for every protocol type nestd decodes and that
/// also has an encoder.
pub fn roundtrip<T: Serialize + DeserializeOwned + PartialEq + Debug>(v: &T) {
    let s = serde_json::to_vec(v).expect("a decoded value serializes");
    let back: T = serde_json::from_slice(&s).unwrap_or_else(|e| panic!("re-encoded value does not decode: {e}\n{}", String::from_utf8_lossy(&s)));
    assert_eq!(*v, back, "round trip changed the value");
}

// --- guest control stream (vsock port 1024) -----------------------------------------------------

/// What the guest frame decoder made of a byte stream.
#[derive(Debug, PartialEq)]
pub struct GuestDecode {
    pub frames: Vec<Frame>,
    pub error: Option<FrameError>,
    /// Buffered bytes after the last complete frame (`None` once the stream errored).
    pub remainder: Option<Vec<u8>>,
}

/// Push `chunks` into one [`Decoder`] and pop frames after each push until it needs more bytes,
/// as nestd's guest session (crates/nestd/src/guest.rs `read_frame` and the steady-state loop)
/// and nest-gateway's guest pipe (crates/nest-gateway/src/server.rs) do. The first error ends the
/// stream, as it ends the connection there.
pub fn guest_decode(chunks: &[&[u8]]) -> GuestDecode {
    let mut dec = Decoder::new();
    let mut frames = vec![];
    for c in chunks {
        dec.push(c);
        loop {
            match dec.next_frame() {
                Ok(Some(f)) => frames.push(f),
                Ok(None) => break,
                Err(e) => return GuestDecode { frames, error: Some(e), remainder: None },
            }
        }
    }
    GuestDecode { frames, error: None, remainder: Some(dec.into_remainder()) }
}

/// The checks on one guest stream: chunking does not change the result, and re-encoding each
/// frame (what nest-gateway sends on to the client) reproduces the guest's bytes exactly.
pub fn check_guest_stream(ctl: u8, stream: &[u8]) {
    let whole = guest_decode(&[stream]);
    let chunked = guest_decode(&split(ctl, stream));
    assert_eq!(whole, chunked, "chunk boundaries changed the decode");

    let mut off = 0;
    for f in &whole.frames {
        let enc = frame::encode(f.kind, &f.payload).expect("a decoded frame re-encodes");
        assert_eq!(&stream[off..off + enc.len()], &enc[..], "re-encoded frame differs from the wire bytes");
        off += enc.len();
        if f.kind == Kind::Json {
            check_control_json(&f.payload);
        }
    }
    if let Some(rest) = &whole.remainder {
        assert_eq!(&stream[off..], &rest[..], "remainder is not the bytes after the last frame");
    }
}

/// A JSON payload as nestd reads it from the control channel (`serde_json::from_slice::<ControlFrame>`
/// in guest.rs `read_frame` and `Task::on_frame`). A frame that parses must re-encode through
/// `frame::encode_json` (which `expect`s serialization) and decode back to the same value.
pub fn check_control_json(payload: &[u8]) {
    let Ok(cf) = serde_json::from_slice::<ControlFrame>(payload) else { return };
    let enc = frame::encode_json(&cf).expect("a decoded control frame re-encodes within MAX_FRAME_LEN");
    let mut dec = Decoder::new();
    dec.push(&enc);
    let f = dec.next_frame().expect("own frame decodes").expect("own frame is complete");
    assert_eq!(f.kind, Kind::Json);
    let back: ControlFrame = serde_json::from_slice(&f.payload)
        .unwrap_or_else(|e| panic!("re-encoded control frame does not decode: {e}\n{}", String::from_utf8_lossy(&f.payload)));
    assert_eq!(cf, back, "control frame round trip changed the value");
}

// --- host-internal length-delimited links (gateway, runner) -------------------------------------

/// The codec nestd's gateway and runner links build (gateway_link.rs / runner_link.rs `start`).
pub fn link_codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder().max_frame_length(nest_protocol::host::frame::MAX_FRAME).new_codec()
}

#[derive(Debug, PartialEq)]
pub struct LinkDecode {
    pub frames: Vec<Vec<u8>>,
    /// `(kind, message)` of the error that ended the stream, if one did.
    pub error: Option<(io::ErrorKind, String)>,
}

/// Decode `chunks` with [`link_codec`] the way `tokio_util::codec::Framed` drives it: `decode`
/// until `None` after each read, `decode_eof` at the end of the stream; an error ends it.
pub fn link_decode(chunks: &[&[u8]]) -> LinkDecode {
    let mut codec = link_codec();
    let mut buf = BytesMut::new();
    let mut frames = vec![];
    let err = |e: io::Error| Some((e.kind(), e.to_string()));
    for c in chunks {
        buf.extend_from_slice(c);
        loop {
            match codec.decode(&mut buf) {
                Ok(Some(f)) => frames.push(f.to_vec()),
                Ok(None) => break,
                Err(e) => return LinkDecode { frames, error: err(e) },
            }
        }
    }
    loop {
        match codec.decode_eof(&mut buf) {
            Ok(Some(f)) => frames.push(f.to_vec()),
            Ok(None) => break,
            Err(e) => return LinkDecode { frames, error: err(e) },
        }
    }
    LinkDecode { frames, error: None }
}

/// The checks on one link stream: chunking does not change the decode, the codec re-encodes each
/// frame to the original bytes, and every frame that parses as `T` round-trips.
pub fn check_link_stream<T: Serialize + DeserializeOwned + PartialEq + Debug>(ctl: u8, stream: &[u8]) {
    let whole = link_decode(&[stream]);
    let chunked = link_decode(&split(ctl, stream));
    assert_eq!(whole, chunked, "chunk boundaries changed the decode");

    let mut codec = link_codec();
    let mut enc = BytesMut::new();
    for f in &whole.frames {
        codec.encode(Bytes::from(f.clone()), &mut enc).expect("a decoded frame re-encodes");
        if let Ok(v) = serde_json::from_slice::<T>(f) {
            roundtrip(&v);
        }
    }
    assert_eq!(&stream[..enc.len()], &enc[..], "re-encoded frames differ from the wire bytes");
}

// --- nestd ↔ nest-proxy (seqpacket) -------------------------------------------------------------

/// Deliver `packet` as one seqpacket datagram and read it with `fdpass::recv::<ProxyEvent>`, the
/// call nestd's proxy reader thread makes (proxy_link.rs `handshake_and_resync`). `None` when the
/// kernel won't take the datagram (larger than the socket buffer).
#[allow(clippy::type_complexity)]
pub fn proxy_recv(packet: &[u8]) -> Option<io::Result<Option<(ProxyEvent, Vec<OwnedFd>)>>> {
    use nix::sys::socket::{AddressFamily, MsgFlags, SockFlag, SockType, send, socketpair};
    let (a, b) = socketpair(AddressFamily::Unix, SockType::SeqPacket, None, SockFlag::SOCK_CLOEXEC).expect("socketpair");
    if send(a.as_raw_fd(), packet, MsgFlags::MSG_DONTWAIT).is_err() {
        return None;
    }
    let mut buf = Vec::new();
    Some(fdpass::recv::<ProxyEvent>(b.as_fd(), &mut buf, fdpass::MAX_PACKET_FROM_PROXY))
}

// --- FleetDO → nestd (WebSocket) ----------------------------------------------------------------

/// A text message from FleetDO through nestd's own decode (`nestd::fleet::decode`: the WebSocket
/// item to the fleet core's input), exactly as the shell calls it.
pub fn fleet_decode_text(text: &str) -> CoreInput {
    nestd::fleet::decode(Some(Ok(Message::Text(text.into()))))
}

/// The same bytes as a binary message (the decode checks UTF-8 first).
pub fn fleet_decode_binary(b: &[u8]) -> CoreInput {
    nestd::fleet::decode(Some(Ok(Message::Binary(Bytes::copy_from_slice(b)))))
}

/// The wire message the bytes are, if any: the oracle for which inputs decode to a frame.
pub fn fleet_message(b: &[u8]) -> Option<FleetToHost> {
    serde_json::from_slice(b).ok()
}

// --- meta.json ----------------------------------------------------------------------------------

/// A per-process scratch incarnation directory (on tmpfs when there is one).
pub fn meta_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let shm = Path::new("/dev/shm");
        let base = if shm.is_dir() { shm.to_path_buf() } else { std::env::temp_dir() };
        let dir = base.join(format!("nestd-fuzz-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    })
}

/// Write `bytes` as `meta.json` and read it with the production `nestd::recovery::read_meta`.
pub fn read_meta_bytes(bytes: &[u8]) -> io::Result<nestd::recovery::SandboxMeta> {
    let dir = meta_dir();
    std::fs::write(dir.join(nestd::recovery::META_FILE), bytes)?;
    nestd::recovery::read_meta(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeds(target: &str) -> Vec<(String, Vec<u8>)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeds").join(target);
        let mut out: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e} (run `python3 -I gen_seeds.py` first)", dir.display()))
            .map(|e| e.unwrap().path())
            .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
            .collect();
        out.sort();
        assert!(!out.is_empty(), "no seeds for {target}");
        out
    }

    // The seeds are valid frames, so every run starts from inputs that reach the deep parsers.

    #[test]
    fn guest_stream_seeds_decode_to_control_frames() {
        for (name, s) in seeds("guest_stream") {
            let d = guest_decode(&[&s[1..]]);
            assert!(d.error.is_none() && d.remainder.as_deref() == Some(&[][..]) && !d.frames.is_empty(), "{name}: {d:?}");
            for f in d.frames.iter().filter(|f| f.kind == Kind::Json) {
                serde_json::from_slice::<ControlFrame>(&f.payload).unwrap_or_else(|e| panic!("{name}: {e}"));
            }
        }
    }

    #[test]
    fn guest_control_json_seeds_parse() {
        for (name, s) in seeds("guest_control_json") {
            serde_json::from_slice::<ControlFrame>(&s).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn proxy_seeds_parse() {
        for (name, s) in seeds("proxy_events") {
            assert!(matches!(proxy_recv(&s), Some(Ok(Some(_)))), "{name}");
        }
    }

    fn link_seeds_parse<T: DeserializeOwned>(target: &str) {
        for (name, s) in seeds(target) {
            let d = link_decode(&[&s[1..]]);
            assert!(d.error.is_none() && !d.frames.is_empty(), "{name}: {d:?}");
            for f in &d.frames {
                serde_json::from_slice::<T>(f).unwrap_or_else(|e| panic!("{name}: {e}"));
            }
        }
    }

    #[test]
    fn gateway_seeds_parse() {
        link_seeds_parse::<nest_protocol::host::gateway_link::GatewayEvent>("gateway_events");
    }

    #[test]
    fn runner_seeds_parse() {
        link_seeds_parse::<nest_protocol::host::runner::RunnerEvent>("runner_events");
    }

    #[test]
    fn fleet_seeds_parse() {
        for (name, s) in seeds("fleet_to_host") {
            assert!(matches!(fleet_decode_binary(&s), nestd_core::fleet::Input::Frame(_)), "{name}");
        }
    }

    #[test]
    fn meta_seeds_read() {
        for (name, s) in seeds("meta_json") {
            read_meta_bytes(&s).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn handshake_seeds_parse() {
        for (name, s) in seeds("vsock_handshake") {
            let line = std::str::from_utf8(&s).unwrap();
            assert!(nest_protocol::guest::handshake::parse_ok_line(line).is_some(), "{name}");
        }
    }
}
