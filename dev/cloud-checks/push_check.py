#!/usr/bin/env python3
"""Live push-allowlist check: a worker on a fresh sandbox (new guest image) allowed to push only to ALLOWED.
Env: NEST_ADMIN_TOKEN, REPO, OTHER_REPO (the owner's, the App installed on both), NEST_GITHUB_APP_ID, NEST_GITHUB_APP_PRIVATE_KEY (for cleanup and verification). Never prints a token."""
import base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

BASE, CELL = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh"), os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ["NEST_ADMIN_TOKEN"]
ALLOWED, OTHER = os.environ.get("REPO", "by77er/nest"), os.environ.get("OTHER_REPO", "by77er/randomc")
NONE = "nest-check-none/does-not-exist"
RUN = time.strftime("r%m%d%H%M%S")
BRANCH = f"nest-check/push-{RUN}"
TPL = "push-check"


def send(req, timeout=60):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t[:300]


def api(method, path, body=None):
    sep = "&" if "?" in path else "?"
    return send(urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=None if body is None else json.dumps(body).encode(), method=method,
                                       headers={"authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"}))


def assistant_texts(agent):
    """The text blocks of the agent's assistant messages, in order, from its session transcript (None: no answer)."""
    texts, since, base = [], 0, None
    for _ in range(50):
        s, v = api("GET", f"/v1/agents/{agent}/transcript?since={since}&limit=500" + (f"&base={base}" if base is not None else ""))
        if s != 200 or not isinstance(v, dict):
            return None
        for line in v.get("lines", []):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and e.get("type") == "assistant":
                for b in (e.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                        texts.append(b["text"])
        if not v.get("more"):
            return texts
        since, base = v.get("next_seq", since), v.get("base")
    return texts


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def app_token(repo):
    """An installation token for one repo (contents write), minted here for verification and cleanup."""
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    now = int(time.time())
    head = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": os.environ["NEST_GITHUB_APP_ID"]}).encode())
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        os.chmod(f.name, 0o600)
        f.write(os.environ["NEST_GITHUB_APP_PRIVATE_KEY"].replace("\\n", "\n") + "\n")
        key = f.name
    try:
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=f"{head}.{claims}".encode(), capture_output=True, check=True).stdout
    finally:
        os.unlink(key)
    jwt = f"{head}.{claims}.{b64(sig)}"
    gh = lambda m, u, b=None, tok=jwt: send(urllib.request.Request(f"https://api.github.com{u}", data=None if b is None else json.dumps(b).encode(), method=m,
                                                                  headers={"authorization": f"Bearer {tok}", "accept": "application/vnd.github+json", "user-agent": "nest-cloud-check/1"}))
    s, inst = gh("GET", f"/repos/{repo}/installation")
    s, t = gh("POST", f"/app/installations/{inst['id']}/access_tokens", {"repositories": [repo.split("/")[1]], "permissions": {"contents": "write"}})
    return lambda m, u, b=None: gh(m, u, b, t["token"])


# A foreign credential that isn't one: the probe must be refused for its repo, not its credential.
FOREIGN = base64.b64encode(b"dummy:" + b"dummy").decode()

SCRIPT = f"""set +e
echo HOSTNAME=$(hostname)
echo GH=$(command -v gh)
echo HELPER=$(command -v git-credential-nest)
case "$GITHUB_TOKEN" in nest-ph-*) echo TOKEN_PLACEHOLDER=yes;; *) echo TOKEN_PLACEHOLDER=no;; esac
cd /tmp && rm -rf pc && git clone -q --depth 1 https://github.com/{ALLOWED}.git pc && cd pc || {{ echo CLONE_FAILED; exit 0; }}
git checkout -q -b {BRANCH} && mkdir -p dev/cloud-checks/.scratch && echo "push check {RUN}" > dev/cloud-checks/.scratch/{RUN}.md
git -c user.name=nest-check -c user.email=nest-check@invalid add -A && git -c user.name=nest-check -c user.email=nest-check@invalid commit -q -m "push check {RUN}"
git push -q origin {BRANCH} 2>/tmp/e1; echo PUSH_ALLOWED_EXIT=$?
probe() {{ curl -s -o /tmp/b -w '%{{http_code}}' "$@"; echo " $(head -c 100 /tmp/b | tr '\n' ' ')"; }}
echo DISCOVERY_OTHER=$(probe 'https://github.com/{OTHER}.git/info/refs?service=git-receive-pack')
echo DISCOVERY_NONE=$(probe 'https://github.com/{NONE}.git/info/refs?service=git-receive-pack')
echo RECEIVE_OTHER=$(probe -X POST -H 'Authorization: Basic {FOREIGN}' -H 'Content-Type: application/x-git-receive-pack-request' --data-binary '0000' 'https://github.com/{OTHER}.git/git-receive-pack')
echo GH_API=$(gh api repos/{ALLOWED} --jq .full_name 2>&1 | tail -c 120)
"""

