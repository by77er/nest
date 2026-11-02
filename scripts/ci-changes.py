#!/usr/bin/env python3
"""Which CI jobs a change needs (dev/ci.md#what-runs). Reads changed paths, one per line, on stdin
and prints `<job>=true|false` lines for $GITHUB_OUTPUT.

A job runs when a changed path is one of its inputs. A path no rule knows runs every job, as does
a change to CI itself, so a new directory is covered until someone classifies it. The rules follow
what each job's build and tests read, including the few cross-directory reads (nestd's test of
fleet.ts, the dashboard's import of the control plane's admin view).

Usage: git diff --name-only --no-renames A B | ci-changes.py
       ci-changes.py --all      every job (a dispatch, or a diff that can't be computed)
       ci-changes.py --none     no job (a push whose tree a pull request already passed)
"""

import sys

JOBS = ("rust", "control-plane", "dashboard", "projects", "e2e", "infra", "verify-nestd", "fuzz-nestd")
ALL = frozenset(JOBS)

# (path prefix, jobs). The longest matching prefix wins; a prefix ending in "/" is a directory.
RULES = [
    # CI itself: every job.
    (".github/workflows/ci.yml", ALL),
    ("scripts/ci-changes.py", ALL),
    # Read by no job but `plan`, which runs on every change (guards, gitleaks).
    ("docs/", set()),
    ("dev/", set()),
    (".claude/", set()),
    # The UI design skill: both apps' theme tests read its token tables.
    (".claude/skills/nest-ui-design/", {"dashboard", "projects"}),
    ("README.md", set()),
    ("CLAUDE.md", set()),
    ("images/", set()),
    ("verification/", set()),
    (".github/", set()),
    (".gitleaks.toml", set()),
    (".gitignore", set()),
    ("scripts/", set()),
    # Rust.
    ("crates/", {"rust", "e2e"}),
    ("crates/nest-protocol/", {"rust", "e2e", "fuzz-nestd"}),
    ("crates/nestd/", {"rust", "e2e", "fuzz-nestd"}),
    ("crates/nestd-core/", {"rust", "e2e", "verify-nestd", "fuzz-nestd"}),
    ("Cargo.toml", {"rust", "e2e", "verify-nestd"}),
    ("Cargo.lock", {"rust", "e2e", "verify-nestd"}),
    ("rust-toolchain.toml", {"rust", "e2e", "verify-nestd"}),
    (".cargo/", {"rust", "e2e", "verify-nestd"}),
    ("clippy.toml", {"rust", "verify-nestd"}),
    ("deny.toml", {"rust"}),
    # The verification crates have their own lockfiles, which `rust` runs cargo-deny over.
    ("verification/nestd/check/", {"verify-nestd"}),
    ("verification/nestd/check/Cargo.lock", {"verify-nestd", "rust"}),
    ("verification/nestd/check/Cargo.toml", {"verify-nestd", "rust"}),
    ("verification/nestd/fuzz/", {"fuzz-nestd"}),
    ("verification/nestd/fuzz/Cargo.lock", {"fuzz-nestd", "rust"}),
    ("verification/nestd/fuzz/Cargo.toml", {"fuzz-nestd", "rust"}),
    # Wire contracts: both sides round-trip the fixtures; the fuzz seeds come from them.
    ("protocol/", {"rust", "control-plane", "e2e", "fuzz-nestd"}),
    # TypeScript.
    ("control-plane/", {"control-plane", "e2e"}),
    ("control-plane/src/protocol/", {"control-plane", "e2e", "dashboard"}),
    # nestd's test that its GC grace stays below FleetDO's (crates/nestd/src/s3.rs).
    ("control-plane/src/do/fleet.ts", {"control-plane", "e2e", "rust"}),
    ("dashboard/", {"dashboard"}),
    # The projects app: a separate Worker that imports nothing outside projects/.
    ("projects/", {"projects"}),
    # Its own inframe stack, which the infra job tests; the app's npm checks don't read it.
    ("projects/deploy/", {"infra"}),
    # The MCP test server is a separate Worker with no CI job of its own; e2e runs it.
    ("mcp-test/", {"e2e"}),
    ("e2e/", {"e2e"}),
    # nest's stacks.
    ("deploy/", {"infra"}),
    ("scripts/infra-tools.sh", {"infra"}),
]


def jobs_for(path):
    best = None
    for prefix, jobs in RULES:
        hit = path.startswith(prefix) if prefix.endswith("/") else path == prefix
        if hit and (best is None or len(prefix) > len(best[0])):
            best = (prefix, jobs)
    return ALL if best is None else frozenset(best[1])


def needed(paths):
    out = set()
    for p in paths:
        out |= jobs_for(p)
    return out


def main(argv):
    if argv[1:] == ["--all"]:
        jobs = ALL
    elif argv[1:] == ["--none"]:
        jobs = frozenset()
    elif len(argv) == 1:
        jobs = needed(line.strip() for line in sys.stdin if line.strip())
    else:
        print(__doc__, file=sys.stderr)
        return 2
    for j in JOBS:
        print(f"{j}={'true' if j in jobs else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
