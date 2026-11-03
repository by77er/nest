// The projects app's API, served from fixtures: a demo project in every state only nest's events
// produce (stalled, in review, asks, blocked tasks, the manager's replies, reviews, a live trace).
// Made-up ids and repos only. `variant` is "demo", "long" (overlong names and titles), "empty" (no
// projects), "error" (the API fails), "rich" (a manager message with every kind of rich content),
// "chat-empty" or "chat-long" (thirty messages).

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
  // Review-only variants: a manager message with every kind of rich content, an empty chat, a long chat.
  const SVG = [
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="140" viewBox="0 0 420 140"><title>Search pipeline</title>',
    '<rect x="10" y="40" width="110" height="50" rx="6" fill="none" stroke="#333"/><text x="65" y="70" text-anchor="middle" font-family="sans-serif" font-size="14">Query</text>',
    '<line x1="120" y1="65" x2="160" y2="65" stroke="#333"/><polygon points="160,60 170,65 160,70" fill="#333"/>',
    '<rect x="170" y="40" width="110" height="50" rx="6" fill="#e7f0ff" stroke="#3b6fc0"/><text x="225" y="70" text-anchor="middle" font-family="sans-serif" font-size="14">Tag index</text>',
    '<line x1="280" y1="65" x2="300" y2="65" stroke="#333"/><polygon points="300,60 310,65 300,70" fill="#333"/>',
    '<rect x="310" y="40" width="100" height="50" rx="6" fill="none" stroke="#333"/><text x="360" y="70" text-anchor="middle" font-family="sans-serif" font-size="14">Results</text>',
    '</svg>',
    '```',
  ].join("\n");
  const RICH = [
    "## Search plan",
    "I split the search work into three tasks. task:tsk_demo7 is in review; [the flaky test](task:tsk_demo5) blocks the next release, and task:tsk_demo99 isn't on this board.",
    "### Where things stand",
    "```tasks\ntsk_demo7 — the parser and index\ntsk_demo5: needs a fixture bucket\ntsk_demo6\n```",
    "| Task | Estimate | Risk |\n|---|---:|---|\n| Tag index | 2 d | low |\n| Query parser | 3 d | medium |\n| Pagination | 1 d | low |",
    "The ranking is $s(t) = \\sum_{i=1}^{n} w_i \\cdot \\mathrm{tf}(t_i)$, and the cut-off:",
    "$$\nP(\\text{match}) = \\frac{e^{\\beta x}}{1 + e^{\\beta x}}, \\quad \\beta \\approx 0.8\n$$",
    "```ts\nexport async function searchByTag(tag: string, page = 0): Promise<Gadget[]> {\n  return db.query(\"select * from gadgets where tags @> $1 limit 50 offset $2\", [[tag], page * 50]);\n}\n```",
    SVG,
    "- [x] Spec the tag index\n- [ ] Decide prefix vs whole-word matching\n- [ ] Load-test on staging",
    "> The staging data has 40k gadgets; p95 is 180 ms today.",
    "See the [Postgres GIN docs](https://www.postgresql.org/docs/current/gin.html) and the mock-up: ![search mock-up](https://example.com/mockup.png)",
  ].join("\n\n");
  const chatFor = () => {
    if (variant === "chat-empty") return [];
    if (variant === "rich") return [chat[0], { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: RICH, delivered: true, error: null }];
    if (variant === "chat-long") {
      const out = [];
      for (let k = 0; k < 30; k++) {
        const owner = k % 2 === 0;
        out.push({ seq: k + 1, at_ms: now - (30 - k) * 600_000, sender: k === 13 ? "app" : owner ? "owner" : "manager",
          text: k === 13 ? "The manager restarted (upgrade)." : owner ? `Message ${k + 1}: what is the status of the ${["search", "export", "auth", "cache"][k % 4]} work? Keep it short, please.` : `Reply ${k + 1}: **${["search", "export", "auth", "cache"][k % 4]}** is moving. task:tsk_demo${(k % 8) + 1} is the one to watch; I'll report back when it lands, with the PR and the review's verdict.`,
          delivered: true, error: null });
      }
      return out;
    }
    return chat;
  };
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
  let seq = 0;
  const ev = (type, more = {}) => ({ seq: ++seq, ts_ms: now - 600_000 + seq * 9000, type, ...more });
  const trace = [
    ev("state", { state: "working", turn: "trn_1" }),
    ev("turn_started", { turn: "trn_1", input_kind: "user" }),
    ev("assistant_text", { turn: "trn_1", text: "Looking at how the gadget list is queried before I spec pagination." }),
    ev("tool_call", { turn: "trn_1", call_id: "toolu_1", name: "Bash", input: JSON.stringify({ command: "rg -n 'listGadgets' src" }) }),
    ev("tool_result", { turn: "trn_1", call_id: "toolu_1", is_error: false, summary: "src/routes/gadgets.ts:42: export async function listGadgets(" }),
    ev("tool_call", { turn: "trn_1", call_id: "toolu_2", name: "mcp__projects-board__write_spec", input: JSON.stringify({ task: "tsk_demo6" }) }),
    ev("tool_result", { turn: "trn_1", call_id: "toolu_2", is_error: false, summary: "ready" }),
    ev("turn_completed", { turn: "trn_1", stop_reason: "end_turn" }),
    { type: "live" },
  ];
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
    const routes = { "": demo, "/tasks": tasks, "/asks": asks, "/attention": attention, "/chat": chatFor(), "/reviews": reviews, "/manager": { phase: "running", agent: "agt_mgr7k2", state: "working", host: "bh_3f2a", error: null } };
    if (q in routes) return [200, routes[q]];
    if (q.startsWith("/tasks/")) return [200, detail];
    return [404, { error: "unknown route" }];
  };
  return { answer, trace };
}
