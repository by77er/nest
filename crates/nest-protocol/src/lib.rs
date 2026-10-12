//! Wire types for every nest boundary. Each module is owned by one boundary spec in
//! `docs/interfaces/`; JSON fixtures in `protocol/fixtures/` are the cross-language source of truth.

pub mod control; // control plane <-> host (WebSocket)       docs/interfaces/control-host/
pub mod guest; // host <-> guest agent (vsock)              docs/interfaces/host-guest/
pub mod host; // host-internal: nestd <-> proxy/runner/hook docs/interfaces/host-internal/
pub mod model; // shared data models: events, policy, generations, ids
