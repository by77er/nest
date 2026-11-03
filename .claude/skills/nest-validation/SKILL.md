---
name: nest-validation
description: Use before claiming that a nest change works, is safe, or is verified, and when choosing which checks to run. Says which runs prove what, so no claim outruns its evidence.
---

# Validating a nest change

1. **Run the fast checks for what you touched:**
   - Rust: `cargo clippy --workspace --all-targets --locked -- -D warnings` and `cargo test -p <crate>`;
   - control plane: `cd control-plane && npm run typecheck && npm test`;
   - an app (`dashboard/`, `projects/`): `npm ci && npm run typecheck && npm test && npm run build` in it; for a UI change also `scripts/ui-review/` (its README);
   - repo guards: `python3 -I scripts/check-doc-links.py`, `python3 -I scripts/check-fences.py`, and `python3 -m unittest discover -s scripts/tests`;
   - the subsystem's own checks (model checks, Kani, mutants, fuzz replay, `inframe test`, the bootstrap test): `nest-control-plane`, `nest-host`, `nest-wire`, `nest-infra`, `nest-verification`.

   Read each command's exit code, not its counts: a vitest run can report every test passed and still exit 1.
2. **Run `e2e/run.sh`** when a change crosses components (runner, nestd, proxy, gateway, guest, control plane), with a short work path: `NEST_E2E_WORK=/var/tmp/nest-e2e-<tag>`. Unix-socket paths are limited to 108 bytes, and the directory is deleted at each start.
3. **Name the evidence tier in every claim** (the tiers and what each can't prove: `dev/practices.md#evidence-tiers`). Never claim:
   - Firecracker, snapshot, real-vsock, tunnel or Access behaviour from the process driver (it does prove the gateway's WebSocket-to-vsock path on one host, not across machines);
   - real Claude Code behaviour from `fake_claude.py`;
   - live-data or Access behaviour of an app from `scripts/ui-review/`, which runs `vite dev` against fixtures.
4. **For a fix or an invariant, mutation-check it:** break the code, watch the owning test fail, restore. Say what you mutated.
5. **A skipped test is not a pass.** Look for `NEST-TEST-SKIP:` lines, and say which tests skipped and why.
6. **Report failures with their output.** If a check can't run here (no KVM, no token), say so; don't substitute a weaker one silently.
