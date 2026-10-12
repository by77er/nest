//! Small shared helpers: wall-clock time and identifier generation.

use std::time::{SystemTime, UNIX_EPOCH};

use nest_protocol::model::{ErrorBody, TimestampMs};

/// Wall-clock milliseconds since the Unix epoch. Only used for wire timestamps; lease deadlines
/// use the monotonic clock.
pub fn now_ms() -> TimestampMs {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Time since boot **including suspend** (`CLOCK_BOOTTIME`). Lease deadlines are checked on this
/// clock too: `Instant` (`CLOCK_MONOTONIC`) stops while the host is suspended, so a host waking
/// from suspend would otherwise believe a long-expired lease is still valid.
pub fn boottime() -> std::time::Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime writes into the timespec we own.
    unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
    std::time::Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

/// Random lowercase hex string of `bytes` random bytes.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(&mut buf[..]);
    hex::encode(buf)
}

/// New identifier with the given prefix, e.g. `new_id("req_")`.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", random_hex(8))
}

pub fn error(code: &str, message: impl Into<String>, retryable: bool) -> ErrorBody {
    ErrorBody { code: code.into(), message: message.into(), retryable }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_have_prefix_and_entropy() {
        let a = super::new_id("req_");
        let b = super::new_id("req_");
        assert!(a.starts_with("req_") && a.len() == 4 + 16);
        assert_ne!(a, b);
    }
}
