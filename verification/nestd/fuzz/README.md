# nestd wire-parser fuzzing

cargo-fuzz (libFuzzer + AddressSanitizer) targets for every parser nestd runs on input from across a trust boundary. The guest control stream comes first: it is untrusted bytes from inside a VM. This is a standalone crate: its own `[workspace]` and `Cargo.lock`, outside the repo workspace, so `cargo test --workspace` never builds it. Each target drives the production decoder the way nestd's reader does; the shared drivers are in [src/lib.rs](src/lib.rs).

## Targets

Line numbers are as of 84cace6.

| Target | Input | Production code exercised | Properties |
|---|---|---|---|
| `guest_stream` | byte 0 picks the read-chunk boundaries; the rest is the vsock port-1024 stream after the handshake | `nest_protocol::guest::frame::Decoder::{push,next_frame}` (crates/nest-protocol/src/guest.rs:120,125), driven as nestd's guest session does (crates/nestd/src/guest.rs:263, `read_frame` :358) and as nest-gateway's guest pipe does (crates/nest-gateway/src/server.rs:196). Each JSON frame is parsed as `ControlFrame` (guest.rs:297,364) | no panic; same frames, error and remainder whatever the chunking; `frame::encode` of each frame (what nest-gateway relays, server.rs:198) equals the wire bytes; every parsed `ControlFrame` re-encodes through `frame::encode_json` (which `expect`s) and decodes back equal |
| `guest_control_json` | one control-channel JSON payload | `serde_json::from_slice::<ControlFrame>` (hello, ports, task_exited, cli with `CliCommand`, replies with `CliResult`), then the same payload framed and read 1 byte at a time | as above |
| `vsock_handshake` | the hybrid-vsock reply line | `handshake::parse_ok_line` (guest.rs:201) as `vsock::connect` uses it (crates/nestd/src/vsock.rs:30), and `parse_connect_line` | no panic; `ok_line`/`connect_line` of a parsed port parse back to it |
| `proxy_events` | one seqpacket datagram from nest-proxy | `fdpass::recv::<ProxyEvent>` (crates/nest-protocol/src/host.rs:175) over a real `SOCK_SEQPACKET` socketpair, as the proxy reader calls it (crates/nestd/src/proxy_link.rs:407,473) | no panic, no fds returned; >64 KiB is `InvalidData` (truncated), empty is EOF; a parsed event round-trips |
| `gateway_events` | byte 0 picks the chunking; the rest is the gateway's byte stream | `LengthDelimitedCodec` with `max_frame_length(MAX_FRAME)` (crates/nestd/src/gateway_link.rs:123) driven like `Framed` (`decode` per read, `decode_eof` at the end), then `serde_json::from_slice::<GatewayEvent>` (gateway_link.rs:183,238) | no panic; chunking-independent; the codec re-encodes frames to the wire bytes; a parsed event round-trips |
| `runner_events` | as above, from nest-runner | same codec (crates/nestd/src/runner_link.rs:110), `serde_json::from_slice::<RunnerEvent>` (runner_link.rs:227,275) | as above |
| `fleet_to_host` | a WebSocket message from FleetDO | the shell's own `nestd::fleet::decode` (crates/nestd/src/fleet.rs; the WebSocket item → fleet core `Input`: UTF-8 check for binary, `serde_json::from_str::<FleetToHost>`, then the frame in the core's vocabulary), called as a text and as a binary message | no panic; text and binary decode equal; a data message never reads as a close; it decodes to a frame exactly when the bytes are a `FleetToHost`; an error frame carries its own code to the core; a parsed message round-trips |
| `meta_json` | the bytes of `meta.json` (torn, another version's, junk) | the production `nestd::recovery::read_meta` (crates/nestd/src/recovery.rs:83), on a file written per input in a scratch directory under `/dev/shm` | no panic; an accepted file has `version == META_VERSION`; `write_meta` (recovery.rs:69) of it reads back equal |

Not covered here: the nest-gateway client side (its WebSocket `bind` text and the client's binary frames, `check_frame`), which is not a nestd parser; and nestd's Firecracker API and S3/HTTP responses, which come from trusted local processes or libraries (hyper, reqwest) rather than nest code.

## Running

cargo-fuzz needs nightly. [rust-toolchain.toml](rust-toolchain.toml) pins `nightly-2026-08-21`, which applies when cargo runs from this directory through the rustup proxies. A `RUSTUP_TOOLCHAIN` in the environment, or a tool manager's shim on `PATH` (mise), overrides the file: put `~/.cargo/bin` first on `PATH`.

```sh
cargo install --locked cargo-fuzz           # 0.13.2 was used
verification/nestd/fuzz/run.sh guest_stream 600   # target, seconds, extra libFuzzer flags
python3 -I gen_seeds.py && cargo test       # from this directory: the seeds still decode
```

`run.sh` sets `-rss_limit_mb=2048 -malloc_limit_mb=2048 -timeout=60` (generous: every input runs in milliseconds, and on a heavily loaded machine a 10 s limit fired on stalls, not hangs) and a `-max_len` per target: 64 KiB (one socket read), 128 KiB with `-len_control=0` for `proxy_events` (past the 64 KiB packet limit, below the socket buffer, reached early), and 256 B for `vsock_handshake`. The corpus grows in `corpus/<target>/` and crashes land in `artifacts/<target>/` (both gitignored). Reproduce a crash with `cargo fuzz run --fuzz-dir . <target> <artifact>` and minimize it with `cargo fuzz tmin --fuzz-dir . <target> <artifact>`.

## Seeds

`seeds/<target>/` holds valid inputs generated from `protocol/fixtures/` by [gen_seeds.py](gen_seeds.py) (gitignored: `run.sh` regenerates them at every run, so the fixtures stay the only copy), so every run starts from frames that reach the deep parsers. Guest seeds come from `guest/control/`, plus a multi-frame session and a DATA frame. Proxy, gateway and runner seeds come from `host/{proxy,gateway,runner}_event/`, and the link targets also get all frames in one chunked stream. Fleet seeds come from `control/fleet_to_host/`. `meta.json` seeds are built from `control/generation_record/`. `cargo test`, after `gen_seeds.py`, checks that every seed still decodes.
