// The JSON API the board's UI reads (behind Cloudflare Access, src/worker.ts). The state is the app's
// own Durable Objects'; the only calls out are to nest's client interface (src/nest.ts).

import type { z } from "zod";
import { syncCatalog } from "./catalog";
import { directory, type Env, project, review } from "./env";
import { type AgentRecord, type Lookup, managerStatus } from "./manager";
import { clientIdOf, NestError, nestFrom } from "./nest";
import { NETWORK_ROLES, normalizeRules, type OperatorRule, operatorRules, rulesProblems } from "./network";
import { prNumberOf } from "./prs";
import { nestSecretName, type SecretGrant, secretProblems, valueProblem } from "./secrets";
import { AddDependency, Answer, AttachPr, Cancel, Chat, CreateProject, CreateTask, Network, PutSecret, Settings, Spec, UpdateTask } from "./requests";
import type { Result } from "./sql";
import { proxyTrace, proxyTraceHistory } from "./trace";

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
  if (parts[0] === "agents" && parts.length === 4 && parts[2] === "trace" && parts[3] === "history") return proxyTraceHistory(req, env, parts[1]!, url);
  if (parts[0] !== "projects") return err(404, "unknown route");
  if (parts.length === 1) {
    // Each with `needs_you`: how many asks and blocked tasks wait on the owner (README.md#blocked).
    if (m === "GET") {
      const rows = await directory(env).projects();
      return json({ projects: await Promise.all(rows.map(async (r) => ({ ...r, needs_you: await project(env, r.id).attentionCount() }))) });
    }
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
  const route = rest[0] === "secrets" && rest.length === 2 ? `${m} secrets/:name`
    : rest[0] === "secret-requests" && rest.length === 3 ? `${m} secret-requests/:id/${rest[2]}`
    : `${m} ${rest.map((s) => (ID.task.test(s) ? ":task" : ID.ask.test(s) ? ":ask" : /^[1-9][0-9]{0,9}$/.test(s) ? ":n" : s)).join("/")}`;
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
      // Workers editing CI workflows needs the grant to allow it: refused here rather than at every spawn.
      if (rest.workers_edit_workflows === true) {
        const g = await grantOf(env);
        if (!g.ok) return err(g.status, g.error);
        if (!g.value.workflows) return err(409, "the app's grant doesn't allow workflows on push tokens: the operator must set github_push.workflows in its grant");
      }
      if (max_concurrent_reviews !== undefined) await review(env, pid).setMaxConcurrent(max_concurrent_reviews);
      return done(await withReviews(env, pid, await p.updateSettings(rest)));
    }
    case "GET secrets": {
      // Metadata only: the app's, with nest's last injection and size; never a value.
      const [mine, g] = await Promise.all([p.secrets(), grantOf(env)]);
      if (!mine.ok) return done(mine);
      const nest = nestFrom(env);
      let theirs: Map<string, { size: number; last_injected_ms: number | null }> = new Map();
      if (nest) {
        try {
          theirs = new Map((await nest.listSecrets()).map((x) => [x.name, x]));
        } catch {
          // shown without nest's facts
        }
      }
      return json({
        secrets: mine.value.map((x) => {
          const n = theirs.get(nestSecretName(pid, x.name));
          return { ...x, size: n?.size ?? x.size, last_injected_ms: n?.last_injected_ms ?? null, in_nest: theirs.size ? n !== undefined : null };
        }),
        grant: g.ok ? { ...g.value, used: theirs.size } : null,
        client: clientIdOf(env.NEST_CLIENT_TOKEN),
      });
    }
    case "PUT secrets/:name": {
      const name = rest[1]!;
      const b = await body(req, PutSecret);
      if (!b.ok) return b.res;
      const { value, ...meta } = b.value;
      const g = await grantOf(env);
      const problems = secretProblems({ name, ...meta }, g.ok ? g.value : null);
      if (value !== undefined) {
        const v = valueProblem(value, g.ok ? g.value : null);
        if (v) problems.value = v;
      }
      if (Object.keys(problems).length) return json({ error: Object.values(problems).join("; "), problems }, 400);
      const nest = nestFrom(env);
      if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
      let size: number | null = null;
      if (value !== undefined) {
        // Straight to nest, write-only: the value never reaches the app's objects, logs or answers.
        try {
          size = (await nest.putSecret(nestSecretName(pid, name), value, meta.description)).size;
        } catch (e) {
          return err(e instanceof NestError ? e.status : 502, e instanceof NestError && e.status === 403 ? `nest refused it: ${e.message} (the grant's secrets.max_count or max_bytes)` : String(e));
        }
      }
      return done(await p.saveSecretMeta({ name, ...meta }, size));
    }
    case "DELETE secrets/:name": {
      const name = rest[1]!;
      const nest = nestFrom(env);
      if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
      try {
        await nest.deleteSecret(nestSecretName(pid, name));
      } catch (e) {
        if (!(e instanceof NestError && e.status === 404)) return err(502, String(e));
      }
      return done(await p.deleteSecretMeta(name));
    }
    case "POST secret-requests/:id/done":
      return done(await p.secretRequestDone(rest[1]!));
    case "POST auto-merge/retry":
      return done(await withReviews(env, pid, await p.retryRepoAutoMerge()));
    case "POST attach":
      return done(await withReviews(env, pid, await p.retryAttach()));
    case "GET manager": {
      // The manager's status for its page: the project's record, then nest's agent record once it has one.
      const s = await p.getSettings();
      if (!s.ok) return done(s);
      let lookup: Lookup | null = null;
      if (s.value.attached && s.value.manager) {
        const nest = nestFrom(env);
        if (!nest) lookup = { failed: "NEST_CLIENT_TOKEN is not set" };
        else {
          try {
            lookup = { record: (await nest.getAgent(s.value.manager)) as AgentRecord };
          } catch (e) {
            lookup = e instanceof NestError && e.status === 404 ? { gone: true } : { failed: e instanceof Error ? e.message : String(e) };
          }
        }
      }
      return json(managerStatus(s.value, lookup));
    }
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
    case "GET attention":
      return done(await p.attention());
    case "GET prs/open":
      return done(await p.openPrs());
    case "POST tasks/:task/prs": {
      const b = await body(req, AttachPr);
      if (!b.ok) return b.res;
      const n = prNumberOf(b.value.pr, row.repo);
      return n === null ? err(400, `pr: a PR number, #<n>, or https://github.com/${row.repo}/pull/<n>`) : done(await p.attachPrByNumber(task, n, { kind: "owner" }));
    }
    case "DELETE tasks/:task/prs/:n":
      return done(await p.detachPr(task, Number(rest[3]), { kind: "owner" }));
    case "POST tasks/:task/dependencies": {
      const b = await body(req, AddDependency);
      return b.ok ? done(await p.addDependency(task, b.value.blocked_by, { kind: "owner" })) : b.res;
    }
    case "DELETE tasks/:task/dependencies/:task":
      return done(await p.removeDependency(task, rest[3]!, { kind: "owner" }));
    case "POST tasks/:task/answer": {
      const b = await body(req, Answer);
      return b.ok ? done(await p.answerBlocked(task, b.value.answer)) : b.res;
    }
    case "GET asks":
      return done(await p.asks());
    case "POST asks/:ask/answer": {
      const b = await body(req, Answer);
      return b.ok ? done(await p.answerAsk(ask, b.value.answer)) : b.res;
    }
    case "GET waits":
      return done(await p.waits());
    case "GET network":
      return networkView(env, p);
    case "PUT network": {
      const b = await body(req, Network);
      if (!b.ok) return b.res;
      const g = await egressHostsOf(env);
      if (!g.ok) return err(g.status, g.error);
      const problems = Object.fromEntries(NETWORK_ROLES.flatMap((role) => Object.entries(rulesProblems(normalizeRules(b.value[role]), g.value)).map(([k, v]) => [`${role}.${k}`, v])));
      if (Object.keys(problems).length) {
        const outside = Object.values(problems).some((v) => v.includes("must widen"));
        return json({ error: Object.values(problems).join("; "), problems }, outside ? 403 : 400);
      }
      const r = await p.setNetwork(b.value);
      return r.ok ? networkView(env, p, r.value) : done(r);
    }
    case "GET errors":
      return done(await p.errors());
    default:
      return err(404, "unknown route");
  }
}

