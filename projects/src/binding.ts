// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id, read from GitHub (at
// attach, at a catalog sync for a project that has none, or at the operator's re-read) rather than taken
// from the first event; and a rename or transfer applied once nest's grant names the repo's new name.
// Only nest's client interface: a GitHub token for the project's repo (metadata: read), and the grant.

import { directory, type Env, project, review } from "./env";
import { githubFor, ownInstallation, PERMISSIONS } from "./github";
import { repoAttachable } from "./grant-repos";
import { type Nest, NestError } from "./nest";
import type { BindOutcome, GithubRepo, RepoBinding } from "./do/directory";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Read the repo from GitHub and bind the project to it (`fill`: only where there's no id; `replace`: the
 * operator's re-read). Read by the name GitHub last gave it, so an old name taken by another repo since
 * isn't read; with a token for that name, or (outside nest's grant yet) for the name the project has.
 */
export async function readBinding(env: Env, nest: Nest, id: string, mode: "fill" | "check" | "replace", shownId?: number): Promise<BindOutcome> {
  const dir = directory(env);
  const b = await dir.binding(id);
  if (!b) return { ok: false, error: "unknown project", binding: null };
  let info: GithubRepo & { installation_id: number | null };
  const name = b.renamed_to ?? b.repo;
  try {
    let gh;
    // Whether the token is for the repo's current name: only then is its installation the repo's.
    let current = true;
    try {
      gh = await githubFor(nest, name, PERMISSIONS.metadata);
    } catch (e) {
      // The new name isn't in nest's grant yet (403): a token for the name the grant holds reads the same repo.
      if (!(b.renamed_to && e instanceof NestError && e.status === 403)) throw e;
      gh = await githubFor(nest, b.repo, PERMISSIONS.metadata);
      current = false;
    }
    const r = await gh.repoInfo(name);
    // A token for the old name may come from another installation (the name taken since, by a repo the App
    // is installed on): its installation is never stored, so the one stored stays. Nor is one for a name
    // GitHub redirects (moved since, no event naming the new one yet): it may be another account's.
    info = { id: r.id, full_name: r.full_name, owner: { id: r.owner.id, login: r.owner.login }, installation_id: current ? ownInstallation(name, r.full_name, gh.installationId) : null };
  } catch (e) {
    return { ok: false, error: `GitHub couldn't be read: ${message(e)}`, binding: b };
  }
  // The operator's choice binds the repo they were shown, and no other: GitHub's answer changed since, nothing.
  if (mode === "replace" && info.id !== shownId) return { ok: false, error: `GitHub's ${name} is repo ${info.id} now, not the repo ${shownId ?? "?"} you were shown: re-read to compare again`, binding: b };
  return await dir.bindRepo(id, info, mode);
}

/** Why a rename isn't applied yet, or null once it is (or there's none). */
export type RenameOutcome = { applied: string } | { blocked: string } | null;

/**
 * Apply a rename GitHub told (`renamed_to`): the directory's guarded rename (never onto another project's
 * name) is the whole change. The directory is the name's one owner: ProjectDO, ReviewDO and the Worker read
 * it from there, so a rename reaches them all at once and they can't disagree. Only once nest's grant names
 * the new name (it mints tokens for the repos it names).
 */
export async function applyRename(env: Env, nest: Nest, b: RepoBinding): Promise<RenameOutcome> {
  const to = b.renamed_to;
  if (!to) return null;
  // nest decides whether its grant covers the new name (an owner-wide entry by the owner's id, too).
  if (!(await repoAttachable(nest, to))) return { blocked: `nest's grant for the app doesn't cover ${to} yet: add it, then re-read` };
  const dir = directory(env);
  if (await dir.projectByName(to, b.project)) return { blocked: `${to} is another project's repo` };
  if (!(await dir.renameRepo(b.project, to))) return { blocked: "the rename changed while it was applied: re-read" };
  await writeOldCopies(env, b.project, to);
  return { applied: to };
}

/**
 * The copies of the repo's name the previous release reads (ProjectDO's and ReviewDO's settings), written
 * after the directory's for a rollback to find (expand/contract: removed the release after). Nothing in this
 * release reads them, so one that fails is only logged, and written again at the next catalog sync.
 */
export async function writeOldCopies(env: Env, id: string, name: string): Promise<void> {
  for (const [what, write] of [["ProjectDO", () => project(env, id).repoRenamed(name)], ["ReviewDO", () => review(env, id).repoRenamed(name)]] as const) {
    try {
      await write();
    } catch (e) {
      console.warn(`project ${id}: ${what}'s old copy of the repo's name wasn't written: ${message(e)}`);
    }
  }
}

/**
 * An event refused for coming from another App installation than the binding's (README.md#the-repos-binding):
 * the binding is read again (at most once a minute per project), so it follows nest's answer, the
 * installation nest mints the repo's tokens from now (the App reinstalled, or the repo moved to an account
 * nest's grant covers). nest's grant decides which installation is the repo's, never the event. True when
 * the binding's installation changed, so the event is to be routed again (and refused again, and counted,
 * if the binding took another one than the event's).
 */
export async function followInstallation(env: Env, nest: Nest, id: string): Promise<boolean> {
  const dir = directory(env);
  if (!(await dir.claimInstallationCheck(id))) return false;
  const before = (await dir.binding(id))?.installation_id ?? null;
  const r = await readBinding(env, nest, id, "fill");
  return r.binding !== null && r.binding.installation_id !== before;
}

/**
 * A catalog sync's pass over the bindings: an id read for each project with none (or bound from an event),
 * each one that has a rename noted or events refused read again (its owner and installation as GitHub and
 * nest answer now), each rename applied that can be, and the previous release's copies of the name written
 * again. Never fails the sync: what didn't bind is kept on the binding.
 */
export async function bindAll(env: Env, nest: Nest): Promise<void> {
  for (const b of await directory(env).bindings()) {
    try {
      let now: RepoBinding | null = b;
      // No id, one taken from an event, no installation yet (bound before nest named it), a rename or
      // transfer noted, or events refused (another installation): read from GitHub.
      if (b.repo_id === null || b.bound !== "github" || b.installation_id === null || b.renamed_to !== null || b.refused !== null) {
        const r = await readBinding(env, nest, b.project, "fill");
        now = r.binding;
      }
      if (now?.renamed_to) await applyRename(env, nest, now);
      const name = (await directory(env).getProject(b.project))?.repo;
      if (name) await writeOldCopies(env, b.project, name);
    } catch (e) {
      console.warn(`project ${b.project}: its repo binding wasn't read: ${message(e)}`);
    }
  }
}
