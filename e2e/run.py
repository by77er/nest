#!/usr/bin/env python3
"""nest local end-to-end harness. See e2e/README.md.

Runs the real control plane (wrangler dev --local) and the real host components (nest-proxy, nestd
with the `process` driver running nest-guest, nest-runner with a FAKE claude) inside an
unprivileged user namespace, then drives a scenario through the admin API and checks the results.
The real `claude` binary is never invoked.
"""
import json, os, re, shutil, signal, subprocess, sys, time, urllib.error, urllib.request

E2E = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(E2E)
WORK = os.environ.get("NEST_E2E_WORK", os.path.join(E2E, ".work"))
BIN = os.path.join(ROOT, "target", "e2e", "release")
PORT = int(os.environ.get("NEST_E2E_PORT", "18787"))
BASE = f"http://127.0.0.1:{PORT}"
ADMIN = "e2e-admin-token"
FENCE_BUDGET_S = float(os.environ.get("NEST_E2E_FENCE_BUDGET_S", "30"))

PROCS = {}
RESULTS = []  # (name, ok, detail)


# ---------------------------------------------------------------------------------- helpers
def log(msg):
    print(f"[e2e {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    log(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")
    return ok


def skip(name, why):
    RESULTS.append((name, None, why))
    log(f"SKIP {name} — {why}")


def api(method, path, body=None, raw=False, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"authorization": f"Bearer {ADMIN}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode()
            return r.status, (text if raw else (json.loads(text) if text else None))
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text


def wait_for(fn, timeout, interval=0.25, what=""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 - polling
            last = e
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {what}: last={last!r}")


def read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def inner_pid():
    return PROCS["inner"].pid


def in_userns(cmd, netns=None, timeout=20):
    """Run a command inside the harness user+mount namespace (optionally a sandbox netns)."""
    args = ["nsenter", "-t", str(inner_pid()), "--user", "--mount", "--preserve-credentials"]
    if netns:  # the persisted netns bind mount only exists inside the harness mount namespace
        args += ["nsenter", f"--net={netns}"]
    return subprocess.run(args + cmd, capture_output=True, text=True, timeout=timeout)


def pid_of(name):
    try:
        return int(read(os.path.join(WORK, f"{name}.pid")).strip())
    except ValueError:
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, TypeError):
        return False
    except PermissionError:
        return True


def proc_state(pid):
    m = re.search(r"^State:\s+(\S)", read(f"/proc/{pid}/status"), re.M)
    return m.group(1) if m else None


def children_named(pattern):
    out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) != os.getpid()]


# ---------------------------------------------------------------------------------- setup
def build():
    log("building release binaries (CARGO_TARGET_DIR=target/e2e)")
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target", "e2e"))
    subprocess.run(["cargo", "build", "--release", "-q", "-p", "nestd", "-p", "nest-proxy", "-p", "nest-guest",
                    "-p", "nest-runner", "-p", "nest-cli"], cwd=ROOT, env=env, check=True)
    if not os.path.exists(os.path.join(ROOT, "control-plane", "node_modules")):
        subprocess.run(["npm", "install", "--silent"], cwd=os.path.join(ROOT, "control-plane"), check=True)


def prepare_work():
    shutil.rmtree(WORK, ignore_errors=True)
    for d in ["logs", "run", "state", "netns", "runner/cwd", "files", "guest-state", "wrangler-state"]:
        os.makedirs(os.path.join(WORK, d), exist_ok=True)
    with open(os.path.join(WORK, "dev.vars"), "w") as f:
        f.write(f"ADMIN_TOKEN={ADMIN}\nHOST_TOKEN_SECRET=e2e-host-token-secret-0123456789abcdef\nALLOW_DEV_CA=1\n")


