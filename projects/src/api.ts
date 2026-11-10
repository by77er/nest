// The JSON API the board's UI reads (behind Cloudflare Access, src/worker.ts). The state is the app's
// own Durable Objects'; the only calls out are to nest's client interface (src/nest.ts).

import type { z } from "zod";
import { finishProject, syncRepos } from "./creation";
import { verdict } from "./outbox";
import { directory, type Env, project, review } from "./env";
import { type AgentRecord, type Lookup, managerStatus } from "./manager";
import { clientIdOf, NestError, nestFrom } from "./nest";
import { NETWORK_ROLES, normalizeRules, type OperatorRule, operatorRules, OUTSIDE, rulesProblems } from "./network";
import { prNumberOf } from "./prs";
import { outsideGrant, type SecretGrant, secretProblems, valueProblem } from "./secrets";
import { AcceptIssue, AddDependency, Answer, AttachPr, Cancel, Chat, CreateProject, CreateRoutine, CreateTask, DeclineIssue, DeclineProposal, Network, PutSecret, Settings, Spec, UpdateRoutine, UpdateTask } from "./requests";
import { PRESETS } from "./routines";
import type { UntrustedPolicy } from "./review-trust";
import type { Result } from "./sql";
import { proxyTrace, proxyTraceHistory } from "./trace";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, error: string) => json({ error }, status);
const done = <T>(r: Result<T>, status = 200) => (r.ok ? json(r.value, status) : err(r.status, r.error));

/** A project's settings with ReviewDO's: `max_concurrent_reviews`, and what happens to PRs it doesn't trust (README.md#the-review-gate). */
async function withReviews<T extends object>(env: Env, id: string, r: Result<T>): Promise<Result<T & { max_concurrent_reviews: number | null; untrusted_reviews: UntrustedPolicy }>> {
  if (!r.ok) return r;
  const rv = review(env, id);
  return { ok: true, value: { ...r.value, max_concurrent_reviews: await rv.maxConcurrent(), untrusted_reviews: await rv.untrustedPolicy() } };
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
  const r = await syncRepos(env);
  return r.ok ? json({ written: r.written, repos: r.repos }) : err(r.status, r.error);
}

