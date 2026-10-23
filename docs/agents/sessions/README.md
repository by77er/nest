# Sessions (stored outside the sandbox)

**There's one artifact: Claude Code's native session directory.** It's written on the brain host, outside every VM and away from every sandbox host, so the agent's commands can't tamper with it. Anthropic's Agent SDK [`SessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) mirrors the same files the same way; nest's copy is stronger, because nothing is acknowledged before it's durable.

```
claude writes $CLAUDE_CONFIG_DIR/projects/…/<session>.jsonl, plus subagents/ and sidecar files
  → agent runner tails each file (inotify + offset), redacts known secrets
  → WebSocket per agent → AgentDO
       ├─ live fan-out to readers
       ├─ SQLite (durable on commit) → acknowledged by offset
       └─ R2 segments at 1 MiB, at turn end, after 30 s idle, and before any start
```

- **The whole directory, not one file:** each stream is keyed by its relative path (the main JSONL, `subagents/agent-<id>`, sidecars) and deduplicated by entry uuid. Resume would otherwise lose subagent context.
- **Acknowledged after the SQLite commit:** Durable Objects storage is durable once a write commits, so R2 holds the resume copy, not the durability. That saves a PUT every few seconds per working agent.
- **The R2 copy is authoritative.** Local transcripts age out after 30 days by default ([sessions](https://code.claude.com/docs/en/sessions)), which is shorter than an agent may wait, and the format is internal and changes between versions. Bytes are stored verbatim, and resume is tested on every Claude Code upgrade.
- **Stored raw,** because it's exactly what `--resume` needs. When a brain starts on another brain host, the runner rebuilds the directory from R2 (through Worker-signed URLs) and passes the file to `--resume`.
- **Normalized on read** for the UI, `nest logs` and agents' `read_transcript`. Reads never wake anything.
- **Rewrites:** if a file shrinks or its inode changes (e.g. from `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` trimming after compaction), it's re-uploaded as a new base segment.
- **Fenced** by `(agent, epoch)`. Segments from a stale host go to the orphan branch.
- **Why not rebuild resume files from captured API traffic?** Claude Code's JSONL carries data the API traffic doesn't (uuid chains, structured tool results, compaction boundaries, subagent sidechains). Rebuilding it would break on Claude Code updates, and the native file is already trustworthy.
- **No proxy decrypts model traffic.** A wire-level debug tap could be added later if it's ever needed.

## After a crash

- **Claude Code's own interrupted-turn handling:** on resume, a cut-off tool call is shown to the model as interrupted, with an instruction to check whether it took effect before re-running it ([sessions](https://code.claude.com/docs/en/sessions)).
- **One way to continue:** AgentDO's `recovery` turn ([AgentDO](../../control-plane/durable-objects/agent/)). `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` also continues a turn ([env vars](https://code.claude.com/docs/en/env-vars); verified under stream-json), but never both: it would run the turn alongside the recovery turn, and only the recovery turn can say what the transcript can't. The runner never sets it, and a test checks the environment and managed settings.
- **Subagents restart, they don't resume** (Claude Code 2.1.301, host-reboot drill on EC2, 2026-10-17): after `--resume`, an `Agent` (Task) call that was mid-run reads as interrupted with an unknown outcome, and the parent checks and runs the subagent again from the start. A subagent's work is therefore kept only as far as the workspace's last generation; long delegated work should be safe to re-run, or go to a separate agent.
- **The transcript can trail the workspace:** bytes not yet durable are lost with the host, while their tool calls' effects stay in the sandbox. The recovery turn names where the durable transcript ends; until the hands journal exists, that time is the reconciliation.
- **Recovery context:** a `SessionStart` hook adds what the model can't know:
  - **In-flight hands calls,** from the [hands journal](../hands/#journal). Each is looked up through the gateway in the guest's call records at brain start, so it reads as finished (exit status, output path), killed by the hangup (output so far), not started, or, only when the guest lost its records, unknown.
  - **What changed since:** for each call that didn't finish cleanly, the files modified after its intent, from the guest's [change ledger](../../sandbox/guest-agent/#change-ledger), marked incomplete when the ledger overflowed or doesn't reach back that far.
  - **A workspace rollback:** each sandbox generation records the session offset and last `tool_use` uuid it covers. After a disk-only restore, the notice says which calls after that point may be undone (see [sandbox state](../../sandbox/state/)).
