// src/github.ts's pure parts against GitHub's own docs: the webhook signature against the example in
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries, the review check's
// required-checks rules, and the check output a verdict makes.
import { describe, expect, it } from "vitest";
import { CHECK_NAME, clip, OUTPUT_MAX, protectionKeeping, type Verdict, verdictCheck, verifyGithubSignature, withReviewCheck } from "../src/github";

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
  it("is added to the contexts when nothing is pinned to an app and the App's id isn't known", () => {
    expect(withReviewCheck({ strict: true, contexts: ["ci"], checks: [{ context: "ci", app_id: null }] }, null)).toEqual({ contexts: ["ci", CHECK_NAME] });
  });

  it("keeps other entries' app pins, sending any source back as -1", () => {
    const have = { checks: [{ context: "ci", app_id: 15368 }, { context: "lint", app_id: null }] };
    expect(withReviewCheck(have, null)).toEqual({ checks: [{ context: "ci", app_id: 15368 }, { context: "lint", app_id: -1 }, { context: CHECK_NAME }] });
    expect(withReviewCheck(have, 7)).toEqual({ checks: [{ context: "ci", app_id: 15368 }, { context: "lint", app_id: -1 }, { context: CHECK_NAME, app_id: 7 }] });
  });

  it("is left alone once there, and pinned to the App once its id is known", () => {
    expect(withReviewCheck({ checks: [{ context: CHECK_NAME, app_id: null }] }, null)).toBeNull();
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
  const v = (c: "pass" | "fail", q: "pass" | "fail", a: "pass" | "fail", summary = "the summary"): Verdict => ({
    correctness: { verdict: c, notes: "correctness notes" }, quality: { verdict: q, notes: "quality notes" }, architecture: { verdict: a, notes: "architecture notes" }, summary,
  });

  it("succeeds only when all three pass", () => {
    const all: ("pass" | "fail")[][] = [];
    for (const c of ["pass", "fail"] as const) for (const q of ["pass", "fail"] as const) for (const a of ["pass", "fail"] as const) all.push([c, q, a]);
    for (const [c, q, a] of all) {
      const out = verdictCheck(v(c!, q!, a!), { agent: "agt_r", tainted: false });
      expect(out.conclusion, `${c} ${q} ${a}`).toBe(c === "pass" && q === "pass" && a === "pass" ? "success" : "failure");
    }
  });

  it("names the failed dimensions in the title, the summary as given, and each dimension's notes and the taint in the text", () => {
    const out = verdictCheck(v("fail", "pass", "fail"), { agent: "agt_r", tainted: true });
    expect(out.output.title).toBe("Review failed: correctness, architectural cohesiveness");
    expect(out.output.summary).toBe("the summary");
    expect(out.output.text).toContain("## Correctness: fail\n\ncorrectness notes");
    expect(out.output.text).toContain("## Quality: pass\n\nquality notes");
    expect(out.output.text).toContain("## Architectural cohesiveness: fail\n\narchitecture notes");
    expect(out.output.text).toMatch(/Reviewer: agt_r\. Tainted: yes/);
    expect(verdictCheck(v("pass", "pass", "pass"), { agent: "agt_r", tainted: false }).output.text).toMatch(/Tainted: no\.$/);
  });

  it("is clipped to GitHub's limits", () => {
    const out = verdictCheck({ ...v("pass", "pass", "pass", "s".repeat(OUTPUT_MAX + 10)), quality: { verdict: "pass", notes: "n".repeat(OUTPUT_MAX) } }, { agent: "agt_r", tainted: false });
    expect(out.output.summary.length).toBe(OUTPUT_MAX);
    expect(out.output.summary.endsWith("(clipped)")).toBe(true);
    expect(out.output.text!.length).toBe(OUTPUT_MAX);
    // A surrogate pair at the cut isn't split.
    expect(clip(`${"a".repeat(8)}😀😀😀`, 10)).toBe(`${"a".repeat(8)}…`);
  });
});
