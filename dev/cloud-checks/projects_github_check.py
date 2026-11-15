#!/usr/bin/env python3
"""Has every live sandbox of the projects client left nest's GitHub access for the app's own?

Phase B4 of taking service integrations out of nest's kernel (dev/rollout/2026-11-14-projects-converge-github.md).
Passes when no live sandbox of the client, in any cell its grant names, is given one of nest's own GitHub
bindings: the gate for the operator's grant narrowing (projects/README.md, setup step 11). It only reads nest.

With CHECK_WAKE=1 it first reads each project's manager through the projects app (PROJECTS_BASE_URL), which wakes the
project. That has effects: a manager still on nest's repos is replaced at its next quiet pause (a new sandbox, and a
host start in a cold cell), so run it again after that.

Exit: 0 PASS, 1 FAIL, 2 setup or HTTP error.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
CLIENT_NAME = os.environ.get("CHECK_CLIENT_NAME", "projects")
PROJECTS = os.environ.get("PROJECTS_BASE_URL", "https://projects-nest.bitcru.sh").rstrip("/")
# nest's own GitHub bindings (control-plane/src/lib/rules/github.ts). The app's own guards are `client:github-*`.
NEST_GITHUB = {"github", "github_read", "github_read_default"}
APP_GITHUB_GUARD = "client:github-"
GRANT_FIELDS = ["repos", "read_repos", "github", "github_push", "repo_owners"]
# The checks' own service token for the projects app: never nest's gateway token (`access:gateway`), which runners hold.
ACCESS = (("PROJECTS_ACCESS_CLIENT_ID", "CF-Access-Client-Id"), ("PROJECTS_ACCESS_CLIENT_SECRET", "CF-Access-Client-Secret"))


class Failed(Exception):
    pass


def request(url: str, headers: dict[str, str]) -> dict:
    # Cloudflare refuses the default Python-urllib agent.
    req = urllib.request.Request(url, headers={"User-Agent": "nest-cloud-check", **headers})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = res.read()
    except urllib.error.HTTPError as e:
        raise Failed(f"{e.code} from {url.split('?')[0]}: {e.read()[:300].decode(errors='replace')}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise Failed(f"no answer from {url.split('?')[0]}: {e}") from None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        # Access answers its login page (HTML) when it doesn't admit the request.
        raise Failed(f"not JSON from {url.split('?')[0]} (refused by Access?)") from None


def get(path: str, cell: str = CELL, **query: str) -> dict:
    """The nest Worker, as the operator: the bearer token only."""
    q = urllib.parse.urlencode({"cell": cell, **query})
    return request(f"{BASE}{path}?{q}", {"Authorization": f"Bearer {os.environ['NEST_ADMIN_TOKEN']}"})


def wake() -> None:
    """Read each project's manager through the app, which wakes the project. Access admits the service token."""
    headers = {header: os.environ[env] for env, header in ACCESS}
    for p in request(f"{PROJECTS}/api/projects", headers)["projects"]:
        m = request(f"{PROJECTS}/api/projects/{p['id']}/manager", headers)
        print(f"woke {p['id']} ({p.get('name')}): manager {m.get('agent')} {m.get('state')}")


def live_sandboxes(cell: str, client: str) -> list[dict]:
    out, cursor = [], None
    while True:
        d = get("/v1/sandboxes", cell, **({"cursor": cursor} if cursor else {}))
        out += [s for s in d.get("sandboxes", []) if s.get("client") == client and not s.get("ended_ms")]
        cursor = d.get("next_cursor")
        if not cursor:
            return out


def check() -> int:
    clients = [c for c in get("/v1/admin/clients").get("clients", []) if c.get("name") == CLIENT_NAME]
    if len(clients) != 1:
        raise Failed(f"expected one client named {CLIENT_NAME!r}, found {len(clients)}")
    if os.environ.get("CHECK_WAKE") == "1":
        wake()
    client = clients[0]["client"]
    grant = clients[0].get("grant") or {}
    cells = grant.get("cells") or [CELL]

    legacy = []
    for cell in cells:
        live = live_sandboxes(cell, client)
        print(f"client {client} ({CLIENT_NAME}), cell {cell}: {len(live)} live sandbox(es)")
        for s in sorted(live, key=lambda s: s["created_ms"]):
            policy = get(f"/v1/sandboxes/{s['sandbox']}/policy", cell)
            nest_gh = sorted(n for n in (i.get("name") for i in policy.get("inject", [])) if n in NEST_GITHUB)
            app_gh = any(str(g.get("name", "")).startswith(APP_GITHUB_GUARD) for g in policy.get("guards", []))
            labels = s.get("labels") or {}
            who = " ".join(f"{k}={labels[k]}" for k in ("project", "role", "start", "task", "pr") if k in labels)
            verdict = f"NEST'S GITHUB ({', '.join(nest_gh)})" if nest_gh else "app's own access" if app_gh else "no GitHub access"
            print(f"  {s['sandbox']}  {who:<55} {verdict}")
            if nest_gh:
                legacy.append(s["sandbox"])

    # nest keeps a dropped `repos` and `read_repos` as [] (the grant's defaults).
    held = [f for f in GRANT_FIELDS if grant.get(f)]
    print(f"grant still holds: {', '.join(held) if held else 'none of ' + ', '.join(GRANT_FIELDS)}")
    print("not checked here: the Worker's GITHUB_TOKEN_SOURCE (wrangler config, not the API)")
    if legacy:
        print(f"FAIL: {len(legacy)} sandbox(es) still given nest's GitHub bindings; narrowing the grant now would cut them")
        print(json.dumps({"legacy": legacy}))
        return 1
    print("PASS: no live sandbox of the client is given nest's GitHub bindings")
    return 0


def main() -> int:
    needed = ["NEST_ADMIN_TOKEN"] + ([env for env, _ in ACCESS] if os.environ.get("CHECK_WAKE") == "1" else [])
    missing = [e for e in needed if not os.environ.get(e)]
    if missing:
        print(f"not set: {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        return check()
    except Failed as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