def start_control_plane():
    log(f"starting wrangler dev --local on :{PORT}")
    logf = open(os.path.join(WORK, "logs", "wrangler.log"), "w")
    env = dict(os.environ, WRANGLER_SEND_METRICS="false", CI="1")
    PROCS["wrangler"] = subprocess.Popen(
        ["npx", "wrangler", "dev", "--local", "--port", str(PORT), "--ip", "127.0.0.1",
         "--persist-to", os.path.join(WORK, "wrangler-state"), "--env-file", os.path.join(WORK, "dev.vars"),
         "--var", f"PUBLIC_BASE_URL:{BASE}", "--var", "ASK_SYNC_WINDOW_MS:5000",
         "--show-interactive-dev-session=false", "--log-level", "info"],
        cwd=os.path.join(ROOT, "control-plane"), stdout=logf, stderr=subprocess.STDOUT, env=env,
        start_new_session=True)
    wait_for(lambda: api("GET", "/v1/health")[0] == 200, 90, 0.5, "control plane health")


def stop_control_plane():
    p = PROCS.get("wrangler")
    if p and p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)


def configure_host():
    st, tok = api("POST", "/v1/admin/enrollment-tokens", {"role": "burst", "cell": "local"})
    assert st == 200, (st, tok)
    with open(os.path.join(WORK, "enroll.token"), "w") as f:
        f.write(tok["token"])
    st, ca = api("GET", "/v1/admin/root-ca", raw=True)
    assert st == 200 and "BEGIN CERTIFICATE" in ca, (st, ca)
    with open(os.path.join(WORK, "root-ca.pem"), "w") as f:
        f.write(ca)
    st, r = api("PUT", "/v1/admin/secrets/claude_oauth_token", {"value": "fake-e2e-oauth-token-not-real"})
    assert st == 200, (st, r)
    guest = [os.path.join(BIN, "nest-guest"), "--state-dir", os.path.join(WORK, "guest-state"),
             "--cgroup-root", "none", "--cli-socket", "none", "--run-as", "none", "--port-poll-ms", "500"]
    cfg = {
        "role": "burst", "cell": "local", "control_url": BASE,
        "enrollment": {"type": "token_file", "path": os.path.join(WORK, "enroll.token")},
        "run_dir": os.path.join(WORK, "run"), "state_dir": os.path.join(WORK, "state"),
        "driver": {"type": "process", "guest_command": guest},
        "network": {"type": "netns", "persist_dir": os.path.join(WORK, "netns")},
        "flush_interval_ms": 500,
        "versions": {"nest_proxy": "e2e", "agent_runner": "e2e", "claude_code": "fake"},
    }
    with open(os.path.join(WORK, "nestd.json"), "w") as f:
        json.dump(cfg, f, indent=2)


