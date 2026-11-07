//! The proxy intermediate CA's renewal (audit P-B2).
//!
//! nestd renews its intermediate CA (the key nest-proxy signs leaves with) before it expires: it
//! makes a key, sends FleetDO a CSR for it, and installs the certificate that comes back. A
//! renewal unanswered after [`RETRY_MS`] is asked again with a new key, so answers can arrive late
//! and out of order. An answer used to be paired with whichever key was pending, so a late answer
//! to a superseded CSR installed a certificate with another key's private half: every inspected TLS
//! connection then failed until close to the next expiry, the pair persisted across restarts.
//!
//! Here an answer is paired only with a key its certificate names ([`cert_public_key`]): the
//! pending key (the renewal is done), else the current one (a re-issue), else it is refused.

/// Renew when less than this is left of the current certificate.
pub const RENEW_BEFORE_MS: i64 = 48 * 3600 * 1000;
/// Ask again (with a new key) when a renewal has had no answer for this long.
pub const RETRY_MS: u64 = 600_000;

/// What an answer did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer<K> {
    /// The pending key's certificate: install it, with this key.
    Renewed(K),
    /// The current key's certificate (issued again): install it, with this key.
    Reissued(K),
    /// A certificate for neither key: install nothing.
    Refused,
}

/// The CA's renewal state: the installed key and its certificate's expiry, and a renewal in flight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaRenewal<K> {
    current: Option<K>,
    expires_ms: Option<i64>,
    /// The key of the renewal in flight, and when (monotonic ms) its CSR went out.
    pending: Option<(K, u64)>,
}

impl<K: Clone> CaRenewal<K> {
    /// `current`: the installed key, if any; `expires_ms`: its certificate's expiry. A host with
    /// no usable key but an expiry (a persisted pair that doesn't match) is due at once.
    pub fn new(current: Option<K>, expires_ms: Option<i64>) -> Self {
        CaRenewal { current, expires_ms, pending: None }
    }

    pub fn expires_ms(&self) -> Option<i64> {
        self.expires_ms
    }

    /// Whether the current certificate has expired (inspected egress fails closed).
    pub fn expired(&self, now_wall_ms: i64) -> bool {
        self.expires_ms.is_some_and(|e| e <= now_wall_ms)
    }

    /// Whether to send a CSR now: within [`RENEW_BEFORE_MS`] of the expiry, and no renewal sent in
    /// the last [`RETRY_MS`]. A host that never had a CA (none enrolled) renews nothing.
    pub fn due(&self, now_wall_ms: i64, now_mono_ms: u64) -> bool {
        let Some(expires) = self.expires_ms else { return false };
        if expires - now_wall_ms > RENEW_BEFORE_MS {
            return false;
        }
        self.pending.as_ref().is_none_or(|(_, at)| now_mono_ms.saturating_sub(*at) >= RETRY_MS)
    }

    /// A CSR for `key` went out: it replaces any renewal still unanswered.
    pub fn asked(&mut self, key: K, now_mono_ms: u64) {
        self.pending = Some((key, now_mono_ms));
    }

    /// A certificate expiring at `expires_ms` arrived; `names` says whether its public key is a
    /// key's. The pending key's ends the renewal; the current key's is a re-issue; anything else
    /// (a late answer to a CSR whose key was replaced) changes nothing.
    pub fn answered(&mut self, expires_ms: i64, names: impl Fn(&K) -> bool) -> Answer<K> {
        if let Some((k, _)) = &self.pending
            && names(k)
        {
            let k = k.clone();
            self.current = Some(k.clone());
            self.expires_ms = Some(expires_ms);
            self.pending = None;
            return Answer::Renewed(k);
        }
        if let Some(k) = &self.current
            && names(k)
        {
            self.expires_ms = Some(expires_ms);
            return Answer::Reissued(k.clone());
        }
        Answer::Refused
    }
}

/// One DER element: its tag, its content, and what follows it. Definite lengths up to 4 bytes.
fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        (rest[..n].iter().fold(0usize, |l, b| l * 256 + *b as usize), &rest[n..])
    };
    if rest.len() < len {
        return None;
    }
    Some((tag, &rest[..len], &rest[len..]))
}

const SEQUENCE: u8 = 0x30;
const BIT_STRING: u8 = 0x03;
const VERSION: u8 = 0xa0;

