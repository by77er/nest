// src/reviewers.ts: a submission against its reviewer's dimensions, and the verdict as stored, read in
// either release's form. The release before's form is written out here as it stored and read it.
import { describe, expect, it } from "vitest";
import { reviewConclusion } from "../src/do/project";
import { CODE_REVIEW, legacySubmit, mayChangeReviewer, parseVerdict, type Review, reviewOf, storedVerdict, type Verdict, verdictPassed } from "../src/reviewers";

const by = { agent: "agt_r", tainted: false };
const sub = (dimension: string, verdict: "pass" | "fail" = "pass") => ({ dimension, verdict, notes: `${dimension} notes` });
const security: Review = {
  reviewer: { id: "rv_sec", name: "Security" }, agent: "agt_s", tainted: true,
  dimensions: [{ name: "Secrets", verdict: "fail", notes: "a key in the diff" }], summary: "security summary",
};

describe("a submission", () => {
  it("names each dimension once, in any order and case: the review in the reviewer's order and names", () => {
    const r = reviewOf(CODE_REVIEW, [sub("quality", "fail"), sub("Architectural cohesiveness "), sub("CORRECTNESS")], "s", by);
    expect(r).toEqual({
      ok: true,
      review: {
        reviewer: { id: "code-review", name: "Code review" }, agent: "agt_r", tainted: false, summary: "s",
        dimensions: [
          { name: "Correctness", verdict: "pass", notes: "CORRECTNESS notes" },
          { name: "Quality", verdict: "fail", notes: "quality notes" },
          { name: "Architectural cohesiveness", verdict: "pass", notes: "Architectural cohesiveness  notes" },
        ],
      },
    });
  });

  it("is refused naming what's missing, twice or unknown", () => {
    const err = (xs: ReturnType<typeof sub>[]) => {
      const r = reviewOf(CODE_REVIEW, xs, "s", by);
      return r.ok ? null : r.error;
    };
    expect(err([sub("Correctness"), sub("Quality")])).toMatch(/Missing: "Architectural cohesiveness"\.$/);
    expect(err([sub("Correctness"), sub("Quality"), sub("Architectural cohesiveness"), sub("quality")])).toMatch(/Named more than once: "Quality"\.$/);
    expect(err([sub("Correctness"), sub("Quality"), sub("Architecture")])).toBe(
      `Not recorded: name each of Code review's dimensions exactly once ("Correctness", "Quality", "Architectural cohesiveness"), and submit again. Missing: "Architectural cohesiveness". Not its dimensions: "Architecture".`,
    );
  });
});

describe("the release before's submit", () => {
  const dim = (verdict: string) => ({ verdict, notes: `${verdict} notes` });

  it("converts to the built-in reviewer's dimensions; other forms aren't it", () => {
    expect(legacySubmit({ correctness: dim("pass"), quality: dim("fail"), architecture: dim("pass"), summary: "s" })).toEqual({
      verdicts: [
        { dimension: "Correctness", verdict: "pass", notes: "pass notes" },
        { dimension: "Quality", verdict: "fail", notes: "fail notes" },
        { dimension: "Architectural cohesiveness", verdict: "pass", notes: "pass notes" },
      ],
      summary: "s",
    });
    expect(legacySubmit({ verdicts: [], summary: "s" })).toBeNull();
    expect(legacySubmit({ summary: "s" })).toBeNull();
    // A mix is this release's form, refused by its schema.
    expect(legacySubmit({ verdicts: [], correctness: dim("pass"), summary: "s" })).toBeNull();
  });

  it("is checked as that release checked it", () => {
    expect(legacySubmit({ correctness: dim("maybe"), quality: dim("pass"), architecture: dim("pass"), summary: "s" })).toEqual({ error: "arguments.correctness.verdict must be one of pass, fail" });
    expect(legacySubmit({ correctness: dim("pass"), quality: dim("pass"), summary: "s" })).toEqual({ error: "arguments.architecture is required" });
  });
});

