//! A proxy CA certificate's subject public key, as nestd reads it from a FleetDO `proxy_ca` answer
//! (DER, after the PEM decode) to pair the answer with its key: `nestd_core::ca::cert_public_key`.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Some(key) = nestd_core::ca::cert_public_key(data) {
        assert!(!key.is_empty());
        let start = key.as_ptr() as usize - data.as_ptr() as usize;
        assert!(start + key.len() <= data.len(), "the key lies inside the input");
    }
});
