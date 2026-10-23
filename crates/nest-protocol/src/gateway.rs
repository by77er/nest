//! Brain ↔ sandbox gateway (WebSocket). Owned by `docs/interfaces/gateway/`.
//!
//! A client (the agent runner's hands client, a person's `nest` CLI, later AgentDO's `api-loop`)
//! opens one WebSocket per hands call to the sandbox host's gateway, at the URL and with the
//! binding that SandboxDO handed out. The first message is a JSON text frame, [`ClientMessage::Bind`];
//! the gateway answers [`GatewayMessage::Bound`] or closes after [`GatewayMessage::Error`]. After
//! `bound`, every binary message is exactly one host-guest frame (`crate::guest::frame`), piped
//! verbatim to the guest's vsock port, so the hands contract itself lives in `crate::guest`.
//! Closing the WebSocket closes the vsock side: a hangup is a cancel.

use serde::{Deserialize, Serialize};

use crate::model::{Epoch, ErrorBody, SandboxId, TimestampMs};

/// Version of this boundary (the `bind` handshake and framing), independent of the guest version
/// the frames inside carry. The gateway serves `[MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION]`.
pub const PROTOCOL_VERSION: u32 = 1;
pub const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 1;

/// Routes. `/hands` carries hands calls and `call_status`; `/pty` and `/ingress/<port>` carry the
/// host-guest ingress channel (designed, not served yet).
pub const ROUTE_HANDS: &str = "/hands";
pub const ROUTE_PTY: &str = "/pty";
pub const ROUTE_INGRESS_PREFIX: &str = "/ingress/";

/// Everything a client needs to reach one sandbox's hands. Issued by SandboxDO (`attach`,
/// `resolve`); the runner receives it inside `agent_start` and in `hands_resolved`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandsTarget {
    /// `ws://` or `wss://` base URL of the sandbox host's gateway (no path).
    pub url: String,
    pub sandbox: SandboxId,
    /// The sandbox epoch the binding names; every `HandsRequest` carries it too.
    pub epoch: Epoch,
    /// The binding token (`nbd_…`), sent as the first message. Never put in a URL.
    pub binding: String,
    /// The guest's protocol version and capabilities, as nestd reported them; the client speaks
    /// that version and uses only advertised features.
    pub guest: GuestInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInfo {
    pub protocol_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingScope {
    Hands,
    Pty,
    Ingress,
}

/// The claims inside a binding token. `client` is the agent id for an agent, or a person's id
/// for a terminal; the slot (cwd, env, cgroup) is configured in the guest at `attach`, not here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingClaims {
    /// Claims format version; see [`BINDING_VERSION`].
    pub v: u32,
    /// Id of the cell signing key that signed this binding.
    pub kid: String,
    pub sandbox: SandboxId,
    pub epoch: Epoch,
    pub client: String,
    pub scope: BindingScope,
    pub exp_ms: TimestampMs,
}

pub const BINDING_VERSION: u32 = 1;
/// Token prefix: `nbd_<base64url(claims JSON)>.<base64url(signature)>`.
pub const BINDING_PREFIX: &str = "nbd_";
/// Domain separation: the signed bytes are this prefix followed by the base64url claims segment,
/// exactly as it appears in the token. ECDSA P-256 with SHA-256, fixed-size (r‖s) signature.
pub const BINDING_SIGN_DOMAIN: &[u8] = b"nest-binding-v1:";

/// A token split into its parts. The verifier checks `signature` over `message` with the cell's
/// public key before trusting `claims`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedBinding {
    pub claims: BindingClaims,
    pub message: Vec<u8>,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindingParseError {
    Prefix,
    Shape,
    Base64,
    Claims(String),
    Version(u32),
}

impl std::fmt::Display for BindingParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindingParseError::Prefix => write!(f, "binding does not start with {BINDING_PREFIX}"),
            BindingParseError::Shape => write!(f, "binding is not <claims>.<signature>"),
            BindingParseError::Base64 => write!(f, "binding segment is not base64url"),
            BindingParseError::Claims(e) => write!(f, "binding claims: {e}"),
            BindingParseError::Version(v) => write!(f, "binding claims version {v} is not {BINDING_VERSION}"),
        }
    }
}

