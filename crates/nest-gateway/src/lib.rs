//! The sandbox gateway: the one network door into a sandbox. See `docs/sandbox/gateway/` and
//! `docs/interfaces/gateway/`.
//!
//! One unprivileged process per sandbox host. A client (the agent runner's hands client, a
//! person's `nest` CLI) opens one WebSocket per hands call, sends a signed binding, and the
//! gateway pipes host-guest frames to the guest's vsock port. Everything the gateway knows (the
//! binding keys, which sandboxes run here at which epoch, their vsock sockets, attached clients
//! and guest versions) comes from nestd over `/run/nest/gateway.sock` ([`link`]); losing nestd
//! closes every connection and refuses every binding until the link is back.
//!
//! No TLS here: the gateway listens on loopback behind cloudflared (or on a test port), and
//! holds no secret except the public verification keys.

pub mod link;
pub mod server;
pub mod state;
pub mod testing;
pub mod verify;

pub use link::link;
pub use server::serve;
pub use state::State;
