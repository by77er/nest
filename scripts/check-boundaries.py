#!/usr/bin/env python3
"""Check the module boundaries in scripts/boundaries.toml: which code may import which.

Two graphs are checked:
- **Imports** between TypeScript and JavaScript files (`[[imports]]` rules). Every static import,
  re-export, side-effect import, dynamic `import()`, `require()`, `import.meta.glob()` (each file
  its patterns match) and `new URL(..., import.meta.url)` is an edge from the importing file to the
  file it resolves to (a repo path) or to a package (`pkg:<name>`, e.g. `pkg:zod`,
  `pkg:cloudflare:workers`). An edge is type-only when TypeScript erases it (`import type`,
  `export type`, every named specifier marked `type`, `typeof import("x")`, `import("x").Name`),
  and raw when it reads a file's text or URL (`?raw`, `?url`, a raw glob, `new URL`).
- **Crate dependencies** between the Cargo workspace's members (`[[crates]]` rules), by kind
  (`normal`, `dev`, `build`), read from each member's manifest.

Sources are read twice, as written and with comments blanked out, and the edges of both readings
count: comments can't hide an import, and a misread comment can't hide one either. A dynamic import
of anything but a literal fails, since nothing could check where it goes, unless its file is listed
under `[dynamic_imports] allow` with a reason.

A rule names the code it covers (`from`, minus `exclude`) and what that code may reach: never
`deny`, and nothing outside `only` (either or both). `types_ok` exempts type-only imports.
`transitive` follows value imports (never type-only or raw ones) from every covered file and checks
every edge it reaches, so a browser bundle can't pull in worker code through a shared module. Crate
rules are always transitive: past the first dependency (of the rule's `kinds`), they follow what each
crate links (normal and build dependencies). `requires` names targets every covered file must
import. `allow` lists recorded exceptions, each a `{from, to, why}` edge; one that no longer excuses
anything is stale and fails, so the list only shrinks. `example` is an edge the rule must reject,
which scripts/tests adds to the real graph to prove it can.

Besides the rules, every package import in a directory with a package.json must be declared there
(dependencies of any kind; a type-only import may be declared as `@types/<name>`), or be a runtime
built-in (`node:`, `cloudflare:`), so nothing resolves through a hoisted or neighbouring
node_modules; and a declared package must come from a registry, not a local path (`file:`, `link:`).

Exit 1 on any violation. For tests, `--root DIR` checks another tree, `--rule NAME` checks one rule,
and `--extra-edge FROM TO` adds a value import (or a normal crate dependency) first, or a type-only
import with `--extra-kind type`.
"""

import argparse
import json
import os
import re
import sys
import tomllib
from collections import deque
from pathlib import Path

SKIP_ANYWHERE = {".git", "node_modules", ".wrangler", ".ruff_cache", "__pycache__"}
SKIP_AT_ROOT = {".claude", "target"}
# Build output, skipped only beside the manifest that builds it.
BUILD_OUTPUT = {"dist": "package.json", ".work": "package.json", "target": "Cargo.toml"}
SOURCE = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
RESOLVE = ["", ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs",
           "/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.jsx", "/index.mjs"]
JS_TO_TS = {".js": (".ts", ".tsx"), ".jsx": (".tsx",), ".mjs": (".mts",), ".cjs": (".cts",)}
BUILTIN = ("node:", "cloudflare:")
LOCAL_SPEC = ("file:", "link:", "portal:", "workspace:", ".", "/")
KINDS = {"dependencies": "normal", "dev-dependencies": "dev", "dev_dependencies": "dev",
         "build-dependencies": "build", "build_dependencies": "build"}
LINKED = ("normal", "build")

