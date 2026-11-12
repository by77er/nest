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
