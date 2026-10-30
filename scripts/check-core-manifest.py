#!/usr/bin/env python3
"""nestd-core stays pure by construction (docs/verification/nestd/): no dependency it could reach a
clock, a socket or a runtime through, no build script, and `no_std` outside its own tests so the
compiler rejects `std`. The text fence (scripts/fences.toml, `nestd-core-purity`) is a second layer;
this parses the manifest, so spelling (dotted keys, inline tables, target tables) can't slip past.

Fails on: any `dependencies` or `build-dependencies` table or key (also `build_dependencies`, and
under `target.<cfg>`); any `build` key (`[package] build = ...`, or a `[build]` table); a `build.rs`
next to the manifest (cargo runs it without being told); `[patch]` or `[replace]`; and a `src/lib.rs`
without the `no_std` attribute. `dev-dependencies` are fine: they never reach the shipped library.

Usage: check-core-manifest.py [crate dir, default crates/nestd-core]
"""

import sys
import tomllib
from pathlib import Path

NO_STD = "#![cfg_attr(not(test), no_std)]"
DEPENDENCY_TABLES = {"dependencies", "build-dependencies", "build_dependencies"}


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
        lines = [line.strip() for line in lib.read_text(encoding="utf-8").splitlines()]
    except OSError as e:
        return out + [f"{lib}: unreadable: {e}"]
    if NO_STD not in lines:
        out.append(f"{lib}: missing `{NO_STD}` (the compiler's purity check)")
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
