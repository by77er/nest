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