STR = r"""(?:"[^"\n]*"|'[^'\n]*')"""
# Statements open a line or follow a `;`, so a commented-out import (`// import`, ` * import`) is not
# one. The clause between the keyword and `from` holds no `;` and no further import or export.
STATIC = re.compile(
    r"""(?m)(?:^|;)[ \t]*(import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)(?:[^;'"`]|""" + STR + r"""))*?)\bfrom\s*(['"])([^'"\n]+)\4"""
)
SIDE_EFFECT = re.compile(r"""(?m)(?:^|;)[ \t]*import\s*(['"])([^'"\n]+)\1""")
DYNAMIC = re.compile(r"""(typeof\s+)?(?<![.\w$])import\s*\(\s*(['"`])([^'"`\n$]+)\2\s*\)(\s*\.\s*(\w+))?""")
DYNAMIC_ANY = re.compile(r"""(?<![.\w$])import\s*\(\s*(?!['"])(?!`[^`$]*`)""")
REQUIRE = re.compile(r"""(?<![.\w$])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)""")
URL = re.compile(r"""\bnew\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)""")
GLOB = re.compile(r"""import\.meta\.glob\s*(?:<[^>()]*>)?\s*\(\s*(\[[^\]]*\]|""" + STR + r"""|`[^`$]*`)\s*(?:,\s*(\{[^}]*\}))?""")
GLOB_RAW = re.compile(r"""\b(?:query\s*:\s*['"]\?(?:raw|url)|as\s*:\s*['"](?:raw|url))""")
LITERAL = re.compile(r"""(['"`])([^'"`\n]*)\1""")
TYPE_NAMED = re.compile(r"\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,\s*)*type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*\}")


def glob_re(glob):
    """`**` spans path segments (`**/` also none), `*` and `?` stay within one, `{a,b}` is either."""
    out, i, depth = "", 0, 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        elif glob[i] == "{":
            out, i, depth = out + "(?:", i + 1, depth + 1
        elif glob[i] == "}" and depth:
            out, i, depth = out + ")", i + 1, depth - 1
        elif glob[i] == "," and depth:
            out, i = out + "|", i + 1
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
    def walk(d, rel):
        for path in sorted(d.iterdir()):
            name = path.name
            if name in SKIP_ANYWHERE or (not rel and name in SKIP_AT_ROOT):
                continue
            if path.is_dir():
                if name in BUILD_OUTPUT and (d / BUILD_OUTPUT[name]).is_file():
                    continue
                yield from walk(path, rel + name + "/")
            elif path.is_file():
                yield rel + name, path
    yield from walk(root, "")


# --- reading sources ----------------------------------------------------------------------------


def blank_comments(text, strings=False):
    """The source with every comment replaced by spaces (newlines kept), and string contents too with
    `strings`; otherwise strings are left as they are.
    A quote opens a string that ends at its match or at the line's end, so a misread quote (in JSX
    text, say) blanks nothing beyond its line."""
    out, i, n = list(text), 0, len(text)
    prev = ""  # the last significant character, to tell a regex literal from a division
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out[i:j] = " " * (j - i)
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out[i:j] = [ch if ch == "\n" else " " for ch in text[i:j]]
            i = j
        elif c in "'\"`":
            j = _skip_string(text, i)
            if strings:
                keep = "\n$" if c == "`" else "\n"  # a template's `$` shows it isn't a literal
                out[i + 1:j - 1] = [ch if ch in keep else " " for ch in text[i + 1:j - 1]]
            i, prev = j, c
        elif c == "/" and (not prev or prev in "(,=:[!&|?{};+-*%<>~^" or _after_keyword(text, i)):
            j = i + 1
            in_class = False
            while j < n and text[j] != "\n":
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                elif text[j] == "/" and not in_class:
                    break
                j += 1
            i, prev = j + 1, "/"
        else:
            if not c.isspace():
                prev = c
            i += 1
    return "".join(out)


def _skip_string(text, i):
    q, j, n = text[i], i + 1, len(text)
    while j < n:
        c = text[j]
        if c == "\\":
            j += 2
        elif c == q:
            return j + 1
        elif c == "\n" and q != "`":
            return j
        elif q == "`" and text.startswith("${", j):
            depth, j = 1, j + 2
            while j < n and depth:
                if text[j] in "'\"`":
                    j = _skip_string(text, j)
                    continue
                depth += {"{": 1, "}": -1}.get(text[j], 0)
                j += 1
        else:
            j += 1
    return n


def _after_keyword(text, i):
    m = re.search(r"(\w+)\s*\Z", text[max(0, i - 12):i])
    return bool(m) and m.group(1) in {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete",
                                       "void", "throw", "yield", "await"}


