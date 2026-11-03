//! The bind check: every refusal the gateway can give, in the order the contract's error-code
//! table documents (`docs/interfaces/gateway/#error-codes`), and what an admitted bind yields.

use std::path::PathBuf;

use nest_protocol::gateway::{
    BindingClaims, BindingParseError, BindingScope, GatewayMessage, GuestInfo, MIN_SUPPORTED_PROTOCOL_VERSION,
    PAUSED_RETRY_AFTER_MS, PROTOCOL_VERSION, RefusalReason, error_code, parse_binding,
};
use nest_protocol::model::ErrorBody;
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};

use crate::state::SandboxEntry;

/// Why a bind was refused; becomes a `GatewayMessage::Error` then a close.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    /// Sent as the error's `reason`: only a paused VM's `busy` has one.
    pub reason: Option<RefusalReason>,
}

impl Refusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Refusal { code, message: message.into(), retryable: false, retry_after_ms: None, reason: None }
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Refusal { code: error_code::BUSY, message: message.into(), retryable: true, retry_after_ms: Some(500), reason: None }
    }

    /// `busy` while nestd has the VM paused: reason `paused` (a client waits it out within its
    /// long budget), the hint [`PAUSED_RETRY_AFTER_MS`], and the message names what the pause is
    /// for (a client shows it if its budget runs out).
    pub fn paused(why: &str) -> Self {
        Refusal {
            retry_after_ms: Some(PAUSED_RETRY_AFTER_MS),
            reason: Some(RefusalReason::Paused),
            ..Refusal::busy(format!("the sandbox is paused: {why}"))
        }
    }

    pub fn moved(message: impl Into<String>) -> Self {
        Refusal::new(error_code::MOVED, message)
    }

    pub fn message(&self) -> GatewayMessage {
        GatewayMessage::Error {
            error: ErrorBody { code: self.code.to_string(), message: self.message.clone(), retryable: self.retryable },
            executed: false,
            retry_after_ms: self.retry_after_ms,
            reason: self.reason,
        }
    }
}

/// What an admitted bind yields besides its claims: where the guest is, and what it speaks.
#[derive(Clone, Debug)]
pub struct Admission {
    pub vsock_uds_path: PathBuf,
    pub guest: GuestInfo,
}

/// The state-free half of the bind check, run before any lock: gateway version → token shape →
/// claims version → key id → signature, expiry, scope. `key` looks a kid up. Every answer here
/// precedes every state-dependent one, so an unsigned probe learns nothing about which
/// sandboxes a host runs.
pub fn verify_token(
    key: impl FnOnce(&str) -> Option<Vec<u8>>,
    binding: &str,
    gateway_version: u32,
    now_ms: i64,
) -> Result<BindingClaims, Refusal> {
    if !(MIN_SUPPORTED_PROTOCOL_VERSION..=PROTOCOL_VERSION).contains(&gateway_version) {
        return Err(Refusal::new(
            error_code::UNSUPPORTED_VERSION,
            format!("gateway version {gateway_version} outside [{MIN_SUPPORTED_PROTOCOL_VERSION}, {PROTOCOL_VERSION}]"),
        ));
    }
    let parsed = match parse_binding(binding) {
        Ok(p) => p,
        Err(BindingParseError::Version(v)) => {
            return Err(Refusal::new(error_code::UNSUPPORTED_VERSION, format!("binding claims version {v}")));
        }
        Err(_) => return Err(unauthorized()),
    };
    let claims = parsed.claims;
    let Some(key) = key(&claims.kid) else {
        return Err(Refusal::new(error_code::UNKNOWN_KEY, format!("no key with kid {}", claims.kid)));
    };
    if UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key).verify(&parsed.message, &parsed.signature).is_err() {
        return Err(unauthorized());
    }
    if claims.exp_ms <= now_ms || claims.scope != BindingScope::Hands {
        return Err(unauthorized());
    }
    Ok(claims)
}

/// The state-dependent half, run under the lock that registers the connection
/// ([`crate::state::State::admit_and_register`]): sandbox known (`moved`, or `busy` during a
/// resync) → epoch older (`stale_epoch`) or newer (`busy`) → client attached (to that sandbox at
/// that epoch) → guest known (`busy`) → guest version → VM running (`busy` with a hint while
/// nestd has it paused).
pub fn admit(entry: Option<&SandboxEntry>, resyncing: bool, claims: &BindingClaims, protocol_version: u32) -> Result<Admission, Refusal> {
    let Some(entry) = entry else {
        if resyncing {
            return Err(Refusal::busy("resync in progress"));
        }
        return Err(Refusal::moved(format!("sandbox {} is not on this host", claims.sandbox.0)));
    };
    if claims.epoch.0 < entry.epoch.0 {
        // The current epoch is not the client's to learn here; `resolve` tells it.
        return Err(Refusal::new(error_code::STALE_EPOCH, "binding names an epoch that is no longer current"));
    }
    if claims.epoch.0 > entry.epoch.0 {
        return Err(Refusal::busy("that epoch is not placed here yet"));
    }
    if !entry.clients.contains(&claims.client) {
        return Err(unauthorized());
    }
    let Some(guest) = entry.guest.clone() else {
        return Err(Refusal::busy("guest not configured yet"));
    };
    if protocol_version != guest.protocol_version {
        return Err(Refusal::new(
            error_code::UNSUPPORTED_VERSION,
            format!("guest speaks protocol version {}, not {protocol_version}", guest.protocol_version),
        ));
    }
    if let Some(p) = &entry.paused {
        return Err(Refusal::paused(&p.reason));
    }
    Ok(Admission { vsock_uds_path: entry.vsock_uds_path.clone(), guest })
}

