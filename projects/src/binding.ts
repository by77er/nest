// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id, read from GitHub (at
// attach, at a catalog sync for a project that has none, or at the operator's re-read) rather than taken
// from the first event; and a rename or transfer applied once nest's grant names the repo's new name.
// Only nest's client interface: a GitHub token for the project's repo (metadata: read), and the grant.

import { directory, type Env, project, review } from "./env";
import { githubFor, PERMISSIONS } from "./github";
import { type Nest, NestError } from "./nest";
import type { BindOutcome, RepoBinding } from "./do/directory";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Read the repo from GitHub and bind the project to it (`fill`: only where there's no id; `replace`: the
 * operator's re-read). Read by the name GitHub last gave it, so an old name taken by another repo since
 * isn't read; with a token for that name, or (outside nest's grant yet) for the name the project has.
 */
export async function readBinding(env: Env, nest: Nest, id: string, mode: "fill" | "replace"): Promise<BindOutcome> {
  const dir = directory(env);
  const b = await dir.binding(id);
  if (!b) return { ok: false, error: "unknown project", binding: null };
  let info: { id: number; full_name: string };
  const name = b.renamed_to ?? b.repo;
  try {
    let gh;
    try {
      gh = await githubFor(nest, name, PERMISSIONS.metadata);
    } catch (e) {
      // The new name isn't in nest's grant yet (403): a token for the name the grant holds reads the same repo.
      if (!(b.renamed_to && e instanceof NestError && e.status === 403)) throw e;
      gh = await githubFor(nest, b.repo, PERMISSIONS.metadata);
    }
    info = await gh.repoInfo(name);
  } catch (e) {
    return { ok: false, error: `GitHub couldn't be read: ${message(e)}`, binding: b };
  }
  return await dir.bindRepo(id, info, mode);
}

/** Why a rename isn't applied yet, or null once it is (or there's none). */
export type RenameOutcome = { applied: string } | { blocked: string } | null;

/**
 * Apply a rename GitHub told (`renamed_to`): ProjectDO and ReviewDO first, the directory last, so a step
 * that fails is redone whole next time. Only once nest's grant names the new name (it mints tokens for
 * the repos it names), and never onto another project's name.
 */
export async function applyRename(env: Env, nest: Nest, b: RepoBinding): Promise<RenameOutcome> {
  const to = b.renamed_to;
  if (!to) return null;
  const repos = ((await nest.self()).grant?.github?.repos ?? []).map((r) => r.toLowerCase());
  if (!repos.includes(to)) return { blocked: `nest's grant for the app doesn't name ${to} yet: add it, then re-read` };
  if (await directory(env).projectByName(to, b.project)) return { blocked: `${to} is another project's repo` };
  await project(env, b.project).repoRenamed(to);
  await review(env, b.project).repoRenamed(to);
  return (await directory(env).renameRepo(b.project, to)) ? { applied: to } : { blocked: "the rename changed while it was applied: re-read" };
}

/**
 * A catalog sync's pass over the bindings: an id read for each project with none (or bound from an event),
 * and each rename applied that can be. Never fails the sync: what didn't bind is kept on the binding.
 */
export async function bindAll(env: Env, nest: Nest): Promise<void> {
  for (const b of await directory(env).bindings()) {
    try {
      let now: RepoBinding | null = b;
      if (b.repo_id === null || b.bound !== "github") {
        const r = await readBinding(env, nest, b.project, "fill");
        now = r.binding;
      }
      if (now?.renamed_to) await applyRename(env, nest, now);
    } catch (e) {
      console.warn(`project ${b.project}: its repo binding wasn't read: ${message(e)}`);
    }
  }
}
