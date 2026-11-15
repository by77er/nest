"""The module-boundary checker (scripts/check-boundaries.py) must be able to fail: every rule in
boundaries.toml rejects its example edge on the real tree, and scratch trees pin down what counts as
an import, which imports are type-only, how far a transitive rule follows, and the crate graph."""

import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
REPO = SCRIPTS.parent
CHECK = SCRIPTS / "check-boundaries.py"
CONFIG = tomllib.loads((SCRIPTS / "boundaries.toml").read_text(encoding="utf-8"))
RULES = CONFIG.get("imports", []) + CONFIG.get("crates", [])


def run(root, config, *args):
    proc = subprocess.run([sys.executable, "-I", str(CHECK), "--root", str(root), "--config", str(config), *args],
                          capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def checker():
    """The checker as a module, reading the real tree's import graph once."""
    spec = importlib.util.spec_from_file_location("check_boundaries", CHECK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    graph = mod.import_graph(REPO)
    mod.import_graph = lambda root: copy.deepcopy(graph)
    return mod


class RealTree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = checker()

    def check(self, *args):
        """Like a run of the checker on the real tree: (exit code, output)."""
        rule, kind, edges = None, "value", []
        args = list(args)
        while args:
            flag = args.pop(0)
            if flag == "--rule":
                rule = args.pop(0)
            elif flag == "--extra-kind":
                kind = args.pop(0)
            elif flag == "--extra-edge":
                edges.append((args.pop(0), args.pop(0)))
        errors = self.mod.check(REPO, SCRIPTS / "boundaries.toml", rule, edges, kind)
        return (1 if errors else 0), "\n".join(errors)

    def test_the_repo_passes(self):
        code, out = run(REPO, SCRIPTS / "boundaries.toml")
        self.assertEqual(code, 0, out)

    def test_every_rule_rejects_its_example(self):
        for rule in RULES:
            if not ("deny" in rule or "only" in rule):
                continue  # a `requires` rule: tested in a scratch tree
            with self.subTest(rule=rule["name"]):
                self.assertIn("example", rule, "every rule needs an example edge its tests can plant")
                ex = rule["example"]
                code, out = self.check("--rule", rule["name"], "--extra-edge", ex["from"], ex["to"])
                self.assertEqual(code, 1, out)
                self.assertIn(f"[{rule['name']}]", out)

    def test_type_only_examples_pass_where_types_are_fine(self):
        for rule in RULES:
            if not rule.get("types_ok"):
                continue
            with self.subTest(rule=rule["name"]):
                ex = rule["example"]
                code, out = self.check("--rule", rule["name"], "--extra-kind", "type",
                                "--extra-edge", ex["from"], ex["to"])
                self.assertEqual(code, 0, out)

    def test_rule_names_are_unique(self):
        names = [r["name"] for r in RULES]
        self.assertEqual(len(names), len(set(names)))


class Scratch(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def plant(self, rel, text=""):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")

    def check(self, config, *args):
        self.plant("boundaries.toml", config)
        return run(self.root, self.root / "boundaries.toml", *args)


DENY_SRV = """
[[imports]]
name = "ui-no-server"
why = "test"
from = ["app/ui/**"]
deny = ["app/srv/**", "pkg:cloudflare:*"]
types_ok = true
"""


class Imports(Scratch):
    def test_type_only_forms_pass_and_value_forms_fail(self):
        self.plant("app/srv/a.ts", "export const a = 1; export type A = number;\n")
        type_only = [
            'import type { A } from "../srv/a";',
            'import { type A } from "../srv/a";',
            'import { type A, type A as B } from "../srv/a";',
            'export type { A } from "../srv/a";',
            'import type * as S from "../srv/a";',
            'let x: import("../srv/a").A;',
            'type T = typeof import("../srv/a");',
            'import {\n  type A,\n} from "../srv/a";',
            'import {\n  type A, // the page\'s type\n} from "../srv/a";',
            '\ufeffimport type { A } from "../srv/a";',
            'const s = "import(x)";',
            '// import { a } from "../srv/a";',
            '/*\n * import { a } from "../srv/a";\n */',
        ]
        for src in type_only:
            with self.subTest(src=src):
                self.plant("app/ui/x.ts", src + "\n")
                code, out = self.check(DENY_SRV)
                self.assertEqual(code, 0, out)
        value = [
            'import { a } from "../srv/a";',
            'import { type A, a } from "../srv/a";',
            'import A, { type B } from "../srv/a";',
            'import * as S from "../srv/a";',
            'export * from "../srv/a";',
            'export { a } from "../srv/a";',
            'import "../srv/a";',
            'const m = await import("../srv/a");',
            'import("../srv/a").then((m) => m.a);',
            'const m = require("../srv/a");',
            'import { b } from "./b"; import { a } from "../srv/a";',
            'import {\n  a,\n  b,\n} from "../srv/a.js";',
            'import { DurableObject } from "cloudflare:workers";',
            'import {\n  a, // the page\'s list\n} from "../srv/a";',
            '/* x */ import { a } from "../srv/a";',
            'const m = import(/* @vite-ignore */ "../srv/a");',
            '\ufeffimport { a } from "../srv/a";',
            'import { "a" as b } from "../srv/a";',
            'const u = new URL("../srv/a.ts", import.meta.url);',
            'const p = <p>Don\'t</p>;\nconst L = lazy(() => import("../srv/a"));',
            'const m = import.meta.glob("../srv/*.ts");',
            'const m = import.meta.glob<string>(["../x/*.ts", "../srv/{a,b}.ts"], { query: "?raw", import: "default" });',
            'const m = import.meta.glob("../**/a.ts", { eager: true });',
        ]
        for src in value:
            with self.subTest(src=src):
                self.plant("app/ui/x.ts", src + "\n")
                code, out = self.check(DENY_SRV)
                self.assertEqual(code, 1, out)
                self.assertIn("[ui-no-server]", out)

    def test_a_non_literal_dynamic_import_fails_unless_listed(self):
        for src in ("const m = await import(path);", "const m = await import(`./${name}`);"):
            with self.subTest(src=src):
                self.plant("app/ui/x.ts", src + "\n")
                code, out = self.check(DENY_SRV)
                self.assertEqual(code, 1, out)
                self.assertIn("[dynamic-imports]", out)
        listed = '[dynamic_imports]\nallow = [{ file = "app/ui/x.ts", why = "test" }]\n' + DENY_SRV
        self.assertEqual(self.check(listed)[0], 0)
        self.plant("app/ui/x.ts", 'const m = await import("./y");\n')
        code, out = self.check(listed)
        self.assertEqual(code, 1, out)
        self.assertIn("stale allow entry app/ui/x.ts", out)

    def test_raw_globs_are_not_followed(self):
        self.plant("app/ui/x.ts", 'const m = import.meta.glob("../shared/*.ts", { query: "?raw" });\n')
        self.plant("app/shared/s.ts", 'import { DurableObject } from "cloudflare:workers";\n')
        config = DENY_SRV.replace("types_ok = true", "types_ok = true\ntransitive = true")
        self.assertEqual(self.check(config)[0], 0)
        self.plant("app/ui/x.ts", 'const m = import.meta.glob("../shared/*.ts");\n')
        self.assertEqual(self.check(config)[0], 1)

    def test_build_output_is_skipped_only_beside_its_manifest(self):
        self.plant("app/package.json", "{}")
        self.plant("app/dist/x.ts", 'import { a } from "../srv/a";\n')
        self.plant("app/srv/a.ts", "export const a = 1;\n")
        config = DENY_SRV.replace('from = ["app/ui/**"]', 'from = ["app/**"]').replace('deny = ["app/srv/**", "pkg:cloudflare:*"]', 'deny = ["app/srv/**"]\nexclude = ["app/srv/**"]')
        self.assertEqual(self.check(config)[0], 0)
        self.plant("app/ui/dist/x.ts", 'import { a } from "../../srv/a";\n')
        self.assertEqual(self.check(config)[0], 1)

    def test_a_source_that_is_not_utf8_fails(self):
        path = self.root / "app/ui/x.ts"
        path.parent.mkdir(parents=True)
        path.write_bytes(b'import { a } from "../srv/a"; // \xff\n')
        code, out = self.check(DENY_SRV)
        self.assertEqual(code, 1, out)
        self.assertIn("isn't UTF-8", out)

    def test_requires_names_what_a_file_must_import(self):
        self.plant("app/view.ts", "export type V = number;\n")
        self.plant("app/ui/api.ts", 'import type { V } from "../view";\n')
        config = '[[imports]]\nname = "typed"\nwhy = "test"\nfrom = ["app/ui/api.ts"]\nrequires = ["app/view.ts"]\n'
        self.assertEqual(self.check(config)[0], 0)
        self.plant("app/ui/api.ts", "export type V = number;\n")
        code, out = self.check(config)
        self.assertEqual(code, 1, out)
        self.assertIn("doesn't import app/view.ts", out)

    def test_specifiers_resolve_to_files(self):
        self.plant("app/srv/dir/index.ts", "export const a = 1;\n")
        self.plant("app/srv/b.tsx", "export const b = 1;\n")
        config = """
        [[imports]]
        name = "exact"
        why = "test"
        from = ["app/ui/**"]
        deny = ["app/srv/dir/index.ts", "app/srv/b.tsx"]
        """
        for src in ('import { a } from "../srv/dir";', 'import { b } from "../srv/b.js";', 'import { b } from "../srv/b";'):
            with self.subTest(src=src):
                self.plant("app/ui/x.ts", src + "\n")
                self.assertEqual(self.check(config)[0], 1)

    def test_transitive_rules_follow_value_imports_only(self):
        self.plant("app/ui/page.ts", 'import { s } from "../shared/s";\nimport type { T } from "../shared/t";\nimport txt from "../shared/r.ts?raw";\n')
        self.plant("app/shared/s.ts", 'import { m } from "./m";\nexport const s = m;\n')
        self.plant("app/shared/m.ts", "export const m = 1;\n")
        self.plant("app/shared/t.ts", 'import { DurableObject } from "cloudflare:workers";\nexport type T = number;\n')
        self.plant("app/shared/r.ts", 'import { DurableObject } from "cloudflare:workers";\n')
        config = DENY_SRV.replace("types_ok = true", "types_ok = true\ntransitive = true")
        self.assertEqual(self.check(config)[0], 0)
        self.plant("app/shared/m.ts", 'import { x } from "../srv/x";\nexport const m = x;\n')
        code, out = self.check(config)
        self.assertEqual(code, 1, out)
        self.assertIn("app/ui/page.ts -> app/shared/s.ts -> app/shared/m.ts -> app/srv/x", out)

    def test_raw_reads_count_for_direct_rules(self):
        self.plant("app/srv/a.ts", "export const a = 1;\n")
        self.plant("app/ui/x.ts", 'import text from "../srv/a.ts?raw";\n')
        self.assertEqual(self.check(DENY_SRV)[0], 1)

    def test_only_rejects_anything_outside(self):
        self.plant("app/x.ts", 'import { z } from "zod";\nimport { y } from "../other/y";\n')
        config = '[[imports]]\nname = "only"\nwhy = "test"\nfrom = ["app/**"]\nonly = ["app/**", "pkg:zod"]\n'
        code, out = self.check(config)
        self.assertEqual(code, 1, out)
        self.assertIn("other/y", out)
        self.assertIn("1 boundary violation(s)", out)

    def test_exclude_and_allow_excuse_and_a_stale_allow_fails(self):
        self.plant("app/srv/a.ts", "export const a = 1;\n")
        self.plant("app/ui/x.test.ts", 'import { a } from "../srv/a";\n')
        self.plant("app/ui/y.ts", 'import { a } from "../srv/a";\n')
        base = DENY_SRV + 'exclude = ["**/*.test.ts"]\n'
        self.assertEqual(self.check(base)[0], 1)
        allowed = base + 'allow = [{ from = "app/ui/y.ts", to = "app/srv/a.ts", why = "test" }]\n'
        self.assertEqual(self.check(allowed)[0], 0)
        (self.root / "app/ui/y.ts").unlink()
        code, out = self.check(allowed)
        self.assertEqual(code, 1, out)
        self.assertIn("stale allow entry", out)

    def test_an_allow_entry_needs_a_reason(self):
        code, out = self.check(DENY_SRV + 'allow = [{ from = "a", to = "b" }]\n')
        self.assertNotEqual(code, 0)
        self.assertIn("needs a `why`", out)


class DeclaredPackages(Scratch):
    def test_imports_must_name_declared_packages(self):
        self.plant("app/package.json", json.dumps({"dependencies": {"react": "1"}, "devDependencies": {"@types/hast": "1", "@types/scope__lib": "1"}}))
        ok = 'import React from "react";\nimport { x } from "react/jsx-runtime";\nimport { readFileSync } from "node:fs";\nimport { DurableObject } from "cloudflare:workers";\nimport type { Root } from "hast";\nimport type { L } from "@scope/lib";\n'
        self.plant("app/src/x.ts", ok)
        self.assertEqual(self.check("")[0], 0)
        for bad in ('import { z } from "zod";', 'import { Root } from "hast";', 'import "@scope/other/styles.css";'):
            with self.subTest(bad=bad):
                self.plant("app/src/x.ts", bad + "\n")
                code, out = self.check("")
                self.assertEqual(code, 1, out)
                self.assertIn("[declared-packages]", out)

    def test_a_local_path_dependency_fails(self):
        for spec in ("file:../control-plane", "link:../x", "workspace:*", "../x"):
            with self.subTest(spec=spec):
                self.plant("app/package.json", json.dumps({"dependencies": {"cp": spec}}))
                self.plant("app/x.ts", 'import { s } from "cp/src/lib/spec";\n')
                code, out = self.check("")
                self.assertEqual(code, 1, out)
                self.assertIn("is a local path", out)

    def test_the_nearest_package_json_decides(self):
        self.plant("app/package.json", json.dumps({"dependencies": {"zod": "1"}}))
        self.plant("app/sub/package.json", json.dumps({"dependencies": {}}))
        self.plant("app/sub/x.ts", 'import { z } from "zod";\n')
        self.assertEqual(self.check("")[0], 1)


WORKSPACE = """
[workspace]
members = ["crates/proto", "crates/host", "crates/agent"]
[workspace.dependencies]
proto = { path = "crates/proto" }
"""

CRATE_RULE = """
[[crates]]
name = "agent-no-host"
why = "test"
from = ["agent"]
kinds = ["normal", "build"]
deny = ["host"]
optional_ok = true
"""


class Crates(Scratch):
    def manifest(self, name, body=""):
        self.plant(f"crates/{name}/Cargo.toml", f'[package]\nname = "{name}"\nversion = "0.1.0"\n' + textwrap.dedent(body))

    def setUp(self):
        super().setUp()
        self.plant("Cargo.toml", WORKSPACE)
        self.manifest("proto")
        self.manifest("host", "[dependencies]\nproto.workspace = true\n")

    def test_each_way_to_depend_counts(self):
        self.manifest("agent", "[dependencies]\nproto.workspace = true\n")
        self.assertEqual(self.check(CRATE_RULE)[0], 0)
        for body in (
            '[dependencies]\nhost = { path = "../host" }\n',
            '[dependencies.h]\npath = "../host"\npackage = "host"\n',
            '[build-dependencies]\nhost = { path = "../host" }\n',
            "[target.'cfg(unix)'.dependencies]\nhost = { path = \"../host\" }\n",
            '[dependencies]\nhost = { path = "../host", optional = true }\n[features]\ndefault = ["extra"]\nextra = ["dep:host"]\n',
        ):
            with self.subTest(body=body):
                self.manifest("agent", body)
                code, out = self.check(CRATE_RULE)
                self.assertEqual(code, 1, out)
                self.assertIn("[agent-no-host]", out)

    def test_a_dependency_through_another_crate_counts(self):
        self.plant("Cargo.toml", WORKSPACE.replace('"crates/agent"]', '"crates/agent", "crates/mid"]'))
        self.manifest("mid", '[dependencies]\nhost = { path = "../host" }\n')
        self.manifest("agent", '[dependencies]\nmid = { path = "../mid" }\n')
        code, out = self.check(CRATE_RULE)
        self.assertEqual(code, 1, out)
        self.assertIn("host through agent -> mid -> host", out)
        self.manifest("mid", '[dev-dependencies]\nhost = { path = "../host" }\n')
        self.assertEqual(self.check(CRATE_RULE)[0], 0)

    def test_kinds_and_optional_dependencies_are_respected(self):
        for body in (
            '[dev-dependencies]\nhost = { path = "../host" }\n',
            '[dependencies]\nhost = { path = "../host", optional = true }\n[features]\ntest-support = ["dep:host"]\n',
        ):
            with self.subTest(body=body):
                self.manifest("agent", body)
                code, out = self.check(CRATE_RULE)
                self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
