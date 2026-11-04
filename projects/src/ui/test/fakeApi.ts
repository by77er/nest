// A fake of the JSON API (src/api.ts) for component tests: the routes the page calls, answering with
// the Worker's shapes (typed by them) and applying the same state machine (src/tasks.ts), and a record
// of every write the page made.

import { type TaskEvent, transition } from "../../tasks";
import type { SecretRequest, SecretsAnswer } from "../api/types";
import type { Ask, Attention, OpenPr, ChatMessage, HistoryRow, Job, ManagerStatus, NetworkView, Project, ProjectRow, Settings, SyncState, Task, Waits } from "../api/types";

export interface Write {
  method: string;
  path: string;
  body: unknown;
}

const now = Date.UTC(2026, 10, 2, 9, 0, 0);

export function project(over: Partial<ProjectRow> = {}): Project {
  const row: ProjectRow = { id: "prj_one", name: "Widgets", repo: "owner/widgets", created_ms: now - 86_400_000, ...over };
  const settings: Settings = {
    id: row.id, name: row.name, repo: row.repo, auto_assign: false, max_workers: 2, manager: "agt_manager", manager_error: null,
    attached: true, attach_error: null, attach: { branch: "main", change: "created", app_id: null, at_ms: row.created_ms },
    auto_merge: false, merge_method: "squash", workers_edit_workflows: false, repo_auto_merge: { state: "none", want: false, repo: null, error: null, at_ms: null }, created_ms: row.created_ms,
  };
  return { ...row, settings };
}

let seq = 0;
export function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `tsk_t${seq}`, title: `Task ${seq}`, body: "", spec: null, state: "draft", ord: seq, assignee: null, pr: null, start_error: null, tainted: false, blocked: null,
    prs: [], blocked_by: [], blocks: [], waiting_on: [],
    created_ms: now - 3_600_000, updated_ms: now - 60_000, ...over,
  };
}

export function ask(over: Partial<Ask> = {}): Ask {
  seq += 1;
  return { ask: `ask_a${seq}`, agent: "agt_worker", role: "worker", task: null, question: null, approval: null, at_ms: now - 30_000, answered_ms: null, ...over };
}

export class FakeApi {
  projects: Project[] = [project()];
  tasks: Task[] = [];
  history = new Map<string, HistoryRow[]>();
  chat: ChatMessage[] = [];
  asks: Ask[] = [];
  sync: SyncState | null = null;
  reviews: Job[] = [];
  waits: Waits = { pending: [], recent: [] };
  workflowWorkers: string[] = [];
  /** `PUT network`'s answer instead of saving: a refusal (403 with `problems`, say). */
  networkRefusal: { status: number; body: unknown } | null = null;
  network: NetworkView = { rules: { worker: [], manager: [] }, rev: 0, agents: [], egress_hosts: ["registry.npmjs.org", "nodejs.org", "pypi.org", "files.pythonhosted.org"], base: [{ host: "github.com", ports: [443], source: "base" }, { host: "mirror.internal.example", ports: [8443], source: "operator" }, { host: "api.github.com", ports: [443], source: "repos" }] };
  openPrs: OpenPr[] = [];
  secrets: SecretsAnswer["secrets"] = [];
  grant: SecretsAnswer["grant"] = { inject_hosts: ["api.cloudflare.com", "registry.npmjs.org"], max_count: 10, max_bytes: 4096, workflows: true, used: 0 };
  secretRequests: SecretRequest[] = [];
  manager: ManagerStatus = { phase: "running", agent: "agt_manager", state: "idle", host: "bh_1", error: null };
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
    return this.route(method, url.pathname.replace(/^\/api/, "").split("/").filter(Boolean), body);
  };

  /** What the Worker's attention list answers: open asks and blocked tasks, oldest first. */
  /** A secrets change, like a network one, is owed to every live agent's layer (one revision for both). */
  layersOwed(): void {
    this.network = { ...this.network, rev: this.network.rev + 1, agents: this.network.agents.map((a) => ({ ...a, state: "pending" as const })) };
  }

  attention(): Attention[] {
    const asks = this.asks.filter((a) => a.answered_ms === null).map((a): Attention => ({ kind: "ask", ...a }));
    const blocked = this.tasks.filter((t) => t.blocked).map((t): Attention => ({ kind: "blocked", task: t.id, title: t.title, state: t.state, ...t.blocked! }));
    const secrets = this.secretRequests.map((r): Attention => ({ kind: "secret", ...r }));
    return [...asks, ...blocked, ...secrets].sort((a, b) => a.at_ms - b.at_ms);
  }

  private move(t: Task, event: TaskEvent): Response | null {
    const r = transition(t.state, event);
    if (!r.ok) return json({ error: r.error }, 409);
    t.state = r.to;
    return null;
  }

  private route(m: string, parts: string[], body: any): Response {
    if (parts[0] === "admin") {
      if (parts[1] === "sync-state") return json(this.sync);
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
    if (parts[2] === "secret-requests" && parts[4] === "done") {
      this.secretRequests = this.secretRequests.filter((r) => r.id !== parts[3]);
      return json({ done: parts[3] });
    }
    const route = `${m} ${parts.slice(2).map((s) => (/^tsk_/.test(s) ? ":task" : /^ask_/.test(s) ? ":ask" : /^\d+$/.test(s) ? ":n" : s)).join("/")}`;
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
      case "POST attach":
        this.manager = { ...this.manager, phase: "starting", error: null };
        return json(p.settings);
      case "GET waits":
        return json(this.waits);
      case "GET network":
        return json(this.network);
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
        const c: ChatMessage = { seq: this.chat.length + 1, at_ms: now, sender: "owner", text: body.text, delivered: true, error: null };
        this.chat.push(c);
        return json({ seq: c.seq, delivered: true }, 201);
      }
      case "GET asks":
        return json(this.asks);
      case "GET attention":
        return json(this.attention());
      case "POST asks/:ask/answer": {
        const a = this.asks.find((x) => x.ask === parts[3]);
        if (!a) return json({ error: "unknown ask" }, 404);
        a.answered_ms = now;
        return json({ delivered: true });
      }
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
      default:
        return json({ error: "unknown route" }, 404);
    }
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
