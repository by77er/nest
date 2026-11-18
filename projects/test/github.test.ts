// src/github.ts's pure parts against GitHub's own docs: the webhook signature against the example in
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries, the review check's
// required-checks rules, and the check output a verdict makes.
import { describe, expect, it } from "vitest";
import { CHECK_NAME, clip, OUTPUT_MAX, protectionKeeping, TITLE_MAX, verdictCheck, verifyGithubSignature, withReviewCheck } from "../src/github";
import { CODE_REVIEW, parseVerdict, type Review, type Verdict } from "../src/reviewers";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("the webhook signature", () => {
  // GitHub's documented test values.
  const SECRET = "It's a Secret to Everybody";
  const PAYLOAD = "Hello, World!";
  const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("matches GitHub's example", async () => {
    expect(await verifyGithubSignature(SECRET, SIGNATURE, bytes(PAYLOAD))).toBe(true);
  });

  it.each([
    ["missing", null, PAYLOAD, SECRET],
    ["empty", "", PAYLOAD, SECRET],
    ["without its sha256= prefix", SIGNATURE.slice(7), PAYLOAD, SECRET],
    ["in upper case", SIGNATURE.toUpperCase().replace("SHA256", "sha256"), PAYLOAD, SECRET],
    ["over another body", SIGNATURE, `${PAYLOAD} `, SECRET],
    ["under another secret", SIGNATURE, PAYLOAD, `${SECRET}.`],
    ["the SHA-1 header's format", "sha1=0123456789abcdef0123456789abcdef01234567", PAYLOAD, SECRET],
  ])("refuses a signature %s", async (_n, header, body, secret) => {
    expect(await verifyGithubSignature(secret, header, bytes(body))).toBe(false);
  });
});

describe("the review check among the required checks", () => {
  it("is added from the App, a context-only list read as entries from any source", () => {
    expect(withReviewCheck({ strict: true, contexts: ["ci"] }, 7)).toEqual({ checks: [{ context: "ci", app_id: -1 }, { context: CHECK_NAME, app_id: 7 }] });
  });

  it("keeps other entries' app pins, sending any source back as -1", () => {
    const have = { checks: [{ context: "ci", app_id: 15368 }, { context: "lint", app_id: null }] };
    expect(withReviewCheck(have, 7)).toEqual({ checks: [{ context: "ci", app_id: 15368 }, { context: "lint", app_id: -1 }, { context: CHECK_NAME, app_id: 7 }] });
  });

  it("is left alone once there, and pinned to the App once its id is known", () => {
    expect(withReviewCheck({ checks: [{ context: CHECK_NAME, app_id: 7 }] }, 7)).toBeNull();
    expect(withReviewCheck({ checks: [{ context: CHECK_NAME, app_id: null }] }, 7)).toEqual({ checks: [{ context: CHECK_NAME, app_id: 7 }] });
  });

  it("writes a protected branch's settings back as GitHub's PUT names them", () => {
    // GET's shape (https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection).
    const get = {
      enforce_admins: { url: "u", enabled: true },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2, require_last_push_approval: false,
        bypass_pull_request_allowances: { users: [{ login: "octocat" }], teams: [{ slug: "core" }], apps: [] },
      },
      restrictions: { users: [{ login: "octocat" }], teams: [], apps: [{ slug: "deployer" }] },
      required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      block_creations: { enabled: true }, required_conversation_resolution: { enabled: true }, lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
    };
    expect(protectionKeeping(get, { strict: false, contexts: [CHECK_NAME] })).toEqual({
      required_status_checks: { strict: false, contexts: [CHECK_NAME] },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2, require_last_push_approval: false,
        bypass_pull_request_allowances: { users: ["octocat"], teams: ["core"], apps: [] },
      },
      restrictions: { users: ["octocat"], teams: [], apps: ["deployer"] },
      required_linear_history: true, allow_force_pushes: false, allow_deletions: false, block_creations: true,
      required_conversation_resolution: true, lock_branch: false, allow_fork_syncing: false,
    });
  });
});