def specifiers(text):
    """(specifier, kind) for every import in a source, kind being "value", "type", "raw" or
    "glob"/"glob-raw" (a pattern), with "dynamic" for an import of a non-literal."""
    text = text.lstrip("﻿")
    out = set()
    for reading in (text, blank_comments(text)):
        out.update(_specifiers(reading))
    if DYNAMIC_ANY.search(blank_comments(text, strings=True)):
        out.add(("<non-literal>", "dynamic"))
    return sorted(out)


def _specifiers(text):
    out = []
    for m in STATIC.finditer(text):
        clause = blank_comments(m.group(3)).strip()
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
    for m in URL.finditer(text):
        out.append((m.group(2), "raw"))
    for m in GLOB.finditer(text):
        raw = bool(m.group(2) and GLOB_RAW.search(m.group(2)))
        for lit in LITERAL.finditer(m.group(1)):
            if not lit.group(2).startswith("!"):
                out.append((lit.group(2), "glob-raw" if raw else "glob"))
    out = [(s, "raw" if k == "value" and re.search(r"\?(raw|url)\b", s) else k) for s, k in out]
    return out


def package_of(spec):
    if spec.startswith(BUILTIN):
        return spec
    parts = spec.split("/")
    return "/".join(parts[:2]) if spec.startswith("@") else parts[0]


def resolve(root, importer, spec):
    """A relative specifier as a repo path: the file it names, else the normalized path itself."""
    norm = Path(os.path.normpath(root / Path(importer).parent / spec.split("?", 1)[0]))
    cands = [Path(str(norm) + ext) for ext in RESOLVE]
    cands += [norm.with_suffix(ext) for ext in JS_TO_TS.get(norm.suffix, ())]
    return rel_to(root, next((c for c in cands if c.is_file()), norm))


def rel_to(root, path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return "<outside>/" + path.as_posix().lstrip("/")


def import_graph(root):
    """({file: [(target, kind, specifier)]} over every source file in the tree, [errors])."""
    files = list(files_under(root))
    paths = [rel for rel, _ in files]
    graph, errors = {}, []
    for rel, path in files:
        if path.suffix not in SOURCE:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"{rel}: [sources] isn't UTF-8, so its imports can't be read")
            continue
        edges = []
        for spec, kind in specifiers(text):
            if kind == "dynamic":
                errors.append(f"{rel}: [dynamic-imports] imports a non-literal specifier, so where it goes can't be checked; "
                              "import a literal path")
            elif kind.startswith("glob"):
                pattern = rel_to(root, Path(os.path.normpath(root / Path(rel).parent / spec.split("?", 1)[0])))
                kind = "raw" if kind == "glob-raw" else "value"
                hits = [p for p in paths if glob_re(pattern).match(p)] if spec.startswith((".", "/")) else []
                edges += [(p, kind, spec) for p in hits] or [(pattern if spec.startswith((".", "/")) else "pkg:" + package_of(spec), kind, spec)]
            else:
                target = resolve(root, rel, spec) if spec.startswith(".") else "pkg:" + package_of(spec)
                edges.append((target, kind, spec))
        graph[rel] = edges
    return graph, errors


def package_errors(root, graph):
    """Package imports the nearest package.json doesn't declare, and declared local paths."""
    manifests, errors = {}, []
    for rel in sorted(graph):
        pkg_dir = _nearest_manifest(root, rel, manifests, errors)
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
            errors.append(f"{rel}: [declared-packages] imports {spec!r}, which {pkg_dir or '.'}/package.json doesn't declare")
    return errors


