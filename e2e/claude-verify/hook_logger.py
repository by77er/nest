#!/usr/bin/env python3
"""Hook command for the claude-verify probes (wired in through the probe's managed settings).

    hook_logger.py <log.jsonl> [<decisions.json>]

Appends one JSON line per invocation to <log.jsonl>: wall-clock time, the raw hook input, and a
summary of the environment Claude Code gave the hook (see `env_summary`). Paths come from argv,
never the environment, because whether the subprocess env scrub keeps variables is under test.

Output: `PreToolUse` answers like nest's runner does for an allowed call (`allow`) unless
<decisions.json> says otherwise: {"PreToolUse": ["defer", "allow"]} answers the first call with
`defer`, the second with `allow`, and repeats the last entry after that (the counter lives in
<decisions.json>.state). Every other event prints nothing. Always exits 0.
"""
import hashlib, json, os, sys, time

WATCHED = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")


def env_summary(env):
    """What reached the subprocess, without writing secrets: every name, the NEST_* values (socket
    paths and ids), and a short SHA-256 of every value so the orchestrator can spot the OAuth token
    under any name by comparing hashes."""
    return {
        "names": sorted(env),
        "nest": {k: v for k, v in sorted(env.items()) if k.startswith("NEST_")},
        "present": {k: k in env for k in WATCHED},
        "sha256_16": {k: hashlib.sha256(v.encode()).hexdigest()[:16] for k, v in env.items()},
    }


def next_decision(decisions_path, event):
    """The configured decision for this call of `event` (None = default)."""
    if not decisions_path or not os.path.exists(decisions_path):
        return None
    with open(decisions_path) as f:
        seq = json.load(f).get(event)
    if not seq:
        return None
    state_path = decisions_path + ".state"
    try:
        with open(state_path) as f:
            state = json.load(f)
    except (FileNotFoundError, ValueError):
        state = {}
    n = state.get(event, 0)
    state[event] = n + 1
    with open(state_path, "w") as f:
        json.dump(state, f)
    return seq[min(n, len(seq) - 1)]


def output_for(event, decision):
    if event != "PreToolUse":
        return None
    decision = decision or "allow"
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                   "permissionDecisionReason": f"claude-verify probe: {decision}"}}


def main(argv):
    if len(argv) < 2:
        print("usage: hook_logger.py <log.jsonl> [<decisions.json>]", file=sys.stderr)
        return 0
    log_path = argv[1]
    decisions = argv[2] if len(argv) > 2 else None
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {"_unparsed": raw[:2000]}
    event = data.get("hook_event_name", "") if isinstance(data, dict) else ""
    decision = next_decision(decisions, event)
    out = output_for(event, decision)
    entry = {"ts": time.time(), "pid": os.getpid(), "ppid": os.getppid(), "cwd": os.getcwd(), "event": event,
             "input": data, "env": env_summary(dict(os.environ)), "output": out}
    with open(log_path, "a") as f:
        f.write(json.dumps(entry) + "\n")
    if out is not None:
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
