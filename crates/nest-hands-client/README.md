# nest-hands-client

The hands client: one WebSocket per hands call to a sandbox's gateway, speaking the
[gateway contract](../../docs/interfaces/gateway/). Used by the agent runner (design:
`docs/agents/hands/`, `docs/agents/runner/`); AgentDO's `api-loop` will speak the same contract
from TypeScript.

| Item | What |
|---|---|
| `open(target, opts) -> Result<HandsConn, OpenError>` | Connects to `target.url` + `/hands` (`ws://`, or `wss://` with an explicit rustls connector: the process's installed provider or ring, webpki roots), with the gateway's message limit (`MAX_FRAME_LEN + 4`). The Access service token in `target.edge` goes on the upgrade as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and only over `wss://` or to a loopback host. Sends `bind` and waits for `bound` (→ `HandsConn`) or `error` (→ `OpenError::Refused`). |
| `OpenOptions { connect_timeout, bind_timeout }` | 5 s each by default; `OpenError::Timeout(Phase::{Connect, Bind})` says which elapsed. |
| `OpenError::{Refused(Refusal), Transport(TransportError), Protocol(String), Timeout(Phase)}` | `Refusal { code: RefusalCode, message, retryable, retry_after_ms }` with `resolve_again()` (`stale_epoch`, `moved`, `unknown_key`) and `is_final()` (`unauthorized`, `bad_request`, `unsupported_version`); `RefusalCode::{Unauthorized, UnknownKey, StaleEpoch, Moved, UnsupportedVersion, Busy, BadRequest, Other(String)}`. `TransportError::{Io(io::Error), Tls(String), Http(u16), Url(String), ClosedBeforeBound { code, reason }}` with `is_unreachable()` (refused, reset, not connected, host or network unreachable): the runner resolves again on it. `Protocol` also covers a `bound.gateway_version` outside what this client serves. |
| `HandsConn::guest()`, `gateway_version()` | From `bound`; authoritative. |
| `HandsConn::send_json(&T) -> io::Result<()>` | One JSON frame (`HandsRequest`, `cancel`, `call_status`) as one binary message, `len:u32be kind:u8 payload`; over the frame limit is `InvalidInput`. |
| `HandsConn::recv_json::<T>() -> Result<Option<T>, RecvError>` | The next JSON frame. `Ok(None)` only on a normal close (1000) or EOF after the close handshake. `RecvError::Closed(Closed { code, reason })` for any other close code (4400 protocol, 4401 unauthorized, 4409 moved; `is_moved()`, `is_unauthorized()`); `RecvError::Io` for a socket failure, including a reset without a close handshake (`ConnectionReset`); `RecvError::Protocol` for a text message, a `DATA` frame, a message that is not exactly one frame, or JSON that is not a `T`. Cancel-safe inside `select!`. |
| `HandsConn::close()`, `close_with_reason(&str)` | A close frame, the handshake drained for at most `CLOSE_TIMEOUT` (2 s), then drop. Dropping without it hangs up with no close frame: a hangup is a cancel. |

The binding and the edge secret are never logged by this crate. tungstenite's `trace` logging
prints frame payloads, so `tungstenite=trace` must never be enabled where a binding travels.
Tests run an in-crate gateway on `127.0.0.1:0` with tokio-tungstenite's server side, feed the
`gateway_message` fixtures as raw text (the fixtures are the oracle), and use the `openssl` CLI
for the one TLS test, so the crate stays independent of `nest-gateway` and of any TLS acceptor.
