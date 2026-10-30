//! `meta.json` as a restarted nestd finds it (a torn file, another version's, or junk), read by
//! the production `nestd::recovery::read_meta` from a scratch directory.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nestd::recovery::{META_VERSION, read_meta, write_meta};

fuzz_target!(|data: &[u8]| {
    let Ok(meta) = nestd_fuzz::read_meta_bytes(data) else { return };
    assert_eq!(meta.version, META_VERSION, "read_meta accepted another version");
    // What nestd writes back for this incarnation reads back the same.
    let dir = nestd_fuzz::meta_dir();
    write_meta(dir, &meta).expect("write_meta");
    assert_eq!(read_meta(dir).expect("read back"), meta);
    nestd_fuzz::roundtrip(&meta);
});
