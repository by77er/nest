// The JSON API the board's UI reads (behind Cloudflare Access, src/worker.ts). The state is the app's
// own Durable Objects'; the only calls out are to nest's client interface (src/nest.ts).

import type { z } from "zod";
import { syncCatalog } from "./catalog";
import { directory, type Env, project, review } from "./env";
import { nestFrom } from "./nest";
import { Answer, Cancel, Chat, CreateProject, CreateTask, Settings, Spec, UpdateTask } from "./requests";
import type { Result } from "./sql";
import { proxyTrace } from "./trace";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, error: string) => json({ error }, status);
const done = <T>(r: Result<T>, status = 200) => (r.ok ? json(r.value, status) : err(r.status, r.error));

/** A project's settings with ReviewDO's one, `max_concurrent_reviews`. */
async function withReviews<T extends object>(env: Env, id: string, r: Result<T>): Promise<Result<T & { max_concurrent_reviews: number | null }>> {
  return r.ok ? { ok: true, value: { ...r.value, max_concurrent_reviews: await review(env, id).maxConcurrent() } } : r;
}

async function body<S extends z.ZodType>(req: Request, schema: S): Promise<{ ok: true; value: z.output<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: err(400, "the body isn't JSON") };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, res: err(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) };
}

/** Write the catalog for every project's repo, and remember that it did. */
async function sync(env: Env): Promise<Response> {
  const nest = nestFrom(env);
  if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
  const repos = await directory(env).repos();
  try {
    const r = await syncCatalog(nest, env.PUBLIC_BASE_URL, repos);
    await directory(env).recordSync({ written: r.written, repos });
    return json({ ...r, repos });
  } catch (e) {
    return err(502, `the catalog sync failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const ID = { project: /^prj_[a-z0-9]+$/, task: /^tsk_[a-z0-9]+$/, ask: /^ask_[A-Za-z0-9]+$/ };

/** Answer a request under /api/ (the Access check already passed). */
export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").slice(2); // after "/api"
  const m = req.method;

  if (parts.join("/") === "admin/sync") return m === "POST" ? sync(env) : err(405, "POST only");
  if (parts.join("/") === "admin/sync-state" && m === "GET") return json(await directory(env).lastSync());

  // An agent's live trace, a WebSocket proxied to nest (src/trace.ts).
  if (parts[0] === "agents" && parts.length === 3 && parts[2] === "trace") return proxyTrace(req, env, parts[1]!, url);
  if (parts[0] !== "projects") return err(404, "unknown route");
  if (parts.length === 1) {
    if (m === "GET") return json({ projects: await directory(env).projects() });
    if (m !== "POST") return err(405, "GET or POST");
    const b = await body(req, CreateProject);
    if (!b.ok) return b.res;
    const created = await directory(env).createProject({ name: b.value.name, repo: b.value.repo });
    if (!created.ok) return err(created.status, created.error);
    const p = created.value;
    // The templates may push only to attached repos: written again with this one before its manager starts.
    const synced = await sync(env);
    await review(env, p.id).init({ project: p.id, repo: p.repo }, { max_concurrent_reviews: b.value.max_concurrent_reviews });
    const stub = project(env, p.id);
    await stub.init({
      id: p.id, name: p.name, repo: p.repo, auto_assign: b.value.auto_assign, max_workers: b.value.max_workers,
      auto_merge: b.value.auto_merge, merge_method: b.value.merge_method,
    });
    // Attaches the repo, then starts the manager (README.md#flows).
    await stub.drain();
    const settings = await withReviews(env, p.id, await stub.getSettings());
    return json({ ...p, settings: settings.ok ? settings.value : null, catalog_synced: synced.ok }, 201);
  }

  const pid = parts[1]!;
  if (!ID.project.test(pid)) return err(404, "unknown project");
  const row = await directory(env).getProject(pid);
  if (!row) return err(404, "unknown project");
  const p = project(env, pid);
  const rest = parts.slice(2);
  const route = `${m} ${rest.map((s) => (ID.task.test(s) ? ":task" : ID.ask.test(s) ? ":ask" : s)).join("/")}`;
  const task = rest[1] ?? "";
  const ask = rest[1] ?? "";

  switch (route) {
    case "GET ": {
      // Looking at the project reads the repo's auto-merge setting again (at most once a minute).
      await p.refreshRepoAutoMerge();
      const s = await withReviews(env, pid, await p.getSettings());
      if (!s.ok) return done(s);
      return json({ ...row, settings: s.value });
    }
    case "GET settings":
      return done(await withReviews(env, pid, await p.getSettings()));
    case "PATCH settings": {
      const b = await body(req, Settings);
      if (!b.ok) return b.res;
      const { max_concurrent_reviews, ...rest } = b.value;
      if (max_concurrent_reviews !== undefined) await review(env, pid).setMaxConcurrent(max_concurrent_reviews);
      return done(await withReviews(env, pid, await p.updateSettings(rest)));
    }
    case "POST auto-merge/retry":
      return done(await withReviews(env, pid, await p.retryRepoAutoMerge()));
    case "POST attach":
      return done(await withReviews(env, pid, await p.retryAttach()));
    case "GET reviews":
      return json(await review(env, pid).jobs());
    case "GET tasks":
      return done(await p.listTasks());
    case "POST tasks": {
      const b = await body(req, CreateTask);
      return b.ok ? done(await p.createTask(b.value), 201) : b.res;
    }
    case "GET tasks/:task":
      return done(await p.getTask(task));
    case "PATCH tasks/:task": {
      const b = await body(req, UpdateTask);
      return b.ok ? done(await p.updateTask(task, b.value)) : b.res;
    }
    case "DELETE tasks/:task":
      return done(await p.deleteTask(task));
    case "PUT tasks/:task/spec": {
      const b = await body(req, Spec);
      return b.ok ? done(await p.writeSpec(task, b.value)) : b.res;
    }
    case "POST tasks/:task/assign":
      return done(await p.assign(task));
    case "POST tasks/:task/cancel": {
      const b = await body(req, Cancel);
      return b.ok ? done(await p.cancel(task, { kind: "owner" }, b.value.reason)) : b.res;
    }
    case "POST tasks/:task/done":
      return done(await p.markDone(task));
    case "GET chat":
      return done(await p.chat());
    case "POST chat": {
      const b = await body(req, Chat);
      return b.ok ? done(await p.postChat(b.value.text), 201) : b.res;
    }
    case "GET asks":
      return done(await p.asks());
    case "POST asks/:ask/answer": {
      const b = await body(req, Answer);
      return b.ok ? done(await p.answerAsk(ask, b.value.answer)) : b.res;
    }
    case "GET errors":
      return done(await p.errors());
    default:
      return err(404, "unknown route");
  }
}
