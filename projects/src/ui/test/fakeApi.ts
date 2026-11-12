// A fake of the JSON API (src/api.ts) for component tests: the routes the page calls, answering with
// the Worker's shapes (typed by them) and applying the same state machine (src/tasks.ts), and a record
// of every write the page made.

import { factsOf, step, type TaskEvent } from "../../tasks";
import type { AttachableRepos, Issue, SecretRequest, SecretsAnswer } from "../api/types";
import type { Ask, Attention, OpenPr, ChatMessage, HistoryRow, Job, ManagerStatus, NetworkView, Project, ProjectRow, Settings, SyncState, Task, Waits } from "../api/types";
import type { Note, Proposal, RepoBinding, RereadBinding, Routine, RoutineRun } from "../api/types";
import { PRESETS } from "../../routines";

export interface Write {
  method: string;
  path: string;
  body: unknown;
}

const now = Date.UTC(2026, 10, 2, 9, 0, 0);

export function project(over: Partial<ProjectRow> = {}): Project {
  const row: ProjectRow = { id: "prj_one", name: "Widgets", repo: "owner/widgets", created_ms: now - 86_400_000, state: "ready", ...over };
  const settings: Settings = {
    id: row.id, name: row.name, repo: row.repo, auto_assign: false, max_workers: 2, manager: "agt_manager", manager_error: null, manager_start_owed: false, manager_model: "claude-fable-5-2", worker_model: "claude-opus-5-5",
    attached: true, attach_error: null, attach: { branch: "main", change: "created", app_id: null, at_ms: row.created_ms },
    auto_merge: false, merge_method: "squash", workers_edit_workflows: false, comments_from: { id: 1001, login: "owner" }, repo_owner: { id: 1001, login: "owner" }, repo_auto_merge: { state: "none", want: false, repo: null, error: null, at_ms: null }, max_routine_runs: 1, issues_from: "trusted", issues_dropped: null, manager_switch: null, manager_switch_given_up: null, created_ms: row.created_ms,
  };
  return { ...row, settings };
}

let seq = 0;

/** A routine as the Worker answers it (README.md#routines). */
export function routine(over: Partial<Routine> = {}): Routine {
  seq += 1;
  return {
    id: `rtn_r${seq}`, name: `Routine ${seq}`, kind: "custom", prompt: "Look around.", enabled: true,
    triggers: { timer: null, tasks_done: null, prs_merged: null }, cooldown_min: 60, max_minutes: 30, max_turns: 3, proposals: "triage", preset: null,
    next_timer_ms: null, counts: { tasks_done: 0, prs_merged: 0 }, due: null, waiting: null, cooldown_until_ms: null, live_run: null, last_run: null, runs: 0,
    created_ms: now - 86_400_000, updated_ms: now - 86_400_000, ...over,
  };
}

export function run(over: Partial<RoutineRun> = {}): RoutineRun {
  seq += 1;
  return {
    id: `run_u${seq}`, routine: "rtn_r1", n: 1, trigger: "timer", count: null, state: "ended", outcome: "done", agent: `agt_run${seq}`, error: null, note: null,
    turns: 1, max_turns: 3, summary: null, created: [], queued_ms: now - 3_600_000, started_ms: now - 3_600_000, deadline_ms: now, ended_ms: now - 3_000_000, ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `tsk_t${seq}`, title: `Task ${seq}`, body: "", spec: null, state: "draft", ord: seq, assignee: null, pr: null, start_error: null, tainted: false, blocked: null,
    prs: [], blocked_by: [], blocks: [], waiting_on: [], issue: null, worker_live: ["assigned", "in_progress", "in_review"].includes(over.state ?? "draft"),
    created_ms: now - 3_600_000, updated_ms: now - 60_000, ...over,
  };
}

export function ask(over: Partial<Ask> = {}): Ask {
  seq += 1;
  return { ask: `ask_a${seq}`, agent: "agt_worker", role: "worker", task: null, question: null, approval: null, at_ms: now - 30_000, answered_ms: null, previous: false, ...over };
}

