# Sessions (stored outside the sandbox)

**There's one artifact: Claude Code's native session file.** It's written on the host, outside every VM, so the agent's commands can't tamper with it.

```
claude writes $CLAUDE_CONFIG_DIR/projects/…/<session>.jsonl (path from SessionStart's transcript_path)
  → agent runner tails it (inotify + offset), redacts known secrets
  → WebSocket per agent → AgentDO
       ├─ live fan-out to subscribers
       └─ buffered → R2 segments (every 5 s while working, 30 s otherwise), acknowledged by offset after the flush
```

- **Stored raw,** because it's exactly what `--resume` needs. When a brain moves to another host, the runner rebuilds the file from R2 (through Worker-signed URLs) and passes its path to `--resume`.
- **Normalized on read** for the UI, `nest logs` and agents' `read_transcript`. Reads never wake anything.
- **Rewrites:** if the file shrinks or its inode changes (e.g. from `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` trimming after compaction), it's re-uploaded as a new base segment.
- **Fenced** by `(agent, epoch)`. Segments from a stale host go to the orphan branch.
- **Why not rebuild resume files from captured API traffic?** Claude Code's JSONL is an internal, versioned format with data the API traffic doesn't carry (uuid chains, structured tool results, compaction boundaries, subagent sidechains). Rebuilding it would break on Claude Code updates, and the native file is already trustworthy.
- **No proxy decrypts model traffic.** A wire-level debug tap could be added later if it's ever needed.
