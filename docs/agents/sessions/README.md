# Sessions (stored outside the sandbox)

**There's one artifact: Claude Code's native session directory** (built: its main JSONL; below). It's written on the brain host, outside every VM and away from every sandbox host, so the agent's commands can't tamper with it. Anthropic's Agent SDK [`SessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) mirrors the same files the same way; nest's copy is stronger, because nothing is acknowledged before it's durable.

```
claude writes $CLAUDE_CONFIG_DIR/projects/…/<session>.jsonl, plus subagents/ and sidecar files
  → agent runner tails the main JSONL (polled every 500 ms, by offset), redacts known secrets
  → WebSocket per agent → AgentDO
       ├─ live fan-out to readers
       ├─ SQLite buffer (seg_buffer)
       └─ R2 segment at 1 MiB buffered, within 5 s of new bytes while working (30 s otherwise),
          and before any start → acknowledged by offset
```

- **The whole directory, not one file (designed, not built):** each stream is keyed by its relative path (the main JSONL, `subagents/agent-<id>`, sidecars) and deduplicated by entry uuid. Resume would otherwise lose subagent context. Built: the main JSONL only (`crates/nest-runner/src/tailer.rs`).
- **Acknowledged once in R2:** received bytes wait in AgentDO's SQLite until a flush writes them to R2 as one segment; only then does the runner get `segment_ack` for them, and it keeps unacknowledged bytes to send again. Each flush is one PUT.
- **The R2 copy is authoritative.** Local transcripts age out after 30 days by default ([sessions](https://code.claude.com/docs/en/sessions)), which is shorter than an agent may wait, and the format is internal and changes between versions. Bytes are stored verbatim, and resume is tested on every Claude Code upgrade.
- **Stored raw,** because it's exactly what `--resume` needs. When a brain starts on another brain host, the runner rebuilds the file from R2 (through Worker-signed URLs) and passes the file to `--resume`.
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
- **Recovery context (designed, not built):** a `SessionStart` hook adds what the model can't know (built: the recovery turn's notes say where the durable transcript ends; the runner's `SessionStart` hook adds nothing to the context):
  - **In-flight hands calls,** from the [hands journal](../hands/#journal). Each is looked up through the gateway in the guest's call records at brain start, so it reads as finished (exit status, output path), killed by the hangup (output so far), not started, or, only when the guest lost its records, unknown.
  - **What changed since:** for each call that didn't finish cleanly, the files modified after its intent, from the guest's [change ledger](../../sandbox/guest-agent/#change-ledger), marked incomplete when the ledger overflowed or doesn't reach back that far.
  - **A workspace rollback:** each sandbox generation records the session offset and last `tool_use` uuid it covers. After a disk-only restore, the notice says which calls after that point may be undone (see [sandbox state](../../sandbox/state/)).
