//! The hybrid-vsock reply line nestd reads before the frame stream (vsock.rs `connect`):
//! `read_line` (UTF-8) then `handshake::parse_ok_line`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nest_protocol::guest::handshake;

fuzz_target!(|data: &[u8]| {
    let Ok(line) = std::str::from_utf8(data) else { return };
    if let Some(port) = handshake::parse_ok_line(line) {
        assert_eq!(handshake::parse_ok_line(&handshake::ok_line(port)), Some(port));
    }
    if let Some(port) = handshake::parse_connect_line(line) {
        assert_eq!(handshake::parse_connect_line(&handshake::connect_line(port)), Some(port));
    }
});
