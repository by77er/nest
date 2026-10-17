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

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (year, month, day) → days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYYMMDDTHHMMSSZ` for a Unix time in seconds (SigV4's `x-amz-date`).
pub fn amz_date(unix_s: i64) -> String {
    let (y, mo, d) = civil_from_days(unix_s.div_euclid(86_400));
    let t = unix_s.rem_euclid(86_400);
    format!("{y:04}{mo:02}{d:02}T{:02}{:02}{:02}Z", t / 3600, t / 60 % 60, t % 60)
}

/// Milliseconds since the epoch for an RFC 3339 UTC timestamp as AWS writes them
/// (`2026-10-17T04:04:14Z`, optionally with fractional seconds).
pub fn parse_rfc3339_utc_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || !s.ends_with('Z') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let frac_ms = match &s[19..s.len() - 1] {
        "" => 0,
        f if f.starts_with('.') && f.len() > 1 && f[1..].bytes().all(|c| c.is_ascii_digit()) => {
            format!("{:0<3}", &f[1..f.len().min(4)]).parse::<i64>().ok()?
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo as u32, d as u32);
    Some((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + frac_ms)
}

pub fn error(code: &str, message: impl Into<String>, retryable: bool) -> ErrorBody {
    ErrorBody { code: code.into(), message: message.into(), retryable }
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_formatting_and_parsing_round_trip() {
        assert_eq!(super::amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(super::amz_date(951_782_400), "20000229T000000Z");
        let ms = super::parse_rfc3339_utc_ms("2026-10-17T04:04:14Z").unwrap();
        assert_eq!(super::amz_date(ms / 1000), "20261017T040414Z");
        assert_eq!(super::parse_rfc3339_utc_ms("2026-10-17T04:04:14.5Z"), Some(ms + 500));
        assert_eq!(super::parse_rfc3339_utc_ms("2026-10-17 04:04:14Z"), None);
        assert_eq!(super::parse_rfc3339_utc_ms("2026-13-17T04:04:14Z"), None);
    }

    #[test]
    fn ids_have_prefix_and_entropy() {
        let a = super::new_id("req_");
        let b = super::new_id("req_");
        assert!(a.starts_with("req_") && a.len() == 4 + 16);
        assert_ne!(a, b);
    }
}
