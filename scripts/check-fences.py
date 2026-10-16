#!/usr/bin/env python3
"""Check the source fences in scripts/fences.toml.

A fence is a set of regexes that may match only in its `allow` globs, within the files its
`files` globs cover. Exit 1 on any match outside the allowed places, or on a stale allow entry
(its files exist but none of them match any more). For tests, `--root DIR` checks another tree
and `--fence NAME` checks one fence.
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

SKIP = {".git", "node_modules", "target", ".work", ".wrangler", ".ruff_cache", "__pycache__"}


def glob_re(glob):
    """`**` spans directories, `*` and `?` stay within one path segment."""
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(out + r"\Z")


def files_under(root):
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if path.is_file() and not SKIP.intersection(rel.parts):
            yield rel.as_posix(), path


def check(root, config, only=None):
    fences = tomllib.loads(config.read_text(encoding="utf-8"))["fence"]
    if only:
        fences = [f for f in fences if f["name"] == only]
        if not fences:
            return [f"no fence named {only!r}"]
    files = list(files_under(root))
    errors = []
    for fence in fences:
        patterns = [re.compile(p) for p in fence["patterns"]]
        scope = [glob_re(g) for g in fence["files"]]
        allow = {g: glob_re(g) for g in fence.get("allow", [])}
        allow_files, allow_hits = {g: 0 for g in allow}, {g: 0 for g in allow}
        for rel, path in files:
            if not any(s.match(rel) for s in scope):
                continue
            allowed = [g for g, r in allow.items() if r.match(rel)]
            for g in allowed:
                allow_files[g] += 1
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for n, line in enumerate(text.splitlines(), 1):
                hit = next((p.pattern for p in patterns if p.search(line)), None)
                if hit is None:
                    continue
                if allowed:
                    for g in allowed:
                        allow_hits[g] += 1
                else:
                    errors.append(f"{rel}:{n}: [{fence['name']}] /{hit}/ outside its allowed places. {fence['why']}")
        for g in allow:
            if allow_files[g] and not allow_hits[g]:
                errors.append(f"{config.name}: [{fence['name']}] stale allow entry {g!r}: its files no longer match; remove it")
    return errors


def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=here.parent)
    ap.add_argument("--config", type=Path, default=here / "fences.toml")
    ap.add_argument("--fence", help="check only this fence")
    args = ap.parse_args()
    errors = check(args.root.resolve(), args.config, args.fence)
    for e in errors:
        print(e)
    print(f"{len(errors)} fence violation(s)" if errors else "all fences hold")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