export class FakeApi {
  projects: Project[] = [project()];
  /** `GET /api/repos`'s answer; null: the Worker can't say (502), so the form takes a typed name. */
  attachable: AttachableRepos | null = null;
  tasks: Task[] = [];
  history = new Map<string, HistoryRow[]>();
  chat: ChatMessage[] = [];
  asks: Ask[] = [];
  sync: SyncState | null = null;
  /** Each project's repo binding (README.md#the-repos-binding). */
  bindings: RepoBinding[] = [];
  /** What the Worker's re-read answers for a binding: by default, GitHub's id as it is. */
  reread: (b: RepoBinding) => RereadBinding | { error: string; binding: RepoBinding } = (b) => ({ binding: b, changed: false, previous_id: b.repo_id, rename: null });
  /** What the Worker answers when the operator binds the repo a re-read showed (`repo_id`). */
  bindTo: (b: RepoBinding, repo_id: number) => RereadBinding | { error: string; binding: RepoBinding } = (b, repo_id) => {
    const after = { ...b, repo_id, bound: "github" as const, error: null };
    this.bindings = this.bindings.map((x) => (x.project === b.project ? after : x));
    return { binding: after, changed: true, previous_id: b.repo_id, rename: null };
  };
  reviews: Job[] = [];
  /** PRs past the review queue's limits, with no job yet. */
  reviewBacklog = 0;
  /** The default PR comments user cleared by a transfer (README.md#pr-comments), as Needs you lists it. */
  commentsCleared: Extract<Attention, { kind: "comments_cleared" }> | null = null;
  waits: Waits = { pending: [], recent: [] };
  workflowWorkers: string[] = [];
  /** `PUT network`'s answer instead of saving: a refusal (403 with `problems`, say). */
  networkRefusal: { status: number; body: unknown } | null = null;
  network: NetworkView = { rules: { worker: [], manager: [] }, rev: 0, agents: [], egress_hosts: ["registry.npmjs.org", "nodejs.org", "pypi.org", "files.pythonhosted.org"], base: [{ host: "github.com", ports: [443], source: "base" }, { host: "mirror.internal.example", ports: [8443], source: "operator" }, { host: "api.github.com", ports: [443], source: "repos" }], failed_stops: [] };
  openPrs: OpenPr[] = [];
  secrets: SecretsAnswer["secrets"] = [];
  grant: SecretsAnswer["grant"] = { inject_hosts: ["api.cloudflare.com", "registry.npmjs.org"], max_count: 10, max_bytes: 4096, workflows: true, used: 0 };
  secretRequests: SecretRequest[] = [];
  manager: ManagerStatus = { phase: "running", agent: "agt_manager", state: "idle", host: "bh_1", error: null };
  routines: Routine[] = [];
  runs: RoutineRun[] = [];
  proposals: Proposal[] = [];
  notes: Note[] = [];
  readonly writes: Write[] = [];
  /** Every GET's path, in order. */
  readonly reads: string[] = [];
  /** The request being answered (its query string). */
  private url: URL | null = null;
  interrupted = 0;
  /** Answers to give instead, by `METHOD path` pattern, once each. */
  readonly failures: { match: RegExp; status: number; error: string }[] = [];

  /** Answers held until `until` settles, by `METHOD path` pattern (a slow board, say). */
  readonly holds: { match: RegExp; until: Promise<unknown> }[] = [];

  fail(match: RegExp, status: number, error: string): void {
    this.failures.push({ match, status, error });
  }

  /** The next matching write is taken, but its answer is lost (a 502 instead), once. */
  loseAnswer(match: RegExp): void {
    this.lost.push(match);
  }
  private readonly lost: RegExp[] = [];
  /** The chat's request ids, as the Worker keeps them (README.md#outboxes). */
  private readonly chatRequests = new Map<string, ChatMessage>();

