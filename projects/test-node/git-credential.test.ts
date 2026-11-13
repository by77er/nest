// The environment the app gives a sandbox for GitHub (src/github-access.ts), run through the real git and gh
// (README.md#repo-authority): git, configured as nest's guest image configures it (`credential.https://github.com.helper
// nest`, a helper answering the image's placeholder; images/guest/build.sh), answers github.com with
// `x-access-token` and the app's placeholder instead, and nothing else; gh takes `GH_TOKEN` over the image's
// `GITHUB_TOKEN`. No network: `git credential fill` asks the helpers only.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubEnv } from "../src/github-access";

let dir: string;
/** The image's environment for a command (nest-guest's own, read from /etc/environment), and its system config. */
let image: Record<string, string>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nest-git-cred-"));
  // The image's helper, as images/guest/git-credential-nest answers: the kernel's placeholder.
  writeFileSync(join(dir, "git-credential-nest"), "#!/bin/sh\n[ \"$1\" = get ] || exit 0\ncat >/dev/null\necho username=x-access-token\necho password=nest-ph-github\n");
  chmodSync(join(dir, "git-credential-nest"), 0o755);
  writeFileSync(join(dir, "system.gitconfig"), "[credential \"https://github.com\"]\n\thelper = nest\n");
  image = {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_SYSTEM: join(dir, "system.gitconfig"), GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GITHUB_TOKEN: "nest-ph-github", LANG: "C",
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** `git credential fill` for a URL, as a command in the sandbox runs it: its fields, or null when no helper answered. */
function fill(env: Record<string, string>, host: string): Record<string, string> | null {
  const r = spawnSync("git", ["credential", "fill"], { input: `protocol=https\nhost=${host}\n\n`, env, encoding: "utf8" });
  if (r.status !== 0) return null;
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
}

describe("git with the app's GitHub environment", () => {
  it("the image alone answers its own placeholder (the setup this test overrides)", () => {
    expect(fill(image, "github.com")).toMatchObject({ username: "x-access-token", password: "nest-ph-github" });
  });

  it("answers github.com with x-access-token and the app's placeholder, the image's helper reset", () => {
    for (const kind of ["push", "read"] as const) {
      const got = fill({ ...image, ...githubEnv("cli_abc", kind) }, "github.com");
      expect(got, kind).toMatchObject({ protocol: "https", host: "github.com", username: "x-access-token", password: `nest-ph.cli_abc.gh_${kind}.` });
    }
  });

  it("answers no other host", () => {
    expect(fill({ ...image, ...githubEnv("cli_abc", "push") }, "gitlab.com")).toBeNull();
  });

  it("store and erase do nothing and fail nothing (git calls them after a push)", () => {
    const env = { ...image, ...githubEnv("cli_abc", "push") };
    for (const action of ["approve", "reject"]) {
      const r = spawnSync("git", ["credential", action], { input: "protocol=https\nhost=github.com\nusername=x-access-token\npassword=nest-ph.cli_abc.gh_push.\n\n", env, encoding: "utf8" });
      expect(r.status, `${action}: ${r.stderr}`).toBe(0);
    }
  });

  it("git sees the helper as its configuration says: the image's emptied, then the app's", () => {
    const out = execFileSync("git", ["config", "--get-all", "credential.https://github.com.helper"], { env: { ...image, ...githubEnv("cli_abc", "push") }, encoding: "utf8" });
    expect(out.replace(/\n$/, "").split("\n")).toEqual(["nest", "", githubEnv("cli_abc", "push").GIT_CONFIG_VALUE_1]);
  });
});

describe("gh with the app's GitHub environment", () => {
  it("takes GH_TOKEN, the app's placeholder, over the image's GITHUB_TOKEN", () => {
    const has = spawnSync("gh", ["--version"], { encoding: "utf8" });
    if (has.error || has.status !== 0) {
      // Not installed here: CI's runner has it, and must run this.
      if (process.env.CI) throw new Error("gh isn't installed on this CI runner");
      console.log("NEST-TEST-SKIP: gh isn't installed");
      return;
    }
    const r = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], { env: { ...image, GH_CONFIG_DIR: join(dir, "gh"), ...githubEnv("cli_abc", "push") }, encoding: "utf8" });
    expect(r.stdout.trim(), r.stderr).toBe("nest-ph.cli_abc.gh_push.");
  });
});
