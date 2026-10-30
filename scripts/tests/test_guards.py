"""Every repo guard must be able to fail: a guard that only ever passes can't be told apart from
one that never looks. Each test copies a guard into a scratch tree, plants a violation, and
checks the guard rejects it; then checks it accepts the clean case."""

import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
FENCES = tomllib.loads((SCRIPTS / "fences.toml").read_text(encoding="utf-8"))["fence"]


def run(script, root, *args):
    proc = subprocess.run([sys.executable, "-I", str(script), *args], capture_output=True, text=True, cwd=root)
    return proc.returncode, proc.stdout + proc.stderr


def scope_path(glob, name):
    """A concrete path inside a `files` or `allow` glob."""
    path = glob.replace("**", "zz_probe").replace("*", "zz").replace("?", "z")
    return path if not path.endswith("zz_probe") else f"{path}/{name}"


class Fences(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "scripts").mkdir()
        for f in ("check-fences.py", "fences.toml"):
            shutil.copy(SCRIPTS / f, self.root / "scripts" / f)

    def plant(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")

    def check(self, fence=None):
        args = ["--fence", fence] if fence else []
        return run(self.root / "scripts" / "check-fences.py", self.root, *args)

    def test_clean_tree_passes(self):
        self.assertEqual(self.check()[0], 0)

    def test_every_fence_rejects_its_example_outside_allow(self):
        for fence in FENCES:
            with self.subTest(fence=fence["name"]):
                self.assertIn("example", fence, "every fence needs an example line its tests can plant")
                rel = scope_path(fence["files"][0], "probe.rs")
                self.plant(rel, fence["example"])
                code, out = self.check(fence["name"])
                self.assertEqual(code, 1, out)
                self.assertIn(f"[{fence['name']}]", out)
                (self.root / rel).unlink()

    def test_every_allow_entry_accepts_the_example(self):
        for fence in FENCES:
            for glob in fence.get("allow", []):
                with self.subTest(fence=fence["name"], allow=glob):
                    rel = scope_path(glob, "probe.rs")
                    self.plant(rel, fence["example"])
                    code, out = self.check(fence["name"])
                    self.assertEqual(code, 0, out)
                    (self.root / rel).unlink()

    def test_stale_allow_entry_fails(self):
        fence = next(f for f in FENCES if f.get("allow"))
        self.plant(scope_path(fence["allow"][0], "probe.rs"), "nothing to see here")
        code, out = self.check(fence["name"])
        self.assertEqual(code, 1, out)
        self.assertIn("stale allow entry", out)


class CorePurityFence(unittest.TestCase):
    """The nestd-core fence lets the crate name `alloc`, never bring `std` back."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "scripts").mkdir()
        for f in ("check-fences.py", "fences.toml"):
            shutil.copy(SCRIPTS / f, self.root / "scripts" / f)

    def check(self, line):
        path = self.root / "crates" / "nestd-core" / "src" / "lib.rs"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(line + "\n", encoding="utf-8")
        return run(self.root / "scripts" / "check-fences.py", self.root, "--fence", "nestd-core-purity")

    def test_extern_crate_alloc_passes(self):
        self.assertEqual(self.check("extern crate alloc;")[0], 0)

    def test_extern_crate_std_fails(self):
        for line in ("extern crate std;", "extern crate std as s;", "extern  crate alloc as std;"):
            with self.subTest(line=line):
                self.assertEqual(self.check(line)[0], 1, line)


class CoreManifest(unittest.TestCase):
    """check-core-manifest.py over a copy of nestd-core's real manifest and lib.rs."""

    CRATE = SCRIPTS.parent / "crates" / "nestd-core"

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.crate = self.root / "nestd-core"
        (self.crate / "src").mkdir(parents=True)
        shutil.copy(self.CRATE / "Cargo.toml", self.crate / "Cargo.toml")
        shutil.copy(self.CRATE / "src" / "lib.rs", self.crate / "src" / "lib.rs")

    def check(self):
        return run(SCRIPTS / "check-core-manifest.py", self.root, str(self.crate))

    def prepend(self, text):
        """At the top, so a dotted or inline key is top-level rather than inside the last table."""
        path = self.crate / "Cargo.toml"
        path.write_text(text + "\n\n" + path.read_text(encoding="utf-8"), encoding="utf-8")

    def test_the_real_crate_passes(self):
        self.assertEqual(self.check()[0], 0)

    def test_dev_dependencies_pass(self):
        self.prepend('[dev-dependencies]\nproptest = "1"\n\n[target.\'cfg(unix)\'.dev-dependencies]\nx = "1"')
        self.assertEqual(self.check()[0], 0)

    def test_every_way_to_name_a_dependency_fails(self):
        cases = {
            "table": '[dependencies]\nlibc = "0.2"',
            "dotted key": 'dependencies.libc = "0.2"',
            "dotted table": '[dependencies.libc]\nversion = "0.2"',
            "inline table": 'dependencies = { libc = "0.2" }',
            "workspace dependency": "[dependencies]\nlibc.workspace = true",
            "build dependency": '[build-dependencies]\ncc = "1"',
            "old spelling": '[build_dependencies]\ncc = "1"',
            "target table": '[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"',
            "target dotted": 'target."cfg(unix)".dependencies.libc = "0.2"',
            "target build": '[target.x86_64-unknown-linux-gnu.build-dependencies]\ncc = "1"',
            "patch": '[patch.crates-io]\nlibc = { path = "x" }',
        }
        for name, text in cases.items():
            with self.subTest(name):
                shutil.copy(self.CRATE / "Cargo.toml", self.crate / "Cargo.toml")
                self.prepend(text)
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn("nestd-core", out)

    def test_a_build_script_fails(self):
        manifest = (self.CRATE / "Cargo.toml").read_text(encoding="utf-8")
        with self.subTest("package.build"):
            (self.crate / "Cargo.toml").write_text(manifest.replace("[package]\n", '[package]\nbuild = "gen.rs"\n', 1), encoding="utf-8")
            code, out = self.check()
            self.assertEqual(code, 1, out)
            self.assertIn("package.build", out)
        with self.subTest("[build] table"):
            (self.crate / "Cargo.toml").write_text(manifest + '\n[build]\nrustflags = ["--cfg", "x"]\n', encoding="utf-8")
            self.assertEqual(self.check()[0], 1)
        with self.subTest("build.rs"):
            (self.crate / "Cargo.toml").write_text(manifest, encoding="utf-8")
            (self.crate / "build.rs").write_text("fn main() {}\n", encoding="utf-8")
            code, out = self.check()
            self.assertEqual(code, 1, out)
            self.assertIn("build.rs", out)

    def test_dropping_no_std_fails(self):
        lib = self.crate / "src" / "lib.rs"
        lib.write_text(lib.read_text(encoding="utf-8").replace("#![cfg_attr(not(test), no_std)]\n", ""), encoding="utf-8")
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("no_std", out)

    def test_a_commented_out_no_std_fails(self):
        lib = self.crate / "src" / "lib.rs"
        text = lib.read_text(encoding="utf-8")
        for name, hidden in {
            "block comment": "/*\n#![cfg_attr(not(test), no_std)]\n*/\n",
            "nested block comment": "/* /* */\n#![cfg_attr(not(test), no_std)]\n*/\n",
        }.items():
            with self.subTest(name):
                lib.write_text(text.replace("#![cfg_attr(not(test), no_std)]\n", hidden), encoding="utf-8")
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn("no_std", out)

    def test_code_from_outside_the_crate_or_std_fails(self):
        lib = self.crate / "src" / "lib.rs"
        text = lib.read_text(encoding="utf-8")
        cases = {
            "extern crate std": ("extern crate std;", "extern crate"),
            "split over lines and renamed": ("extern\ncrate std as s;", "extern crate"),
            "another crate": ("extern crate core as c;", "extern crate"),
            "#[path]": ('#[path = "../../nestd/src/util.rs"]\nmod util;', "#[path]"),
            "spaced #[path]": ('# [ path = "x.rs" ] mod x;', "#[path]"),
            "include!": ('include!("../../nestd/src/util.rs");', "include!"),
        }
        for name, (line, what) in cases.items():
            with self.subTest(name):
                lib.write_text(text + "\n" + line + "\n", encoding="utf-8")
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn(what, out)
        with self.subTest("only in a comment"):
            lib.write_text(text + "\n// extern crate std;\n/* #[path = \"x.rs\"] mod x; include!(\"y\"); */\n", encoding="utf-8")
            self.assertEqual(self.check()[0], 0)
        with self.subTest("alloc"):
            lib.write_text(text.replace("extern crate alloc;", "extern\ncrate alloc;"), encoding="utf-8")
            self.assertEqual(self.check()[0], 0)


class DocLinks(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "scripts").mkdir()
        shutil.copy(SCRIPTS / "check-doc-links.py", self.root / "scripts")
        (self.root / "docs" / "sub").mkdir(parents=True)
        (self.root / "docs" / "sub" / "README.md").write_text("# Sub\n\n## The `nest` CLI\n", encoding="utf-8")

    def check(self, body):
        (self.root / "docs" / "README.md").write_text(body, encoding="utf-8")
        return run(self.root / "scripts" / "check-doc-links.py", self.root)

    def test_good_links_pass(self):
        self.assertEqual(self.check("[a](sub/) [b](sub/#the-nest-cli) [c](https://x.y/z)\n")[0], 0)

    def test_missing_file_fails(self):
        code, out = self.check("[a](nope/)\n")
        self.assertEqual(code, 1, out)
        self.assertIn("missing nope/", out)

    def test_missing_anchor_fails(self):
        code, out = self.check("[a](sub/#no-such-heading)\n")
        self.assertEqual(code, 1, out)
        self.assertIn("no heading for #no-such-heading", out)

    def test_links_in_code_are_ignored(self):
        self.assertEqual(self.check("`[a](nope/)`\n\n```\n[b](nope/)\n```\n")[0], 0)


if __name__ == "__main__":
    unittest.main()