  /** The global fetch the page calls. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://projects.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") this.writes.push({ method, path: url.pathname, body });
    else this.reads.push(url.pathname);
    for (const h of this.holds) if (h.match.test(`${method} ${url.pathname}`)) await h.until;
    const f = this.failures.findIndex((x) => x.match.test(`${method} ${url.pathname}`));
    if (f >= 0) {
      const [x] = this.failures.splice(f, 1);
      return json({ error: x!.error }, x!.status);
    }
    this.url = url;
    const lose = this.lost.findIndex((x) => x.test(`${method} ${url.pathname}`));
    if (lose >= 0) {
      this.lost.splice(lose, 1);
      this.route(method, url.pathname.replace(/^\/api/, "").split("/").filter(Boolean), body);
      return json({ error: "Bad gateway" }, 502);
    }
    return this.route(method, url.pathname.replace(/^\/api/, "").split("/").filter(Boolean), body);
  };

  /** The repo's issues waiting for triage. */
  issues: Issue[] = [];
  /** What an import answers (README.md#triage): by default nothing new. */
  importAnswer: { imported: number; known: number; ignored: number; dropped: number } | null = null;
  /** What the Worker's attention list answers: open asks and blocked tasks, oldest first. */
  /** A secrets change, like a network one, is owed to every live agent's layer (one revision for both). */
  layersOwed(): void {
    this.network = { ...this.network, rev: this.network.rev + 1, agents: this.network.agents.map((a) => ({ ...a, state: "pending" as const })) };
  }

  attention(): Attention[] {
    const asks = this.asks.filter((a) => a.answered_ms === null).map((a): Attention => ({ kind: "ask", ...a }));
    const blocked = this.tasks.filter((t) => t.blocked).map((t): Attention => ({ kind: "blocked", task: t.id, title: t.title, state: t.state, ...t.blocked! }));
    const secrets = this.secretRequests.map((r): Attention => ({ kind: "secret", ...r }));
    const held = this.reviews.filter((j) => j.state === "held").map((j): Attention => ({ kind: "review", pr: j.pr, sha: j.sha, title: j.title, author: j.author, fork: j.fork, at_ms: j.created_ms }));
    const waiting = [...this.issues.map((i) => i.opened_ms), ...this.proposals.map((p) => p.created_ms)];
    const triage: Attention[] = waiting.length ? [{ kind: "triage", count: this.issues.length, proposals: this.proposals.length, at_ms: Math.min(...waiting) }] : [];
    const backlog: Attention[] = this.reviewBacklog ? [{ kind: "review_backlog", count: this.reviewBacklog, at_ms: Date.now() - 60_000 }] : [];
    return [...asks, ...blocked, ...secrets, ...held, ...backlog, ...triage, ...(this.commentsCleared ? [this.commentsCleared] : [])].sort((a, b) => a.at_ms - b.at_ms);
  }

  private move(t: Task, event: TaskEvent): Response | null {
    const r = step(factsOf(t), event);
    if (!r.ok) return json({ error: r.error }, 409);
    t.state = r.to;
    t.worker_live = r.facts.workerLive;
    return null;
  }