fn unauthorized() -> Refusal {
    Refusal::new(error_code::UNAUTHORIZED, "binding refused")
}

/// Is the first client frame consistent with the binding it came in under? `None` when it is.
pub fn first_frame_mismatch(json: &serde_json::Value, claims: &BindingClaims, guest_version: u32) -> Option<&'static str> {
    if let Some(a) = json.get("agent_id")
        && a.as_str() != Some(claims.client.as_str())
    {
        return Some("agent_id");
    }
    if let Some(e) = json.get("epoch")
        && e.as_u64() != Some(claims.epoch.0)
    {
        return Some("epoch");
    }
    if let Some(v) = json.get("protocol_version")
        && v.as_u64() != Some(u64::from(guest_version))
    {
        return Some("protocol_version");
    }
    None
}

/// Verify a token against one raw public key, as the gateway does; the claims only if it holds.
pub fn verify_with_key(public_key: &[u8], token: &str) -> Option<BindingClaims> {
    let parsed = parse_binding(token).ok()?;
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public_key).verify(&parsed.message, &parsed.signature).ok()?;
    Some(parsed.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::State;
    use nest_protocol::host::gateway_link::SandboxPause;
    use nest_protocol::model::{Epoch, SandboxId};

    /// One combination of everything [`admit`] reads.
    #[derive(Clone, Copy, Debug)]
    struct Case {
        placed: bool,
        resyncing: bool,
        /// The binding's epoch minus the held one: -1, 0 or 1.
        epoch: i64,
        attached: bool,
        /// The guest's protocol version, `None` before its hello; the bind asks for 1.
        guest: Option<u32>,
        /// nestd has the VM paused.
        paused: bool,
    }

    /// A row of the table: its code, and when it applies.
    type Row = (&'static str, fn(&Case) -> bool);

    /// The contract's error-code table (`docs/interfaces/gateway/#error-codes`), rows 5 to 10 in
    /// order: the first row whose condition holds is the answer.
    const TABLE: &[Row] = &[
        (error_code::MOVED, |c| !c.placed && !c.resyncing),
        (error_code::BUSY, |c| !c.placed && c.resyncing),
        (error_code::STALE_EPOCH, |c| c.epoch < 0),
        (error_code::BUSY, |c| c.epoch > 0),
        (error_code::UNAUTHORIZED, |c| !c.attached),
        (error_code::BUSY, |c| c.guest.is_none()),
        (error_code::UNSUPPORTED_VERSION, |c| c.guest != Some(1)),
        (error_code::BUSY, |c| c.paused),
    ];

    #[test]
    fn admission_follows_the_contracts_error_code_table() {
        let mut n = 0;
        for placed in [false, true] {
            for resyncing in [false, true] {
                for epoch in [-1, 0, 1] {
                    for attached in [false, true] {
                        for (guest, paused) in [None, Some(1), Some(2)].into_iter().flat_map(|g| [(g, false), (g, true)]) {
                            let c = Case { placed, resyncing, epoch, attached, guest, paused };
                            let state = State::new();
                            let sandbox = SandboxId("sbx_1".into());
                            if placed {
                                let clients: &[&str] = if attached { &["agt_a"] } else { &["agt_b"] };
                                let guest = guest.map(|v| GuestInfo { protocol_version: v, capabilities: vec![] });
                                let pause = paused.then(|| SandboxPause { reason: "a checkpoint (turn_end)".into() });
                                state.upsert_sandbox_paused(sandbox.clone(), Epoch(5), PathBuf::from("/v"), clients.iter().copied(), guest, pause);
                            }
                            let claims = BindingClaims {
                                v: 1,
                                kid: "k".into(),
                                sandbox: sandbox.clone(),
                                epoch: Epoch((5 + epoch) as u64),
                                client: "agt_a".into(),
                                scope: BindingScope::Hands,
                                exp_ms: i64::MAX,
                            };
                            let got = admit(state.sandbox(&sandbox).as_ref(), resyncing, &claims, 1);
                            let want = TABLE.iter().find(|(_, holds)| holds(&c)).map(|(code, _)| *code);
                            match (got, want) {
                                (Ok(a), None) => assert_eq!(a.guest.protocol_version, 1, "{c:?}"),
                                (Err(r), Some(code)) => {
                                    assert_eq!(r.code, code, "{c:?}");
                                    assert_eq!(r.retryable, code == error_code::BUSY, "only busy is retried with the same binding: {c:?}");
                                    // Only the pause row's busy carries the pause hint and reason.
                                    let pause_row = TABLE.iter().position(|(_, holds)| holds(&c)) == Some(TABLE.len() - 1);
                                    assert_eq!(r.retry_after_ms == Some(PAUSED_RETRY_AFTER_MS), pause_row, "{c:?}: {r:?}");
                                    assert_eq!(r.message.contains("checkpoint (turn_end)"), pause_row, "{c:?}: {r:?}");
                                    assert_eq!(r.reason == Some(RefusalReason::Paused), pause_row, "only the pause row says paused: {c:?}");
                                }
                                (got, want) => panic!("{c:?}: got {got:?}, the table says {want:?}"),
                            }
                            n += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(n, 144);
    }
}