describe("a verdict's check", () => {
  type P = "pass" | "fail";
  const code = (c: P, q: P, a: P, o: { summary?: string; tainted?: boolean } = {}): Review => ({
    reviewer: { id: CODE_REVIEW.id, name: CODE_REVIEW.name }, agent: "agt_r", tainted: o.tainted ?? false,
    dimensions: [
      { name: "Correctness", verdict: c, notes: "correctness notes" },
      { name: "Quality", verdict: q, notes: "quality notes" },
      { name: "Architectural cohesiveness", verdict: a, notes: "architecture notes" },
    ],
    summary: o.summary ?? "the summary",
  });
  const v = (...reviews: Review[]): Verdict => ({ reviews });
  const TAINTED = "yes (its session read untrusted content, such as the PR itself, which could have steered this verdict)";

  describe("the built-in reviewer alone: the check as the release before made it", () => {
    // The release before's output for the same verdicts, written out: the oracle.
    const before = (c: P, q: P, a: P, tainted: boolean, summary: string) => {
      const failed = [["correctness", c], ["quality", q], ["architectural cohesiveness", a]].filter(([, x]) => x !== "pass").map(([n]) => n);
      return {
        conclusion: failed.length ? "failure" : "success",
        output: {
          title: failed.length ? `Review failed: ${failed.join(", ")}` : "Review passed",
          summary: summary || "(no summary)",
          text: `## Correctness: ${c}\n\ncorrectness notes\n\n## Quality: ${q}\n\nquality notes\n\n## Architectural cohesiveness: ${a}\n\narchitecture notes\n\n---\n\nReviewer: agt_r. Tainted: ${tainted ? TAINTED : "no"}.`,
        },
      };
    };

    it("gives the same conclusion, title, summary and text for every verdict", () => {
      for (const c of ["pass", "fail"] as const) for (const q of ["pass", "fail"] as const) for (const a of ["pass", "fail"] as const) for (const tainted of [false, true]) for (const summary of ["the summary", ""]) {
        expect(verdictCheck(v(code(c, q, a, { tainted, summary }))), `${c} ${q} ${a} ${tainted} ${JSON.stringify(summary)}`).toEqual(before(c, q, a, tainted, summary));
      }
    });

    it("reads a row the release before stored as that same check", () => {
      const old = JSON.stringify({ correctness: { verdict: "fail", notes: "correctness notes" }, quality: { verdict: "pass", notes: "quality notes" }, architecture: { verdict: "fail", notes: "architecture notes" }, summary: "the summary" });
      expect(verdictCheck(parseVerdict(old, { agent: "agt_r", tainted: true }))).toEqual(before("fail", "pass", "fail", true, "the summary"));
    });
  });

  describe("several reviews", () => {
    const security = (s: P, o: { tainted?: boolean } = {}): Review => ({
      reviewer: { id: "rv_sec", name: "Security" }, agent: "agt_s", tainted: o.tainted ?? false,
      dimensions: [{ name: "Secrets", verdict: s, notes: "secrets notes" }, { name: "Injection", verdict: "pass", notes: "injection notes" }],
      summary: "security summary",
    });

    it("succeeds only if every dimension of every review passes", () => {
      expect(verdictCheck(v(code("pass", "pass", "pass"), security("pass"))).conclusion).toBe("success");
      expect(verdictCheck(v(code("pass", "pass", "pass"), security("fail"))).conclusion).toBe("failure");
      expect(verdictCheck(v(code("pass", "fail", "pass"), security("pass"))).conclusion).toBe("failure");
      // Nothing judged is no pass.
      expect(verdictCheck(v()).conclusion).toBe("failure");
      expect(verdictCheck(v({ ...security("pass"), dimensions: [] })).conclusion).toBe("failure");
    });

    it("names each failed reviewer with its failed dimensions in the title, and gives each reviewer a section", () => {
      const out = verdictCheck(v(code("fail", "pass", "fail"), security("fail", { tainted: true })));
      expect(out.output.title).toBe("Review failed: Code review (correctness, architectural cohesiveness); Security (secrets)");
      expect(verdictCheck(v(code("pass", "pass", "pass"), security("fail"))).output.title).toBe("Review failed: Security (secrets)");
      expect(verdictCheck(v(code("pass", "pass", "pass"), security("pass"))).output.title).toBe("Review passed");
      expect(out.output.summary).toBe("**Code review** (failed): the summary\n\n**Security** (failed): security summary");
      expect(out.output.text).toBe([
        "# Code review: failed\n\n## Correctness: fail\n\ncorrectness notes\n\n## Quality: pass\n\nquality notes\n\n## Architectural cohesiveness: fail\n\narchitecture notes\n\nReviewer: agt_r. Tainted: no.",
        `# Security: failed\n\n## Secrets: fail\n\nsecrets notes\n\n## Injection: pass\n\ninjection notes\n\nReviewer: agt_s. Tainted: ${TAINTED}.`,
      ].join("\n\n---\n\n"));
    });

    it("a reviewer other than the built-in one, alone, is named too", () => {
      expect(verdictCheck(v(security("fail"))).output.title).toBe("Review failed: Security (secrets)");
    });
  });

  it("is clipped to GitHub's limits", () => {
    const big = code("pass", "pass", "pass", { summary: "s".repeat(OUTPUT_MAX + 10) });
    big.dimensions[1]!.notes = "n".repeat(OUTPUT_MAX);
    for (const verdict of [v(big), v(big, { ...big, reviewer: { id: "rv_2", name: "x".repeat(TITLE_MAX) }, dimensions: [{ name: "y", verdict: "fail", notes: "" }] })]) {
      const out = verdictCheck(verdict);
      expect(out.output.summary.length).toBe(OUTPUT_MAX);
      expect(out.output.summary.endsWith("(clipped)")).toBe(true);
      expect(out.output.text!.length).toBe(OUTPUT_MAX);
      expect(out.output.title.length).toBeLessThanOrEqual(TITLE_MAX);
    }
    // A surrogate pair at the cut isn't split.
    expect(clip(`${"a".repeat(8)}😀😀😀`, 10)).toBe(`${"a".repeat(8)}…`);
  });
});
