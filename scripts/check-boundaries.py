#!/usr/bin/env python3
"""Check the module boundaries in scripts/boundaries.toml: which code may import which.

Two graphs are checked:
- **Imports** between TypeScript and JavaScript files (`[[imports]]` rules). Every static import,
  re-export, side-effect import, dynamic `import()` and `require()` is an edge from the importing file
  to the file it resolves to (a repo path) or to a package (`pkg:<name>`, e.g. `pkg:zod`,
  `pkg:cloudflare:workers`). An edge is type-only when TypeScript erases it (`import type`,
  `export type`, every named specifier marked `type`, `typeof import("x")`, `import("x").Name`),
  and raw when it reads a file's text (`?raw`, `?url`).
- **Crate dependencies** between the Cargo workspace's members (`[[crates]]` rules), by kind
  (`normal`, `dev`, `build`), read from each member's manifest.

A rule names the code it covers (`from`, minus `exclude`) and what that code may reach: never
`deny`, or nothing outside `only`. `types_ok` exempts type-only imports. `transitive` follows value
imports (never type-only or raw ones) from every covered file and checks every edge it reaches, so a
browser bundle can't pull in worker code through a shared module. `allow` lists recorded exceptions,
each a `{from, to, why}` edge; one that no longer excuses anything is stale and fails, so the list
only shrinks. `example` is an edge the rule must reject, which scripts/tests plants to prove it can.

Besides the rules, every package import in a directory with a package.json must be declared there
(dependencies of any kind; a type-only import may be declared as `@types/<name>`), or be a runtime
built-in (`node:`, `cloudflare:`), so nothing resolves through a hoisted or neighbouring
node_modules.

Exit 1 on any violation. For tests, `--root DIR` checks another tree and `--rule NAME` checks one
rule (`--extra-edge FROM TO` adds a value import to the graph first).
"""

import argparse
import json
import os
import re
import sys
import tomllib
from collections import deque
from pathlib import Path

