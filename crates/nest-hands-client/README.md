# nest-hands-client

The hands client: one WebSocket per hands call to a sandbox's gateway, speaking the
[gateway contract](../../docs/interfaces/gateway/). Used by the agent runner (design:
`docs/agents/hands/`, `docs/agents/runner/`); AgentDO's `api-loop` will speak the same contract
from TypeScript.

| Item | What |
|---|---|
| `open(target, opts) -> Result<HandsConn, OpenError>` | Connects to `target.url` + `/hands` (`ws://`, or `wss://` with an explicit rustls connector: the process's installed provider or ring, webpki roots), with the gateway's message limit (`MAX_FRAME_LEN + 4`). The Access service token in `target.edge` goes on the upgrade as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and only over `wss://` or to a loopback host. Sends `bind` and waits for `bound` (→ `HandsConn`) or `error` (→ `OpenError::Refused`). |
| `OpenOptions { connect_timeout, bind_timeout }` | 5 s each by default; `OpenError::Timeout(Phase::{Connect, Bind})` says which elapsed. |
| `OpenError::{Refused(Refusal), Transport(TransportError), Protocol(String), Timeout(Phase)}` | `Refusal { code: RefusalCode, message, retryable, retry_after_ms }`; `RefusalCode::{Unauthorized, UnknownKey, StaleEpoch, Moved, UnsupportedVersion, Busy, BadRequest, Other(String)}`. `OpenError::next()` / `Refusal::next()` give the one classification, `Next::{RetrySame { after }, Resolve, Final}`: `busy` waits `retry_after_ms` (else `BUSY_RETRY`, 500 ms); `stale_epoch`, `moved`, `unknown_key`, `unauthorized` (an expired or revoked binding), `unsupported_version` (a target minted with an older guest version), an unreachable target and a connect timeout resolve again; the rest is final. `TransportError::{Io(io::Error), Dns(String), Tls(String), Http(u16), Url(String), ClosedBeforeBound { code, reason }}` with `is_unreachable()` (refused, reset, not connected, host or network unreachable; a hostname that does not resolve; an HTTP 5xx from in front of the gateway, which is Cloudflare's edge with no connector behind the hostname; a 401 or 403, which is Access refusing the `edge` credential): the runner resolves again on it, after a short pause when `is_edge_outage()` (a 5xx: a tunnel reconnecting answers 530 for a few seconds). 404 and 501 are the gateway's own answers and stay final. `Protocol` also covers a `bound.gateway_version` outside what this client serves. |
| `guest_error_next(&ErrorBody)` | A guest `error` frame: `busy` (refused before anything runs) is `RetrySame`, within the caller's same budget as a gateway `busy`; anything else is `Final`. |
| `binding_exp_ms(target)`, `refresh_due(target, now_ms)` | `exp_ms` from the binding's claims segment (the signature is the gateway's to check); due when it is within `REFRESH_MARGIN` (60 s), so a caller resolves again before a bind would be refused. `NOT_READY_RETRY` (2 s) is the fallback pause for `sandbox_not_ready`. |
| `HandsConn::guest()`, `gateway_version()` | From `bound`; authoritative. |
| `HandsConn::send_json(&T) -> io::Result<()>` | One JSON frame (`HandsRequest`, `cancel`, `call_status`) as one binary message, `len:u32be kind:u8 payload`; over the frame limit is `InvalidInput`. |
| `HandsConn::recv_json::<T>() -> Result<Option<T>, RecvError>` | The next JSON frame. `Ok(None)` only on a normal close (1000) or EOF after the close handshake. `RecvError::Closed(Closed { code, reason })` for any other close code (4400 protocol, 4401 unauthorized, 4409 moved; `is_moved()`, `is_unauthorized()`); `RecvError::Io` for a socket failure, including a reset without a close handshake (`ConnectionReset`); `RecvError::Protocol` for a text message, a `DATA` frame, a message that is not exactly one frame, or JSON that is not a `T`. Cancel-safe inside `select!`. |
| `HandsConn::close()`, `close_with_reason(&str)` | A close frame, the handshake drained for at most `CLOSE_TIMEOUT` (2 s), then drop. Dropping without it hangs up with no close frame: a hangup is a cancel. |

The binding and the edge secret are never logged by this crate. tungstenite's `trace` logging
prints frame payloads, so `tungstenite=trace` must never be enabled where a binding travels.
Tests run an in-crate gateway on `127.0.0.1:0` with tokio-tungstenite's server side, feed the
`gateway_message` fixtures as raw text (the fixtures are the oracle), and use the `openssl` CLI
for the one TLS test, so the crate stays independent of `nest-gateway` and of any TLS acceptor.
