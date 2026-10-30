//! FleetDO → nestd: a WebSocket message through nestd's real decode (`nestd::fleet::decode`, the
//! shell's WebSocket item → fleet core input), as a text message and as a binary one.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nestd::fleet::Other;
use nestd_core::fleet::{Inbound, Input};

fuzz_target!(|data: &[u8]| {
    let bin = nestd_fuzz::fleet_decode_binary(data);
    if let Ok(text) = std::str::from_utf8(data) {
        assert_eq!(nestd_fuzz::fleet_decode_text(text), bin, "text and binary decode differently");
    }
    // A data message never ends the connection; it is a frame exactly when it is a FleetToHost.
    assert!(!matches!(bin, Input::Closed), "a data message closed the connection");
    let message = nestd_fuzz::fleet_message(data);
    assert_eq!(matches!(bin, Input::Frame(_)), message.is_some(), "decode and the wire type disagree: {bin:?}");
    if let Input::Frame(Inbound::Error { code, error: Other::Error(e), .. }) = &bin {
        assert_eq!(*code, e.code, "the core judges the error's own code");
    }
    if let Some(m) = message {
        nestd_fuzz::roundtrip(&m);
    }
});
