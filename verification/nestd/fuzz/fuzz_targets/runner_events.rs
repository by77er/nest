//! nest-runner → nestd: LengthDelimitedCodec (MAX_FRAME) then `RunnerEvent`.
//! Byte 0 picks the read-chunk boundaries.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nest_protocol::host::runner::RunnerEvent;

fuzz_target!(|data: &[u8]| {
    let Some((&ctl, stream)) = data.split_first() else { return };
    nestd_fuzz::check_link_stream::<RunnerEvent>(ctl, stream);
});
