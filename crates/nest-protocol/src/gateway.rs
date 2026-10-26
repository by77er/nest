//! Brain ↔ sandbox gateway (WebSocket). Owned by `docs/interfaces/gateway/`.
//!
//! A client (the agent runner's hands client, a person's `nest` CLI, later AgentDO's `api-loop`)
//! opens one WebSocket per hands call to the sandbox host's gateway, at the URL and with the
//! binding that SandboxDO handed out. The first message is a JSON text frame, [`ClientMessage::Bind`];
//! the gateway answers [`GatewayMessage::Bound`] or closes after [`GatewayMessage::Error`]. After
//! `bound`, every binary message is exactly one host-guest frame (`crate::guest::frame`), piped
//! verbatim to the guest's vsock port, so the hands contract itself lives in `crate::guest`.
//! Closing the WebSocket closes the vsock side: a hangup is a cancel.
//!
//! Framing rule: a binary message holds exactly one frame, `len:u32be kind:u8 payload` with
//! `len == message_len - 4` and a known `kind`; the gateway rejects anything else (close code
//! [`close_code::PROTOCOL`]) so a message can never smuggle a second frame past the checks on the
//! first. The first client frame after `bound` must be a JSON frame whose `agent_id`, `epoch` and
//! `protocol_version`, where present, equal the binding's client and epoch and the bound guest
//! version; on a mismatch the gateway closes with [`close_code::UNAUTHORIZED`] before forwarding
//! anything, so `executed: false` stays true. Later client frames (`cancel`) pass through.
//! After `bound` the gateway sends no text frames: refusals are close codes, and every other
//! error is the guest's own frame. A text frame from the client after `bound` is a protocol error.

use serde::{Deserialize, Serialize};

use crate::model::{Epoch, ErrorBody, SandboxId, Secret, TimestampMs};

/// Version of this boundary (the `bind` handshake and framing), independent of the guest version
/// the frames inside carry. The gateway serves `[MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION]`.
pub const PROTOCOL_VERSION: u32 = 1;
pub const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 1;

/// Routes. `/hands` carries hands calls and `call_status`; `/pty` and `/ingress/<port>` carry the
/// host-guest ingress channel (designed, not served yet).
pub const ROUTE_HANDS: &str = "/hands";
pub const ROUTE_PTY: &str = "/pty";
pub const ROUTE_INGRESS_PREFIX: &str = "/ingress/";

/// Everything a client needs to reach one sandbox's hands. Issued by SandboxDO (`resolve`) and
/// carried to the runner only over the session channel (`hands_resolved`), never through
/// FleetDO, nestd or any command at rest: a bearer token travels AgentDO → runner, nowhere else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandsTarget {
    /// `ws://` or `wss://` base URL of the sandbox host's gateway (no path).
    pub url: String,
    /// Deprecated, for one release: unsigned copies of the binding's `sandbox` and `epoch`
    /// claims, still sent for clients of the previous release, which require them. Current
    /// clients read both from the binding's claims ([`parse_binding`]), the copy the gateway
    /// checks, and ignore these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<Epoch>,
    /// The binding token (`nbd_…`), sent as the first message. Never in a URL, never logged
    /// (`Secret` redacts `Debug`); held in memory only.
    pub binding: Secret,
    /// The guest's protocol version and capabilities as SandboxDO last heard them. Advisory: the
    /// gateway's `bound.guest` is authoritative, and the client uses that for capabilities.
    pub guest: GuestInfo,
    /// Credentials for the edge in front of the gateway (a Cloudflare Access service token),
    /// absent on a plain `ws://` gateway. Sent as request headers on the upgrade, never in a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<EdgeAuth>,
}

/// A Cloudflare Access service token: `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeAuth {
    pub client_id: String,
    pub client_secret: Secret,
}

