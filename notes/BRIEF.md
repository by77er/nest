# Shared brief for doc-audit subagents

Repo: /workspace/nest (branch task/tsk_4e1r3a0i1i395t09). Do NOT commit, amend, reset, push, switch branches, or stash. Other agents edit other files in the same checkout at the same time.

Goal: the docs say only what the code on main bears out. Code is truth for what is built and how it behaves; docs are truth for design intent.

Method:
1. Read each assigned doc IN FULL. Read /workspace/nest/AGENTS.md "Docs" section and .claude/skills/nest-host/SKILL.md (and nest-infra for compute) for where things live.
2. For every checkable claim (names of types/files/functions/config keys/env vars/flags/nftables & cgroup names/S3 key layouts/systemd units; fields with type & optionality; defaults; limits; timeouts; instance types and sizes; Built / Not built / Designed status; relative links and anchors) find the code that confirms or contradicts it. Grep crates/, deploy/, control-plane/src/, images/, protocol/. For external links, check they look plausible; WebFetch only a few if doubtful.
3. Fix contradictions by editing ONLY your assigned files, minimally, in the doc's existing style. Succinct: decision + brief rationale. NO tombstones: never write "previously", "formerly", "renamed from", "used to", "no longer", "removed", "was removed", "now" in the sense of a change. Say what is true.
4. A design not built stays, marked not built (don't delete it; don't mark anything built without finding its code). If the doc marks something built and you cannot find code, mark it not built only if you are sure it's absent; else list as unconfirmed.
5. Change NO code/config/tests. If a doc states a decision/invariant and the code breaks it in a way that looks like a code bug, leave both alone and report it.
6. Anything you can't confirm either way: don't guess in the docs; report it. Measured numbers (boot times, sizes, costs) are confirmed only if a record in dev/measure-cut/, dev/cloud-checks/ or e2e/FINDINGS.md backs them; otherwise report them as unconfirmed (leave the text).
7. Don't edit parent READMEs you weren't assigned; instead report the exact summary line in a parent (docs/sandbox/README.md, docs/README.md, docs/architecture/README.md, other parents) that repeats a fact you corrected, with the suggested replacement.
8. Drift in docs outside your files (docs/interfaces/, docs/control-plane/, docs/security/, crates/*/README.md, deploy/README.md, etc.): report, don't edit.

Output: write your report to /workspace/findings/<your-group>.md with these sections:
- Corrections: table rows `| doc:line | what it said | what the code says | evidence file:line |` (one per fix you made).
- Parent summary lines to update (file:line, current text, suggested text).
- Unconfirmed claims: `doc:line — claim — what you looked at`.
- Suspected code bugs.
- Drift outside the area.
- Docs with no drift.
Your final message: a short summary plus the path of the report.

## Output (overrides the above)
Write your report to /workspace/nest/notes/<slug>.md (slug given in your prompt), not /workspace/findings. Create it in your first minutes and append each finding as you confirm it: the sandbox can be moved at any time, killing you; the parent commits this file periodically. Already-verified edits may exist in your file (`git diff origin/main -- <file>`); re-check any you rely on.
