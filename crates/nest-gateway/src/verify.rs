//! The bind check: every refusal the gateway can give, in the order `gateway::error_code`
//! documents, and what an accepted bind yields.

use std::path::PathBuf;

use nest_protocol::gateway::{
    BindingClaims, BindingParseError, BindingScope, GatewayMessage, GuestInfo, MIN_SUPPORTED_PROTOCOL_VERSION,
    PROTOCOL_VERSION, error_code, parse_binding,
};
use nest_protocol::model::ErrorBody;
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};

use crate::state::State;

/// Why a bind was refused; becomes a `GatewayMessage::Error` then a close.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl Refusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Refusal { code, message: message.into(), retryable: false, retry_after_ms: None }
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Refusal { code: error_code::BUSY, message: message.into(), retryable: true, retry_after_ms: Some(500) }
    }

    pub fn moved(message: impl Into<String>) -> Self {
        Refusal::new(error_code::MOVED, message)
    }

    pub fn message(&self) -> GatewayMessage {
        GatewayMessage::Error {
            error: ErrorBody { code: self.code.to_string(), message: self.message.clone(), retryable: self.retryable },
            executed: false,
            retry_after_ms: self.retry_after_ms,
        }
    }
}

/// An accepted bind: what the pipe needs.
#[derive(Clone, Debug)]
pub struct Accepted {
    pub claims: BindingClaims,
    pub vsock_uds_path: PathBuf,
    pub guest: GuestInfo,
    pub gateway_version: u32,
}

/// Check a `bind` against one snapshot of the state. Precedence (the first failing check wins):
/// gateway version → token shape → claims version → key id → signature, expiry, scope →
/// sandbox known (`moved`, or `busy` during a resync) → epoch older (`stale_epoch`) or newer
/// (`busy`) → client attached → guest known (`busy`) → guest version. The attached set is
/// checked only once the sandbox and epoch are known, since it belongs to that sandbox.
pub fn check_bind(
    state: &State,
    binding: &str,
    protocol_version: u32,
    gateway_version: u32,
    now_ms: i64,
) -> Result<Accepted, Refusal> {
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
    let snap = state.snapshot(&claims.kid, &claims.sandbox);
    let Some(key) = snap.key else {
        return Err(Refusal::new(error_code::UNKNOWN_KEY, format!("no key with kid {}", claims.kid)));
    };
    if UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key).verify(&parsed.message, &parsed.signature).is_err() {
        return Err(unauthorized());
    }
    if claims.exp_ms <= now_ms || claims.scope != BindingScope::Hands {
        return Err(unauthorized());
    }
    let Some(entry) = snap.entry else {
        if snap.resyncing {
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
    let Some(guest) = entry.guest else {
        return Err(Refusal::busy("guest not configured yet"));
    };
    if protocol_version != guest.protocol_version {
        return Err(Refusal::new(
            error_code::UNSUPPORTED_VERSION,
            format!("guest speaks protocol version {}, not {protocol_version}", guest.protocol_version),
        ));
    }
    // The highest version this gateway serves that the client also speaks: with one version
    // served, that is the client's.
    Ok(Accepted { claims, vsock_uds_path: entry.vsock_uds_path, guest, gateway_version })
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
