//! The lease watchdog's decision: self-fence once the lease deadline has passed on either clock.
//!
//! The deadline is kept on `CLOCK_MONOTONIC` and on `CLOCK_BOOTTIME` (which keeps running while
//! the host is suspended), so a host waking from suspend notices its lease lapsed. The shell reads
//! both clocks and passes what remains of the deadline on each.

/// How often the watchdog looks again at most, so a suspend never hides the deadline for long.
pub const RECHECK_MS: u64 = 250;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LeaseCheck {
    /// The deadline has passed on at least one clock: fence everything now.
    Expired,
    /// Still leased; look again after this long (or on a renewal).
    Valid { recheck_ms: u64 },
}

/// `remaining_*`: what is left of the deadline on each clock (0 once it has passed).
pub fn check(remaining_mono_ms: u64, remaining_boot_ms: u64) -> LeaseCheck {
    if remaining_mono_ms == 0 || remaining_boot_ms == 0 {
        LeaseCheck::Expired
    } else {
        LeaseCheck::Valid { recheck_ms: remaining_mono_ms.min(remaining_boot_ms).min(RECHECK_MS) }
    }
}

#[cfg(test)]
mod tests {
    use super::{LeaseCheck, check};

    #[test]
    fn either_clock_running_out_expires_the_lease() {
        assert_eq!(check(0, 5_000), LeaseCheck::Expired);
        assert_eq!(check(5_000, 0), LeaseCheck::Expired, "a suspend: boottime ran on, monotonic didn't");
        assert_eq!(check(100, 5_000), LeaseCheck::Valid { recheck_ms: 100 });
        assert_eq!(check(5_000, 5_000), LeaseCheck::Valid { recheck_ms: 250 });
    }
}
