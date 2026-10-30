#!/usr/bin/env python3
"""nestd-core stays pure by construction (docs/verification/nestd/): no dependency it could reach a
clock, a socket or a runtime through, no build script, and `no_std` outside its own tests so the
compiler rejects `std`. The text fence (scripts/fences.toml, `nestd-core-purity`) is a second layer;
this parses the manifest, so spelling (dotted keys, inline tables, target tables) can't slip past.

Fails on: any `dependencies` or `build-dependencies` table or key (also `build_dependencies`, and
under `target.<cfg>`); any `build` key (`[package] build = ...`, or a `[build]` table); a `build.rs`
next to the manifest (cargo runs it without being told); `[patch]` or `[replace]`; a `src/lib.rs`
without the `no_std` attribute (comments don't count); and, in any source file with comments
stripped, `extern crate` of anything but `alloc` (whatever whitespace or lines it spans: `std` would
undo `no_std`), a `#[path = ...]` module (code from outside the crate) or `include!`.
A `cfg` predicate on any `target_*` key is rejected too: code compiled only off the no-std target
would escape that build. `dev-dependencies` are fine: they never reach the shipped library.

The compiler is the first layer: CI builds the crate for a target with no `std` at all
(`x86_64-unknown-none`), where naming `std` in any way fails. This and the text fence are the
second and third.

Usage: check-core-manifest.py [crate dir, default crates/nestd-core]
"""

import re
import sys
import tomllib
from pathlib import Path

NO_STD = "#![cfg_attr(not(test), no_std)]"
DEPENDENCY_TABLES = {"dependencies", "build-dependencies", "build_dependencies"}
# Over comment-stripped source; `\s` spans newlines.
FORBIDDEN = {
    "extern crate other than alloc (std would undo no_std)": re.compile(r"\bextern\s+crate\s+(?!alloc\s*;)"),
    "a #[path] module (code from outside the crate)": re.compile(r"#\s*!?\s*\[\s*path\s*="),
    "include! (code from outside the crate)": re.compile(r"\binclude\s*!"),
}


# A char literal ('a', '\n', '\'', '\u{1F600}'); a `'` that doesn't start one is a lifetime.
CHAR = re.compile(r"'(?:\\u\{[0-9a-fA-F_]{1,8}\}|\\x[0-9a-fA-F]{2}|\\.|[^\\'\n])'")
RAW = re.compile(r'b?r(#*)"')


def strip_comments(src: str) -> str:
    """Rust source without comments (`//`, and nested `/* */`) and with every string, byte-string,
    raw-string and char literal emptied (`""`, `''`), so neither a comment marker nor code-like text
    inside a literal changes what the checks see."""
    out, i, n = [], 0, len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if src.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif src.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif (m := RAW.match(src, i)) and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_")):
            end = src.find('"' + m.group(1), m.end())
            out.append('""')
            i = n if end < 0 else end + 1 + len(m.group(1))
        elif src[i] == '"' or (src.startswith('b"', i) and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_"))):
            i += 2 if src[i] == "b" else 1
            while i < n and src[i] != '"':
                i += 2 if src[i] == "\\" else 1
            out.append('""')
            i += 1
        elif src[i] == "'" and (m := CHAR.match(src, i)):
            out.append("''")
            i = m.end()
        else:
            out.append(src[i])
            i += 1
    return "".join(out)


def cfg_on_target(code: str) -> bool:
    """Whether any `cfg(...)`, `cfg_attr(...)` or `cfg!(...)` predicate names a `target_*` key: code
    that compiles only off the no-std target would escape the build CI checks purity with."""
    for m in re.finditer(r"\bcfg(?:_attr)?\s*!?\s*\(", code):
        depth, j = 1, m.end()
        while j < len(code) and depth:
            depth += {"(": 1, ")": -1}.get(code[j], 0)
            j += 1
        if re.search(r"\btarget_\w+", code[m.end():j]):
            return True
    return False


def problems(crate: Path) -> list[str]:
    out = []
    manifest = crate / "Cargo.toml"
    try:
        toml = tomllib.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        return [f"{manifest}: unreadable: {e}"]

    for key in sorted(DEPENDENCY_TABLES & toml.keys()):
        out.append(f"{manifest}: [{key}] (nestd-core has no dependencies)")
    for cfg, table in toml.get("target", {}).items():
        for key in sorted(DEPENDENCY_TABLES & table.keys()):
            out.append(f"{manifest}: [target.{cfg!r}.{key}] (nestd-core has no dependencies)")
    for key in ("patch", "replace"):
        if key in toml:
            out.append(f"{manifest}: [{key}] (nestd-core has no dependencies to patch)")
    if "build" in toml:
        out.append(f"{manifest}: [build] (nestd-core has no build step)")
    if "build" in toml.get("package", {}):
        out.append(f"{manifest}: package.build (nestd-core has no build script)")
    if (crate / "build.rs").exists():
        out.append(f"{crate / 'build.rs'}: a build script (cargo runs it unasked)")

    lib = crate / "src" / "lib.rs"
    try:
        lines = [line.strip() for line in strip_comments(lib.read_text(encoding="utf-8")).splitlines()]
    except OSError as e:
        return out + [f"{lib}: unreadable: {e}"]
    if NO_STD not in lines:
        out.append(f"{lib}: missing `{NO_STD}` (the compiler's purity check)")
    for src in sorted((crate / "src").rglob("*.rs")):
        try:
            code = strip_comments(src.read_text(encoding="utf-8"))
        except OSError as e:
            out.append(f"{src}: unreadable: {e}")
            continue
        for what, pattern in FORBIDDEN.items():
            if pattern.search(code):
                out.append(f"{src}: {what}")
        if cfg_on_target(code):
            out.append(f"{src}: a cfg on target_* (code the no-std build wouldn't compile)")
    return out


def main() -> int:
    crate = Path(sys.argv[1] if len(sys.argv) > 1 else "crates/nestd-core")
    found = problems(crate)
    for p in found:
        print(p)
    if found:
        print("nestd-core must stay dependency-free and no_std: docs/verification/nestd/README.md")
        return 1
    print("nestd-core manifest holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
