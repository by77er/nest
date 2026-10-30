#!/usr/bin/env bash
# Runs inside `unshare --user --map-root-user --mount` (started by run.py). The host network is
# shared, so nest-proxy reaches the internet and nestd reaches the local control plane on 127.0.0.1;
# nestd creates the per-sandbox netns (owned by this user namespace) itself.
set -euo pipefail
: "${WORK:?}" "${BIN:?}" "${E2E:?}" "${NEST_E2E_GATEWAY_PORT:?}"
mkdir -p "$WORK/logs"
trap 'kill $(jobs -p) 2>/dev/null; wait' EXIT TERM INT

# Real-Claude mode (NEST_E2E_CLAUDE=real): Claude Code reads /etc/claude-code/managed-settings.json.
# This mount namespace is private, so the host's /etc and the invoking user's ~/.claude are untouched:
# /etc gets an overlay when /etc/claude-code doesn't exist, and ~/.claude{,.json} are masked read-only.
if [ -n "${NEST_E2E_MANAGED_SETTINGS_DIR:-}" ]; then
    if [ ! -d /etc/claude-code ]; then
        mkdir -p "$WORK/etc-overlay/upper" "$WORK/etc-overlay/work"
        mount -t overlay overlay -o "lowerdir=/etc,upperdir=$WORK/etc-overlay/upper,workdir=$WORK/etc-overlay/work" /etc
        mkdir -p /etc/claude-code
    fi
    mount --bind "$NEST_E2E_MANAGED_SETTINGS_DIR" /etc/claude-code
    mkdir -p "$WORK/mask/dir" && touch "$WORK/mask/file"
    for p in "$HOME/.claude" "$HOME/.claude.json"; do
        if [ -d "$p" ]; then mount --bind "$WORK/mask/dir" "$p"; elif [ -f "$p" ]; then mount --bind "$WORK/mask/file" "$p"; else continue; fi
        mount -o remount,bind,ro "$p"
    done
fi

NEST_LOG=info "$BIN/nest-proxy" --nestd-sock "$WORK/run/proxy.sock" >"$WORK/logs/proxy.log" 2>&1 &
echo $! >"$WORK/proxy.pid"

# The sandbox host's nestd (run/, state/) and the brain host's (brun/, bstate/): two hosts that
# share this machine but nothing else; the runner reaches the guest only through the gateway.
RUST_LOG=info,nestd=debug "$BIN/nestd" --config "$WORK/nestd.json" >"$WORK/logs/nestd.log" 2>&1 &
echo $! >"$WORK/nestd.pid"
RUST_LOG=info,nestd=debug "$BIN/nestd" --config "$WORK/nestd-brain.json" >"$WORK/logs/nestd-brain.log" 2>&1 &
echo $! >"$WORK/nestd-brain.pid"

# The sandbox gateway: the only way the runner's hands reach the guest. It connects to nestd's
# gateway socket and listens on loopback; the runner learns its URL from the control plane.
for _ in $(seq 100); do [ -S "$WORK/run/gateway.sock" ] && break; sleep 0.1; done
RUST_LOG=info,nest_gateway=debug "$BIN/nest-gateway" --listen "127.0.0.1:$NEST_E2E_GATEWAY_PORT" \
    --nestd-sock "$WORK/run/gateway.sock" >"$WORK/logs/gateway.log" 2>&1 &
echo $! >"$WORK/gateway.pid"
for _ in $(seq 100); do
    kill -0 "$(cat "$WORK/gateway.pid")" 2>/dev/null || { echo "nest-gateway died (port $NEST_E2E_GATEWAY_PORT taken?)" >&2; exit 1; }
    timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$NEST_E2E_GATEWAY_PORT" 2>/dev/null && break
    sleep 0.1
done

# Wait for the brain host's runner socket before starting the runner there.
for _ in $(seq 100); do [ -S "$WORK/brun/runner.sock" ] && break; sleep 0.1; done

env NEST_RUNNER_NESTD_SOCK="$WORK/brun/runner.sock" \
    NEST_RUNNER_HOOK_DGRAM="$WORK/runner/hook.dgram" \
    NEST_RUNNER_HOOK_SOCK="$WORK/runner/hook.sock" \
    NEST_RUNNER_MCP_SOCK="$WORK/runner/mcp.sock" \
    NEST_RUNNER_CLAUDE_BIN="${NEST_E2E_CLAUDE_BIN:-$E2E/fake_claude.py}" \
    NEST_RUNNER_NEST_BIN="$BIN/nest" \
    NEST_RUNNER_CWD="${NEST_E2E_RUNNER_CWD:-$WORK/runner/cwd}" \
    NEST_RUNNER_IDLE_GRACE_MS=600000 \
    NEST_RUNNER_BATCH_MS=500 \
    RUST_LOG=info,nest_runner=debug \
    "$BIN/nest-runner" >"$WORK/logs/runner.log" 2>&1 &
echo $! >"$WORK/runner.pid"

echo ready >"$WORK/inner.ready"
wait