describe("a stored verdict", () => {
  const old = { correctness: { verdict: "pass", notes: "c" }, quality: { verdict: "fail", notes: "q" }, architecture: { verdict: "pass", notes: "a" }, summary: "s" };

  it("from the release before reads as one Code review review by the job's agent, with its taint", () => {
    expect(parseVerdict(JSON.stringify(old), { agent: "agt_old", tainted: true })).toEqual({
      reviews: [{
        reviewer: { id: "code-review", name: "Code review" }, agent: "agt_old", tainted: true, summary: "s",
        dimensions: [{ name: "Correctness", verdict: "pass", notes: "c" }, { name: "Quality", verdict: "fail", notes: "q" }, { name: "Architectural cohesiveness", verdict: "pass", notes: "a" }],
      }],
    });
  });

  it("is written so this release reads it back, and the release before reads its Code review review as its own", () => {
    const code = parseVerdict(JSON.stringify(old), { agent: "agt_r", tainted: false }).reviews[0]!;
    for (const v of [{ reviews: [code] }, { reviews: [code, security] }] as Verdict[]) {
      const stored = storedVerdict(v);
      expect(parseVerdict(stored, { agent: null, tainted: null })).toEqual(v);
      // The release before: `JSON.parse(row.verdict)` and its three keys, failed if any isn't "pass".
      expect(JSON.parse(stored)).toMatchObject(v.reviews.length === 1 ? old : { ...old, correctness: { verdict: "fail", notes: "c\n\nFailed by another reviewer: Security." } });
    }
    // Another reviewer failing alone: the release before reads it failed (its correctness), never passed.
    const passed = { ...code, dimensions: code.dimensions.map((d) => ({ ...d, verdict: "pass" as const })) };
    expect(JSON.parse(storedVerdict({ reviews: [passed, security] }))).toMatchObject({ correctness: { verdict: "fail" }, quality: { verdict: "pass" }, architecture: { verdict: "pass" } });
    expect(JSON.parse(storedVerdict({ reviews: [passed] }))).toMatchObject({ correctness: { verdict: "pass", notes: "c" } });
    // Without a Code review review, no such keys (no verdict like that is written in this release).
    expect(Object.keys(JSON.parse(storedVerdict({ reviews: [security] })))).toEqual(["reviews"]);
  });
});

describe("a review job's end in a word (await_pr)", () => {
  const code = (q: "pass" | "fail"): Review => ({ ...parseVerdict(JSON.stringify({ ...old(), quality: { verdict: q, notes: "" } }), { agent: "a", tainted: false }).reviews[0]! });
  function old() {
    return { correctness: { verdict: "pass", notes: "" }, quality: { verdict: "pass", notes: "" }, architecture: { verdict: "pass", notes: "" }, summary: "" };
  }

  it("passed only if every review passed", () => {
    expect(reviewConclusion({ state: "done", verdict: { reviews: [code("pass")] } })).toBe("passed");
    expect(reviewConclusion({ state: "done", verdict: { reviews: [code("fail")] } })).toBe("failed");
    expect(reviewConclusion({ state: "done", verdict: { reviews: [code("pass"), { ...security, dimensions: [{ ...security.dimensions[0]!, verdict: "pass" }] }] } })).toBe("passed");
    expect(reviewConclusion({ state: "done", verdict: { reviews: [code("pass"), security] } })).toBe("failed");
    expect(reviewConclusion({ state: "failed", verdict: null })).toBe("failed without a verdict");
    // No reviewer was enabled: done, with no verdict, and not failed.
    expect(reviewConclusion({ state: "done", verdict: null })).toBe("no reviewer enabled");
    expect(verdictPassed({ reviews: [] })).toBe(false);
  });
});

describe("who may change a reviewer through the manager's tools (`mayChangeReviewer`)", () => {
  it("a tainted session only a tainted reviewer; an untainted session any; refused with why and where the owner changes it", () => {
    const table: [reviewer: boolean, session: boolean, may: boolean][] = [
      [false, false, true],
      [true, false, true],
      [true, true, true],
      [false, true, false],
    ];
    for (const [reviewer, session, may] of table) {
      const r = mayChangeReviewer({ name: "Code review", tainted: reviewer }, { tainted: session });
      expect(r.ok, `reviewer tainted ${reviewer}, session tainted ${session}`).toBe(may);
    }
    const no = mayChangeReviewer({ name: "Code review", tainted: false }, { tainted: true });
    expect(no.ok ? "" : no.error).toMatch(/^"Code review" was written by the owner \(or an untainted session\) and your session is tainted.*can't change, disable or delete it.*on the Reviews page\.$/);
  });
});
