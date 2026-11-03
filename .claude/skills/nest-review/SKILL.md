---
name: nest-review
description: Use when reviewing a nest pull request or diff (code, docs, tests, contracts, dependencies), as the reviewer agent or for the owner. A checklist of what must hold before the review check passes; frontend design is judged separately by nest-design-review.
---

# Reviewing a nest change

Review from the diff, the task and the repo, never the author's transcript. Run the checks yourself (`nest-validation`). Pass, or fail with specific reasons; don't approve "with nits", list them as comments. A frontend change also needs a design review PASS (`nest-design-review`); this review doesn't judge design.

1. **Invariants:** every invariant in `AGENTS.md` still holds. A change near them keeps `scripts/check-fences.py` passing without widening `scripts/fences.toml`; a widened fence needs the owner.
2. **Kernel scope:** nothing app-specific enters the platform. A client, app or provider that seems to need a special case means the generic interface is wrong: fix the interface, don't add the case ([principle 9](../../../docs/README.md#principles)).
3. **Docs** follow `AGENTS.md`'s Docs rules: the decision in the lowest owning doc with its summaries updated, open questions also in `docs/README.md`, external facts sourced or marked unverified, no tombstones, this repo's process in `dev/`.
4. **Tests** follow `nest-tests`: each can fail, the PR says what was mutation-checked, claims name their evidence tier, skipped tests are called out.
5. **Contracts:** a wire change updates `protocol/fixtures/` and the interface doc and stays compatible with old peers; stored data and the wire stay readable by the previous release (`nest-wire`). A change to a modelled handler updates the conformance doc or the spec (`nest-verification`).
6. **Subsystem rules:** check the skill for each area the diff touches (`nest-control-plane`, `nest-host`, `nest-infra`).
7. **Dependencies:** a new or bumped crate or package says why, passes `cargo deny check` (Rust), and needs the owner (`CODEOWNERS`).
8. **[Review lessons](../../../dev/review-lessons.md):** check the change against each. A finding that recurs becomes a proposed lesson.
9. **Scope:** one concern per PR; unrelated cleanups go elsewhere.
