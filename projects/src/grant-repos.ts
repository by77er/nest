// The repos the app may attach (README.md#flows, "Attaching a repo"): those nest's grant lets the app's
// workers push to (`repos`) and mint its GitHub tokens for (`github.repos`), as nest answers it. nest
// decides membership, owner-wide entries (`owner/*`, matched by the owner's GitHub id) included: the
// app never matches names itself. A nest from before that answer (its route 404s) is read the old way,
// from the grant's exact entries, which then covers no owner-wide entry.

import { type GrantRepo, type Nest, NestError } from "./nest";

/** The repos nest can list that the app may attach, and the owner-wide entries it couldn't list. */
export async function attachableRepos(nest: Nest): Promise<{ repos: string[]; unlisted: string[]; complete: boolean }> {
  try {
    const r = await nest.grantRepos();
    return { repos: r.repos.filter(attachable).map((x) => x.repo), unlisted: r.unlisted, complete: r.complete };
  } catch (e) {
    if (!(e instanceof NestError && e.status === 404)) throw e;
    return { repos: exactFallback(await nest.self()), unlisted: [], complete: true };
  }
}

/** Whether nest's grant lets the app attach `repo` (push and mint tokens for it), as nest answers it. */
export async function repoAttachable(nest: Nest, repo: string): Promise<boolean> {
  try {
    const r = await nest.grantMembership([repo]);
    return r.repos.some((x) => x.repo === repo.toLowerCase() && attachable(x));
  } catch (e) {
    if (!(e instanceof NestError && e.status === 404)) throw e;
    return exactFallback(await nest.self()).includes(repo.toLowerCase());
  }
}

/**
 * Whether nest's grant names `repo` for the app's GitHub calls (`github.repos`, owner-wide entries included), as
 * nest answers it: what the app's own App tokens are checked against before each mint (README.md#github-tokens),
 * as nest checked its own.
 */
export async function githubCovers(nest: Nest, repo: string): Promise<boolean> {
  try {
    const r = await nest.grantMembership([repo]);
    return r.repos.some((x) => x.repo === repo.toLowerCase() && x.github);
  } catch (e) {
    if (!(e instanceof NestError && e.status === 404)) throw e;
    const exact = (await nest.self()).grant?.github?.repos ?? [];
    return exact.some((r) => r.toLowerCase() === repo.toLowerCase());
  }
}

const attachable = (r: GrantRepo) => r.push && r.github;

/** A nest from before the grant routes: the repos named exactly in both lists (no owner-wide entry). */
function exactFallback(self: Awaited<ReturnType<Nest["self"]>>): string[] {
  const exact = (l: string[] | undefined) => new Set((l ?? []).filter((r) => !r.endsWith("/*")).map((r) => r.toLowerCase()));
  const push = exact(self.grant?.repos);
  return [...exact(self.grant?.github?.repos)].filter((r) => push.has(r)).sort();
}