SKIP = {".git", "node_modules", "target", ".work", ".wrangler", ".ruff_cache", "__pycache__", "dist", ".claude"}
SOURCE = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
RESOLVE = ["", ".ts", ".tsx", ".mts", ".d.ts", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"]
BUILTIN = ("node:", "cloudflare:")
KINDS = {"dependencies": "normal", "dev-dependencies": "dev", "dev_dependencies": "dev",
         "build-dependencies": "build", "build_dependencies": "build"}

# Statements open a line or follow a `;`, so a commented-out import (`// import`, ` * import`) is not
# one. The clause between the keyword and `from` holds no quote, `;` or further import or export.
STATIC = re.compile(
    r"""(?m)(?:^|;)[ \t]*(import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^;'"`])*?)\bfrom\s*(['"])([^'"\n]+)\4"""
)
SIDE_EFFECT = re.compile(r"""(?m)(?:^|;)[ \t]*import\s*(['"])([^'"\n]+)\1""")
DYNAMIC = re.compile(r"""(typeof\s+)?\bimport\s*\(\s*(['"`])([^'"`\n$]+)\2\s*\)(\s*\.\s*(\w+))?""")
REQUIRE = re.compile(r"""\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)""")
TYPE_NAMED = re.compile(r"\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,\s*)*type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*\}")


def glob_re(glob):
    """`**` spans path segments, `*` and `?` stay within one."""
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


class Globs:
    def __init__(self, globs):
        self.globs = list(globs or [])
        self.res = [glob_re(g) for g in self.globs]

    def __call__(self, s):
        return any(r.match(s) for r in self.res)


def files_under(root):
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if path.is_file() and not SKIP.intersection(rel.parts):
            yield rel.as_posix(), path


# --- the import graph ---------------------------------------------------------------------------


def specifiers(text):
    """(specifier, kind) for every import in a source, kind being "value", "type" or "raw"."""
    out = []
    for m in STATIC.finditer(text):
        clause = m.group(3).strip()
        typed = bool(m.group(2)) or bool(TYPE_NAMED.fullmatch(clause))
        out.append((m.group(5), "type" if typed else "value"))
    for m in SIDE_EFFECT.finditer(text):
        out.append((m.group(2), "value"))
    for m in DYNAMIC.finditer(text):
        # `import("x").Name` in a type position; on a value it would be a property of a Promise.
        typed = bool(m.group(1)) or (m.group(5) is not None and m.group(5) not in ("then", "catch", "finally"))
        out.append((m.group(3), "type" if typed else "value"))
    for m in REQUIRE.finditer(text):
        out.append((m.group(2), "value"))
    return [(s, "raw" if k != "type" and re.search(r"\?(raw|url)\b", s) else k) for s, k in out]


def package_of(spec):
    if spec.startswith(BUILTIN):
        return spec
    parts = spec.split("/")
    return "/".join(parts[:2]) if spec.startswith("@") else parts[0]


def resolve(root, importer, spec):
    """A relative specifier as a repo path: the file it names, else the normalized path itself."""
    norm = Path(os.path.normpath(root / Path(importer).parent / spec.split("?", 1)[0]))
    cands = [Path(str(norm) + ext) for ext in RESOLVE]
    if norm.suffix in (".js", ".mjs"):
        cands += [norm.with_suffix(ext) for ext in (".ts", ".tsx", ".mts")]
    return rel_to(root, next((c for c in cands if c.is_file()), norm))


def rel_to(root, path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return "<outside>/" + path.as_posix().lstrip("/")


def import_graph(root):
    """{file: [(target, kind, specifier)]} over every source file in the tree."""
    graph = {}
    for rel, path in files_under(root):
        if path.suffix not in SOURCE:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        edges = []
        for spec, kind in specifiers(text):
            target = resolve(root, rel, spec) if spec.startswith(".") else "pkg:" + package_of(spec)
            edges.append((target, kind, spec))
        graph[rel] = edges
    return graph


def undeclared_packages(root, graph):
    """Package imports not declared by the nearest package.json above the importing file."""
    manifests = {}
    errors = []
    for rel in sorted(graph):
        pkg_dir = _nearest_manifest(root, rel, manifests)
        if pkg_dir is None:
            continue
        declared = manifests[pkg_dir]
        for target, kind, spec in graph[rel]:
            if not target.startswith("pkg:"):
                continue
            name = target[4:]
            if name.startswith(BUILTIN) or name in declared:
                continue
            types = "@types/" + (name[1:].replace("/", "__") if name.startswith("@") else name)
            if kind == "type" and types in declared:
                continue
            where = f"{pkg_dir}/package.json" if pkg_dir else "package.json"
            errors.append(f"{rel}: [declared-packages] imports {spec!r}, which {where} doesn't declare")
    return errors


def _nearest_manifest(root, rel, cache):
    parts = rel.split("/")[:-1]
    while True:
        d = "/".join(parts)
        if d not in cache:
            manifest = root / d / "package.json"
            if manifest.is_file():
                data = json.loads(manifest.read_text(encoding="utf-8"))
                cache[d] = set().union(*(data.get(k, {}) for k in
                                         ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")))
            else:
                cache[d] = None
        if cache[d] is not None:
            return d
        if not parts:
            return None
        parts.pop()


# --- the crate graph ----------------------------------------------------------------------------


def crate_graph(root):
    """{crate: [(dependency, kind, optional)]} over the workspace's members' path dependencies, where
    `optional` means no default feature turns the dependency on."""
    ws = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    members = {}
    for m in ws.get("workspace", {}).get("members", []):
        manifest = tomllib.loads((root / m / "Cargo.toml").read_text(encoding="utf-8"))
        members[Path(m).as_posix()] = manifest
    names = {d: man["package"]["name"] for d, man in members.items()}
    ws_deps = ws.get("workspace", {}).get("dependencies", {})
    graph = {}
    for d, man in members.items():
        edges = []
        by_default = default_features(man)
        tables = [(k, man.get(k, {})) for k in KINDS]
        tables += [(k, t.get(k, {})) for t in man.get("target", {}).values() for k in KINDS]
        for key, table in tables:
            for dep, spec in table.items():
                spec = spec if isinstance(spec, dict) else {"version": spec}
                base = root / d
                if spec.get("workspace"):
                    inherited = ws_deps.get(dep, {})
                    spec = {**(inherited if isinstance(inherited, dict) else {}), **spec}
                    base = root
                if "path" not in spec:
                    continue  # from a registry: deny.toml's business
                target = rel_to(root, Path(os.path.normpath(base / spec["path"])))
                name = names.get(target, spec.get("package", dep))
                if name != names[d]:
                    optional = bool(spec.get("optional")) and dep not in by_default
                    edges.append((name, KINDS[key], optional))
        graph[names[d]] = edges
    return graph


def default_features(manifest):
    """The dependencies a crate's `default` features turn on, followed through the features they name."""
    features = manifest.get("features", {})
    seen, todo, deps = set(), ["default"], set()
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        for item in features.get(f, []):
            name = item.removeprefix("dep:").split("/", 1)[0].rstrip("?")
            if item.startswith("dep:") or "/" in item:
                deps.add(name)
            elif name in features:
                todo.append(name)
            else:
                deps.add(name)  # an optional dependency's implicit feature
    return deps


# --- the rules ----------------------------------------------------------------------------------


class Rule:
    def __init__(self, raw, section):
        self.raw, self.section = raw, section
        self.name, self.why = raw["name"], raw["why"]
        self.covers, self.excludes = Globs(raw["from"]), Globs(raw.get("exclude"))
        if ("deny" in raw) == ("only" in raw):
            raise SystemExit(f"boundaries.toml: [{self.name}] needs exactly one of `deny` and `only`")
        self.deny, self.only = Globs(raw.get("deny")), Globs(raw.get("only")) if "only" in raw else None
        self.types_ok = raw.get("types_ok", False)
        self.transitive = raw.get("transitive", False)
        if self.transitive and not self.types_ok:
            raise SystemExit(f"boundaries.toml: [{self.name}] follows value imports only, so it needs `types_ok`")
        self.kinds = set(raw.get("kinds", ["normal", "dev", "build"]))
        self.optional_ok = raw.get("optional_ok", False)
        self.allow = [(Globs([a["from"]]), Globs([a["to"]]), a) for a in raw.get("allow", [])]
        for a in raw.get("allow", []):
            if not a.get("why"):
                raise SystemExit(f"boundaries.toml: [{self.name}] allow entry {a} needs a `why`")
        self.used = [0] * len(self.allow)

    def applies(self, source):
        return self.covers(source) and not self.excludes(source)

    def forbids(self, target):
        return self.deny(target) if self.only is None else not self.only(target)

    def excused(self, source, target):
        for i, (f, t, _) in enumerate(self.allow):
            if f(source) and t(target):
                self.used[i] += 1
                return True
        return False

    def stale(self):
        return [a for (_, _, a), n in zip(self.allow, self.used) if not n]


def check_imports(rule, graph):
    errors = []
    roots = [f for f in graph if rule.applies(f)]
    if not rule.transitive:
        for f in roots:
            for target, kind, spec in graph[f]:
                if kind == "type" and rule.types_ok:
                    continue
                if rule.forbids(target) and not rule.excused(f, target):
                    errors.append(f"{f}: [{rule.name}] imports {spec!r} ({target}). {rule.why}")
        return errors
    reported = set()
    for start in roots:
        seen, queue = {start: None}, deque([start])
        while queue:
            f = queue.popleft()
            for target, kind, spec in graph.get(f, []):
                if kind != "value":
                    continue
                if rule.forbids(target):
                    if (f, target) not in reported and not rule.excused(f, target):
                        reported.add((f, target))
                        chain = _chain(seen, f) + [target]
                        errors.append(f"{f}: [{rule.name}] imports {spec!r} ({target}), reached from "
                                      f"{' -> '.join(chain)}. {rule.why}")
                    continue
                if target in graph and target not in seen:
                    seen[target] = f
                    queue.append(target)
    return errors


def _chain(seen, f):
    out = []
    while f is not None:
        out.append(f)
        f = seen[f]
    return out[::-1]


def check_crates(rule, graph):
    errors = []
    for crate, edges in graph.items():
        if not rule.applies(crate):
            continue
        for dep, kind, optional in edges:
            if kind not in rule.kinds or (optional and rule.optional_ok):
                continue
            if rule.forbids(dep) and not rule.excused(crate, dep):
                errors.append(f"{crate}: [{rule.name}] has a {kind} dependency on {dep}. {rule.why}")
    return errors


def load(config):
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    return [Rule(r, "imports") for r in data.get("imports", [])] + [Rule(r, "crates") for r in data.get("crates", [])]


def check(root, config, only=None, extra_edges=()):
    rules = load(config)
    if only:
        rules = [r for r in rules if r.name == only]
        if not rules and only != "declared-packages":
            return [f"no rule named {only!r}"]
    graph = import_graph(root)
    crates = crate_graph(root) if (root / "Cargo.toml").is_file() else {}
    for src, dst in extra_edges:
        graph.setdefault(src, []).append((dst, "value", dst))
        crates.setdefault(src, []).append((dst, "normal", False))
    errors = []
    if only in (None, "declared-packages"):
        errors += undeclared_packages(root, graph)
    for rule in rules:
        errors += check_imports(rule, graph) if rule.section == "imports" else check_crates(rule, crates)
        if not extra_edges:
            for a in rule.stale():
                errors.append(f"{config.name}: [{rule.name}] stale allow entry {a['from']} -> {a['to']}: "
                              "it excuses nothing any more; remove it")
    return errors


def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=here.parent)
    ap.add_argument("--config", type=Path, default=here / "boundaries.toml")
    ap.add_argument("--rule", help="check only this rule (or `declared-packages`)")
    ap.add_argument("--extra-edge", nargs=2, action="append", default=[], metavar=("FROM", "TO"),
                    help="add a value import (or a normal crate dependency) before checking")
    args = ap.parse_args()
    root = args.root.resolve()
    errors = check(root, args.config, args.rule, [tuple(e) for e in args.extra_edge])
    for e in errors:
        print(e)
    print(f"{len(errors)} boundary violation(s)" if errors else "all boundaries hold")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
