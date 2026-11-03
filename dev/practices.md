# Practices

What makes this repo safe for agents to change and to review. The checks are the source of truth; this page says why they exist, and the [skills](../.claude/skills/) point agents at them without restating them.

## Guards

- **Source fences** (`scripts/fences.toml`, checked by `scripts/check-fences.py`) turn `AGENTS.md`'s invariants from prose into checks. Each fence lists patterns that may appear only in the files it allows:
  - the subscription token's names;
  - the guest's credential-free code;
  - the gateway's and the hands client's credential-free code;
  - Claude Code's launch, and permission bypass;
  - TLS interception;
  - metrics writes.
- **Fence lists only shrink:** an allow entry whose files no longer match is stale and fails.
- **Every guard can fail.** Each fence carries an example line, which `scripts/tests/` plants outside the allowed files and expects to be rejected. The doc-link, core-manifest and workflow checkers get the same treatment. A guard that only ever passes can't be told apart from one that never looks.
- **Loosening a guard is invisible to the guard,** so `scripts/` is in `CODEOWNERS`.

## Tests

- **No silent skips in CI.** A test that needs a privilege (user namespaces) skips locally with a `NEST-TEST-SKIP:` line and fails in CI (`NEST_CI_REQUIRE_USERNS=1`).
- **A re-executed test proves it ran:** the child writes an acknowledgement naming the test and the parent asserts it, so a renamed test can't pass by matching nothing.
- **Mutation-check what you claim:** for a fix or an invariant, break the code on purpose, watch the owning test fail, and restore it. The PR says what was mutated.
- **Test economy** (the `nest-tests` skill):
  - each test sits at the lowest layer that owns the behaviour, with an independent oracle and a reachable regression;
  - no change-detector tests;
  - a test's name is a claim its body can falsify;
  - one table-driven test over an enum, not one test per variant.
- **A waiting check proves its window is long enough:** if the claim depends on a timer (an idle flush, a lease expiry), the wait exceeds it by a margin and says so.

## Evidence tiers

What each kind of run can prove (the `nest-validation` skill). Claims in PRs and docs name their tier.

| Tier | Proves | Doesn't prove |
|---|---|---|
| Unit and integration tests | Logic; wire formats against `protocol/fixtures/` | Real processes, namespaces or VMs |
| `e2e/run.sh` (process driver) | The real components together on one machine, as a sandbox host and a brain host: hands through the gateway's WebSocket-to-vsock path (emulated vsock), bindings minted by the control plane and refused when tampered or fenced, netns egress, injection, fencing | Firecracker, real vsock, snapshots, real Claude Code, the tunnel and Cloudflare Access (nothing leaves the machine), the two hosts on different machines |
| `e2e/claude-verify`, `NEST_E2E_CLAUDE=real` | Real Claude Code's behaviour under nest's flags | Firecracker, scale |
| The [first spike](../docs/README.md#first-spike) and cloud checks on AWS | Firecracker, restore, fencing under partition, the seam (a brain on one host reaching a sandbox on another through Cloudflare's edge and Access and down the tunnel into the gateway, shown by the runner's `wss://` target and the gateway logging each call `bound … via=edge`), brain hosts and autoscaling | Only what a run exercised: name the run and its date |

## Review

- **The reviewer agent applies the `nest-review` skill:**
  - the invariants and doc rules in `AGENTS.md`;
  - test economy;
  - the evidence tiers;
  - the [review lessons](review-lessons.md).
- **Review lessons** are short, standalone lessons from real findings. A finding that recurs becomes a lesson.

## Supply chain

- cargo-deny for advisories, licenses and sources; gitleaks over the full history; the toolchain and actions are pinned (see [ci.md](ci.md)).
- Dependency changes need me (manifests and lockfiles are in `CODEOWNERS`). The PR summarizes how the lockfile changed (`cargo tree -i <crate>` for anything new).

## Planned

- **A nest-proxy attack suite:** the real proxy against local peers in throwaway network namespaces, with cases written as data. Credential cases record which headers matched, never values. It lands with the proxy changes it tests (see [egress](../docs/sandbox/networking/egress/)). Cases:
  - a placeholder sent to the wrong host;
  - routing-override headers (`Fastly-Host`);
  - smuggling: a `Connection:` header naming a protected field, and a non-`chunked` `Transfer-Encoding`;
  - the metadata address on the allowlist, still refused;
  - an open WebSocket after its grant is revoked;
  - NXDOMAIN for unlisted names;
  - QUIC rejected.
- **e2e verdicts:**
  - each check reports PASS, FAIL or INFRA_ERROR (an unreachable `httpbin.org` isn't nest's failure), with evidence and phase timings in `summary.json`;
  - scenarios split by area (hands, egress, injection, fencing) as they grow;
  - a quarantined check needs a reason and shows as a visible hole, never as a pass.
- **Doc structure checks:**
  - every `docs/` directory has a README linked from its parent;
  - every open question recorded in a doc also appears in `docs/README.md`.
