"""scripts/ci-changes.py: a change runs every job whose inputs it touches, and an unknown path runs
everything. Each case is a path a past PR touched or a cross-directory read a job depends on."""

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "ci-changes.py"
ALL = {"rust", "control-plane", "dashboard", "projects", "e2e", "infra", "verify-nestd", "fuzz-nestd"}


def jobs(*paths, args=()):
    proc = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], input="\n".join(paths) + "\n",
                          capture_output=True, text=True, check=True)
    out = dict(line.split("=") for line in proc.stdout.split())
    assert set(out) == ALL, out
    return {k for k, v in out.items() if v == "true"}


class CiChanges(unittest.TestCase):
    def test_docs_only_runs_nothing(self):
        self.assertEqual(jobs("docs/README.md", "dev/ci.md", ".claude/skills/x/SKILL.md", "README.md"), set())

    def test_unknown_path_runs_everything(self):
        self.assertEqual(jobs("docs/a.md", "newdir/thing.rs"), ALL)
        self.assertEqual(jobs("Makefile"), ALL)

    def test_ci_itself_runs_everything(self):
        self.assertEqual(jobs(".github/workflows/ci.yml"), ALL)
        self.assertEqual(jobs("scripts/ci-changes.py"), ALL)

    def test_other_workflows_and_guards_run_nothing_extra(self):
        self.assertEqual(jobs(".github/workflows/deploy.yml", "scripts/check-fences.py", "scripts/tests/test_guards.py"), set())

    def test_ui_review_tooling_runs_nothing(self):
        # Run by hand and by the design reviewer, never in CI (Actions minutes).
        self.assertEqual(jobs("scripts/ui-review/review.mjs", "scripts/ui-review/package-lock.json",
                              "scripts/ui-review/fixtures/projects/demo.mjs"), set())

    def test_control_plane(self):
        self.assertEqual(jobs("control-plane/src/do/agent.ts"), {"control-plane", "e2e"})
        # The dashboard imports the admin view types.
        self.assertEqual(jobs("control-plane/src/protocol/admin/view.ts"), {"control-plane", "e2e", "dashboard"})
        # nestd's s3 test reads GC_GRACE_MS from fleet.ts.
        self.assertIn("rust", jobs("control-plane/src/do/fleet.ts"))

    def test_rust(self):
        self.assertEqual(jobs("crates/nest-runner/src/main.rs"), {"rust", "e2e"})
        self.assertEqual(jobs("crates/nestd/src/host.rs"), {"rust", "e2e", "fuzz-nestd"})
        self.assertEqual(jobs("crates/nestd-core/src/lease.rs"), {"rust", "e2e", "verify-nestd", "fuzz-nestd"})
        self.assertEqual(jobs("Cargo.lock"), {"rust", "e2e", "verify-nestd"})
        self.assertEqual(jobs(".cargo/mutants.toml"), {"rust", "e2e", "verify-nestd"})

    def test_protocol_reaches_both_sides(self):
        self.assertEqual(jobs("protocol/fixtures/control/command/x.json"), {"rust", "control-plane", "e2e", "fuzz-nestd"})

    def test_verification(self):
        self.assertEqual(jobs("verification/tla/agent-brain/AgentBrain.tla"), set())
        self.assertEqual(jobs("verification/nestd/check/tests/variants.rs"), {"verify-nestd"})
        self.assertEqual(jobs("verification/nestd/fuzz/Cargo.lock"), {"fuzz-nestd", "rust"})

    def test_infra(self):
        self.assertEqual(jobs("deploy/host/bootstrap.sh"), {"infra"})
        self.assertEqual(jobs("scripts/infra-tools.sh"), {"infra"})

    def test_union(self):
        self.assertEqual(jobs("dashboard/src/App.tsx", "deploy/lean/Cell/Stack.lean"), {"dashboard", "infra"})
        self.assertEqual(jobs("mcp-test/src/index.ts"), {"e2e"})

    def test_projects_runs_only_its_own_job(self):
        self.assertEqual(jobs("projects/src/worker.ts", "projects/package-lock.json"), {"projects"})
        self.assertEqual(jobs("projects/README.md"), {"projects"})

    def test_projects_stack_runs_only_infra(self):
        self.assertEqual(jobs("projects/deploy/lean/Projects/Stack.lean"), {"infra"})
        self.assertEqual(jobs("projects/deploy/inframe.toml", "projects/src/worker.ts"), {"infra", "projects"})

    def test_ui_design_skill_runs_both_apps(self):
        self.assertEqual(jobs(".claude/skills/nest-ui-design/SKILL.md"), {"dashboard", "projects"})
        self.assertEqual(jobs(".claude/skills/nest-tests/SKILL.md"), set())

    def test_flags(self):
        self.assertEqual(jobs(args=["--all"]), ALL)
        self.assertEqual(jobs("crates/nestd/src/host.rs", args=["--none"]), set())


if __name__ == "__main__":
    unittest.main()