def start_inner():
    log("starting nest-proxy, nestd, nest-runner inside `unshare --user --map-root-user --mount`")
    env = dict(os.environ, WORK=WORK, BIN=BIN, E2E=E2E)
    logf = open(os.path.join(WORK, "logs", "inner.log"), "w")
    PROCS["inner"] = subprocess.Popen(
        ["unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", "bash", os.path.join(E2E, "inner.sh")],
        env=env, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    wait_for(lambda: os.path.exists(os.path.join(WORK, "inner.ready")), 30, 0.2, "inner ready")


def stop_inner():
    p = PROCS.get("inner")
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(10)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    # Guests/brains may have been re-parented; sweep anything under WORK.
    for pat in [os.path.join(BIN, "nest-guest"), os.path.join(E2E, "fake_claude.py"), os.path.join(BIN, "nest") + " mcp"]:
        for pid in children_named(pat):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# ---------------------------------------------------------------------------------- scenario
INJECT_PLACEHOLDER = "nest-ph-httpbin-e2e01"
INJECT_SECRET = "s3cret-e2e-token-7Qz9-longer"  # longer than the placeholder, so the masked length proves substitution
E2E_POLICY = {
    "allow": [{"host": "httpbin.org", "ports": [443]}],
    "inject": [{"name": "httpbin", "hosts": ["httpbin.org"], "placeholder": INJECT_PLACEHOLDER,
                "locations": [{"type": "authorization_bearer"}]}],
}

def scenario(sbx_dir):
    ca = os.path.join(WORK, "root-ca.pem")
    f = os.path.join(WORK, "files", "hello.txt")
    steps = [
        ("pwd", "Bash", {"command": "pwd"}),
        ("set_state", "Bash", {"command": f"export E2E_VAR=persisted && cd {WORK}/files"}),
        ("persist", "Bash", {"command": "echo \"var=$E2E_VAR cwd=$(pwd)\""}),
        ("env", "Bash", {"command": "echo \"agent=$NEST_AGENT_ID proxy=$HTTPS_PROXY\""}),
        ("allowed", "Bash", {"command": f"curl -s -m 20 --cacert {ca} https://registry.npmjs.org/ -o /dev/null -w '%{{http_code}}'"}),
        ("denied", "Bash", {"command": f"curl -s -m 20 --cacert {ca} https://example.com/ -w '\\nhttp=%{{http_code}}'; echo \" rc=$?\""}),
        ("inject", "Bash", {"command": f"curl -s -m 20 --cacert {ca} -H 'Authorization: Bearer {INJECT_PLACEHOLDER}' https://httpbin.org/headers -w '\\nhttp=%{{http_code}}'"}),
        ("direct", "Bash", {"command": "curl --noproxy '*' -sk -m 5 https://1.1.1.1/ -o /dev/null -w '%{http_code}'; echo \" rc=$?\""}),
        ("write", "Write", {"file_path": f, "content": "hello from nest e2e\nsecond line\n"}),
        ("read", "Read", {"file_path": f}),
        ("edit", "Edit", {"file_path": f, "old_string": "second line", "new_string": "edited line"}),
        ("reread", "Read", {"file_path": f}),
        ("notify", "notify", {"to": "user", "message": "hello from the e2e fake claude"}),
    ]
    path = os.path.join(WORK, "scenario.json")
    with open(path, "w") as fh:
        json.dump({"results": os.path.join(WORK, "results.jsonl"),
                   "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    return path, len(steps)


def results_by_label():
    out = {}
    for line in read(os.path.join(WORK, "results.jsonl")).splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["label"]] = r
    return out


def r2_blobs():
    """Every object body in the local R2 bucket (miniflare persists blobs as files)."""
    texts = []
    for root, _, files in os.walk(os.path.join(WORK, "wrangler-state")):
        for name in files:
            p = os.path.join(root, name)
            if "/r2/" in p and not name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
                texts.append(read(p))
    return texts


def run_scenario():
    st, _ = api("PUT", "/v1/admin/secrets/inject:httpbin", {"value": INJECT_SECRET})
    check("injection secret stored", st in (200, 201, 204), str(st))
    st, ws = api("POST", "/v1/workstreams", {"goal": "e2e"})
    assert st == 201, (st, ws)
    wsid = ws.get("workstream") or ws.get("id")
    sbx = wait_for(lambda: (lambda r: r[1] if r[0] == 201 else None)(api("POST", "/v1/sandboxes", {"workstream": wsid, "cell": "local", "policy": E2E_POLICY})),
                   60, 1.0, "sandbox placed on a connected host")
    sbxid = sbx.get("sandbox") or sbx.get("id")
    check("sandbox placed", sbx.get("host"), f"{sbxid} on {sbx.get('host')}")
    netns = os.path.join(WORK, "netns", f"ns-{sbxid}")
    wait_for(lambda: os.path.exists(netns), 20, 0.2, "sandbox netns")

    st, ag = api("POST", "/v1/agents", {"role": "worker", "workstream": wsid, "sandbox": sbxid, "cell": "local"})
    check("agent created + started", st == 201, json.dumps(ag)[:300])
    agid = ag.get("agent") or ag.get("id")

    spath, nsteps = scenario(os.path.join(WORK, "files"))
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {spath}"})
    check("turn enqueued", st == 201, json.dumps(t))

    try:
        wait_for(lambda: len(results_by_label()) >= nsteps or None, 120, 0.5, "scenario tool results")
    except TimeoutError as e:
        check("all tool results returned to fake claude", False, f"{len(results_by_label())}/{nsteps}: {e}")
    res = results_by_label()
    text = lambda k: (res.get(k) or {}).get("text") or ""
    check("Bash pwd", res.get("pwd") and not res["pwd"]["is_error"], text("pwd").strip()[:200])
    check("Bash cwd persists across calls", f"cwd={WORK}/files" in text("persist"), text("persist").strip()[:200])
    check("Bash exported vars do NOT persist (matches Claude Code; host-guest spec)", "var=persisted" not in text("persist"), text("persist").strip()[:200])
    check("exec env (NEST_AGENT_ID, HTTPS_PROXY)", agid in text("env") and "172.16.0.1:" in text("env"), text("env").strip()[:200])
    check("allowed host via proxy → 200", text("allowed").strip().endswith("200"), text("allowed").strip()[:200])
    check("denied host → 403 inside the tunnel", "http=403" in text("denied"), text("denied").strip().replace("\n", " | ")[:200])
    check("denied host → readable JSON reason", "egress_denied" in text("denied"), text("denied").strip().replace("\n", " | ")[:300])
    inj = text("inject")
    check("credential injection: upstream saw the real secret (scrubbed on the way back)",
          "http=200" in inj and INJECT_PLACEHOLDER not in inj and INJECT_SECRET not in inj and ("*" * len(INJECT_SECRET)) in inj,
          inj.strip().replace("\n", " | ")[:300])
    check("direct egress blocked (no route)", " rc=0" not in text("direct"), text("direct").strip()[:200])
    check("Write", res.get("write") and not res["write"]["is_error"], text("write").strip()[:200])
    check("Read", "hello from nest e2e" in text("read"), text("read").strip()[:200])
    check("Edit", res.get("edit") and not res["edit"]["is_error"], text("edit").strip()[:200])
    check("Read after Edit", "edited line" in text("reread"), text("reread").strip()[:200])
    check("platform tool notify", res.get("notify") and not res["notify"]["is_error"], text("notify").strip()[:300])

    # Direct connect from inside the sandbox netns (outside the guest's own tools).
    p = in_userns(["bash", "-c", "ip route; timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo CONNECTED || echo BLOCKED"], netns=netns)
    check("netns: no route out (direct TCP to 1.1.1.1:443 blocked)", "BLOCKED" in p.stdout and "CONNECTED" not in p.stdout,
          (p.stdout + p.stderr).strip().replace("\n", " | ")[:300])
    p = in_userns(["bash", "-c", "timeout 5 bash -c 'exec 3<>/dev/tcp/172.16.0.1/443' && echo OPEN || echo CLOSED"], netns=netns)
    check("netns: proxy listener reachable on 172.16.0.1:443", "OPEN" in p.stdout, (p.stdout + p.stderr).strip()[:200])

    # Session transcript in R2 (via the admin API), agent turns/events.
    def transcript_ok():
        st, tr = api("GET", f"/v1/agents/{agid}/transcript", raw=True)
        return tr if st == 200 and "tool_use" in tr and "scenario done" in tr else None
    try:
        tr = wait_for(transcript_ok, 30, 1.0, "transcript segments in R2")
        check("session transcript stored (R2 via read API)", True, f"{len(tr)} bytes")
    except TimeoutError as e:
        check("session transcript stored (R2 via read API)", False, str(e)[:300])
    st, turns = api("GET", f"/v1/agents/{agid}/turns")
    check("turn completed", st == 200 and '"status": "done"' in json.dumps(turns), json.dumps(turns)[:300])
    st, info = api("GET", f"/v1/agents/{agid}")
    check("agent info", st == 200, json.dumps(info)[:300])
    st, evs = api("GET", f"/v1/workstreams/{wsid}/events")
    evs_s = json.dumps(evs)
    check("workstream events visible", st == 200, evs_s[:300])
    st, notes = api("GET", f"/v1/workstreams/{wsid}/notifications")
    check("notify reached the user-notification queue", st == 200 and "hello from the e2e fake claude" in json.dumps(notes), json.dumps(notes)[:300])

    # Egress audit records (FleetDO writes them to R2 under audit/…).
    def audit():
        blobs = "\n".join(r2_blobs())
        return blobs if "registry.npmjs.org" in blobs and "example.com" in blobs else None
    try:
        blobs = wait_for(audit, 20, 1.0, "egress audit in R2")
        allowed = re.search(r'\{[^{}]*"registry\.npmjs\.org"[^{}]*\}', blobs)
        denied = re.search(r'\{[^{}]*"example\.com"[^{}]*\}', blobs)
        check("egress audit: allowed + denied records", allowed and denied,
              f"allowed={allowed.group(0)[:160] if allowed else None} denied={denied.group(0)[:160] if denied else None}")
    except TimeoutError as e:
        check("egress audit: allowed + denied records", False, str(e)[:200])

    return {"workstream": wsid, "sandbox": sbxid, "agent": agid, "netns": netns}


def run_fencing(ids):
    brains = children_named(os.path.join(E2E, "fake_claude.py"))
    guests = children_named(os.path.join(BIN, "nest-guest"))
    check("pre-fence: brain + guest alive", brains and guests, f"brains={brains} guests={guests}")
    log("stopping the control plane to cut heartbeats")
    t0 = time.time()
    stop_control_plane()
    nestd_log = os.path.join(WORK, "logs", "nestd.log")
    try:
        wait_for(lambda: re.search(r"self[- _]?fenc", read(nestd_log), re.I), FENCE_BUDGET_S, 0.5, "nestd self-fence log")
        dt = time.time() - t0
        check("nestd self-fences after control-plane loss", dt <= 25, f"{dt:.1f}s after cut (spec: ~20s after last sent renewal)")
    except TimeoutError:
        check("nestd self-fences after control-plane loss", False, "no self-fence in nestd.log within budget")
    time.sleep(2)
    left = [p for p in brains if alive(p)]
    check("runner brains killed", not left, f"still alive: {left}")
    states = {p: proc_state(p) for p in guests}
    check("sandbox paused or stopped", all(s in (None, "T", "t", "Z") for s in states.values()), f"guest states {states}")
    p = in_userns(["bash", "-c", "timeout 5 bash -c 'exec 3<>/dev/tcp/172.16.0.1/443' && echo OPEN || echo CLOSED"], netns=ids["netns"]) \
        if os.path.exists(ids["netns"]) else None
    check("proxy listeners dropped / netns removed",
          p is None or "CLOSED" in p.stdout,
          "netns removed" if p is None else (p.stdout + p.stderr).strip()[:200])


def main():
    started = time.time()
    try:
        build()
        prepare_work()
        start_control_plane()
        configure_host()
        start_inner()
        try:
            wait_for(lambda: re.search(r"enrolled", read(os.path.join(WORK, "logs", "nestd.log"))), 30, 0.5, "nestd enrolled")
            check("nestd enrolled + fleet connected", True)
        except TimeoutError as e:
            check("nestd enrolled + fleet connected", False, str(e))
        ids = run_scenario()
        run_fencing(ids)
        skip("transparent :443 interception", "the process driver runs the guest inside the netns itself (no tap0 peer), so nft's tap0 redirect never applies; covered by nestd's netns_redirect_reaches_listener test")
    except Exception as e:  # noqa: BLE001
        check("harness", False, f"{type(e).__name__}: {e}")
    finally:
        stop_control_plane()
        stop_inner()
        passed = sum(1 for _, ok, _ in RESULTS if ok)
        failed = [n for n, ok, _ in RESULTS if ok is False]
        skipped = sum(1 for _, ok, _ in RESULTS if ok is None)
        log(f"done in {time.time() - started:.0f}s: {passed} passed, {len(failed)} failed, {skipped} skipped; logs in {WORK}/logs")
        for n in failed:
            log(f"  failed: {n}")
        with open(os.path.join(WORK, "summary.json"), "w") as f:
            json.dump([{"check": n, "ok": ok, "detail": d} for n, ok, d in RESULTS], f, indent=2)
    sys.exit(1 if any(ok is False for _, ok, _ in RESULTS) else 0)


if __name__ == "__main__":
    main()
