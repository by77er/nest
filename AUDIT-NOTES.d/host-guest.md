# Audit notes: docs/interfaces/host-guest/README.md

## Corrections
| Doc:line | Said | Code says | Evidence file:line |
|---|---|---|---|

## Summary lines affected

## Unconfirmed
- Reconnect table (doc:72-76) says the host decides `configure`+`resume` from the hello identity. nestd sends `resume` when a restore was arranged (`expect_resume`, set before restoring a memory snapshot), not from comparing the hello; it only logs the identity comparison. Same result in practice; left as is. crates/nestd/src/guest.rs:282-312.
- `health` (doc:60): the guest answers it (crates/nest-guest/src/control.rs:117), but no nestd code sends `health` today (grep for `ControlBody::Health` outside nest-guest/nest-protocol finds nothing). Doc doesn't claim nestd sends it in v1.

## Suspected code bugs

## Drift outside the area

## No drift
- Transport (doc:7-33): CID 3 / host CID 2, ports 1024/1025/10000, CONNECT/OK handshake, peer-CID-2 filter, `--listen unix:<dir>` → `<dir>/<port>.sock`, emulator, `guest::handshake`. crates/nest-protocol/src/guest.rs:20-33,281-306; crates/nest-guest/src/transport.rs; crates/nest-guest/src/main.rs:6.
- Framing (doc:35-45): MAX_FRAME_LEN 16 MiB counting kind+payload, kinds 0x00/0x01, Empty/TooLarge/UnknownKind errors, `Decoder::into_remainder`. guest.rs:39-180.
- Control table v1 rows (doc:51-64): all `ControlBody` tags and fields match guest.rs:313-389 and CONTROL_TYPES (guest.rs:892). Resume errors bad_request/internal match crates/nest-guest/src/sys.rs:43-90. Configure fence (lower epoch same sandbox → stale_epoch) crates/nest-guest/src/state.rs:86-93. v1 version check equal → error unsupported_version + close (crates/nestd/src/guest.rs:276-281). boot_id from /proc/sys/kernel/random/boot_id (state.rs). Buffering: latest ports + 1000 task_exited, flushed after configure (crates/nest-guest/src/events.rs:16,88-125). prepare_snapshot sync + drop_caches, fsfreeze ignored (sys.rs:104-111). thaw no-op, nestd sends it after resume of paused VM (crates/nestd/src/host.rs:2021). Owed detach: 10 s sweep, sent after configure, before attach (crates/nestd/src/guest.rs:107-118,316-339,462). PROTOCOL_VERSION = 1, no MIN_SUPPORTED constant (v2 not built, consistent).
- Hands/tools/ingress/CLI (doc:64-388): bash limits (crates/nest-guest/src/hands/bash.rs:23-30), TaskOutput 30 s/600 s (bash.rs:378), output retention 64 / 256 MiB / 32 tasks, 64 MiB cap, 5 GB kill, 512 KiB view (crates/nest-guest/src/output.rs:15-22,90), Read limits (hands/read.rs:23-34), PDF >10 pages needs `pages` (read.rs:334), Edit 16 MiB (files.rs:21), Glob 100/500 000 (glob.rs:21-23), Grep 250, 16 MiB, 120 s (grep.rs:21-23), file-tool deadline 120 s (hands/mod.rs:126), ingress 2 s connect (ingress.rs:30), NO_PROXY (exec.rs:49), task_exited buffer 1000 (events.rs:16). CliCommand incl. compat notify/emit/ask (crates/nest-protocol/src/guest.rs:485-511), AgentDO answers them `unknown_tool` (control-plane/src/do/agent.ts:3706-3709). v2 items (range, caps, heartbeats, call_status, pty_attach) have no code: correctly marked v2/designed (guest PROTOCOL_VERSION = 1).
- Omitted by the doc, listed only: `CliResult` also has `answered` and `pending` statuses (fixtures protocol/fixtures/guest/cli/response_answered.json, response_pending.json), used only by the compat `ask`.
STATUS: DONE
