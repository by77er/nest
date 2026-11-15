#!/usr/bin/env python3
"""Read-only: has every sandbox of the projects client left nest's GitHub access for the app's own?

Phase B4 of taking service integrations out of nest's kernel (dev/rollout/2026-11-14-projects-converge-github.md).
Passes when no live sandbox of the client is given one of nest's own GitHub bindings, which is the gate for
the operator's grant narrowing (projects/README.md, setup step 11). Changes nothing in nest.

With CHECK_WAKE=1 it first reads each project's manager through the projects app (PROJECTS_BASE_URL), which wakes the
project: a manager still on nest's repos is replaced at its next quiet pause, so run it again after that.
"""

import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
CLIENT_NAME = os.environ.get("CHECK_CLIENT_NAME", "projects")
PROJECTS = os.environ.get("PROJECTS_BASE_URL", "https://projects-nest.bitcru.sh").rstrip("/")
# nest's own GitHub bindings (control-plane/src/lib/rules/github.ts); the app's are prefixed `client:`.
NEST_GITHUB = {"github", "github_read", "github_read_default"}
GRANT_FIELDS = ["repos", "read_repos", "github", "github_push", "repo_owners"]


def request(url: str, admin: bool) -> dict:
    # Cloudflare refuses the default Python-urllib agent.
    req = urllib.request.Request(url, headers={"User-Agent": "nest-cloud-check"})
    if admin:
        req.add_header("Authorization", f"Bearer {os.environ['NEST_ADMIN_TOKEN']}")
    for env, header in (("NEST_ACCESS_CLIENT_ID", "CF-Access-Client-Id"), ("NEST_ACCESS_CLIENT_SECRET", "CF-Access-Client-Secret")):
        if os.environ.get(env):
            req.add_header(header, os.environ[env])
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def get(path: str, **query: str) -> dict:
    return request(f"{BASE}{path}?{urllib.parse.urlencode({'cell': CELL, **query})}", admin=True)


def wake() -> None:
    """Read each project's manager through the app (Access admits the service token), which wakes the project."""
    for p in request(f"{PROJECTS}/api/projects", admin=False)["projects"]:
        m = request(f"{PROJECTS}/api/projects/{p['id']}/manager", admin=False)
        print(f"woke {p['id']} ({p.get('name')}): manager {m.get('agent')} {m.get('state')}")


def pages(path: str, key: str, **query: str) -> list[dict]:
    out, cursor = [], None
    while True:
        d = get(path, **query, **({"cursor": cursor} if cursor else {}))
        out += d.get(key, [])
        cursor = d.get("next_cursor")
        if not cursor:
            return out


def main() -> int:
    if not os.environ.get("NEST_ADMIN_TOKEN"):
        print("NEST_ADMIN_TOKEN is not set", file=sys.stderr)
        return 2
    clients = [c for c in get("/v1/admin/clients").get("clients", []) if c.get("name") == CLIENT_NAME]
    if len(clients) != 1:
        print(f"expected one client named {CLIENT_NAME!r}, found {len(clients)}", file=sys.stderr)
        return 2
    if os.environ.get("CHECK_WAKE") == "1":
        wake()
    client = clients[0]["client"]
    grant = clients[0].get("grant") or {}

    live = [s for s in pages("/v1/sandboxes", "sandboxes") if s.get("client") == client and not s.get("ended_ms")]
    legacy = []
    print(f"client {client} ({CLIENT_NAME}): {len(live)} live sandbox(es)")
    for s in sorted(live, key=lambda s: s["created_ms"]):
        policy = get(f"/v1/sandboxes/{s['sandbox']}/policy")
        injected = [i.get("name") for i in policy.get("inject", [])]
        nest_gh = sorted(n for n in injected if n in NEST_GITHUB)
        app_guards = sum(1 for g in policy.get("guards", []) if str(g.get("name", "")).startswith("client:"))
        labels = s.get("labels") or {}
        who = " ".join(f"{k}={labels[k]}" for k in ("project", "role", "start", "task", "pr") if k in labels)
        verdict = f"NEST'S GITHUB ({', '.join(nest_gh)})" if nest_gh else "app's own access" if app_guards else "no GitHub access"
        print(f"  {s['sandbox']}  {who:<55} {verdict}")
        if nest_gh:
            legacy.append(s["sandbox"])

    # nest stores a dropped `repos` and `read_repos` as [] (the grant's defaults).
    held = [f for f in GRANT_FIELDS if grant.get(f)]
    print(f"grant still holds: {', '.join(held) if held else 'none of ' + ', '.join(GRANT_FIELDS)}")
    print("not checked here: the Worker's GITHUB_TOKEN_SOURCE (wrangler config, not the API)")
    if legacy:
        print(f"FAIL: {len(legacy)} sandbox(es) still given nest's GitHub bindings; narrowing the grant now would cut them")
        print(json.dumps({"legacy": legacy}))
        return 1
    print("PASS: no live sandbox of the client is given nest's GitHub bindings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
