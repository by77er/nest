// GitHub, as the review pipeline uses it (README.md#built-the-review-pipeline): the webhook's signature, a thin client of
// the REST API for check runs, the repo and branch protection, and the pure rules that keep the
// owner's branch protection while adding the review check. Every call carries a short-lived token of
// nest's GitHub App, minted for one repo with exactly the permissions it needs
// (`POST /v1/clients/self/github-token`, docs/control-plane/api/clients/#github-tokens). The token is
// never logged or put in an error.
//
// GitHub's docs this follows:
// - webhook signatures: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
// - events: https://docs.github.com/en/webhooks/webhook-events-and-payloads (pull_request, check_run)
// - check runs: https://docs.github.com/en/rest/checks/runs
// - branch protection: https://docs.github.com/en/rest/branches/branch-protection
// - which conclusions a required check accepts (success, skipped, neutral):
//   https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

import type { Nest } from "./nest";

export const GITHUB_API = "https://api.github.com";
/** GitHub's REST version header (https://docs.github.com/en/rest/about-the-rest-api/api-versions). */
const API_VERSION = "2022-11-28";

/** The check the app sets on every PR head, and branch protection requires. */
export const CHECK_NAME = "nest-projects/review";

/** What each operation's token may do: nothing more (the grant's `github.permissions` covers them all). */
export const PERMISSIONS = {
  checks: { checks: "write" },
  // `GET /repos/{o}/{r}` needs metadata, which GitHub gives every installation token; it's named anyway,
  // so the token doesn't depend on that implicit grant.
  attach: { administration: "write", metadata: "read" },
  // `PATCH /repos/{o}/{r}` is Administration: write ("Permissions required for GitHub Apps",
  // https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
  repoSettings: { administration: "write" },
  // "To view merge-related settings, you must have the contents:read and contents:write permissions"
  // (https://docs.github.com/en/rest/repos/repos#get-a-repository); metadata for the repo itself.
  repoRead: { metadata: "read", contents: "write" },
  // Enabling auto-merge takes "write permissions to a repository"
  // (https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request):
  // the merge it arms is Contents: write (`PUT …/pulls/{n}/merge`) and it changes the PR (Pull
  // requests: write). GitHub's GraphQL reference names no permission for the mutations (unverified).
  autoMerge: { pull_requests: "write", contents: "write" },
} as const satisfies Record<string, Record<string, "read" | "write">>;

