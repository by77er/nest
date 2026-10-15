# Sessions (stored outside the sandbox)

**There's one artifact: Claude Code's native session directory.** It's written on the host, outside every VM, so the agent's commands can't tamper with it. Anthropic's Agent SDK [`SessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) mirrors the same files the same way; nest's copy is stronger, because nothing is acknowledged before it's durable.

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
- **Stored raw,** because it's exactly what `--resume` needs. When a brain moves to another host, the runner rebuilds the directory from R2 (through Worker-signed URLs) and passes the file to `--resume`.
- **Normalized on read** for the UI, `nest logs` and agents' `read_transcript`. Reads never wake anything.
- **Rewrites:** if a file shrinks or its inode changes (e.g. from `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` trimming after compaction), it's re-uploaded as a new base segment.
- **Fenced** by `(agent, epoch)`. Segments from a stale host go to the orphan branch.
- **Why not rebuild resume files from captured API traffic?** Claude Code's JSONL carries data the API traffic doesn't (uuid chains, structured tool results, compaction boundaries, subagent sidechains). Rebuilding it would break on Claude Code updates, and the native file is already trustworthy.
- **No proxy decrypts model traffic.** A wire-level debug tap could be added later if it's ever needed.

## After a crash

- **Claude Code's own interrupted-turn handling first:** on resume, a cut-off tool call is shown to the model as interrupted, with an instruction to check whether it took effect before re-running it ([sessions](https://code.claude.com/docs/en/sessions)). `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues the turn automatically ([env vars](https://code.claude.com/docs/en/env-vars)); whether it works under stream-json input is to be verified. The platform's own `recovery` turn is the fallback.
- **Recovery context:** a `SessionStart` hook adds what the model can't know:
  - **In-flight hands calls,** from the [hands journal](../hands/#journal), each marked done, failed or unknown.
  - **A workspace rollback:** each sandbox generation records the session offset and last `tool_use` uuid it covers. After a disk-only restore, the notice says which calls after that point may be undone (see [sandbox state](../../sandbox/state/)).
