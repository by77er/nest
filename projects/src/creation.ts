// Creating a project (README.md#creating-a-project): the directory row first, as pending, then the steps
// that make the project whole (the catalog synced with its repo, ReviewDO and ProjectDO initialized), then
// the row marked ready. Each step is idempotent, so the Worker's request or, should it fail or die
// half-way, DirectoryDO's alarm finishes it from the row; a project that can't be finished is removed.

import { bindAll } from "./binding";
import { syncCatalog } from "./catalog";
import { directory, type Env, project, review } from "./env";
import { nestFrom } from "./nest";
import { CreateProject } from "./requests";
import type { ProjectRow } from "./do/directory";
import type { z } from "zod";

export type CreateSpec = z.output<typeof CreateProject>;

/**
 * Write the catalog again (the templates name no repo: README.md#repo-authority), after reading each project's
 * repo binding afresh; the repos it saw are recorded with it, for the Admin page.
 */
export async function syncRepos(env: Env): Promise<{ ok: true; written: string[]; repos: string[] } | { ok: false; status: number; error: string }> {
  const nest = nestFrom(env);
  if (!nest) return { ok: false, status: 503, error: "NEST_CLIENT_TOKEN is not set" };
  try {
    // Each project's repo binding first (README.md#the-repos-binding): an id for one with none, a rename applied.
    await bindAll(env, nest);
    const r = await syncCatalog(nest, env.PUBLIC_BASE_URL);
    const repos = await directory(env).repos();
    await directory(env).recordSync({ written: r.written, repos });
    return { ok: true, written: r.written, repos };
  } catch (e) {
    return { ok: false, status: 502, error: `the catalog sync failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The steps after the row, each idempotent: run again from the start whenever it's resumed. The catalog
 * sync's failure doesn't stop it (the next sync covers it; the answer says so). Throws when a step does.
 */
export async function finishProject(env: Env, p: ProjectRow, spec: CreateSpec): Promise<{ catalog_synced: boolean }> {
  const synced = await syncRepos(env);
  await review(env, p.id).init({ project: p.id, repo: p.repo }, { max_concurrent_reviews: spec.max_concurrent_reviews });
  const stub = project(env, p.id);
  await stub.init({
    id: p.id, name: p.name, repo: p.repo, auto_assign: spec.auto_assign, max_workers: spec.max_workers,
    auto_merge: spec.auto_merge, merge_method: spec.merge_method,
  });
  await directory(env).creationDone(p.id);
  // Attaches the repo, then starts the manager (README.md#flows); its own alarm retries what fails here.
  await stub.drain().catch(() => {});
  return { catalog_synced: synced.ok };
}