// --- the webhook's signature ---------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** `sha256=<hex HMAC-SHA256(secret, body)>`, as GitHub sends it in `X-Hub-Signature-256`. */
export async function signGithub(secret: string, body: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, body))}`;
}

/** Whether `header` is GitHub's signature of the raw `body` under `secret`, compared in constant time. */
export async function verifyGithubSignature(secret: string, header: string | null, body: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = new TextEncoder().encode(await signGithub(secret, body));
  const got = new TextEncoder().encode(header);
  if (want.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want[i]! ^ got[i]!;
  return d === 0;
}

// --- the client ----------------------------------------------------------------------------------------

/** GitHub's refusal: its status and `message`, never the token. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimited: boolean,
  ) {
    super(`GitHub ${status}: ${message}`);
  }
  /** A refusal that will repeat (the App isn't installed, lacks a permission, a bad request). */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429 && !this.rateLimited;
  }
}

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
}

export type Conclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped";

export interface CheckRunUpdate {
  status?: "queued" | "in_progress" | "completed";
  conclusion?: Conclusion;
  completed_at?: string;
  details_url?: string;
  output?: CheckOutput;
}

/** `required_status_checks` as GitHub answers it (`GET …/protection/required_status_checks`). */
export interface StatusChecks {
  strict?: boolean;
  contexts?: string[];
  checks?: { context: string; app_id: number | null }[];
}

export class GitHub {
  constructor(
    private readonly token: string,
    /** The GitHub App the token is from, as nest's answer names it; null when it doesn't. */
    readonly appId: number | null = null,
  ) {}

  /** One call: the JSON answer, or GitHubError. A 404 is answered as null where `nullOn404`. */
  async call<T>(method: string, path: string, body?: unknown, o: { nullOn404?: boolean } = {}): Promise<T | null> {
    // The global fetch, looked up per call (dev/review-lessons.md 8).
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "nest-projects/1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    if (res.status === 404 && o.nullOn404) return null;
    let message = text.slice(0, 200);
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof m === "string") message = m.slice(0, 300);
    } catch {
      // not JSON
    }
    const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
    throw new GitHubError(res.status, message, limited);
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = (await this.call<{ default_branch?: unknown }>("GET", `/repos/${repo}`))!;
    if (typeof r.default_branch !== "string" || !r.default_branch) throw new GitHubError(502, "the repo has no default branch", false);
    return r.default_branch;
  }

  createCheckRun(repo: string, b: { head_sha: string; external_id: string; details_url?: string; output: CheckOutput }): Promise<{ id: number; app?: { id?: number } } | null> {
    return this.call("POST", `/repos/${repo}/check-runs`, {
      name: CHECK_NAME, status: "in_progress", started_at: new Date().toISOString(), ...b,
    });
  }

  /** Set the repo's "Allow auto-merge"; answers the value GitHub reports after, when it does. */
  async setAllowAutoMerge(repo: string, allow: boolean): Promise<boolean | null> {
    const r = await this.call<{ allow_auto_merge?: unknown }>("PATCH", `/repos/${repo}`, { allow_auto_merge: allow });
    return typeof r?.allow_auto_merge === "boolean" ? r.allow_auto_merge : null;
  }

  /** The repo's "Allow auto-merge"; null when GitHub doesn't show it to this token. */
  async allowAutoMerge(repo: string): Promise<boolean | null> {
    const r = await this.call<{ allow_auto_merge?: unknown }>("GET", `/repos/${repo}`);
    return typeof r?.allow_auto_merge === "boolean" ? r.allow_auto_merge : null;
  }

  /**
   * One GraphQL request (https://docs.github.com/en/graphql/guides/forming-calls-with-graphql). Its
   * `errors` (a 200 all the same) are refusals for good, except GitHub's rate limit.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = (await this.call<{ data?: T; errors?: { message?: unknown; type?: unknown }[] }>("POST", "/graphql", { query, variables }))!;
    if (r.errors?.length) {
      const limited = r.errors.some((e) => e.type === "RATE_LIMITED");
      throw new GitHubError(limited ? 429 : 422, r.errors.map((e) => (typeof e.message === "string" ? e.message : "error")).join("; ").slice(0, 300), limited);
    }
    return r.data as T;
  }

  /** GitHub's auto-merge on a PR, by its node id (https://docs.github.com/en/graphql/reference/pulls). */
  async enableAutoMerge(pullRequestId: string, mergeMethod: "SQUASH" | "MERGE" | "REBASE"): Promise<void> {
    await this.graphql(
      "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { pullRequest { id } } }",
      { id: pullRequestId, method: mergeMethod },
    );
  }

  async disableAutoMerge(pullRequestId: string): Promise<void> {
    await this.graphql("mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }", { id: pullRequestId });
  }

  /** The app's check runs named CHECK_NAME at `sha`: to find one whose create answer was lost. */
  async checkRunsAt(repo: string, sha: string): Promise<{ id: number; external_id: string | null; app?: { id?: number } }[]> {
    const r = await this.call<{ check_runs?: { id: number; external_id: string | null; app?: { id?: number } }[] }>(
      "GET", `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
    );
    return r?.check_runs ?? [];
  }

  async updateCheckRun(repo: string, id: number, u: CheckRunUpdate): Promise<void> {
    await this.call("PATCH", `/repos/${repo}/check-runs/${id}`, u);
  }

  /** The branch's required status checks; null when the branch has none (or isn't protected). */
  statusChecks(repo: string, branch: string): Promise<StatusChecks | null> {
    return this.call<StatusChecks>("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`, undefined, { nullOn404: true });
  }

  /** The branch's protection as GitHub answers it; null when it isn't protected. */
  protection(repo: string, branch: string): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown>>("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, undefined, { nullOn404: true });
  }

  /** Replace only the required status checks' lists (`strict` and everything else are left as they are). */
  async patchStatusChecks(repo: string, branch: string, body: { contexts: string[] } | { checks: { context: string; app_id?: number }[] }): Promise<void> {
    await this.call("PATCH", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`, body);
  }

  /** Replace the branch's whole protection (only where it has none, or none of required checks). */
  async putProtection(repo: string, branch: string, body: unknown): Promise<void> {
    await this.call("PUT", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, body);
  }
}

/** A client with a token for `repo` with exactly `permissions`, knowing the App it's from when nest says. */
export async function githubFor(nest: Nest, repo: string, permissions: Record<string, string>): Promise<GitHub> {
  const t = await nest.githubToken(repo, permissions);
  return new GitHub(t.token, typeof t.app_id === "number" && Number.isSafeInteger(t.app_id) && t.app_id > 0 ? t.app_id : null);
}

// --- branch protection, kept ---------------------------------------------------------------------------

/**
 * The required checks with the review check in them, or null when they already have it as wanted.
 *
 * - With the App's id known, the check is required from the App (`checks: [{context, app_id}]`): no
 *   other app, nor a commit status anyone with write access may post, can pass it. An entry already
 *   there from any source, or another app, is pinned to the App.
 * - Without it (nest's token answer didn't name the App), from any source: `contexts` when no entry
 *   is pinned to an app, so nothing changes form; `checks` with the review check's `app_id` left out
 *   (GitHub then takes the app that recently set it) when some entry is pinned, so that pin survives.
 *   The App's first check run then tells its id, and the project attaches again to pin it.
 * - Every other entry is kept as it was: an `app_id` of null (any source) is sent back as -1, GitHub's
 *   "any app".
 */
export function withReviewCheck(have: StatusChecks, appId: number | null): { contexts: string[] } | { checks: { context: string; app_id?: number }[] } | null {
  const checks = have.checks ?? (have.contexts ?? []).map((context) => ({ context, app_id: null }));
  const ours = checks.find((c) => c.context === CHECK_NAME);
  if (ours && (appId === null || ours.app_id === appId)) return null;
  const others = checks.filter((c) => c.context !== CHECK_NAME);
  const pinned = others.some((c) => c.app_id !== null && c.app_id !== -1);
  if (appId === null && !pinned) return { contexts: [...others.map((c) => c.context), CHECK_NAME] };
  return {
    checks: [
      ...others.map((c) => ({ context: c.context, app_id: c.app_id === null ? -1 : c.app_id })),
      appId === null ? { context: CHECK_NAME } : { context: CHECK_NAME, app_id: appId },
    ],
  };
}

/** The required status checks for a branch that has none: the review check alone, not strict. */
export function onlyReviewCheck(appId: number | null) {
  return appId === null ? { strict: false, contexts: [CHECK_NAME] } : { strict: false, checks: [{ context: CHECK_NAME, app_id: appId }] };
}

const enabled = (v: unknown): boolean => typeof v === "object" && v !== null && (v as { enabled?: unknown }).enabled === true;
const logins = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (x as { login?: unknown }).login).filter((x): x is string => typeof x === "string") : []);
const slugs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (x as { slug?: unknown }).slug).filter((x): x is string => typeof x === "string") : []);
const actors = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { users: logins(o.users), teams: slugs(o.teams), apps: slugs(o.apps) };
};

/**
 * The `PUT …/protection` body that keeps a protected branch's settings (as `GET …/protection` answers
 * them) and adds `statusChecks`. Used only for a branch protected without required status checks, which
 * the narrower `PATCH …/required_status_checks` can't add to. Required signatures have their own
 * endpoint and aren't in the PUT body (unverified that PUT leaves them as they were).
 */
export function protectionKeeping(get: Record<string, unknown>, statusChecks: unknown): Record<string, unknown> {
  const reviews = get.required_pull_request_reviews as Record<string, unknown> | undefined | null;
  const restrictions = get.restrictions as Record<string, unknown> | undefined | null;
  return {
    required_status_checks: statusChecks,
    enforce_admins: enabled(get.enforce_admins),
    required_pull_request_reviews: reviews
      ? {
          dismiss_stale_reviews: reviews.dismiss_stale_reviews === true,
          require_code_owner_reviews: reviews.require_code_owner_reviews === true,
          required_approving_review_count: typeof reviews.required_approving_review_count === "number" ? reviews.required_approving_review_count : 0,
          require_last_push_approval: reviews.require_last_push_approval === true,
          ...(reviews.dismissal_restrictions ? { dismissal_restrictions: actors(reviews.dismissal_restrictions) } : {}),
          ...(reviews.bypass_pull_request_allowances ? { bypass_pull_request_allowances: actors(reviews.bypass_pull_request_allowances) } : {}),
        }
      : null,
    restrictions: restrictions ? actors(restrictions) : null,
    required_linear_history: enabled(get.required_linear_history),
    allow_force_pushes: enabled(get.allow_force_pushes),
    allow_deletions: enabled(get.allow_deletions),
    block_creations: enabled(get.block_creations),
    required_conversation_resolution: enabled(get.required_conversation_resolution),
    lock_branch: enabled(get.lock_branch),
    allow_fork_syncing: enabled(get.allow_fork_syncing),
  };
}

/** The minimal protection for an unprotected branch: the review check required, and nothing else. */
export function minimalProtection(appId: number | null) {
  return { required_status_checks: onlyReviewCheck(appId), enforce_admins: false, required_pull_request_reviews: null, restrictions: null };
}

export type AttachChange = "created" | "added" | "pinned" | "unchanged";

/**
 * Make CHECK_NAME required on `repo`'s default branch, keeping every other setting:
 * - its required checks exist: only their lists change (`PATCH …/required_status_checks`), and only
 *   when the check is missing or not yet pinned to the App;
 * - protected without required checks: the whole protection is written back as it was, with them;
 * - unprotected: the minimal protection (the check, `strict: false`, nothing else).
 * Running it again changes nothing.
 */
export async function requireReviewCheck(gh: GitHub, repo: string, appId: number | null): Promise<{ branch: string; change: AttachChange; app_id: number | null }> {
  const branch = await gh.defaultBranch(repo);
  const have = await gh.statusChecks(repo, branch);
  if (have) {
    const body = withReviewCheck(have, appId);
    if (!body) return { branch, change: "unchanged", app_id: appId };
    const existed = (have.checks ?? []).some((c) => c.context === CHECK_NAME) || (have.contexts ?? []).includes(CHECK_NAME);
    await gh.patchStatusChecks(repo, branch, body);
    return { branch, change: existed ? "pinned" : "added", app_id: appId };
  }
  const protection = await gh.protection(repo, branch);
  if (protection) {
    await gh.putProtection(repo, branch, protectionKeeping(protection, onlyReviewCheck(appId)));
    return { branch, change: "added", app_id: appId };
  }
  await gh.putProtection(repo, branch, minimalProtection(appId));
  return { branch, change: "created", app_id: appId };
}

// --- check output --------------------------------------------------------------------------------------

/** GitHub's documented limit for a check's `output.summary` and `output.text` (characters). */
export const OUTPUT_MAX = 65535;
/** `output.title` has no documented limit; this keeps it to one line's worth. */
export const TITLE_MAX = 255;
const CLIPPED = "\n\n… (clipped)";

/** `s` within `max` UTF-16 units, marked when cut, never splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = max > CLIPPED.length * 4 ? CLIPPED : "…";
  let cut = max - marker.length;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut) + marker;
}

export const DIMENSIONS = ["correctness", "quality", "architecture"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Verdict = Record<Dimension, { verdict: "pass" | "fail"; notes: string }> & { summary: string };

const LABEL: Record<Dimension, string> = { correctness: "Correctness", quality: "Quality", architecture: "Architectural cohesiveness" };

/** The conclusion and output a verdict completes its check with: success only if all three pass. */
export function verdictCheck(v: Verdict, o: { agent: string; tainted: boolean }): { conclusion: "success" | "failure"; output: CheckOutput } {
  const failed = DIMENSIONS.filter((d) => v[d].verdict !== "pass");
  const conclusion = failed.length === 0 ? "success" : "failure";
  const title = failed.length === 0 ? "Review passed" : `Review failed: ${failed.map((d) => LABEL[d].toLowerCase()).join(", ")}`;
  const text = [
    ...DIMENSIONS.map((d) => `## ${LABEL[d]}: ${v[d].verdict}\n\n${v[d].notes}`),
    "---",
    `Reviewer: ${o.agent}. Tainted: ${o.tainted ? "yes (its session read untrusted content, such as the PR itself, which could have steered this verdict)" : "no"}.`,
  ].join("\n\n");
  return { conclusion, output: { title: clip(title, TITLE_MAX), summary: clip(v.summary || "(no summary)", OUTPUT_MAX), text: clip(text, OUTPUT_MAX) } };
}