impl std::error::Error for BindingParseError {}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, BindingParseError> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).map_err(|_| BindingParseError::Base64)
}

/// The bytes a signer signs for a claims segment (the base64url claims, as in the token).
pub fn signing_message(claims_b64: &str) -> Vec<u8> {
    let mut m = BINDING_SIGN_DOMAIN.to_vec();
    m.extend_from_slice(claims_b64.as_bytes());
    m
}

/// Assemble a token from the serialized claims and their signature. The claims bytes are signed
/// and embedded as given, so a signer serializes once and signs `signing_message(b64(claims))`.
pub fn encode_binding(claims_json: &[u8], signature: &[u8]) -> String {
    format!("{BINDING_PREFIX}{}.{}", b64(claims_json), b64(signature))
}

/// Split a token into claims, the signed message and the signature. Nothing is verified here:
/// the caller checks the signature against the cell key, then the claims against the sandbox.
pub fn parse_binding(token: &str) -> Result<ParsedBinding, BindingParseError> {
    let rest = token.strip_prefix(BINDING_PREFIX).ok_or(BindingParseError::Prefix)?;
    let (claims_b64, sig_b64) = rest.split_once('.').ok_or(BindingParseError::Shape)?;
    if claims_b64.is_empty() || sig_b64.is_empty() || sig_b64.contains('.') {
        return Err(BindingParseError::Shape);
    }
    let claims_json = unb64(claims_b64)?;
    let signature = unb64(sig_b64)?;
    let claims: BindingClaims =
        serde_json::from_slice(&claims_json).map_err(|e| BindingParseError::Claims(e.to_string()))?;
    if claims.v != BINDING_VERSION {
        return Err(BindingParseError::Version(claims.v));
    }
    Ok(ParsedBinding { claims, message: signing_message(claims_b64), signature })
}

/// Client → gateway, as JSON text frames. Only `bind` exists: everything after it is guest frames.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(ClientMessageKind), derive(strum::EnumIter, strum::IntoStaticStr))]
#[strum_discriminants(strum(serialize_all = "snake_case"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// First message on every connection. `protocol_version` is the guest version the client will
    /// speak inside the frames (the one `resolve` reported); `gateway_version` is this boundary's.
    Bind { binding: String, protocol_version: u32, gateway_version: u32 },
}

/// Gateway → client, as JSON text frames, only before the frames start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(GatewayMessageKind), derive(strum::EnumIter, strum::IntoStaticStr))]
#[strum_discriminants(strum(serialize_all = "snake_case"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GatewayMessage {
    /// The binding was accepted and the guest's port is connected; guest frames follow.
    Bound { guest: GuestInfo },
    /// The connection is refused; the gateway closes right after. `executed` is always false
    /// here: nothing reached the guest. Codes: [`error_code`].
    Error {
        error: ErrorBody,
        #[serde(default)]
        executed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
}

