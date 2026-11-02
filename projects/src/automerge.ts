// Auto-merge (README.md#auto-merge): the project's setting, the repo's "Allow auto-merge" the app
// writes back from it, and GitHub's auto-merge on each task PR. Types and the pure rules; ProjectDO
// holds the state and src/github.ts makes the calls.

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** GraphQL's `PullRequestMergeMethod` for each (https://docs.github.com/en/graphql/reference/pulls). */
export const GRAPHQL_METHOD: Record<MergeMethod, "SQUASH" | "MERGE" | "REBASE"> = { squash: "SQUASH", merge: "MERGE", rebase: "REBASE" };

/**
 * The repo's "Allow auto-merge" as the app keeps it:
 * - `none`: the app hasn't written it (auto-merge has never been on), so it isn't the app's to watch;
 * - `pending`: a write is owed (being tried, or retried after `error`);
 * - `error`: GitHub refused the write for good; the setting stays as asked, and a retry writes it again;
 * - `applied`: the repo has the setting's value, as last written or read;
 * - `drifted`: the repo's value, read since, isn't the setting's (changed by hand); a retry writes it back.
 */
export interface RepoAutoMerge {
  state: "none" | "pending" | "error" | "applied" | "drifted";
  /** The project's setting: what the repo should allow. */
  want: boolean;
  /** The repo's value as last written or read; null when never known. */
  repo: boolean | null;
  error: string | null;
  /** When `repo` was last learned. */
  at_ms: number | null;
}

export interface Seen {
  value: boolean | null;
  at_ms: number;
}

/** The repo setting's state from what ProjectDO recorded. */
export function repoAutoMerge(r: { want: boolean; owed: boolean; error: string | null; applied: Seen | null; observed: Seen | null }): RepoAutoMerge {
  const latest = [r.applied, r.observed].filter((x): x is Seen => x !== null).sort((a, b) => b.at_ms - a.at_ms)[0] ?? null;
  const base = { want: r.want, repo: latest?.value ?? null, error: r.error, at_ms: latest?.at_ms ?? null };
  if (r.owed) return { ...base, state: "pending" };
  if (r.error) return { ...base, state: "error" };
  if (!r.applied) return { ...base, state: "none" };
  return { ...base, state: latest!.value === null || latest!.value === r.want ? "applied" : "drifted" };
}

/** Auto-merge on a task's PR: owed (`pending`), done (`enabled`, `disabled`), or refused (`failed`). */
export interface TaskAutoMerge {
  state: "pending" | "enabled" | "disabled" | "failed";
  method: MergeMethod | null;
  error: string | null;
  at_ms: number;
}