/// The subject public key of an X.509 certificate in DER (`subjectPublicKeyInfo.subjectPublicKey`,
/// the key's bits: for EC, the encoded point), or `None` if it doesn't parse as one.
pub fn cert_public_key(der: &[u8]) -> Option<&[u8]> {
    let (SEQUENCE, cert, _) = tlv(der)? else { return None };
    let (SEQUENCE, tbs, _) = tlv(cert)? else { return None };
    let mut rest = tbs;
    let (tag, _, after) = tlv(rest)?;
    if tag == VERSION {
        rest = after;
    }
    // serialNumber, signature, issuer, validity, subject.
    for _ in 0..5 {
        rest = tlv(rest)?.2;
    }
    let (SEQUENCE, spki, _) = tlv(rest)? else { return None };
    let (SEQUENCE, _, rest) = tlv(spki)? else { return None };
    let (BIT_STRING, bits, _) = tlv(rest)? else { return None };
    match bits.split_first()? {
        (0, key) if !key.is_empty() => Some(key),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3600 * 1000;

    #[test]
    fn the_windows_are_two_days_and_ten_minutes() {
        assert_eq!(RENEW_BEFORE_MS, 172_800_000);
        assert_eq!(RETRY_MS, 600_000);
    }

    #[test]
    fn tlv_reads_short_and_long_lengths_and_refuses_the_rest() {
        assert_eq!(tlv(&[0x30, 0x00]), Some((0x30, &[][..], &[][..])));
        assert_eq!(tlv(&[0x30, 0x01, 9, 8]), Some((0x30, &[9][..], &[8][..])));
        assert_eq!(tlv(&[0x30, 0x7f]), None, "a short length past the end");
        // Long forms: one to four length bytes, big-endian.
        assert_eq!(tlv(&[0x30, 0x81, 0x00]), Some((0x30, &[][..], &[][..])), "exactly the length bytes left");
        assert_eq!(tlv(&[0x30, 0x81, 0x01, 7]), Some((0x30, &[7][..], &[][..])));
        let mut two = alloc::vec![0x04, 0x82, 0x01, 0x02];
        two.extend(core::iter::repeat_n(5u8, 0x0102));
        assert_eq!(tlv(&two).map(|(_, c, _)| c.len()), Some(0x0102), "258, not 3 (0x01 + 0x02) or 0x0102 read wrong");
        let mut four = alloc::vec![0x04, 0x84, 0, 0, 0, 2];
        four.extend([1, 2, 3]);
        assert_eq!(tlv(&four), Some((0x04, &[1, 2][..], &[3][..])), "four length bytes are allowed");
        let mut indefinite = alloc::vec![0x30, 0x80];
        indefinite.extend([0u8; 200]);
        assert_eq!(tlv(&indefinite), None, "an indefinite length, whatever follows");
        assert_eq!(tlv(&[0x30, 0x85, 0, 0, 0, 0, 1, 1]), None, "five length bytes");
        assert_eq!(tlv(&[0x30, 0x82, 0x01]), None, "fewer length bytes than said");
        assert_eq!(tlv(&[0x30]), None);
        assert_eq!(tlv(&[]), None);
    }

    #[test]
    fn due_within_the_window_and_again_after_the_retry() {
        let mut r = CaRenewal::new(Some("k1"), Some(100 * H));
        assert!(!r.due(100 * H - RENEW_BEFORE_MS - 1, 0), "not yet");
        assert!(r.due(100 * H - RENEW_BEFORE_MS, 0), "exactly the window");
        r.asked("k2", 1_000);
        assert!(!r.due(99 * H, 1_000 + RETRY_MS - 1), "a renewal is in flight");
        assert!(r.due(99 * H, 1_000 + RETRY_MS), "unanswered too long: ask again");
        assert!(!CaRenewal::<&str>::new(None, None).due(i64::MAX, u64::MAX), "no CA, nothing to renew");
        assert!(CaRenewal::<&str>::new(None, Some(0)).due(1, 0), "an unusable pair renews at once");
    }

    #[test]
    fn expired_at_its_expiry() {
        let r = CaRenewal::new(Some("k"), Some(10));
        assert!(!r.expired(9));
        assert!(r.expired(10));
        assert!(!CaRenewal::<&str>::new(None, None).expired(i64::MAX));
    }

    #[test]
    fn an_answer_is_paired_only_with_the_key_it_names() {
        let mut r = CaRenewal::new(Some("k1"), Some(10));
        r.asked("k2", 0);
        // The pending key's certificate.
        assert_eq!(r.answered(20, |k| *k == "k2"), Answer::Renewed("k2"));
        assert_eq!(r.expires_ms(), Some(20));
        // A re-issue of the current key's.
        assert_eq!(r.answered(30, |k| *k == "k2"), Answer::Reissued("k2"));
        assert_eq!(r.expires_ms(), Some(30));
    }

    /// The bug: a renewal asked again with a new key, then the first CSR's late answer.
    #[test]
    fn a_late_answer_to_a_superseded_csr_installs_nothing() {
        let mut r = CaRenewal::new(Some("k1"), Some(10));
        r.asked("k2", 0);
        r.asked("k3", RETRY_MS);
        assert_eq!(r.answered(20, |k| *k == "k2"), Answer::Refused, "k2's certificate never goes with k3");
        assert_eq!(r.expires_ms(), Some(10), "nothing moved");
        assert!(r.due(0, 2 * RETRY_MS), "still renewing");
        assert_eq!(r.answered(30, |k| *k == "k3"), Answer::Renewed("k3"));
    }

    #[test]
    fn a_certificate_for_no_key_is_refused_and_changes_nothing() {
        let mut r = CaRenewal::new(Some("k1"), Some(10));
        let before = r.clone();
        assert_eq!(r.answered(99, |_| false), Answer::Refused);
        assert_eq!(r, before);
        let mut none: CaRenewal<&str> = CaRenewal::new(None, Some(0));
        assert_eq!(none.answered(99, |_| true), Answer::Refused, "no key at all");
    }

    /// A minimal certificate: `SEQUENCE { tbs, alg, sig }`, `tbs` with an optional version, five
    /// elements, and the SPKI.
    fn cert(version: bool, key: &[u8], unused: u8) -> alloc::vec::Vec<u8> {
        fn el(tag: u8, content: &[u8]) -> alloc::vec::Vec<u8> {
            let mut v = alloc::vec![tag];
            if content.len() < 0x80 {
                v.push(content.len() as u8);
            } else {
                v.extend([0x82, (content.len() >> 8) as u8, content.len() as u8]);
            }
            v.extend_from_slice(content);
            v
        }
        let mut tbs = alloc::vec![];
        if version {
            tbs.extend(el(0xa0, &el(0x02, &[2])));
        }
        tbs.extend(el(0x02, &[1, 2, 3]));
        for _ in 0..4 {
            tbs.extend(el(0x30, &[0x05, 0x00]));
        }
        let mut bits = alloc::vec![unused];
        bits.extend_from_slice(key);
        let mut spki = el(0x30, &[0x06, 0x01, 0x2a]);
        spki.extend(el(0x03, &bits));
        tbs.extend(el(0x30, &spki));
        let mut body = el(0x30, &tbs);
        body.extend(el(0x30, &[0x05, 0x00]));
        body.extend(el(0x03, &[0, 1]));
        el(0x30, &body)
    }

    #[test]
    fn the_public_key_is_found_with_or_without_a_version_and_with_long_lengths() {
        let key = [4u8; 65];
        assert_eq!(cert_public_key(&cert(true, &key, 0)), Some(&key[..]));
        assert_eq!(cert_public_key(&cert(false, &key, 0)), Some(&key[..]));
        let long = [7u8; 300];
        assert_eq!(cert_public_key(&cert(true, &long, 0)), Some(&long[..]), "a two-byte length");
    }

    #[test]
    fn anything_else_is_none_and_never_panics() {
        let good = cert(true, &[4u8; 65], 0);
        assert_eq!(cert_public_key(&cert(true, &[4u8; 65], 1)), None, "unused bits in a key");
        assert_eq!(cert_public_key(&cert(true, &[], 0)), None, "an empty key");
        for n in 0..good.len() {
            assert_eq!(cert_public_key(&good[..n]), None, "truncated at {n}");
        }
        let mut wrong = good.clone();
        wrong[0] = 0x31;
        assert_eq!(cert_public_key(&wrong), None, "not a SEQUENCE");
        assert_eq!(cert_public_key(&[0x30, 0x85, 1, 1, 1, 1, 1]), None, "a five-byte length");
        assert_eq!(cert_public_key(&[0x30, 0x80]), None, "an indefinite length");
    }
}
