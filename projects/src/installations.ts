// The repos the app may attach (README.md#repo-authority): those its own GitHub App's installations reach, on the
// accounts the app acts for (the App's owner, and GITHUB_ACCOUNTS), as GitHub answers: each installation's own
// selection of repos (`GET /app/installations`, then each one's `GET /installation/repositories`). GitHub decides;
// the app matches no names itself, and asks nest nothing.

import type { Env } from "./env";
import { GitHubError, PERMISSIONS } from "./github";
import { AppTokens, tokenSource } from "./github-app";
import { type Nest, NestError } from "./nest";

/**
 * The repos the App's installations reach, sorted, and the accounts whose installation's repos couldn't be
 * listed just now (`unlisted`); `complete` false when an installation has more than the first 1000. Always the
 * App's own listing, even in the fallback (it needs the App's key: there, a failure leaves the name to be typed).
 */
export async function attachableRepos(env: Env): Promise<{ repos: string[]; unlisted: string[]; complete: boolean; app: { slug: string; install_url: string } | null }> {
  const app = new AppTokens(env);
  const repos = new Set<string>();
  const unlisted: string[] = [];
  let complete = true;
  for (const i of await app.installationsList()) {
    try {
      const r = await app.installationRepos(i.id);
      for (const x of r.repos) repos.add(x);
      complete &&= r.complete;
    } catch (e) {
      console.warn(`installation ${i.id}'s repos couldn't be listed: ${String(e).slice(0, 200)}`);
      unlisted.push(i.account ?? `installation ${i.id}`);
    }
  }
  // The App by name, and where on GitHub it's installed on an account or its installation's repos are chosen.
  const slug = await app.appSlug();
  const named = slug && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(slug) ? { slug, install_url: `https://github.com/apps/${slug}/installations/new` } : null;
  return { repos: [...repos].sort(), unlisted: unlisted.sort(), complete, app: named };
}

/**
 * Whether a call's failure says the repo isn't the App's to act on: GitHub has no installation of the App on it
 * (404), or its installation doesn't select it (422, the mint narrowed to it refused); or, in the fallback, nest
 * refused its token (403, outside its grant).
 */
export function notCovered(e: unknown): boolean {
  return (e instanceof GitHubError && (e.status === 404 || e.status === 422)) || (e instanceof NestError && e.status === 403);
}

/**
 * Whether the app may attach `repo`, as GitHub answers now: the App's installation on it looked up afresh (on an
 * account the app acts for) and a token narrowed to it minted, never a cached one (README.md#repo-authority). In
 * the fallback, nest's token. Any other failure (GitHub's or the App's secrets' trouble) is thrown, so a create
 * isn't refused for an outage.
 */
export async function repoAttachable(env: Env, nest: Nest, repo: string): Promise<boolean> {
  try {
    const source = tokenSource(env, nest);
    if (source instanceof AppTokens) await source.reaches(repo);
    else await source.token(repo, PERMISSIONS.metadata);
    return true;
  } catch (e) {
    if (notCovered(e)) return false;
    throw e;
  }
}
