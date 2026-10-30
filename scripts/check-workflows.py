#!/usr/bin/env python3
"""Every GitHub Actions workflow must parse as YAML. GitHub reports an unparseable workflow only on
the Actions page and never runs it, so nothing else fails: fuzz.yml once shipped with an unquoted
step name containing ": " and its nightly run silently never happened.

Checks each .github/workflows/*.yml and *.yaml: it parses, it is a mapping, it has a trigger (`on`)
and a non-empty `jobs` mapping. Needs PyYAML (scripts/requirements-guards.txt); without it the
check fails rather than passing unread.

Usage: check-workflows.py [workflows dir, default .github/workflows]
Exit 1 if any workflow is bad, 2 if PyYAML is missing.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    import yaml
except ImportError:
    print("check-workflows: PyYAML is required (pip install -r scripts/requirements-guards.txt)", file=sys.stderr)
    sys.exit(2)


def problems(path):
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        return [f"does not parse: {e}".replace("\n", " ")]
    if not isinstance(doc, dict):
        return ["is not a mapping"]
    found = []
    # YAML 1.1 (PyYAML) reads the bare key `on` as the boolean true.
    if "on" not in doc and True not in doc:
        found.append("has no `on` trigger")
    if not isinstance(doc.get("jobs"), dict) or not doc["jobs"]:
        found.append("has no `jobs` mapping")
    return found


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".github" / "workflows"
    files = sorted([*root.glob("*.yml"), *root.glob("*.yaml")])
    if not files:
        print(f"check-workflows: no workflows under {root}", file=sys.stderr)
        return 1
    bad = 0
    for path in files:
        for p in problems(path):
            print(f"{path.name}: {p}")
            bad += 1
    if bad:
        return 1
    print(f"check-workflows: {len(files)} workflows parse")
    return 0


if __name__ == "__main__":
    sys.exit(main())
