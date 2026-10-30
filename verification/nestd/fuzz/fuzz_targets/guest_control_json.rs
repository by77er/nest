//! One guest control-channel JSON payload (`ControlFrame`: hello, ports, task_exited, cli, replies),
//! without the framing, so the fuzzer spends its time in the serde types.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    nestd_fuzz::check_control_json(data);
    // The same payload framed and streamed in one-byte reads.
    if let Ok(framed) = nest_protocol::guest::frame::encode(nest_protocol::guest::frame::Kind::Json, data) {
        nestd_fuzz::check_guest_stream(1, &framed);
    }
});
