// Reviewers (README.md#built-the-review-pipeline): who judges a PR head, on which dimensions, and the
// verdict that comes of it, a list of reviews, one per reviewer. Pure. One reviewer runs for now: the
// built-in "Code review".
//
// The release before kept a verdict as three fixed keys (`correctness`, `quality`, `architecture`) and a
// summary. Its rows are read here as one "Code review" review; a verdict holding a "Code review" review is
// still written with those keys besides (`storedVerdict`), so that release reads what this one writes; and a
// reviewer started under it submits in that form, accepted and converted (`legacySubmit`).

import { invalid } from "./schema";

/** A reviewer: what it judges (its dimensions, one verdict each) and how (its instructions). */
export interface Reviewer {
  id: string;
  name: string;
  /** At least one; each judged pass or fail with notes. */
  dimensions: readonly string[];
  instructions: string;
}

/** The built-in reviewer, the one every PR head gets. */
export const CODE_REVIEW: Reviewer = {
  id: "code-review",
  name: "Code review",
  dimensions: ["Correctness", "Quality", "Architectural cohesiveness"],
  instructions:
    "Judge three things separately: correctness (does it do what it claims, without bugs or regressions), quality (clear, tested, no needless code) and architectural cohesiveness (does it fit the repo's design; read its own docs, READMEs and conventions to judge that).",
};

export type Pass = "pass" | "fail";

export interface DimensionVerdict {
  name: string;
  verdict: Pass;
  notes: string;
}

/** One reviewer's review: its dimensions in the reviewer's order, and its summary. */
export interface Review {
  reviewer: { id: string; name: string };
  /** The agent that gave it, and whether that session was tainted. */
  agent: string;
  tainted: boolean;
  dimensions: DimensionVerdict[];
  summary: string;
}

/** A PR head's verdict: one review per reviewer. */
export interface Verdict {
  reviews: Review[];
}

/** A review passes only if it judged something and every dimension passed. */
export const reviewPassed = (r: Review) => r.dimensions.length > 0 && r.dimensions.every((d) => d.verdict === "pass");
/** A verdict passes only if it holds a review and every review passed. */
export const verdictPassed = (v: Verdict) => v.reviews.length > 0 && v.reviews.every(reviewPassed);

/** Whether the verdict is the built-in reviewer's alone: its check and messages read as they always have. */
export const builtInAlone = (v: Verdict) => v.reviews.length === 1 && v.reviews[0]!.reviewer.id === CODE_REVIEW.id;

/** One dimension as `submit_review` names it. */
export interface Submitted {
  dimension: string;
  verdict: Pass;
  notes: string;
}

const key = (s: string) => s.trim().toLowerCase();

/**
 * The review `submitted` makes for `reviewer`, or why it can't be: it must name each of the reviewer's
 * dimensions exactly once (case and surrounding spaces aside), and nothing else.
 */
export function reviewOf(
  reviewer: Reviewer,
  submitted: readonly Submitted[],
  summary: string,
  by: { agent: string; tainted: boolean },
): { ok: true; review: Review } | { ok: false; error: string } {
  const named = new Map<string, Submitted[]>();
  for (const s of submitted) named.set(key(s.dimension), [...(named.get(key(s.dimension)) ?? []), s]);
  const known = new Set(reviewer.dimensions.map(key));
  const missing = reviewer.dimensions.filter((d) => !named.has(key(d)));
  const twice = reviewer.dimensions.filter((d) => (named.get(key(d))?.length ?? 0) > 1);
  const unknown = submitted.filter((s) => !known.has(key(s.dimension))).map((s) => s.dimension);
  if (missing.length || twice.length || unknown.length) {
    const quote = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
    return {
      ok: false,
      error: [
        `Not recorded: name each of ${reviewer.name}'s dimensions exactly once (${quote(reviewer.dimensions)}), and submit again.`,
        ...(missing.length ? [`Missing: ${quote(missing)}.`] : []),
        ...(twice.length ? [`Named more than once: ${quote(twice)}.`] : []),
        ...(unknown.length ? [`Not its dimensions: ${quote(unknown)}.`] : []),
      ].join(" "),
    };
  }
  return {
    ok: true,
    review: {
      reviewer: { id: reviewer.id, name: reviewer.name },
      agent: by.agent,
      tainted: by.tainted,
      dimensions: reviewer.dimensions.map((d) => {
        const s = named.get(key(d))![0]!;
        return { name: d, verdict: s.verdict, notes: s.notes };
      }),
      summary,
    },
  };
}

// --- the release before's form ---------------------------------------------------------------------------

/** Its three keys, and the built-in reviewer's dimension each is. */
const LEGACY = [
  ["correctness", "Correctness"],
  ["quality", "Quality"],
  ["architecture", "Architectural cohesiveness"],
] as const;
type LegacyVerdict = Record<(typeof LEGACY)[number][0], { verdict: Pass; notes: string }> & { summary: string };

const legacyDimension = { type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string", maxLength: 20000 } }, required: ["verdict", "notes"], additionalProperties: false };
/** `submit_review` as the release before listed it. */
const LEGACY_SUBMIT = {
  type: "object",
  properties: { ...Object.fromEntries(LEGACY.map(([k]) => [k, legacyDimension])), summary: { type: "string", maxLength: 20000 } },
  required: [...LEGACY.map(([k]) => k), "summary"],
  additionalProperties: false,
};

/**
 * A `submit_review` in the release before's form (a reviewer started under it), as this release's
 * arguments; null for any other form; an error for that form gone wrong.
 */
export function legacySubmit(a: Record<string, unknown>): { verdicts: Submitted[]; summary: string } | { error: string } | null {
  if (!LEGACY.some(([k]) => k in a) || "verdicts" in a) return null;
  const bad = invalid(LEGACY_SUBMIT, a);
  if (bad) return { error: bad };
  const v = a as unknown as LegacyVerdict;
  return { verdicts: LEGACY.map(([k, d]) => ({ dimension: d, verdict: v[k].verdict, notes: v[k].notes })), summary: v.summary };
}

/**
 * A stored verdict (`jobs.verdict`) as a verdict. A row from the release before has the three keys and
 * no `reviews`: it reads as one "Code review" review by the job's agent, with the job's taint.
 */
export function parseVerdict(stored: string, job: { agent: string | null; tainted: boolean | null }): Verdict {
  const v = JSON.parse(stored) as Partial<Verdict> & Partial<LegacyVerdict>;
  if (Array.isArray(v.reviews)) return { reviews: v.reviews };
  return {
    reviews: [{
      reviewer: { id: CODE_REVIEW.id, name: CODE_REVIEW.name },
      agent: job.agent ?? "",
      tainted: job.tainted ?? false,
      dimensions: LEGACY.map(([k, d]) => ({ name: d, verdict: v[k]?.verdict === "pass" ? "pass" : "fail", notes: v[k]?.notes ?? "" })),
      summary: v.summary ?? "",
    }],
  };
}

/**
 * A verdict as stored: its reviews, and, while the release before may run on these rows again (a
 * rollback), its three keys and summary from the "Code review" review, which is all that release reads.
 */
export function storedVerdict(v: Verdict): string {
  const code = v.reviews.find((r) => r.reviewer.id === CODE_REVIEW.id);
  const legacy = code
    ? {
        ...Object.fromEntries(LEGACY.map(([k, d]) => {
          const x = code.dimensions.find((y) => y.name === d);
          return [k, { verdict: x?.verdict ?? "fail", notes: x?.notes ?? "" }];
        })),
        summary: code.summary,
      }
    : {};
  return JSON.stringify({ reviews: v.reviews, ...legacy });
}
