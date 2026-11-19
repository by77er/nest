// The JSON API the board's UI reads (behind Cloudflare Access, src/worker.ts). The state is the app's
// own Durable Objects'; the only calls out are to nest's client interface (src/nest.ts).

import { z } from "zod";
import { applyRename, readBinding } from "./binding";
import { finishProject, syncRepos } from "./creation";
import { verdict } from "./outbox";
import { directory, type Env, project, review } from "./env";
import { type AgentRecord, type Lookup, managerStatus } from "./manager";
import { clientIdOf, NestError, nestFrom } from "./nest";
import { NETWORK_ROLES, normalizeRules, type OperatorRule, operatorRules, OUTSIDE, rulesProblems } from "./network";
import { prNumberOf } from "./prs";
import { attachableRepos, repoAttachable } from "./installations";
import { outsideGrant, type SecretGrant, secretProblems, valueProblem } from "./secrets";
import { AcceptIssue, AddDependency, Answer, AttachPr, BindRepo, Cancel, Chat, CreateProject, CreateRoutine, CreateTask, DeclineIssue, DeclineProposal, Network, problems, PutSecret, Settings as SettingsBody, Spec, UpdateReviewer, UpdateRoutine, UpdateTask } from "./requests";
import type { RepoBinding } from "./do/directory";
import type { ProjectSettings, Settings } from "./do/project";
import { githubFor, PERMISSIONS } from "./github";
import { legacyView, toCreate } from "./reviewers";
import { PRESETS } from "./routines";
import type { UntrustedPolicy } from "./review-trust";
import type { Result } from "./sql";
import { proxyTrace, proxyTraceHistory } from "./trace";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, error: string) => json({ error }, status);
const done = <T>(r: Result<T>, status = 200) => (r.ok ? json(r.value, status) : err(r.status, r.error));

/**
 * A read started before an earlier one's answer is known, so the two overlap. Awaited where it was awaited
 * when they ran one after another, it answers or fails there as it did; one never awaited (the earlier answer
 * ended the request) fails nothing.
 */
function early<T>(p: T | Promise<T>): Promise<T> {
  const started = Promise.resolve(p);
  started.catch(() => {});
  return started;
}

/** How long the repo's owner as shown is kept by one Worker instance (and a failed read): a page polls the project every few seconds. */
const OWNER_SHOWN_MS = 60_000;
const ownersShown = new Map<string, { at_ms: number; owner: { id: number; login: string } | null }>();

/**
 * The repo's owner to show (`Settings.repo_owner`: the "Use the repo owner" shortcut, who "You only" names),
 * read through from GitHub (README.md#the-repos-binding) for the bound repo only, and kept a minute per Worker
 * instance, a failed read too, so polling doesn't spend nest's or the App's rate limit. Shown only: trust is
 * decided by each event's own owner. Null for an organization's repo, a binding not read from GitHub yet, a
 * name that's another repo's now, or when GitHub couldn't say.
 */
async function shownOwner(env: Env, b: RepoBinding): Promise<{ id: number; login: string } | null> {
  if (b.bound !== "github" || b.repo_id === null) return null;
  const k = `${b.repo}#${b.repo_id}`;
  const had = ownersShown.get(k);
  if (had && Date.now() - had.at_ms < OWNER_SHOWN_MS) return had.owner;
  if (!nestFrom(env)) return null;
  let owner: { id: number; login: string } | null = null;
  try {
    const info = await (await githubFor(env, b.repo, PERMISSIONS.metadata)).repoInfo(b.repo);
    owner = info.id === b.repo_id && info.owner.type === "User" ? { id: info.owner.id, login: info.owner.login } : null;
  } catch (e) {
    console.warn(`the owner of ${b.repo} couldn't be read: ${String(e).slice(0, 200)}`);
  }
  ownersShown.delete(k);
  ownersShown.set(k, { at_ms: Date.now(), owner });
  if (ownersShown.size > 500) ownersShown.delete(ownersShown.keys().next().value!);
  return owner;
}