PROMPT = ("This is the owner's automated test of nest's sandbox network policy, run with the owner's approval. The sandbox may push only "
          f"to {ALLOWED}: the script pushes a throwaway branch there (the check deletes it afterwards) and then sends three plain HTTP probes "
          "that carry no real credential and no data (a push's first request, to the owner's other repo and to a repository that doesn't exist), "
          "which nest's proxy is expected to refuse with 403. Nothing secret is printed. Write the following script to /tmp/check.sh with the "
          "Write tool, run it once with `bash /tmp/check.sh` using Bash, and reply with its complete output verbatim and nothing else.\n\n```bash\n" + SCRIPT + "```")

ok, made = True, {"sandbox": None, "agent": None}
try:
    s, v = api("PUT", f"/v1/admin/templates/{TPL}", {
        "capabilities": ["nest", "hands"], "hands": "required", "credential": "claude_oauth_token:worker", "escalate_to": "workstream",
        "subscribe": [], "params": {},
        "launch": {"model": "haiku", "builtin_tools": [], "system_prompt": {"mode": "append", "text": "You run exactly the commands an automated check gives you."}}})
    assert s == 200, ("template", s, v)
    s, v = api("POST", "/v1/workstreams", {"goal": f"push check {RUN}"})
    ws = v["workstream"]
    s, v = api("POST", "/v1/sandboxes", {"workstream": ws, "cell": CELL})
    assert s in (200, 201, 202), v
    made["sandbox"] = v["sandbox"]
    s, v = api("POST", "/v1/agents", {"template": TPL, "sandbox": made["sandbox"], "cell": CELL, "start": False, "overrides": {"repos": [ALLOWED]}})
    assert s == 201, v
    made["agent"] = v["agent"]
    s, v = api("POST", f"/v1/agents/{made['agent']}/turns", {"text": PROMPT})
    turn = v["turn"]
    log(f"sandbox {made['sandbox']}, agent {made['agent']}, turn sent")
    t0 = time.time()
    while time.time() < t0 + 1200:
        s, v = api("GET", f"/v1/agents/{made['agent']}/turns")
        st = {x["turn"]: x["status"] for x in v} if s == 200 else {}
        if st.get(turn) in ("done", "interrupted", "failed"):
            break
        time.sleep(15)
    log(f"turn {st.get(turn)} after {int(time.time() - t0)} s")
    out = ((assistant_texts(made["agent"]) or [""]))[-1]
    print(out)
    kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l and l.split("=", 1)[0].replace("_", "").isupper())
    nest_gh = app_token(ALLOWED)
    s, b = nest_gh("GET", f"/repos/{ALLOWED}/branches/{BRANCH.replace('/', '%2F')}")
    other_gh = app_token(OTHER)
    s2, _ = other_gh("GET", f"/repos/{OTHER}/branches/{BRANCH.replace('/', '%2F')}")
    refused = lambda k: kv.get(k, "").strip().startswith("403")
    checks = [
        ("the sandbox reports a hostname", bool(kv.get("HOSTNAME", "").strip())),
        ("gh and the credential helper are in the image", "/gh" in kv.get("GH", "") and "git-credential-nest" in kv.get("HELPER", "")),
        ("GITHUB_TOKEN is the placeholder", kv.get("TOKEN_PLACEHOLDER") == "yes"),
        ("the push to the allowed repo succeeded (and GitHub has the branch)", kv.get("PUSH_ALLOWED_EXIT") == "0" and s == 200),
        ("push discovery to the owner's other repo is refused at the proxy", refused("DISCOVERY_OTHER")),
        ("push discovery to a repo outside the allowlist that doesn't exist is refused", refused("DISCOVERY_NONE")),
        ("receive-pack to the other repo with a foreign credential is refused", refused("RECEIVE_OTHER")),
        ("nothing reached the other repo", s2 == 404),
        ("gh api works through the placeholder", ALLOWED in kv.get("GH_API", "")),
    ]
    for n, g in checks:
        log(f"{'ok  ' if g else 'FAIL'} {n}")
        ok &= g
except Exception as e:
    ok = False
    log(f"FAIL: {type(e).__name__}: {str(e)[:400]}")
finally:
    try:
        s, _ = app_token(ALLOWED)("DELETE", f"/repos/{ALLOWED}/git/refs/heads/{BRANCH}")
        log(f"deleted {BRANCH} on {ALLOWED}: {s}")
    except Exception as e:
        log(f"branch cleanup: {type(e).__name__}")
    agent, sandbox = made["agent"], made["sandbox"]
    if agent:
        log(f"end agent: {api('POST', '/v1/agents/' + agent + '/stop', {'end': True})[0]}")
    if sandbox:
        log(f"destroy sandbox: {api('DELETE', '/v1/sandboxes/' + sandbox)[0]}")
    log("PASS" if ok else "FAIL")
    print(json.dumps({"run": RUN, **made}))
    sys.exit(0 if ok else 1)