/// One binding verification key. The control plane lists every key still valid (the previous
/// one stays listed for at least a binding lifetime after a rotation), so a rotation never
/// refuses outstanding bindings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingKey {
    /// First 16 hex characters of SHA-256 over the raw public key bytes.
    pub kid: String,
    /// ECDSA P-256 public key: the uncompressed SEC1 point (65 bytes), base64url, no padding.
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInfo {
    pub protocol_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
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

/// `Prefix`, `Shape`, `Base64` and `Claims` are refused as `unauthorized`; `Version` (claims
/// format newer or older than this gateway knows) as `unsupported_version`.
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
    /// `gateway_version` is the version this gateway chose (the highest it serves that is not
    /// above the client's), so a newer client can step down; `guest` is authoritative.
    Bound { guest: GuestInfo, gateway_version: u32 },
    /// The connection is refused; the gateway closes right after. `executed` is false here by
    /// construction: the gateway never executes anything, and nothing has reached the guest.
    /// (Host-guest v1 treats a *missing* `executed` as "possibly executed"; here the field is
    /// always present.) Codes: [`error_code`].
    Error {
        error: ErrorBody,
        #[serde(default)]
        executed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
}

/// Refusal codes, in the order the gateway checks them: `bad_request` (shape, route, no `bind`
/// within 5 s) → `unsupported_version` (gateway version out of range, claims format version) →
/// `unknown_key` → `unauthorized` (signature, expiry, scope, client not attached) → `moved`
/// (sandbox unknown here) → `stale_epoch` (binding epoch older than the sandbox's) → `busy`
/// (binding epoch newer than this gateway's table, guest not configured, resync in progress,
/// vsock connect failed) → `unsupported_version` again if `bind.protocol_version` is not the
/// guest's. Only `busy` is retryable with the same binding; `stale_epoch`, `moved` and
/// `unknown_key` mean "resolve again"; `unauthorized` and `bad_request` are final.
pub mod error_code {
    /// Bad signature, expired binding, wrong scope, a client that is not attached to the
    /// sandbox, or a first frame whose agent or epoch differs from the binding's. Never says which.
    pub const UNAUTHORIZED: &str = "unauthorized";
    /// The binding's `kid` is none of the keys this gateway holds: rotated away, or forged with
    /// a key this cell never had. Not retryable with the same binding; resolve again.
    pub const UNKNOWN_KEY: &str = "unknown_key";
    /// The binding names an epoch older than the sandbox's current one on this host. Not
    /// retryable: the same binding can never succeed; resolve again.
    pub const STALE_EPOCH: &str = "stale_epoch";
    /// The sandbox is not on this host (or this gateway has lost nestd). Resolve again.
    pub const MOVED: &str = "moved";
    /// The client's gateway version is outside the served range, the claims format is unknown,
    /// or `bind.protocol_version` is not the guest's version (then `message` names it).
    pub const UNSUPPORTED_VERSION: &str = crate::model::error_codes::UNSUPPORTED_VERSION;
    /// Not yet: the binding's epoch is newer than this gateway's table (a placement that nestd
    /// has not pushed yet), the guest has not been configured, a resync is in progress, or the
    /// vsock connect failed. Retryable with the same binding after `retry_after_ms`.
    pub const BUSY: &str = "busy";
    /// The first message was not a well-formed `bind` text frame, or the route is unknown.
    pub const BAD_REQUEST: &str = "bad_request";

    /// Every refusal code; `protocol/fixtures/codes.json` holds the same list (`gateway`).
    pub const ALL: &[&str] = &[UNAUTHORIZED, UNKNOWN_KEY, STALE_EPOCH, MOVED, UNSUPPORTED_VERSION, BUSY, BAD_REQUEST];
}

/// WebSocket close codes the gateway uses after `bound`, when text frames are no longer allowed.
pub mod close_code {
    /// A message that is not exactly one well-formed frame, or a text frame after `bound`.
    pub const PROTOCOL: u16 = 4400;
    /// The first frame's agent, epoch or version differs from the binding's. Nothing was forwarded.
    pub const UNAUTHORIZED: u16 = 4401;
    /// The sandbox left this host mid-call (fence, eviction, nestd link lost). The call may have
    /// run; the client treats the outcome as unknown.
    pub const MOVED: u16 = 4409;
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

    #[test]
    fn signed_fixture_parses_to_its_claims() {
        let f: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixtures_dir().join("binding_token/signed.json")).unwrap(),
        )
        .unwrap();
        let parsed = parse_binding(f["token"].as_str().unwrap()).unwrap();
        let claims: BindingClaims = serde_json::from_value(f["claims"].clone()).unwrap();
        assert_eq!(parsed.claims, claims);
        assert_eq!(parsed.claims.kid, f["kid"].as_str().unwrap());
        assert_eq!(parsed.signature.len(), 64, "fixed-size r‖s signature");
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
