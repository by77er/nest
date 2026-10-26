//! nest-gateway → nestd: LengthDelimitedCodec (MAX_FRAME) then `GatewayEvent` (hello, pong, error).
//! Byte 0 picks the read-chunk boundaries.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nest_protocol::host::gateway_link::GatewayEvent;

fuzz_target!(|data: &[u8]| {
    let Some((&ctl, stream)) = data.split_first() else { return };
    nestd_fuzz::check_link_stream::<GatewayEvent>(ctl, stream);
});