/**
 * A project's settings as the API answers them (do/project.ts `Settings`): ProjectDO's, with the repo's name
 * as DirectoryDO has it and its owner as GitHub answers, both read through (README.md#the-repos-binding), and
 * ReviewDO's `max_concurrent_reviews` and what happens to PRs it doesn't trust (README.md#the-review-gate).
 */
async function answerSettings(env: Env, id: string, settings: Result<ProjectSettings> | Promise<Result<ProjectSettings>>): Promise<Result<Settings & { max_concurrent_reviews: number | null; untrusted_reviews: UntrustedPolicy }>> {
  // Settings a write answered: a refusal is the answer, nothing else read.
  if (!(settings instanceof Promise) && !settings.ok) return settings;
  // The binding and ReviewDO's settings don't need ProjectDO's: read beside them (a poll's settings still being
  // read), and answered in the order they were: ProjectDO's refusal, then an unknown binding, then the rest.
  const binding = early(directory(env).binding(id));
  const reviews = early(review(env, id).reviewSettings());
  const r = await settings;
  if (!r.ok) return r;
  const b = await binding;
  if (!b) return { ok: false, status: 404, error: "unknown project" };
  const [owner, rv] = await Promise.all([shownOwner(env, b), reviews]);
  return {
    ok: true,
    value: { ...r.value, repo: b.repo, repo_owner: owner, max_concurrent_reviews: rv.max_concurrent_reviews, untrusted_reviews: rv.untrusted_reviews },
  };
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
  return r.success ? { ok: true, value: r.data } : { ok: false, res: err(400, problems(r.error)) };
}

/** Write the catalog for every project's repo, and remember that it did. */
async function sync(env: Env): Promise<Response> {
  const r = await syncRepos(env);
  return r.ok ? json({ written: r.written, repos: r.repos }) : err(r.status, r.error);
}

/**
 * The operator's re-read of a project's repo binding (README.md#the-repos-binding): the repo's id from
 * GitHub. No id yet: bound. The same id: confirmed, and a rename applied when the App reaches the new
 * name (then the catalog is synced, so its templates name it). Another id: nothing written, and both repos
 * answered (`mismatch`), each with its owner, and whether GitHub's has the bound one's owner; the operator
 * binds it only by `bind` with the id they were shown.
 */
async function rereadBinding(env: Env, id: string, shownId?: number): Promise<Response> {
  if (!nestFrom(env)) return err(503, "NEST_CLIENT_TOKEN is not set");
  const r = await readBinding(env, id, shownId === undefined ? "check" : "replace", shownId);
  if (!r.ok && "mismatch" in r) {
    // The bound repo's owner as GitHub answered at the binding's last read (none for one learned from an event).
    const known = r.mismatch.bound.owner?.id ?? null;
    const owner = r.mismatch.github.owner?.id ?? null;
    return json({ binding: r.binding, mismatch: { bound: r.mismatch.bound, github: { ...r.mismatch.github, same_owner: known === null || owner === null ? null : known === owner } } });
  }
  if (!r.ok) return r.binding === null ? err(404, r.error) : json({ error: r.error, binding: r.binding }, 409);
  const rename = await applyRename(env, r.binding);
  if (rename && "applied" in rename) await syncRepos(env);
  return json({ binding: (await directory(env).binding(id))!, changed: r.changed, previous_id: r.previous_id, rename });
}

/**
 * What waits on the owner, as "Needs you" lists it: ProjectDO's (asks, blocked tasks, secret requests, and
 * triage as one item), with the reviews held for approval (ReviewDO's) and the review backlog as one item,
 * oldest first. The projects list's `needs_you` counts the same items without reading this (one nest read for every project).
 */
async function attentionOf(env: Env, pid: string): Promise<Result<{ kind: string; at_ms: number }[]>> {
  // ReviewDO's beside ProjectDO's (which waits on nest for the asks); ProjectDO's refusal is still the answer.
  const reviews = early(reviewItems(env, pid));
  const a = (await project(env, pid).attention()) as Result<{ kind: string; at_ms: number }[]>;
  if (!a.ok) return a;
  return { ok: true, value: [...a.value, ...(await reviews)].sort((x, y) => x.at_ms - y.at_ms) };
}