  private route(m: string, parts: string[], body: any): Response {
    if (parts[0] === "repos" && m === "GET") return this.attachable ? json(this.attachable) : json({ error: "nest couldn't say which repos the app may attach" }, 502);
    if (parts[0] === "admin") {
      if (parts[1] === "sync-state") return json(this.sync);
      if (parts[1] === "bindings" && !parts[2]) return json(this.bindings);
      if (parts[1] === "bindings" && parts[2]) {
        const b = this.bindings.find((x) => x.project === parts[2]);
        if (!b) return json({ error: "unknown project" }, 404);
        const r = parts[3] === "bind" ? this.bindTo(b, body.repo_id) : this.reread(b);
        return "error" in r ? json(r, 409) : json(r);
      }
      this.sync = { written: ["templates/projects/manager"], repos: this.projects.map((p) => p.repo), at_ms: now };
      return json({ written: this.sync.written, repos: this.sync.repos });
    }
    if (parts.length === 1) {
      if (m === "GET") return json({ projects: this.projects.map(({ settings: _s, ...row }) => ({ ...row, needs_you: row.id === "prj_one" ? this.attention().length : 0 })) });
      const p = project({ id: `prj_new${++seq}`, name: body.name, repo: body.repo.toLowerCase() });
      this.projects.push(p);
      return json({ ...p, catalog_synced: true }, 201);
    }
    const p = this.projects.find((x) => x.id === parts[1]);
    if (!p) return json({ error: "unknown project" }, 404);
    if (parts[2] === "secrets" && parts[3]) {
      const name = decodeURIComponent(parts[3]);
      if (m === "PUT") {
        const { value: _v, ...meta } = body;
        const had = this.secrets.find((x) => x.name === name);
        const row = { name, nest_name: had?.nest_name ?? `prj_one-${name}-abc123`, outside_hosts: [] as string[], size: _v ? new TextEncoder().encode(_v).length : had?.size ?? null, created_ms: had?.created_ms ?? now, updated_ms: now, holders: had?.holders ?? [], last_injected_ms: null, in_nest: true, ...meta };
        this.secrets = [...this.secrets.filter((x) => x.name !== name), row];
        this.layersOwed();
        return json(row);
      }
      if (m === "DELETE") {
        const had = this.secrets.find((x) => x.name === name);
        this.secrets = this.secrets.filter((x) => x.name !== name);
        this.layersOwed();
        return json({ deleted: name, holders: had?.holders ?? [] });
      }
    }
    if (parts[2] === "reviews" && (parts[5] === "approve" || parts[5] === "dismiss") && m === "POST") {
      const j = this.reviews.find((r) => String(r.pr) === parts[3] && r.sha === parts[4]);
      if (!j) return json({ error: "no review for that PR and commit" }, 404);
      j.state = parts[5] === "approve" ? "queued" : "dismissed";
      return json(j);
    }
    if (parts[2] === "secret-requests" && parts[4] === "done") {
      this.secretRequests = this.secretRequests.filter((r) => r.id !== parts[3]);
      return json({ done: parts[3] });
    }
    if (parts[2] === "memory" && parts[3] && m === "DELETE") {
      const key = decodeURIComponent(parts[3]);
      this.notes = this.notes.filter((n) => n.key !== key);
      return json({ deleted: key });
    }
    const route = `${m} ${parts.slice(2).map((s) => (/^tsk_/.test(s) ? ":task" : /^ask_/.test(s) ? ":ask" : /^rtn_/.test(s) ? ":routine" : /^run_/.test(s) ? ":run" : /^prp_/.test(s) ? ":proposal" : /^agt_/.test(s) ? ":agent" : /^\d+$/.test(s) ? ":n" : s)).join("/")}`;
    const rt = this.routines.find((x) => x.id === parts[3]);
    const t = this.tasks.find((x) => x.id === parts[3]);
    switch (route) {
      case "GET ":
        return json(p);
      case "PATCH settings":
        Object.assign(p.settings, body);
        return json(p.settings);
      case "POST auto-merge/retry":
        p.settings.repo_auto_merge = { state: "applied", want: p.settings.auto_merge, repo: p.settings.auto_merge, error: null, at_ms: now };
        return json(p.settings);
      case "GET tasks":
        return json([...this.tasks].sort((a, b) => a.ord - b.ord));
      case "POST tasks": {
        const n = task({ title: body.title, body: body.body ?? "", ord: Math.max(0, ...this.tasks.map((x) => x.ord)) + 1 });
        this.tasks.push(n);
        return json(n, 201);
      }
      case "GET manager":
        return json(this.manager);
      case "POST comments-cleared/dismiss":
        this.commentsCleared = null;
        return json({ dismissed: true });
      case "POST attach":
        this.manager = { ...this.manager, phase: "starting", error: null };
        return json(p.settings);
      case "POST manager/restart":
        this.manager = { ...this.manager, phase: "starting", agent: null, state: null, host: null, error: null };
        return json(p.settings);
      case "GET waits":
        return json(this.waits);
      case "GET network":
        return json(this.network);
      case "POST stops/:agent/retry":
      case "DELETE stops/:agent": {
        const agent = parts[3]!;
        if (!this.network.failed_stops.some((f) => f.agent === agent)) return json({ error: "no failed stop" }, 409);
        this.network = { ...this.network, failed_stops: this.network.failed_stops.filter((f) => f.agent !== agent) };
        return json(m === "DELETE" ? { dismissed: agent } : { agent, state: "done" });
      }
      case "PUT network":
        if (this.networkRefusal) return json(this.networkRefusal.body, this.networkRefusal.status);
        this.network = { ...this.network, rules: body, rev: this.network.rev + 1, agents: this.network.agents.map((a) => ({ ...a, state: "pending" as const })) };
        return json(this.network);
      case "GET reviews":
        return json(this.reviews);
      case "GET secrets":
        return json({ secrets: this.secrets, grant: this.grant, client: "cli_app", agents: this.network.agents, workflow_workers: this.workflowWorkers });
      case "GET prs/open":
        return json(this.openPrs);
      case "GET chat": {
        // Pages as the Worker answers them: the latest 50, or the 50 before `before`.
        const before = this.url?.searchParams.get("before");
        const rows = before ? this.chat.filter((m) => m.seq < Number(before)) : this.chat;
        return json(rows.slice(-50));
      }
      case "POST manager/interrupt":
        this.interrupted += 1;
        return json({ interrupted: "turn" });
      case "POST chat": {
        // As the Worker: a request id seen before is the same message.
        const had = body.request_id ? this.chatRequests.get(body.request_id) : undefined;
        const c: ChatMessage = had ?? { seq: this.chat.length + 1, at_ms: now, sender: "owner", text: body.text, delivered: true, status: "done", error: null };
        if (!had) {
          this.chat.push(c);
          if (body.request_id) this.chatRequests.set(body.request_id, c);
        }
        return json({ seq: c.seq, delivered: true, status: "done" }, 201);
      }
      case "POST chat/:n/retry": {
        const c = this.chat.find((m) => m.seq === Number(parts[3]));
        if (!c) return json({ error: "no such message" }, 404);
        if (c.status === "failed") Object.assign(c, { status: "done", delivered: true, error: null });
        return json({ seq: c.seq, delivered: c.delivered, status: c.status });
      }
      case "GET asks":
        return json(this.asks);
      case "GET attention":
        return json(this.attention());
      // Triage (README.md#triage).
      case "GET issues":
        return json(this.issues);
      case "POST issues/:n/accept": {
        const n = Number(parts[3]);
        const i = this.issues.find((x) => x.number === n);
        if (!i) return json({ error: `no issue #${n} in triage` }, 404);
        if (body?.updated_ms !== i.updated_ms) return json({ error: `issue #${n} changed since it was read: read it again` }, 409);
        this.issues = this.issues.filter((x) => x.number !== n);
        const t = { ...task(), id: `tsk_from${n}`, title: i.title, body: `${i.body}\n\nFrom issue #${n}: ${i.url}`, state: "draft" as const, tainted: true, issue: { number: n, close: null, error: null } };
        this.tasks = [...this.tasks, t];
        return json(t);
      }
      case "POST issues/:n/decline": {
        const n = Number(parts[3]);
        this.issues = this.issues.filter((x) => x.number !== n);
        return json({ declined: n });
      }
      case "POST issues/import":
        return json(this.importAnswer ?? { imported: 0, known: this.issues.length, ignored: 0, dropped: 0 });
      case "POST asks/:ask/answer": {
        const a = this.asks.find((x) => x.ask === parts[3]);
        if (!a) return json({ error: "unknown ask" }, 404);
        a.answered_ms = now;
        return json({ delivered: true });
      }
      case "GET routines":
        return json({ routines: this.routines, max_routine_runs: p.settings.max_routine_runs, live: this.routines.filter((r) => r.live_run).length });
      case "POST routines": {
        const r = routine("preset" in body ? { ...PRESETS[body.preset as "review" | "dreaming"], preset: body.preset } : body);
        this.routines.push(r);
        return json(r, 201);
      }
      case "PATCH routines/:routine": {
        if (!rt) return json({ error: "unknown routine" }, 404);
        Object.assign(rt, body);
        return json(rt);
      }
      case "DELETE routines/:routine":
        this.routines = this.routines.filter((r) => r.id !== parts[3]);
        return json({ deleted: parts[3] });
      case "POST routines/:routine/run": {
        if (!rt) return json({ error: "unknown routine" }, 404);
        if (rt.live_run) return json({ error: "the routine has a run going already" }, 409);
        const r = run({ routine: rt.id, trigger: "manual", state: "running", outcome: null, ended_ms: null, n: rt.runs + 1 });
        rt.live_run = r;
        this.runs.unshift(r);
        return json(rt);
      }
      case "GET routine-runs":
        return json(this.runs);
      case "POST routine-runs/:run/stop": {
        const r = this.runs.find((x) => x.id === parts[3]);
        if (!r) return json({ error: "unknown run" }, 404);
        Object.assign(r, { state: "ended", outcome: "stopped", ended_ms: now });
        return json(r);
      }
      case "GET proposals":
        return json(this.proposals);
      case "POST proposals/:proposal/accept": {
        const pr = this.proposals.find((x) => x.id === parts[3]);
        if (!pr) return json({ error: "unknown proposal" }, 404);
        this.proposals = this.proposals.filter((x) => x !== pr);
        const nt = task({ title: pr.title, body: pr.body, tainted: true });
        this.tasks.push(nt);
        return json(nt);
      }
      case "POST proposals/:proposal/decline":
        this.proposals = this.proposals.filter((x) => x.id !== parts[3]);
        return json({ declined: parts[3] });
      case "GET memory":
        return json(this.notes);
    }
    if (!t) return json({ error: "unknown task" }, 404);
    switch (route) {
      case "GET tasks/:task":
        return json({ ...t, history: this.history.get(t.id) ?? [] });
      case "PATCH tasks/:task":
        Object.assign(t, body);
        return json(t);
      case "POST tasks/:task/prs": {
        const n = typeof body.pr === "number" ? body.pr : Number(String(body.pr).replace(/^#/, "").replace(/^.*\/pull\//, ""));
        if (!n) return json({ error: "pr: a PR number, #<n>, or its URL" }, 400);
        t.prs = [...t.prs, { number: n, state: "open", title: null, fork: false, attached_by: "owner", attached_ms: now, auto_merge: null }];
        t.pr = t.prs[0]!.number;
        return json(t);
      }
      case "DELETE tasks/:task/prs/:n":
        t.prs = t.prs.filter((p) => p.number !== Number(parts[5]));
        t.pr = t.prs[0]?.number ?? null;
        return json(t);
      case "POST tasks/:task/dependencies": {
        const b = this.tasks.find((x) => x.id === body.blocked_by);
        if (!b) return json({ error: `unknown task ${body.blocked_by}` }, 404);
        t.blocked_by = [...t.blocked_by, { id: b.id, title: b.title, state: b.state }];
        t.waiting_on = t.blocked_by.filter((x) => x.state !== "done").map((x) => x.id);
        return json(t);
      }
      case "DELETE tasks/:task/dependencies/:task":
        t.blocked_by = t.blocked_by.filter((x) => x.id !== parts[5]);
        t.waiting_on = t.blocked_by.filter((x) => x.state !== "done").map((x) => x.id);
        return json(t);
      case "POST tasks/:task/answer":
        if (!t.blocked) return json({ error: "the task isn't blocked" }, 409);
        t.blocked = null;
        return json(t);
      case "DELETE tasks/:task":
        if (t.state !== "draft") return json({ error: "only a draft is deleted; cancel it instead" }, 409);
        this.tasks = this.tasks.filter((x) => x !== t);
        return json({ deleted: t.id });
      case "POST tasks/:task/assign":
        return this.move(t, "assign") ?? json(t);
      case "POST tasks/:task/cancel":
        return this.move(t, "cancel") ?? json(t);
      case "POST tasks/:task/done":
        return this.move(t, "done") ?? json(t);
      case "POST tasks/:task/issue/close":
        if (t.issue?.close !== "failed") return json({ error: "nothing to retry" }, 409);
        t.issue = { ...t.issue, close: "owed", error: null };
        return json(t);
      default:
        return json({ error: "unknown route" }, 404);
    }
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
