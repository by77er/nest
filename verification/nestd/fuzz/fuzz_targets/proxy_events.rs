//! nest-proxy → nestd: one seqpacket datagram read by `fdpass::recv::<ProxyEvent>`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nest_protocol::host::fdpass::MAX_PACKET_FROM_PROXY;

fuzz_target!(|data: &[u8]| {
    let Some(r) = nestd_fuzz::proxy_recv(data) else { return };
    match r {
        Ok(Some((ev, fds))) => {
            assert!(fds.is_empty(), "no fds were sent");
            assert!(data.len() <= MAX_PACKET_FROM_PROXY);
            nestd_fuzz::roundtrip(&ev);
        }
        // A zero-length datagram reads as EOF (nestd's reader then closes the link).
        Ok(None) => assert!(data.is_empty()),
        Err(e) => {
            assert_eq!(e.kind(), std::io::ErrorKind::InvalidData, "{e}");
        }
    }
});