pub mod error_code {
    /// Bad signature, unknown key, expired binding, wrong scope, or a frame whose agent or epoch
    /// differs from the binding's.
    pub const UNAUTHORIZED: &str = "unauthorized";
    /// The binding names an epoch that is not the sandbox's current one on this host; re-resolve.
    pub const STALE_EPOCH: &str = "stale_epoch";
    /// The sandbox is not on this host; re-resolve.
    pub const MOVED: &str = "moved";
    /// The client's guest or gateway version is outside what this gateway serves.
    pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
    /// The guest is not ready (before `configure`, or during a freeze); retryable.
    pub const BUSY: &str = "busy";
    /// The first message was not a well-formed `bind`, or the route is unknown.
    pub const BAD_REQUEST: &str = "bad_request";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use strum::IntoEnumIterator;

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/gateway")
    }

    fn round_trip_dir<T: Serialize + DeserializeOwned>(dir: &str) -> BTreeSet<String> {
        let path = fixtures_dir().join(dir);
        let mut seen = BTreeSet::new();
        let mut entries: Vec<_> = std::fs::read_dir(&path)
            .unwrap_or_else(|e| panic!("missing fixture dir {}: {e}", path.display()))
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        entries.sort();
        assert!(!entries.is_empty(), "no fixtures in {dir}");
        for file in entries {
            let text = std::fs::read_to_string(&file).unwrap();
            let original: serde_json::Value = serde_json::from_str(&text).unwrap();
            let parsed: T =
                serde_json::from_value(original.clone()).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
            let again = serde_json::to_value(&parsed).unwrap();
            assert_eq!(original, again, "round-trip mismatch for {}", file.display());
            if let Some(t) = original.get("type").and_then(|t| t.as_str()) {
                let stem = file.file_stem().unwrap().to_str().unwrap();
                assert_eq!(stem.split('.').next().unwrap(), t, "fixture file name must start with its type: {}", file.display());
                seen.insert(t.to_string());
            }
        }
        seen
    }

    fn assert_covered<K: IntoEnumIterator + Into<&'static str>>(dir: &str, seen: &BTreeSet<String>) {
        let all: BTreeSet<String> = K::iter().map(|k| k.into().to_string()).collect();
        let missing: Vec<_> = all.difference(seen).collect();
        assert!(missing.is_empty(), "variants without a fixture in {dir}: {missing:?}");
        let unknown: Vec<_> = seen.difference(&all).collect();
        assert!(unknown.is_empty(), "fixtures for unknown variants in {dir}: {unknown:?}");
    }

    #[test]
    fn message_fixtures() {
        let seen = round_trip_dir::<ClientMessage>("client_message");
        assert_covered::<ClientMessageKind>("client_message", &seen);
        let seen = round_trip_dir::<GatewayMessage>("gateway_message");
        assert_covered::<GatewayMessageKind>("gateway_message", &seen);
    }

    #[test]
    fn claims_and_target_fixtures() {
        round_trip_dir::<BindingClaims>("binding_claims");
        round_trip_dir::<HandsTarget>("hands_target");
    }

    fn claims() -> BindingClaims {
        BindingClaims {
            v: BINDING_VERSION,
            kid: "k1".into(),
            sandbox: SandboxId("sbx_01jb7m2a4c".into()),
            epoch: Epoch(4),
            client: "agt_01jb7n0w1e".into(),
            scope: BindingScope::Hands,
            exp_ms: 1_760_274_000_000,
        }
    }

    #[test]
    fn token_round_trips_and_exposes_the_signed_bytes() {
        let json = serde_json::to_vec(&claims()).unwrap();
        let token = encode_binding(&json, b"sig-bytes");
        assert!(token.starts_with(BINDING_PREFIX));
        let parsed = parse_binding(&token).unwrap();
        assert_eq!(parsed.claims, claims());
        assert_eq!(parsed.signature, b"sig-bytes");
        let claims_b64 = &token[BINDING_PREFIX.len()..token.rfind('.').unwrap()];
        assert_eq!(parsed.message, signing_message(claims_b64));
        assert!(parsed.message.starts_with(BINDING_SIGN_DOMAIN));
    }

    #[test]
    fn malformed_tokens_are_named_not_guessed() {
        let json = serde_json::to_vec(&claims()).unwrap();
        let good = encode_binding(&json, b"s");
        assert_eq!(parse_binding(&good.replace("nbd_", "nht_")).unwrap_err(), BindingParseError::Prefix);
        assert_eq!(parse_binding("nbd_abc").unwrap_err(), BindingParseError::Shape);
        assert_eq!(parse_binding("nbd_abc.").unwrap_err(), BindingParseError::Shape);
        assert_eq!(parse_binding("nbd_a.b.c").unwrap_err(), BindingParseError::Shape);
        assert_eq!(parse_binding("nbd_!!.cw").unwrap_err(), BindingParseError::Base64);
        let other = encode_binding(b"{\"v\":2}", b"s");
        assert!(matches!(parse_binding(&other).unwrap_err(), BindingParseError::Claims(_)));
        let mut v2 = claims();
        v2.v = 2;
        let token = encode_binding(&serde_json::to_vec(&v2).unwrap(), b"s");
        assert_eq!(parse_binding(&token).unwrap_err(), BindingParseError::Version(2));
    }
}