const ID = {
  project: /^prj_[a-z0-9]+$/, task: /^tsk_[a-z0-9]+$/, ask: /^ask_[A-Za-z0-9]+$/,
  routine: /^rtn_[a-z0-9]+$/, run: /^run_[a-z0-9]+$/, proposal: /^prp_[a-z0-9]+$/,
};

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
      return json({ projects: await Promise.all(rows.map(async (r) => ({ ...r, needs_you: (await project(env, r.id).attentionCount()) + (await review(env, r.id).heldCount()) }))) });
    }
    if (m !== "POST") return err(405, "GET or POST");
    const b = await body(req, CreateProject);
    if (!b.ok) return b.res;
    // Pending first, then finished here; should this request fail or die half-way, DirectoryDO's alarm
    // finishes it (README.md#creating-a-project). The same repo asked for again while pending resumes it.
    const created = await directory(env).createProject({ name: b.value.name, repo: b.value.repo }, b.value);
    if (!created.ok) return err(created.status, created.error);
    const p = created.value;
    let synced: boolean;
    try {
      synced = (await finishProject(env, p, b.value)).catalog_synced;
    } catch (e) {
      const still = await directory(env).creationFailed(p.id, verdict(e));
      return json({ error: `the project ${still ? "is still being created (it's retried)" : "couldn't be created"}: ${verdict(e).error}`, id: p.id, state: still ? "pending" : "removed" }, 503);
    }
    const settings = await withReviews(env, p.id, await project(env, p.id).getSettings());
    return json({ ...p, state: "ready", settings: settings.ok ? settings.value : null, catalog_synced: synced }, 201);
  }

  const pid = parts[1]!;
  if (!ID.project.test(pid)) return err(404, "unknown project");
  const row = await directory(env).getProject(pid);
  if (!row) return err(404, "unknown project");
  // Not whole yet: said so, rather than its objects' 404 (README.md#creating-a-project).
  if (row.state === "pending") return err(503, "the project is still being created: try again shortly");
  const p = project(env, pid);
  const rest = parts.slice(2);
  const route = rest[0] === "secrets" && rest.length === 2 ? `${m} secrets/:name`
    : rest[0] === "secret-requests" && rest.length === 3 ? `${m} secret-requests/:id/${rest[2]}`
    : rest[0] === "memory" && rest.length === 2 ? `${m} memory/:key`
    : rest[0] === "reviews" && rest.length === 4 && /^[1-9][0-9]{0,9}$/.test(rest[1]!) && /^[0-9a-f]{40}$/.test(rest[2]!) ? `${m} reviews/:pr/:sha/${rest[3]}`
    : rest[0] === "stops" && (rest.length === 2 || rest.length === 3) && /^agt_[A-Za-z0-9]{1,64}$/.test(rest[1]!) ? `${m} ${["stops", ":agent", ...rest.slice(2)].join("/")}`
    : `${m} ${rest.map((s) => (ID.task.test(s) ? ":task" : ID.ask.test(s) ? ":ask" : ID.routine.test(s) ? ":routine" : ID.run.test(s) ? ":run" : ID.proposal.test(s) ? ":proposal" : /^[1-9][0-9]{0,9}$/.test(s) ? ":n" : s)).join("/")}`;
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
      const { max_concurrent_reviews, untrusted_reviews, ...rest } = b.value;
      // Workers editing CI workflows needs the grant to allow it: refused here rather than at every spawn.
      if (rest.workers_edit_workflows === true) {
        const g = await grantOf(env);
        if (!g.ok) return err(g.status, g.error);
        if (!g.value.workflows) return err(409, "the app's grant doesn't allow workflows on push tokens: the operator must set github_push.workflows in its grant");
      }
      if (max_concurrent_reviews !== undefined) await review(env, pid).setMaxConcurrent(max_concurrent_reviews);
      if (untrusted_reviews !== undefined) await review(env, pid).setUntrustedPolicy(untrusted_reviews);
      return done(await withReviews(env, pid, await p.updateSettings(rest)));
    }
    case "GET secrets": {
      // Metadata only: the app's, with nest's last injection and size; never a value.
      const [mine, g, layers] = await Promise.all([p.secrets(), grantOf(env), p.network()]);
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
          const n = theirs.get(x.nest_name);
          // Hosts the grant no longer covers: left out of every layer until the operator widens it.
          const outside = g.ok ? outsideGrant(x, g.value.inject_hosts) : [];
          return { ...x, size: n?.size ?? x.size, last_injected_ms: n?.last_injected_ms ?? null, in_nest: theirs.size ? n !== undefined : null, outside_hosts: outside };
        }),
        grant: g.ok ? { ...g.value, used: theirs.size } : null,
        client: clientIdOf(env.NEST_CLIENT_TOKEN),
        // Each live agent's client layer, which carries its bindings and variables (shared with the Network page).
        agents: layers.ok ? layers.value.agents : [],
        // Live workers whose push token may change workflows (README.md#secrets): theirs until they end.
        workflow_workers: await p.workflowWorkers(),
      });
    }
    case "PUT secrets/:name": {
      const name = rest[1]!;
      const b = await body(req, PutSecret);
      if (!b.ok) return b.res;
      const { value, ...meta } = b.value;
      const g = await grantOf(env);
      // Fail closed: without the grant, nothing here can tell a host nest will refuse.
      if (!g.ok) return err(503, `the grant couldn't be read, so the secret can't be checked: ${g.error}`);
      const others = await p.secrets();
      const taken = others.ok ? others.value.filter((x) => x.name !== name).map((x) => x.env) : [];
      const problems = secretProblems({ name, ...meta }, g.value, taken);
      if (value !== undefined) {
        const v = valueProblem(value, g.value);
        if (v) problems.value = v;
      }
      if (Object.keys(problems).length) return json({ error: Object.values(problems).join("; "), problems }, 400);
      const nest = nestFrom(env);
      if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
      let size: number | null = null;
      const nestName = await p.nestNameFor(name, value !== undefined);
      if (nestName === null) return err(400, "a new secret needs a value");
      if (value !== undefined) {
        // Straight to nest, write-only: the value never reaches the app's objects, logs or answers.
        try {
          size = (await nest.putSecret(nestName, value, meta.description)).size;
        } catch (e) {
          return err(e instanceof NestError ? e.status : 502, e instanceof NestError && e.status === 403 ? `nest refused it: ${e.message} (the grant's secrets.max_count or max_bytes)` : String(e));
        }
      }
      const saved = await p.saveSecretMeta({ name, ...meta, nest_name: nestName }, size);
      // Not recorded (a new one refused, or the name made again meanwhile): its value mustn't stay in nest unnamed.
      if (!saved.ok && value !== undefined && !(await secretRows(p)).some((x) => x.nest_name === nestName)) {
        // Failing that, ProjectDO's sweep deletes it once the grace has passed (it counts against max_count).
        await nest.deleteSecret(nestName).catch((e) => console.error(`secret ${nestName} not recorded and not deleted (the sweep retries): ${String(e).slice(0, 200)}`));
      }
      return done(saved);
    }
    case "DELETE secrets/:name": {
      const name = rest[1]!;
      const nest = nestFrom(env);
      if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
      const row = (await secretRows(p)).find((x) => x.name === name);
      if (!row) return err(404, `no secret ${name}`);
      try {
        await nest.deleteSecret(row.nest_name);
      } catch (e) {
        if (!(e instanceof NestError && e.status === 404)) return err(502, String(e));
      }
      return done(await p.deleteSecretMeta(name));
    }
    // Triage (README.md#triage): the repo's issues waiting, accepting one as a draft task, declining one,
    // and a one-off import of the open ones.
    case "GET issues":
      return done(await p.issues());
    case "POST issues/:n/accept": {
      // With the issue's `updated_ms` as the owner read it: changed since, it's refused (409).
      const b = await body(req, AcceptIssue);
      if (!b.ok) return b.res;
      return done(await p.acceptIssue(Number(rest[1]), b.value.updated_ms));
    }
    case "POST issues/:n/decline": {
      const b = await body(req, DeclineIssue);
      if (!b.ok) return b.res;
      return done(await p.declineIssue(Number(rest[1]), b.value.reason?.trim() || null));
    }
    case "POST issues/import":
      return done(await p.importIssues());
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
        // Ended, or gone from nest, whether or not its exit reached the app: replaced as its exit would be
        // (README.md#the-manager-lifecycle), and the status read again.
        const r = lookup && "record" in lookup ? lookup.record : null;
        const why = lookup && "gone" in lookup ? "nest no longer has it" : r && (r.ended || r.state === "ended") ? (r.ended?.reason ?? "ended") : null;
        if (why && (await p.managerGone(s.value.manager, why))) {
          const again = await p.getSettings();
          if (again.ok) return json(managerStatus(again.value, null));
        }
      }
      return json(managerStatus(s.value, lookup));
    }
    case "POST manager/restart":
      // The owner's Restart (README.md#the-manager-lifecycle): the manager goes, a new one starts.
      return done(await p.restartManager());
    case "GET reviews":
      return json(await review(env, pid).jobs());
    // The review gate (README.md#the-review-gate): the owner approves a held review of one head commit, or dismisses it.
    case "POST reviews/:pr/:sha/approve":
      return done(await review(env, pid).approve(Number(rest[1]), rest[2]!));
    case "POST reviews/:pr/:sha/dismiss":
      return done(await review(env, pid).dismiss(Number(rest[1]), rest[2]!));
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
    case "POST tasks/:task/issue/close":
      // Try closing the task's issue again, after GitHub refused it for good (README.md#triage).
      return done(await p.retryIssueClose(task));
    case "GET chat": {
      // `before=<seq>`: the page before it (older messages, as the owner scrolls up); `limit` is capped.
      const before = url.searchParams.get("before");
      const limit = url.searchParams.get("limit");
      if (before !== null && !/^\d{1,15}$/.test(before)) return err(400, "before is a message's seq");
      if (limit !== null && !/^\d{1,4}$/.test(limit)) return err(400, "limit is a number");
      return done(await p.chat(limit === null ? undefined : Number(limit), before === null ? undefined : Number(before)));
    }
    case "POST manager/interrupt": {
      // Stop the manager's current turn (nest's owner route; the app owns the agent).
      const s = await p.getSettings();
      if (!s.ok) return done(s);
      if (!s.value.manager) return err(409, "the manager isn't started");
      const nest = nestFrom(env);
      if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
      try {
        return json(await nest.interrupt(s.value.manager));
      } catch (e) {
        return e instanceof NestError ? err(e.status === 404 ? 404 : 502, e.message) : err(502, String(e));
      }
    }
    case "POST chat": {
      const b = await body(req, Chat);
      return b.ok ? done(await p.postChat(b.value.text, b.value.request_id), 201) : b.res;
    }
    // A stop nest refused (README.md#outboxes): tried again, or dismissed by the owner (it stops counting).
    case "POST stops/:agent/retry":
      return done(await p.retryStop(rest[1]!));
    case "DELETE stops/:agent":
      return done(await p.dismissStop(rest[1]!));
    case "POST chat/:n/retry":
      // Sends again a message nest refused for good; one still being sent is left as it is (README.md#outboxes).
      return done(await p.retryChat(Number(rest[1])));
    case "GET attention": {
      // ProjectDO's, with the reviews held for approval (ReviewDO's), oldest first.
      const a = (await p.attention()) as Result<{ at_ms: number }[]>;
      if (!a.ok) return err(a.status, a.error);
      const held = (await review(env, pid).held()).map((j) => ({ kind: "review" as const, pr: j.pr, sha: j.sha, title: j.title, author: j.author, fork: j.fork, at_ms: j.created_ms }));
      // PRs past every cap, with no job yet: one item, their count.
      const skipped = await review(env, pid).skipped();
      const backlog = skipped.count ? [{ kind: "review_backlog" as const, count: skipped.count, at_ms: skipped.at_ms ?? Date.now() }] : [];
      return json([...a.value, ...held, ...backlog].sort((x, y) => x.at_ms - y.at_ms));
    }
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
      // A host already in a role's rules may stay though the operator has since narrowed the grant: it's
      // kept, shown "outside the grant", and not applied. So a save that only removes (or keeps) rules
      // always goes through; only a host newly added outside the grant is refused.
      const stored = await p.network();
      if (!stored.ok) return err(stored.status, stored.error);
      const problems = Object.fromEntries(NETWORK_ROLES.flatMap((role) => {
        const had = new Set(stored.value.rules[role].map((r) => r.host));
        return Object.entries(rulesProblems(normalizeRules(b.value[role]), g.value))
          .filter(([host, v]) => !(v.endsWith(OUTSIDE) && had.has(host)))
          .map(([k, v]) => [`${role}.${k}`, v]);
      }));
      if (Object.keys(problems).length) {
        const outside = Object.values(problems).some((v) => v.endsWith(OUTSIDE));
        return json({ error: Object.values(problems).join("; "), problems }, outside ? 403 : 400);
      }
      const r = await p.setNetwork(b.value);
      return r.ok ? networkView(env, p, r.value) : done(r);
    }
    // Routines (README.md#routines): background runs on a timer or the board's counters; their runs, the
    // tasks they propose (in triage until the owner accepts or declines them), and the project's memory.
    case "GET routines":
      return done(await p.routines());
    case "POST routines": {
      const b = await body(req, CreateRoutine);
      if (!b.ok) return b.res;
      return done("preset" in b.value ? await p.createRoutine(PRESETS[b.value.preset], b.value.preset) : await p.createRoutine(b.value), 201);
    }
    case "GET routines/:routine":
      return done(await p.getRoutine(rest[1]!));
    case "PATCH routines/:routine": {
      const b = await body(req, UpdateRoutine);
      return b.ok ? done(await p.updateRoutine(rest[1]!, b.value)) : b.res;
    }
    case "DELETE routines/:routine":
      return done(await p.deleteRoutine(rest[1]!));
    case "POST routines/:routine/run":
      return done(await p.runRoutineNow(rest[1]!));
    case "GET routines/:routine/runs":
      return done(await p.routineRuns(rest[1]!));
    case "GET routine-runs":
      return done(await p.routineRuns(null));
    case "POST routine-runs/:run/stop":
      return done(await p.stopRun(rest[1]!));
    case "GET proposals":
      return done(await p.proposals());
    case "POST proposals/:proposal/accept":
      return done(await p.acceptProposal(rest[1]!));
    case "POST proposals/:proposal/decline": {
      const b = await body(req, DeclineProposal);
      return b.ok ? done(await p.declineProposal(rest[1]!, b.value.reason?.trim() || null)) : b.res;
    }
    case "GET memory":
      return done(await p.memory());
    case "DELETE memory/:key":
      return done(await p.deleteNote(rest[1]!));
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

/** A project's secrets' metadata, or none when it can't be read. */
async function secretRows(p: { secrets(): Promise<{ ok: true; value: { name: string; nest_name: string }[] } | { ok: false }> }) {
  const r = await p.secrets();
  return r.ok ? r.value : [];
}
