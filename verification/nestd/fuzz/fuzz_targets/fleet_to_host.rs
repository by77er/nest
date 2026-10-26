//! FleetDO → nestd: a WebSocket text or binary message parsed as `FleetToHost` (fleet.rs `parse`).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let bin = nestd_fuzz::fleet_parse_binary(data);
    if let Ok(text) = std::str::from_utf8(data) {
        assert_eq!(nestd_fuzz::fleet_parse_text(text), bin, "text and binary parse differently");
    }
    if let Some(m) = bin {
        nestd_fuzz::roundtrip(&m);
    }
});