def _nearest_manifest(root, rel, cache, errors):
    parts = rel.split("/")[:-1]
    while True:
        d = "/".join(parts)
        if d not in cache:
            manifest = root / d / "package.json"
            cache[d] = None
            if manifest.is_file():
                data = json.loads(manifest.read_text(encoding="utf-8"))
                cache[d] = set()
                for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                    for name, version in data.get(k, {}).items():
                        cache[d].add(name)
                        if isinstance(version, str) and version.startswith(LOCAL_SPEC):
                            errors.append(f"{d or '.'}/package.json: [declared-packages] {name!r} is a local path "
                                          f"({version}), which would reach another tree; packages come from a registry")
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
        members[Path(m).as_posix()] = tomllib.loads((root / m / "Cargo.toml").read_text(encoding="utf-8"))
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
        if not any(k in raw for k in ("deny", "only", "requires")):
            raise SystemExit(f"boundaries.toml: [{self.name}] needs `deny`, `only` or `requires`")
        self.deny = Globs(raw.get("deny"))
        self.only = Globs(raw["only"]) if "only" in raw else None
        self.requires = list(raw.get("requires", []))
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
        return self.deny(target) or (self.only is not None and not self.only(target))

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
    for f in roots:
        for need in rule.requires:
            if not any(t == need for t, _, _ in graph[f]):
                errors.append(f"{f}: [{rule.name}] doesn't import {need}. {rule.why}")
    if rule.deny.globs == [] and rule.only is None:
        return errors
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
                if kind == "type":
                    continue
                if rule.forbids(target):
                    if (f, target) not in reported and not rule.excused(f, target):
                        reported.add((f, target))
                        errors.append(f"{f}: [{rule.name}] imports {spec!r} ({target}), reached from "
                                      f"{' -> '.join(_chain(seen, f) + [target])}. {rule.why}")
                    continue
                if kind == "value" and target in graph and target not in seen:
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
    """From each covered crate: its dependencies of the rule's kinds, then what those link."""
    errors, reported = [], set()
    for start in graph:
        if not rule.applies(start):
            continue
        seen, queue = {start: None}, deque([start])
        while queue:
            crate = queue.popleft()
            for dep, kind, optional in graph.get(crate, []):
                first = crate == start
                if (kind not in rule.kinds) if first else (kind not in LINKED):
                    continue
                if first and optional and rule.optional_ok:
                    continue
                if rule.forbids(dep):
                    if (crate, dep) not in reported and not rule.excused(crate, dep):
                        reported.add((crate, dep))
                        how = f"a {kind} dependency on {dep}" if first else \
                            f"{dep} through {' -> '.join(_chain(seen, crate) + [dep])}"
                        errors.append(f"{start}: [{rule.name}] has {how}. {rule.why}")
                    continue
                if dep not in seen:
                    seen[dep] = crate
                    queue.append(dep)
    return errors


def load(config):
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    return [Rule(r, "imports") for r in data.get("imports", [])] + [Rule(r, "crates") for r in data.get("crates", [])]


GLOBAL = ("declared-packages", "dynamic-imports", "sources")


def check(root, config, only=None, extra_edges=(), extra_kind="value"):
    rules = load(config)
    if only:
        rules = [r for r in rules if r.name == only]
        if not rules and only not in GLOBAL:
            return [f"no rule named {only!r}"]
    graph, errors = import_graph(root)
    crates = crate_graph(root) if (root / "Cargo.toml").is_file() else {}
    for src, dst in extra_edges:
        graph.setdefault(src, []).append((dst, extra_kind, dst))
        crates.setdefault(src, []).append((dst, "normal", False))
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    dyn_allow = {a["file"]: a for a in data.get("dynamic_imports", {}).get("allow", [])}
    for f, a in dyn_allow.items():
        if not a.get("why"):
            raise SystemExit(f"boundaries.toml: [dynamic_imports] allow entry {f} needs a `why`")
    dynamic = {e.split(":", 1)[0] for e in errors if "[dynamic-imports]" in e}
    errors = [e for e in errors if not ("[dynamic-imports]" in e and e.split(":", 1)[0] in dyn_allow)]
    errors += [f"{config.name}: [dynamic-imports] stale allow entry {f}: it has no non-literal import any more; remove it"
               for f in dyn_allow if f not in dynamic]
    errors = [e for e in errors if only is None or f"[{only}]" in e]
    if only in (None, "declared-packages"):
        errors += package_errors(root, graph)
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
    ap.add_argument("--rule", help=f"check only this rule (or one of {', '.join(GLOBAL)})")
    ap.add_argument("--extra-edge", nargs=2, action="append", default=[], metavar=("FROM", "TO"),
                    help="add an import (or a normal crate dependency) before checking")
    ap.add_argument("--extra-kind", choices=("value", "type"), default="value", help="the kind of --extra-edge imports")
    args = ap.parse_args()
    errors = check(args.root.resolve(), args.config, args.rule, [tuple(e) for e in args.extra_edge], args.extra_kind)
    for e in errors:
        print(e)
    print(f"{len(errors)} boundary violation(s)" if errors else "all boundaries hold")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
