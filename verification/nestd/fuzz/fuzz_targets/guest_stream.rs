//! Guest control stream (vsock port 1024): untrusted bytes from inside a VM.
//! Byte 0 picks the read-chunk boundaries; the rest is the stream after the vsock handshake.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&ctl, stream)) = data.split_first() else { return };
    nestd_fuzz::check_guest_stream(ctl, stream);
});
