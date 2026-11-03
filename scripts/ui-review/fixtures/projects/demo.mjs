// The projects app's API, served from fixtures: a demo project in every state only nest's events
// produce (stalled, in review, asks, blocked tasks, the manager's replies, reviews, a live trace).
// Made-up ids and repos only. `variant` is "demo", "long" (overlong names and titles), "empty" (no
// projects), "error" (the API fails) or "connecting" (a trace that sends nothing yet). Traces come from trace.mjs: history pages plus a live ring.

import { trace } from "./trace.mjs";

const DAY = 86_400_000;

export function data(variant = "demo", now = Date.now()) {
  const long = variant === "long";
  const name = long ? "Gadgets platform: the customer-facing catalogue, its search and the export pipeline" : "Gadgets";
  const repo = long ? "by77er/gadgets-platform-customer-facing-catalogue-and-search" : "by77er/gadgets";
  const spec = {
    goal: "Cache gadget thumbnails at the edge so the list renders in under 200 ms.",
    acceptance_criteria: ["Thumbnails are served from the cache after the first request", "A changed gadget's thumbnail is purged", "p95 list render under 200 ms on the staging data"],
    files: ["src/thumbs/cache.ts", "src/routes/gadgets.ts"],
    test_plan: "Unit tests for the purge; a load test against staging.",
  };
  let i = 0;
  const t = (title, state, o = {}) => ({ id: `tsk_demo${++i}`, title, body: "", spec: state === "draft" ? null : spec, state, ord: i, assignee: null, pr: null, start_error: null, tainted: false, created_ms: now - 7_200_000, updated_ms: now - 600_000, ...o });
  const tasks = [
    t("Support dark gadget skins", "draft"),
    t("Rate-limit the public API", "draft", { tainted: true }),
    t("Cache gadget thumbnails", "ready"),
    t("Export gadgets as CSV", "ready"),
    t(long ? "Fix the flaky upload test that fails only when the fixture bucket is in another region_and_named_without_any_spaces_at_all" : "Fix the flaky upload test", "in_progress", { assignee: "agt_w3f9q1" }),
    t("Paginate the gadget list", "assigned"),
    t("Add search by tag", "in_review", { assignee: "agt_w8x2m4", pr: 118, tainted: true }),
    t("Migrate to the new auth library", "stalled", { assignee: "agt_w1k7c2", start_error: "nest refused the worker: max_agents reached (403)" }),
    t("Write the 0.5 changelog", "done", { pr: 112 }),
    t("Drop the legacy XML export", "cancelled"),
  ];
  const asks = [
    { ask: "ask_A1", agent: "agt_w8x2m4", role: "worker", task: "tsk_demo7", question: "Push to by77er/gadgets: open PR #118?", approval: { name: "github.create_pr", tool: "brokered" }, at_ms: now - 120_000, answered_ms: null },
    { ask: "ask_A2", agent: "agt_mgr7k2", role: "manager", task: null, question: "Should search match tags by prefix or whole words only?", approval: null, at_ms: now - 60_000, answered_ms: null },
  ];
  const blocked = (task, title, by, role, mins, reason, question) => ({ kind: "blocked", task, title, state: "in_progress", at_ms: now - mins * 60_000, by, role, reason, question, tainted: false });
  const attention = [
    blocked("tsk_demo8", "Migrate to the new auth library", "agt_w1k7c2", "worker", 95, "The staging database rejects the new driver's TLS settings.", "Should I pin the old driver for staging?"),
    blocked("tsk_demo5", "Fix the flaky upload test", "agt_w3f9q1", "worker", 40, "The test needs a fixture bucket I can't create.", null),
    { kind: "ask", ...asks[0] },
    { kind: "ask", ...asks[1] },
    blocked("tsk_demo4", "Export gadgets as CSV", "agt_mgr7k2", "manager", 0.5, "Needs a product decision: which columns?", "Include prices?"),
  ].sort((a, b) => a.at_ms - b.at_ms);
  const chat = [
    { seq: 1, at_ms: now - 3_600_000, sender: "owner", text: "Plan the search work and split it into tasks.", delivered: true, error: null },
    { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: 'Done: "Add search by tag" is specced and assigned. I left "Export gadgets as CSV" ready for later.', delivered: true, error: null },
    { seq: 3, at_ms: now - 900_000, sender: "app", text: "The manager ended (exited).", delivered: true, error: null },
    { seq: 4, at_ms: now - 300_000, sender: "owner", text: "Can you also look at the auth migration? It stalled.", delivered: false, error: "nest answered 409: the agent has ended" },
  ];
  const detail = {
    ...tasks[6],
    history: [
      { at_ms: now - 7_200_000, actor: "agt_mgr7k2", action: "created", detail: JSON.stringify({ title: "Add search by tag" }), tainted: false },
      { at_ms: now - 7_000_000, actor: "agt_mgr7k2", action: "spec", detail: JSON.stringify(spec), tainted: false },
      { at_ms: now - 6_900_000, actor: "app:auto-assign", action: "assign", detail: null, tainted: false },
      { at_ms: now - 6_800_000, actor: "app:assign", action: "started", detail: JSON.stringify({ agent: "agt_w8x2m4" }), tainted: false },
      { at_ms: now - 3_000_000, actor: "agt_w8x2m4", action: "progress", detail: "Index built; wiring the query parser.", tainted: true },
      { at_ms: now - 1_200_000, actor: "agt_w8x2m4", action: "pr_opened", detail: JSON.stringify({ pr: 118 }), tainted: true },
    ],
  };
  const settings = {
    id: "prj_demo", name, repo, auto_assign: true, max_workers: 2, manager: "agt_mgr7k2", manager_error: null, created_ms: now - DAY * 3,
    attached: true, attach_error: null, attach: { branch: "main", change: "created", app_id: null, at_ms: now },
    auto_merge: true, merge_method: "squash", max_concurrent_reviews: null, repo_auto_merge: { state: "applied", want: true, repo: true, error: null, at_ms: now - 3_600_000 },
  };
  const demo = { id: "prj_demo", name, repo, created_ms: now - DAY * 3, settings };
  const other = { id: "prj_other", name: "Widgets", repo: "by77er/widgets", created_ms: now - DAY * 9 };
  const verdict = (ok) => ({ correctness: { verdict: "pass", notes: "Tests cover the parser." }, quality: { verdict: ok ? "pass" : "fail", notes: ok ? "Clear." : "The query builder repeats itself." }, architecture: { verdict: "pass", notes: "Fits the routes layer." }, summary: ok ? "Good to merge." : "One change needed." });
  const job = (pr, title, state, o = {}) => ({ pr, sha: (pr * 7919).toString(16).padEnd(40, "a"), state, title, base: "main", agent: state === "running" ? "agt_r9k2" : null, check_run: 1000 + pr, verdict: null, tainted: null, attempts: 0, runs: 1, error: null, created_ms: now - pr * 60_000, updated_ms: now - pr * 30_000, ...o });
  const reviews = [
    job(118, "Add search by tag", "running"),
    job(117, "Paginate the gadget list", "done", { verdict: verdict(true), tainted: true }),
    job(116, "Cache gadget thumbnails", "done", { verdict: verdict(false), tainted: true, runs: 2 }),
    job(115, "Rate-limit the public API", "failed", { error: "The reviewer exited three times without a verdict.", runs: 3 }),
    job(114, "Write the 0.5 changelog", "superseded"),
  ];
  // Every trace (the manager's, a worker's, a reviewer's): history offered and paged, then the live ring (trace.mjs).
  const { messages: allMessages, pages: historyPages } = trace(now);
  // "connecting": the trace's socket opens but nothing arrives yet (the log's loading state).
  const traceMessages = variant === "connecting" ? [] : allMessages;
  const projects = variant === "empty" ? [] : [{ id: demo.id, name, repo, created_ms: demo.created_ms, needs_you: attention.length }, { ...other, needs_you: 0 }];
  const sync = { written: ["capabilities/projects/board", "capabilities/projects/task", "templates/projects/manager", "templates/projects/worker"], repos: ["by77er/gadgets", "by77er/widgets"], at_ms: now - 3_600_000 };

  /** The answer to `GET|POST /api<path>`: [status, body]. */
  const answer = (method, path) => {
    if (variant === "error") return [500, { error: "internal error (fixture)" }];
    if (path === "/projects") return [200, { projects }];
    if (path === "/admin/sync-state") return [200, sync];
    if (path === "/admin/sync" && method === "POST") return [200, { written: sync.written.slice(0, 2), repos: ["by77er/gadgets"] }];
    if (!path.startsWith("/projects/prj_demo")) return [404, { error: "unknown project" }];
    const q = path.slice("/projects/prj_demo".length);
    const routes = { "": demo, "/tasks": tasks, "/asks": asks, "/attention": attention, "/chat": chat, "/reviews": reviews, "/manager": { phase: "running", agent: "agt_mgr7k2", state: "working", host: "bh_3f2a", error: null } };
    if (q in routes) return [200, routes[q]];
    // A task's detail: the demo's in-review task with its history, or any other with none (tsk_demo3 has no worker).
    if (q.startsWith("/tasks/")) {
      const task = tasks.find((x) => x.id === q.slice("/tasks/".length));
      return task && task.id !== detail.id ? [200, { ...task, history: [] }] : [200, detail];
    }
    return [404, { error: "unknown route" }];
  };
  return { answer, trace: traceMessages, history: historyPages };
}
