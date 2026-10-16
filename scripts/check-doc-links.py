#!/usr/bin/env python3
"""Check that relative links in the repo's Markdown files resolve.

A link resolves when its file or directory exists and, if it has an
#anchor, the target Markdown file (a directory's README.md) has a heading
with that GitHub slug. External links (http, mailto) are not checked.
Exit 1 if any link is broken.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {".git", "node_modules", "target", ".work", ".wrangler", ".ruff_cache", ".inframe", ".lake", ".generated"}
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")


def markdown_files():
    for path in sorted(ROOT.rglob("*.md")):
        if not SKIP.intersection(path.relative_to(ROOT).parts):
            yield path


def prose_lines(path, keep_code=False):
    """Lines outside fenced code blocks, with inline code removed unless keep_code."""
    fenced = False
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            yield n, line if keep_code else re.sub(r"`[^`]*`", "", line)


def slug(heading):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)  # [text](url) -> text
    text = text.replace("`", "").strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


_anchors = {}


def anchors(path):
    if path not in _anchors:
        seen = {}
        for _, line in prose_lines(path, keep_code=True):
            m = HEADING.match(line)
            if m:
                base = slug(m.group(1))
                count = seen.get(base, 0)
                seen[base] = count + 1
                seen.setdefault(base if count == 0 else f"{base}-{count}", 1)
        _anchors[path] = set(seen)
    return _anchors[path]


def check(path):
    errors = []
    for n, line in prose_lines(path):
        for target in LINK.findall(line):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                continue
            file_part, _, anchor = target.partition("#")
            dest = (path.parent / file_part).resolve() if file_part else path
            if not dest.exists():
                errors.append(f"{path.relative_to(ROOT)}:{n}: missing {target}")
                continue
            if anchor:
                md = dest / "README.md" if dest.is_dir() else dest
                if md.suffix != ".md" or not md.exists():
                    errors.append(f"{path.relative_to(ROOT)}:{n}: anchor on a non-Markdown target {target}")
                elif anchor.lower() not in anchors(md):
                    errors.append(f"{path.relative_to(ROOT)}:{n}: no heading for #{anchor} in {md.relative_to(ROOT)}")
    return errors


def main():
    errors = [e for p in markdown_files() for e in check(p)]
    for e in errors:
        print(e)
    print(f"{len(errors)} broken link(s)" if errors else "all relative links resolve")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
