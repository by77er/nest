---
name: nest-review
description: Use when reviewing a nest pull request or diff, as the reviewer agent or for the owner. A checklist of what must hold before the review check passes.
---

# Reviewing a nest change

Review from the diff, the task and the repo, never the author's transcript. Run the checks yourself (the `nest-validation` skill). Fail the review with specific reasons, or pass it. Don't approve "with nits"; list them as comments.

1. **Invariants (`AGENTS.md`):**
   - the subscription token never enters a VM;
   - Claude Code runs unmodified with documented flags;
   - no proxy decrypts OAuth traffic;
   - agent logic stays in the control plane;
   - no roles or workstreams in the platform.

   A change near these must keep `scripts/check-fences.py` passing without widening `scripts/fences.toml`. A widened fence needs the owner.
2. **Docs:**
   - a decision is recorded in the lowest doc that owns it, and the summaries above it are updated;
   - open questions also appear in `docs/README.md`;
   - external facts link a source or say unverified;
   - no tombstones;
   - this repo's own process belongs in `dev/`, not `docs/`.
3. **Tests** follow the `nest-tests` skill:
   - each one can fail, and the PR says what was mutation-checked;
   - claims name their evidence tier;
   - skipped tests are called out.
4. **Contracts:** a wire change updates `protocol/fixtures/` and the interface doc. Old peers stay compatible as the interface doc requires (a guest version range, additive fields).
   - Stored data and the wire stay readable by the previous release (`wrangler rollback`), and new host behaviour is gated by a capability flag (the `nest-wire` skill).
   - A change to a modelled handler updates the conformance doc or the spec (the `nest-verification` skill).
   - Check the rules of the subsystem skill for each area the diff touches: `nest-control-plane`, `nest-host`, `nest-infra`.
5. **Dependencies:** a new or bumped crate or package says why, passes `cargo deny check`, and needs the owner (`CODEOWNERS`).
6. **[Review lessons](../../../dev/review-lessons.md):** check the change against each lesson. If a finding recurs, propose a new lesson.
7. **Scope:** one concern per PR; unrelated cleanups go elsewhere.