/** ReviewDO's items in "Needs you": the reviews held for approval, and the review backlog as one item (one call). */
async function reviewItems(env: Env, pid: string): Promise<{ kind: string; at_ms: number }[]> {
  const mine = await review(env, pid).needsYou();
  const held = mine.held.map((j) => ({ kind: "review" as const, pr: j.pr, sha: j.sha, title: j.title, author: j.author, fork: j.fork, at_ms: j.created_ms }));
  // PRs past every cap, with no job yet: one item, their count.
  const skipped = mine.skipped;
  const backlog = skipped.count ? [{ kind: "review_backlog" as const, count: skipped.count, at_ms: skipped.at_ms ?? Date.now() }] : [];
  return [...held, ...backlog];
}

/**
 * The open asks of the app's agents counted per project (README.md#asks), from one read of nest for every
 * project (`GET /v1/asks` over all the app's live agents): only agents the app made itself, by their
 * `project` label, as each project's "Needs you" counts them. Null when nest can't be read: unknown.
 */
async function askCounts(env: Env): Promise<Map<string, number> | null> {
  const nest = nestFrom(env);
  if (!nest) return null;
  const me = clientIdOf(env.NEST_CLIENT_TOKEN);
  try {
    const counts = new Map<string, number>();
    for (const a of await nest.openAsks({})) {
      const p = a.labels.project;
      if (a.owner === me && p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
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
  // Each project's repo binding (README.md#the-repos-binding), and the operator's re-read of one from GitHub.
  if (parts.join("/") === "admin/bindings") return m === "GET" ? json(await directory(env).bindings()) : err(405, "GET only");
  if (parts[0] === "admin" && parts[1] === "bindings" && parts.length === 3) {
    if (m !== "POST") return err(405, "POST only");
    if (!ID.project.test(parts[2]!)) return err(404, "unknown project");
    return rereadBinding(env, parts[2]!);
  }
  // The operator's choice of the repo a re-read showed beside the bound one: that id only.
  if (parts[0] === "admin" && parts[1] === "bindings" && parts.length === 4 && parts[3] === "bind") {
    if (m !== "POST") return err(405, "POST only");
    if (!ID.project.test(parts[2]!)) return err(404, "unknown project");
    const b = await body(req, BindRepo);
    return b.ok ? rereadBinding(env, parts[2]!, b.value.repo_id) : b.res;
  }

  // An agent's live trace, a WebSocket proxied to nest (src/trace.ts).
  if (parts[0] === "agents" && parts.length === 3 && parts[2] === "trace") return proxyTrace(req, env, parts[1]!, url);
  if (parts[0] === "agents" && parts.length === 4 && parts[2] === "trace" && parts[3] === "history") return proxyTraceHistory(req, env, parts[1]!, url);
  // The repos the owner may attach a new project to (README.md#repo-authority): those the App's installations
  // reach, as GitHub answers, each with the project already on it, if any.
  if (parts.join("/") === "repos") {
    if (m !== "GET") return err(405, "GET only");
    try {
      // The projects beside GitHub's answer; GitHub's failure is still the answer.
      const projects = early(directory(env).projects());
      const r = await attachableRepos(env);
      const byRepo = new Map((await projects).map((p) => [p.repo.toLowerCase(), p.id]));
      return json({ repos: r.repos.map((repo) => ({ repo, project: byRepo.get(repo) ?? null })), unlisted: r.unlisted, complete: r.complete, app: r.app });
    } catch (e) {
      return err(502, `GitHub couldn't say which repos the app's GitHub App reaches: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (parts[0] !== "projects") return err(404, "unknown route");
  if (parts.length === 1) {
    // Each with `needs_you`: how many things wait on the owner (README.md#blocked), or null when nest couldn't
    // be read for the agents' asks (README.md#asks).
    if (m === "GET") {
      const rows = await directory(env).projects();
      // The count is the length of the list "Needs you" shows: the app's own items (`localAttention`, the
      // reviews) and the project's asks, read once for every project. All read at once.
      const reading = rows.some((r) => r.state === "ready") ? askCounts(env) : new Map<string, number>();
      const owns = early(Promise.all(rows.map(async (r) => {
        if (r.state !== "ready") return null;
        const reviews = early(reviewItems(env, r.id));
        const local = (await project(env, r.id).localAttention()) as Result<unknown[]>;
        return (local.ok ? local.value.length : 0) + (await reviews).length;
      })));
      const asks = await reading;
      const own = await owns;
      return json({ projects: rows.map((r, i) => (r.state !== "ready" ? { ...r, needs_you: 0 } : { ...r, needs_you: asks === null ? null : own[i]! + (asks.get(r.id) ?? 0) })) });
    }
    if (m !== "POST") return err(405, "GET or POST");
    const b = await body(req, CreateProject);
    if (!b.ok) return b.res;
    // Only a repo the App reaches, as GitHub answers (README.md#repo-authority): a name outside its installations
    // (typed, or sent straight to the API) would make a project that can never attach, and holds its name.
    let ok: boolean;
    try {
      ok = await repoAttachable(env, b.value.repo);
    } catch (e) {
      return err(502, `GitHub couldn't say whether the app's GitHub App reaches ${b.value.repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok) return err(403, `the GitHub App doesn't reach ${b.value.repo}: install it on the repo's account (one the app acts for), with the repo among its installation's repos`);
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
    const settings = await answerSettings(env, p.id, await project(env, p.id).getSettings());
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
    : rest[0] === "reviewers" && rest.length === 2 ? `${m} reviewers/:reviewer`
    : rest[0] === "reviews" && rest.length === 4 && /^[1-9][0-9]{0,9}$/.test(rest[1]!) && /^[0-9a-f]{40}$/.test(rest[2]!) ? `${m} reviews/:pr/:sha/${rest[3]}`
    : rest[0] === "stops" && (rest.length === 2 || rest.length === 3) && /^agt_[A-Za-z0-9]{1,64}$/.test(rest[1]!) ? `${m} ${["stops", ":agent", ...rest.slice(2)].join("/")}`
    : `${m} ${rest.map((s) => (ID.task.test(s) ? ":task" : ID.ask.test(s) ? ":ask" : ID.routine.test(s) ? ":routine" : ID.run.test(s) ? ":run" : ID.proposal.test(s) ? ":proposal" : /^[1-9][0-9]{0,9}$/.test(s) ? ":n" : s)).join("/")}`;
  const task = rest[1] ?? "";
  const ask = rest[1] ?? "";

  switch (route) {
    case "GET ": {
      // Looking at the project reads the repo's auto-merge setting again (at most once a minute).
      const s = await answerSettings(env, pid, Promise.resolve(p.settingsLookedAt()));
      if (!s.ok) return done(s);
      return json({ ...row, settings: s.value });
    }
    case "GET settings":
      return done(await answerSettings(env, pid, Promise.resolve(p.getSettings())));
    case "PATCH settings": {
      const b = await body(req, SettingsBody);
      if (!b.ok) return b.res;
      const { max_concurrent_reviews, untrusted_reviews, ...rest } = b.value;
      // Workers editing CI workflows: the project's push token carries it when the GitHub App's installation grants
      // `workflows: write` (README.md#the-sandboxes-github-access); nest's grant decides it only for workers started on
      // nest's repos, within its `github_push.workflows` at each layer write. Not refused here either way.
      // All or nothing: ProjectDO's part first (its refusals, a GitHub lookup among them, come before it
      // writes anything), then ReviewDO's, only if that went through.
      const updated = await p.updateSettings(rest);
      if (!updated.ok) return done(updated);
      if (max_concurrent_reviews !== undefined) await review(env, pid).setMaxConcurrent(max_concurrent_reviews);
      if (untrusted_reviews !== undefined) await review(env, pid).setUntrustedPolicy(untrusted_reviews);
      return done(await answerSettings(env, pid, updated));
    }
    case "GET secrets": {
      // Metadata only: the app's, with nest's last injection and size; never a value.
      // nest's secrets and the workflow facts too, all read at once, each awaited where it was (so a refusal
      // of the project's secrets is still the answer).
      const nest = nestFrom(env);
      const listed = nest ? early(nest.listSecrets()) : null;
      const workflowWorkers = early(p.workflowWorkers());
      const workflowsRefused = early(p.workflowsRefused());
      const [mine, g, layers, legacy] = await Promise.all([p.secrets(), grantOf(env), p.network(), p.workersOnNestRepos()]);
      if (!mine.ok) return done(mine);
      // nest's grant bounds workflows only for a live worker on nest's repos (its push opt-in): with none, it bounds
      // nothing, whatever its `github_push` says (README.md#converging-onto-the-apps-own-access).
      if (g.ok && !legacy) g.value.workflows = true;
      let theirs: Map<string, { size: number; last_injected_ms: number | null }> = new Map();
      if (listed) {
        try {
          theirs = new Map((await listed).map((x) => [x.name, x]));
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
        workflow_workers: await workflowWorkers,
        // Why none may though the setting says so: the App's installation doesn't grant workflows: write.
        workflows_refused: await workflowsRefused,
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
      return done(await answerSettings(env, pid, await p.retryRepoAutoMerge()));
    case "POST comments-cleared/dismiss":
      // Needs you's notice that the default PR comments user was cleared (README.md#pr-comments), seen.
      return done(await p.dismissCommentsCleared());
    case "POST attach":
      return done(await answerSettings(env, pid, await p.retryAttach()));
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
      return done(await answerSettings(env, pid, await p.restartManager()));
    case "GET reviews":
      // With the release before's keys besides, for a page still running its bundle (README.md#built-the-review-pipeline).
      return json((await review(env, pid).jobs()).map((j) => ({ ...j, verdict: j.verdict && legacyView(j.verdict) })));
    // The review gate (README.md#the-review-gate): the owner approves a held review of one head commit, or dismisses it.
    case "POST reviews/:pr/:sha/approve":
      return done(await review(env, pid).approve(Number(rest[1]), rest[2]!));
    case "POST reviews/:pr/:sha/dismiss":
      return done(await review(env, pid).dismiss(Number(rest[1]), rest[2]!));
    // The project's reviewers (README.md#reviewers), ReviewDO's: the owner's writes, untainted.
    case "GET reviewers":
      return json(await review(env, pid).reviewers());
    case "POST reviewers": {
      // A preset alone, or every field (`toCreate`, as the manager's `create_reviewer` reads it).
      const b = await body(req, z.unknown());
      if (!b.ok) return b.res;
      const c = toCreate(b.value);
      return c.ok ? done(await review(env, pid).createReviewer(c.fields, { preset: c.preset }), 201) : err(400, c.error);
    }
    case "GET reviewers/:reviewer":
      return done(await review(env, pid).getReviewer(rest[1]!));
    case "PATCH reviewers/:reviewer": {
      const b = await body(req, UpdateReviewer);
      return b.ok ? done(await review(env, pid).updateReviewer(rest[1]!, b.value)) : b.res;
    }
    case "DELETE reviewers/:reviewer":
      return done(await review(env, pid).deleteReviewer(rest[1]!));
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
      // `?local=1`: the app's own items only, without reading nest (the page shows them while the asks load).
      if (url.searchParams.get("local") === "1") {
        const reviews = early(reviewItems(env, pid));
        const l = (await p.localAttention()) as Result<{ kind: string; at_ms: number }[]>;
        return l.ok ? json([...l.value, ...(await reviews)].sort((x, y) => x.at_ms - y.at_ms)) : err(l.status, l.error);
      }
      const a = await attentionOf(env, pid);
      return a.ok ? json(a.value) : err(a.status, a.error);
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
  // The grant and the manager's sandbox beside the rules (the rules' refusal is still the answer).
  const others = early(Promise.all([egressHostsOf(env), p.managerSandbox()]));
  const mine = have ? { ok: true as const, value: have } : await p.network();
  if (!mine.ok) return err(mine.status, mine.error);
  const [grant, sandbox] = await others;
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
