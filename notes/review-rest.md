# Review: docs (rest, excl. networking)

Format: severity | doc:line | problem | evidence

## Findings

- **high** | docs/architecture/README.md:87 | New "(and what was lost: designed)" marks as unbuilt something that is built: the brain is told what the move lost. It also now contradicts line 65 of the same doc ("SandboxDO tells each attached agent when the sandbox moves (a new host or epoch, and what was lost)"). Only the SandboxDO *loss record* is unbuilt (already said by "loss records are designed"). | control-plane/src/do/agent.ts:2025-2035 (mid-turn systemNote on move), agent.ts:2041-2051 `movedNote`: "Your sandbox moved to another machine and was restored from its state saved at <T> ... File changes after that were lost."; sandbox.ts:880-891 `sendMoveNotices` -> `onSandboxMoved`.
- **high** | docs/sandbox/fencing/README.md:50 | New "(not built)" on "the brain ... re-resolves its binding and is told what was lost" is wrong: built, via AgentDO `movedNote` (told mid-turn, else at its next turn through `pump`). | control-plane/src/do/agent.ts:2025-2051
- **medium** | docs/sandbox/fencing/README.md:27 | "(not built: the move notice carries only the new epoch and host)" is literally true of SandboxDO's notice (sandbox.ts:886 `onSandboxMoved(sandbox, epoch, host)`) but implies agents learn nothing of the loss; AgentDO derives it from the head generation and tells the brain (agent.ts:2041-2051). Say instead that the explicit loss record isn't built and agents are told the head they were restored from. | control-plane/src/do/sandbox.ts:880-891; agent.ts:2041-2051; no `losses` in control-plane/src (grep).
