---
name: nest-wire
description: Use when changing anything that crosses a process boundary in nest: a field, message, command, event, error code or enum member in crates/nest-protocol, control-plane/src/protocol, protocol/fixtures or protocol/schemas; the fleet hello; the gateway, guest, runner, proxy or session protocols; stored JSON that another release reads. Covers changing both sides together, fixtures, staying compatible one release back, expand/contract, and capability flags for mixed versions.
---

# Changing a wire protocol

**Where things are:**
- **Spec:** [docs/interfaces/](../../../docs/interfaces/README.md), one directory per boundary. Its "Pending contract changes" list tracks shims to remove later.
- **Rust:** `crates/nest-protocol/src/{control,model,gateway,guest,host}.rs`.
- **TypeScript:** `control-plane/src/protocol/{control,model,gateway}.ts` (zod).
- **Fixtures, the source of truth:** `protocol/fixtures/<boundary>/<message>/<variant>[.<case>].json`, plus `codes.json` (error codes) and `enums.json` (members of every shared string enum).
- **Tool schemas:** `protocol/schemas/`.
- **Admin views (TypeScript only, the dashboard imports them):** `protocol/admin/view.ts`.

## Rules

1. **Both sides change in the same PR,** with a fixture for every new variant or meaningful case. Both sides round-trip every fixture, and each fixture directory must cover exactly its type's variants (the file name is the variant tag, or `<tag>.<case>`).
2. **Follow the conventions:** snake_case, internally tagged `{"type": …}`, prefixed ids, `*_ms` times. **Absent, never null:** Rust uses `#[serde(default, skip_serializing_if = …)]`, TypeScript `.optional()` (zod rejects `null` there).
3. **A new field is optional for at least one release** on both sides, and the reader handles its absence: that is what an old peer sends. Never use `deny_unknown_fields` or zod `.strict()`; unknown fields must be ignored.
4. **Reasons that grow are open enums** (TypeScript `openEnum`, Rust `#[serde(other)]` to `unknown`), so a new member never rejects a message. Add every shared enum member to `enums.json` and every error code to `codes.json`; both sides assert those lists.
5. **A new message type or command variant is rejected by an old peer.** A frame an old nestd can't parse costs a reconnect loop (B5 in [docs/verification/nestd/](../../../docs/verification/nestd/README.md#residuals)); so does a reliable session message (or a new enum value inside one) an old runner can't read: it never acks past it and stalls. Gate it, as in Mixed versions below.
6. **Renames are expand/contract over two releases.** This release reads both names and writes the old one; the next writes the new one; the one after stops reading the old one. The worked example is the host roles `burst`/`controller` → `sandbox`/`brain` ([dev/deploy.md](../../../dev/deploy.md#host-role-names-expandcontract)).
7. **Stored records follow the same rules:** DO rows and R2 or S3 records are read by the previous release after a rollback (the `nest-control-plane` skill).

## Mixed versions are normal

- **The Worker deploys first,** and hosts lag it by a release. A `wrangler rollback` can also put the previous Worker in front of new hosts, so check both directions.
- **Brain and sandbox hosts may be a release apart** in either direction. The gateway protocol serves `[min_supported, current]`, and features follow the guest's advertised `capabilities` ([gateway](../../../docs/interfaces/gateway/README.md#versions-and-capabilities)). Raising `min_supported` is a one-way release.
- **Gate new behaviour on a flag the peer sends** in its hello: an optional bool, default false, stored per host. The example is `brain_epochs` (`hello.brain_epochs.json`, FleetDO's `hosts.brain_epochs`). Send the new thing only to peers that advertise it.
- **Handle previous-release peers structurally,** not by reasoning about their old code. For example, FleetDO never gives a brain to a host without `brain_epochs` and drains such a host of brains on sight.
- **Record the window** in the interface doc's pending list, and its rollout rule in `dev/deploy.md`. Name the release that drops the shim.

## Verify

```bash
cargo test -p nest-protocol                                     # module fixture tests + tests/shared_fixtures.rs
(cd control-plane && npx vitest run test/fixtures.test.ts)      # the zod side, coverage and shared lists
(cd control-plane && npm run typecheck && npm test)             # every caller
cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked
```

- **If a fuzzed parser's types changed** (guest frames, proxy/gateway/runner events, `fleet_to_host`, `meta.json`): `cd verification/nestd/fuzz && python3 -I gen_seeds.py && cargo test --locked`, then `./run.sh <target> replay`.
- **If the admin views changed:** `cd dashboard && npm ci && npm run typecheck && npm test && npm run build`.
- **If components interact:** `e2e/run.sh` (`nest-validation`).
- **Old peer:** the new reader must parse a fixture without the new field (keep the old fixture, or add a `<tag>.<case>.json` without it). The old reader must parse the new message, so check that nothing old rejects it.
- **Mutation check:** drop the field from one side and watch the round trip fail; delete the new fixture and watch the coverage test fail.

## Done

- Rust, zod, fixtures, `codes.json`/`enums.json` and the interface doc change together.
- New fields are optional, new variants gated, and renames staged.
- Both suites and the fuzz seeds pass.
- The mixed-version window and the shim's removal release are written down.
