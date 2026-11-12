// A project's PRs as GitHub has them now (README.md#pr-upkeep): one GraphQL query for a set of PRs by
// number, read through each time it's needed and never stored. What it answers (state, title, head, base,
// mergeability, auto-merge and the head's checks) is what the app would otherwise keep copies of.
//
// GitHub's docs this follows:
// - the query and its fields: https://docs.github.com/en/graphql/reference/objects#pullrequest,
//   https://docs.github.com/en/graphql/reference/objects#checksuite, https://docs.github.com/en/graphql/reference/input-objects#checkrunfilter
// - `mergeable` is computed lazily: null in REST (`UNKNOWN` here) while "GitHub has started a background
//   job to compute the mergeability" (https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
// - its cost: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

import { type GitHub, GitHubError } from "./github";

/** One check run on a PR's head: the latest of its name in its suite. */
export interface PrCheck {
  name: string;
  /** The app whose suite it's in, by slug; null when GitHub doesn't show it to the token. */
  app: string | null;
  /** `QUEUED`, `IN_PROGRESS`, `COMPLETED`, … (GitHub's CheckStatusState). */
  status: string;
  /** Once completed: `SUCCESS`, `FAILURE`, `TIMED_OUT`, … (GitHub's CheckConclusionState). */
  conclusion: string | null;
  url: string | null;
}

/** A PR as GitHub has it at the read. */
export interface PrNow {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  /** Whether its head is another repo's (a fork's). */
  cross_repo: boolean;
  /** `UNKNOWN` until GitHub has computed it. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's MergeStateStatus (`CLEAN`, `DIRTY`, `BEHIND`, `BLOCKED`, …). */
  merge_state: string;
  /** GitHub's auto-merge on it, if enabled. */
  auto_merge: { method: string } | null;
  /** The check runs on its head commit. */
  checks: PrCheck[];
}

/** PRs per query: 25 cost 6 points, measured on a real repo (1 for up to a few). */
export const PR_READ_BATCH = 25;

const FRAGMENT = `fragment pr on PullRequest {
  number state title headRefName headRefOid baseRefName isCrossRepository mergeable mergeStateStatus
  autoMergeRequest { mergeMethod }
  commits(last: 1) { nodes { commit { oid checkSuites(first: 20) { nodes { app { slug } checkRuns(first: 50, filterBy: {checkType: LATEST}) { nodes { name status conclusion detailsUrl } } } } } } }
}`;

/** The query for `n` PRs: aliases `p0`…, each number a variable, so nothing of the input is spliced into it. */
export function prQuery(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$n${i}: Int!`).join(", ");
  const aliases = Array.from({ length: n }, (_, i) => `p${i}: pullRequest(number: $n${i}) { ...pr }`).join("\n    ");
  return `query($owner: String!, $name: String!, ${vars}) {\n  repository(owner: $owner, name: $name) {\n    ${aliases}\n  }\n}\n${FRAGMENT}`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);
const nodes = (v: unknown) => arr((v as { nodes?: unknown } | null | undefined)?.nodes);

/** One alias's answer as a PrNow; null for a PR GitHub has none of (or an answer that isn't one). */
export function prOf(p: unknown): PrNow | null {
  if (typeof p !== "object" || p === null) return null;
  const r = p as Record<string, unknown>;
  const state = str(r.state);
  const head = str(r.headRefOid);
  if (typeof r.number !== "number" || (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") || !head) return null;
  const mergeable = str(r.mergeable);
  const commit = nodes(r.commits)[0]?.commit as Record<string, unknown> | undefined;
  // The checks are the head's: a last commit that isn't the head (a push between the two) has none of them.
  const checks = commit && str(commit.oid) === head
    ? nodes(commit.checkSuites).flatMap((s) => {
        const app = str((s.app as { slug?: unknown } | null | undefined)?.slug);
        return nodes(s.checkRuns).map((c) => ({ name: str(c.name) ?? "", app, status: str(c.status) ?? "", conclusion: str(c.conclusion), url: str(c.detailsUrl) }));
      })
    : [];
  const am = r.autoMergeRequest as { mergeMethod?: unknown } | null | undefined;
  return {
    number: r.number, state, title: str(r.title) ?? "", head_ref: str(r.headRefName) ?? "", head_sha: head, base_ref: str(r.baseRefName) ?? "",
    cross_repo: r.isCrossRepository !== false,
    mergeable: mergeable === "MERGEABLE" || mergeable === "CONFLICTING" ? mergeable : "UNKNOWN",
    merge_state: str(r.mergeStateStatus) ?? "UNKNOWN",
    auto_merge: am && typeof am === "object" ? { method: str(am.mergeMethod) ?? "" } : null,
    checks,
  };
}

/**
 * The PRs numbered `numbers` on `repo`, as GitHub has them now: one query per PR_READ_BATCH. A number
 * GitHub has no PR for answers null. Needs Pull requests: read and Checks: read.
 */
export async function readPrs(gh: GitHub, repo: string, numbers: readonly number[]): Promise<Map<number, PrNow | null>> {
  const [owner, name] = repo.split("/");
  const out = new Map<number, PrNow | null>();
  for (let i = 0; i < numbers.length; i += PR_READ_BATCH) {
    const batch = numbers.slice(i, i + PR_READ_BATCH);
    const vars: Record<string, unknown> = { owner, name };
    batch.forEach((n, j) => (vars[`n${j}`] = n));
    const data = await gh.graphql<{ repository?: Record<string, unknown> | null }>(prQuery(batch.length), vars, { notFound: true });
    if (!data?.repository) throw new GitHubError(404, `GitHub has no repo ${repo} for this token`, false);
    batch.forEach((n, j) => out.set(n, prOf(data.repository![`p${j}`])));
  }
  return out;
}
