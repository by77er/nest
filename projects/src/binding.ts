// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id, read from GitHub (at
// attach, at a catalog sync for a project that has none, or at the operator's re-read) rather than taken
// from the first event; and a rename or transfer applied once the App's installation reaches the repo's new
// name. A token of the app's own App for the project's repo (metadata: read), its installation looked up
// afresh (src/github-app.ts, README.md#repo-authority).

import { directory, type Env, project, review } from "./env";
import { githubFor, ownInstallation, PERMISSIONS } from "./github";
import { notCovered, repoAttachable } from "./installations";
import type { Nest } from "./nest";
import type { BindOutcome, GithubRepo, RepoBinding } from "./do/directory";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Read the repo from GitHub and bind the project to it (`fill`: only where there's no id; `replace`: the
 * operator's re-read). Read by the name GitHub last gave it, so an old name taken by another repo since
 * isn't read; with a token for that name, or (the App not on it yet) for the name the project has.
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
      // The installation looked up now, never a cached one: the binding follows a reinstall at once.
      gh = await githubFor(env, nest, name, PERMISSIONS.metadata, { fresh: true });
    } catch (e) {
      // The App doesn't reach the new name yet (not installed, or not in its installation's repos; nest's 403 in
      // the fallback): a token for the name the project has reads the same repo.
      if (!(b.renamed_to && notCovered(e))) throw e;
      gh = await githubFor(env, nest, b.repo, PERMISSIONS.metadata, { fresh: true });
      current = false;
    }
    const r = await gh.repoInfo(name);
    // The installation for the old name may be another (the name taken since, by a repo the App is installed
    // on): it's never stored, so the one stored stays. Nor is one for a name GitHub redirects (moved since, no
    // event naming the new one yet): it may be another account's.
    info = { id: r.id, full_name: r.full_name, owner: { id: r.owner.id, login: r.owner.login, type: r.owner.type }, installation_id: current ? ownInstallation(name, r.full_name, gh.installationId) : null };
  } catch (e) {
    return { ok: false, error: `GitHub couldn't be read: ${message(e)}`, binding: b };
  }
  // The operator's choice binds the repo they were shown, and no other: GitHub's answer changed since, nothing.
  if (mode === "replace" && info.id !== shownId) return { ok: false, error: `GitHub's ${name} is repo ${info.id} now, not the repo ${shownId ?? "?"} you were shown: re-read to compare again`, binding: b };
  // A binding not read from GitHub yet is bound only to a repo with the owner recorded at attach (bindRepo).
  const attached = b.bound === "github" ? null : await project(env, id).attachedOwner();
  const out = await dir.bindRepo(id, info, mode, attached);
  // The repo's owner as GitHub answers now, for the bound repo: a default comments user that isn't it any more goes.
  if (out.ok && info.owner) await project(env, id).repoOwnerSeen(info.owner, b.owner?.id ?? null);
  return out;
}

/** Why a rename isn't applied yet, or null once it is (or there's none). */
export type RenameOutcome = { applied: string } | { blocked: string } | null;

/**
 * Apply a rename GitHub told (`renamed_to`): the directory's guarded rename (never onto another project's
 * name) is the whole change. The directory is the name's one owner: ProjectDO, ReviewDO and the Worker read
 * it from there, so a rename reaches them all at once and they can't disagree. Only once the App's
 * installation reaches the new name (README.md#repo-authority).
 */
export async function applyRename(env: Env, nest: Nest, b: RepoBinding): Promise<RenameOutcome> {
  const to = b.renamed_to;
  if (!to) return null;
  // GitHub decides whether the App reaches the new name: its installation there, and that installation's repos.
  if (!(await repoAttachable(env, nest, to))) return { blocked: `the app's GitHub App doesn't reach ${to} yet (not installed there, or not among its installation's repos): add it, then re-read` };
  const dir = directory(env);
  if (await dir.projectByName(to, b.project)) return { blocked: `${to} is another project's repo` };
  if (!(await dir.renameRepo(b.project, to))) return { blocked: "the rename changed while it was applied: re-read" };
  await writeOldCopies(env, b.project, to);
  return { applied: to };
}

/**
 * The copies the previous release reads, written after the directory's for a rollback to find
 * (expand/contract: removed the release after): the repo's name (ProjectDO's and ReviewDO's settings), and, at
 * a sync (`b`), the repo's owner (ProjectDO's) as GitHub last answered for a binding read from GitHub, so a
 * rolled-back release trusts the owner now, not the one at attach. Nothing in this release reads them for
 * trust, so one that fails is only logged, and written again at the next catalog sync.
 */
export async function writeOldCopies(env: Env, id: string, name: string, b?: RepoBinding): Promise<void> {
  const writes: [string, () => Promise<void>][] = [["ProjectDO", () => project(env, id).repoRenamed(name)], ["ReviewDO", () => review(env, id).repoRenamed(name)]];
  // Its kind known (read by this release): a user's, or none (an organization's), as the previous release keeps it.
  if (b?.bound === "github" && b.owner?.type) {
    const owner = b.owner.type === "User" ? { id: b.owner.id, login: b.owner.login } : null;
    writes.push(["ProjectDO's owner", () => project(env, id).writeOldOwnerCopy(owner)]);
  }
  for (const [what, write] of writes) {
    try {
      await write();
    } catch (e) {
      console.warn(`project ${id}: ${what}'s old copy of the repo's name wasn't written: ${message(e)}`);
    }
  }
}

/**
 * An event refused for coming from another App installation than the binding's (README.md#the-repos-binding):
 * the binding is read again (at most once a minute per project), so it follows GitHub's answer, the App's
 * installation on the repo as looked up now (the App reinstalled, or the repo moved to an account the App is
 * installed on). GitHub's lookup decides which installation is the repo's, never the event. True when the
 * binding's installation changed, so the event is to be routed again (and refused again, and counted, if the
 * binding took another one than the event's).
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
 * each one that has a rename noted or events refused read again (its owner and installation as GitHub
 * answers now), each rename applied that can be, and the previous release's copies of the name written
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
      const after = await directory(env).binding(b.project);
      if (after) await writeOldCopies(env, b.project, after.repo, after);
    } catch (e) {
      console.warn(`project ${b.project}: its repo binding wasn't read: ${message(e)}`);
    }
  }
}