/** The grant's `egress_hosts` (`GET /v1/clients/self`): the ceiling of every network rule. */
async function egressHostsOf(env: Env): Promise<Result<string[]>> {
  const nest = nestFrom(env);
  if (!nest) return { ok: false, status: 503, error: "NEST_CLIENT_TOKEN is not set" };
  try {
    return { ok: true, value: (await nest.self()).grant?.egress_hosts ?? [] };
  } catch (e) {
    return { ok: false, status: 502, error: `nest's grant couldn't be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The Network page's view: the rules and each live agent's layer (ProjectDO's), the grant's ceiling,
 * and the operator's rules (nest's defaults, the operator's layer and the repo allowlists', `operatorRules`) as the manager's
 * sandbox's effective policy shows them (a client may read its own sandboxes' policy; null until the
 * manager runs, or when nest can't be read).
 */
async function networkView(env: Env, p: ReturnType<typeof project>, have?: Awaited<ReturnType<ReturnType<typeof project>["network"]>> extends Result<infer T> ? T : never): Promise<Response> {
  const mine = have ? { ok: true as const, value: have } : await p.network();
  if (!mine.ok) return err(mine.status, mine.error);
  const [grant, sandbox] = await Promise.all([egressHostsOf(env), p.managerSandbox()]);
  let base: OperatorRule[] | null = null;
  const nest = nestFrom(env);
  if (nest && sandbox) {
    try {
      const allow = (await nest.sandboxPolicy(sandbox)).allow ?? [];
      // The client's own layer is needed only by the fallback for a control plane without `source`.
      const own = allow.some((r) => r.source !== undefined) ? [] : ((await nest.getClientPolicy(sandbox)).egress?.allow ?? []);
      base = operatorRules(allow, own);
    } catch {
      base = null;
    }
  }
  return json({ ...mine.value, egress_hosts: grant.ok ? grant.value : null, base });
}

/** The parts of the app's grant secrets need, from `GET /v1/clients/self` (docs/control-plane/api/clients/#clients-and-grants). */
async function grantOf(env: Env): Promise<Result<SecretGrant>> {
  const nest = nestFrom(env);
  if (!nest) return { ok: false, status: 503, error: "NEST_CLIENT_TOKEN is not set" };
  try {
    const g = (await nest.self()).grant ?? {};
    return { ok: true, value: {
      inject_hosts: Array.isArray(g.inject_hosts) ? g.inject_hosts : [],
      max_count: g.secrets?.max_count ?? 0, max_bytes: g.secrets?.max_bytes ?? 4096, workflows: g.github_push?.workflows === true,
    } };
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
  }
}
