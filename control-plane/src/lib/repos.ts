// Repo allowlists (docs/sandbox/networking/egress/policy/#repo-allowlists): the repos a sandbox may push to
// and an agent's brokered actions may reach, as exact `owner/name` names. Generic: a set of names that
// only narrows. What a name means on a forge (the guards, the tokens) is that forge's constructor's
// (lib/rules/github.ts). Pure.
import { z } from "zod";

/**
 * `owner/name`, exact, compared without case (GitHub's names are case-insensitive). No `*`: a wildcard
 * would cover repos created later, including forks an agent made, and can't narrow a token. No name
 * ending in `.git`, which a git URL adds (`owner/name.git` means `owner/name`).
 */
export const Repo = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "a repo is owner/name")
  .refine((r) => !/\/\.{1,2}$/.test(r) && !/\.git$/i.test(r), "a repo name isn't . or .. and doesn't end in .git");
export const Repos = z.array(Repo).max(100);

/** Lowercased, each once, sorted: the canonical form stored and compared. */
export function canonicalRepos(repos: readonly string[]): string[] {
  return [...new Set(repos.map((r) => r.toLowerCase()))].sort();
}

/** Every repo in any of the lists, canonical. */
export function unionRepos(...lists: readonly (readonly string[] | undefined)[]): string[] {
  return canonicalRepos(lists.flatMap((l) => l ?? []));
}

/**
 * Attenuation: `child` must name only repos `parent` has (an agent spawning another, a fork's
 * allowlist). Answers the child's canonical list, or the repos it would add.
 */
export function narrowRepos(parent: readonly string[], child: readonly string[]): { ok: true; value: string[] } | { ok: false; error: string } {
  const have = new Set(canonicalRepos(parent));
  const want = canonicalRepos(child);
  const wider = want.filter((r) => !have.has(r));
  return wider.length ? { ok: false, error: `can't widen the repo allowlist with ${wider.join(", ")}` } : { ok: true, value: want };
}
