// The performance harness's API (perf.mjs): the projects app at a realistic size, generated in code from
// a seed, never checked in. Every answer's shape is the design review's demo fixture's
// (fixtures/projects/demo.mjs, which follows main): its objects are the templates, cloned and varied here;
// a route not generated here is answered by the demo fixture itself.
//
// Sizes: the open project has 300 tasks (60% done) and 200 chat messages (Markdown, code, math and task
// references, paged 50 at a time as the Worker pages them); 100 review jobs; 6 routines with 60 runs;
// 40 issues; 30 secrets; a network view with 24 rules per role. Every agent's trace has 2,000 events: 500 in
// history pages (5 pages of 100, for Load older), 1,000 in the ring sent on connecting (the backlog), and
// 500 streamed live on demand at `rate` events per second.
//
// `shape` is the API under test: "summary" (main since #308: the task list without bodies or specs) or
// "full" (before it: every task whole). `etag`: whether answers carry an ETag and honour If-None-Match
// with a 304 (since #307); a client that never sends If-None-Match gets 200s either way.

import { createHash } from "node:crypto";
import { data as demoData } from "./fixtures/projects/demo.mjs";

const DAY = 86_400_000;

/** A seeded PRNG (mulberry32): the same seed gives the same fixtures on every run. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
  };
}

const WORDS = "search index tag export csv cache thumbnail upload auth token session queue worker retry backoff parser schema migration release changelog pagination cursor filter sort locale timezone billing invoice webhook github review deploy staging metrics latency budget".split(" ");
const sentence = (r, n) => {
  const w = Array.from({ length: n }, () => r.pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(" ") + ".";
};
const title = (r) => {
  const verbs = ["Add", "Fix", "Speed up", "Paginate", "Refactor", "Test", "Document", "Drop", "Cache", "Retry"];
  return `${r.pick(verbs)} the ${r.pick(WORDS)} ${r.pick(WORDS)}${r.chance(0.3) ? ` for the ${r.pick(WORDS)} ${r.pick(WORDS)} page` : ""}`;
};

/** A task's description as the manager writes one: a paragraph, a heading, a list, sometimes code and a table (about 1-2 KB). */
const body = (r) =>
  [
    `${sentence(r, 18)} ${sentence(r, 14)} ${sentence(r, 22)}`,
    "## Scope",
    Array.from({ length: r.int(3, 6) }, (_, i) => `${i + 1}. ${sentence(r, r.int(6, 14))}`).join("\n"),
    r.chance(0.5) ? "```ts\nexport async function " + r.pick(WORDS) + "(id: string): Promise<void> {\n  await db.exec(\"update gadgets set tags = $1 where id = $2\", [tags, id]);\n}\n```" : sentence(r, 30),
    r.chance(0.4) ? "| Endpoint | p95 now | Target |\n|---|---|---|\n| `/api/" + r.pick(WORDS) + "` | 840 ms | 100 ms |\n| `/api/" + r.pick(WORDS) + "` | 310 ms | 80 ms |" : sentence(r, 16),
  ].join("\n\n");
const spec = (r) => ({
  goal: sentence(r, 20),
  acceptance_criteria: Array.from({ length: r.int(3, 7) }, () => sentence(r, r.int(10, 24))),
  files: Array.from({ length: r.int(1, 5) }, () => `src/${r.pick(WORDS)}/${r.pick(WORDS)}.ts`),
  test_plan: `${sentence(r, 25)} ${sentence(r, 15)}`,
});

/** A manager's reply: Markdown, with code, math and task references, cycling through kinds. */
function reply(r, k, taskIds) {
  const ref = () => `task:${r.pick(taskIds)}`;
  const kinds = [
    () => `**${r.pick(WORDS)}** is moving: ${ref()} is in review and ${ref()} is next. ${sentence(r, 16)}`,
    () => ["## Where things stand", `- ${ref()}: ${sentence(r, 8)}\n- ${ref()}: ${sentence(r, 9)}\n- ${ref()}: ${sentence(r, 7)}`, sentence(r, 20)].join("\n\n"),
    () => [sentence(r, 12), "```ts\n" + Array.from({ length: r.int(6, 18) }, (_, i) => `${i ? "  " : ""}const ${r.pick(WORDS)}${i} = await load("${r.pick(WORDS)}", { retry: ${i % 3}, limit: ${i * 10} });`).join("\n") + "\n```", `That fixes ${ref()}.`].join("\n\n"),
    () => [`The ranking is $s(t) = \\sum_{i=1}^{n} w_i \\cdot \\mathrm{tf}(t_i)$ for ${ref()}, with the cut-off:`, "$$\nP(\\text{match}) = \\frac{e^{\\beta x}}{1 + e^{\\beta x}}, \\quad \\beta \\approx 0.8\n$$", sentence(r, 14)].join("\n\n"),
    () => ["| Task | State | PR |\n|---|---|---:|\n" + Array.from({ length: 5 }, () => `| ${ref()} | ${r.pick(["ready", "in review", "done"])} | #${r.int(100, 400)} |`).join("\n"), `> ${sentence(r, 18)}`].join("\n\n"),
    () => `${sentence(r, 20)} ${sentence(r, 18)} See [the docs](https://docs.example.com/${r.pick(WORDS)}) and ${ref()}.`,
  ];
  return kinds[k % kinds.length]();
}

/** An agent's trace: 2,000 events, as nest serves them (history pages, the ring, the live stream). */
export function makeTrace(seed, now) {
  const r = rng(seed);
  const tools = ["Bash", "Read", "Grep", "Edit", "Write", "Glob", "mcp__projects-board__list_tasks", "mcp__projects-task__report_progress"];
  const input = (name) => {
    const f = `src/${r.pick(WORDS)}/${r.pick(WORDS)}.ts`;
    if (name === "Bash") return { command: `npm test -- ${r.pick(WORDS)} --reporter=verbose`, description: sentence(r, 4) };
    if (name === "Read" || name === "Write") return { file_path: f, ...(name === "Write" ? { content: Array.from({ length: r.int(5, 40) }, () => sentence(r, 8)).join("\n") } : {}) };
    if (name === "Edit") return { file_path: f, old_string: sentence(r, 6), new_string: sentence(r, 9) };
    if (name === "Grep" || name === "Glob") return { pattern: r.pick(WORDS), path: "src" };
    return { text: sentence(r, 10) };
  };
  const result = (name) => {
    const n = name === "Read" ? r.int(20, 80) : name === "Bash" ? r.int(3, 60) : r.int(1, 8);
    return Array.from({ length: n }, (_, i) => (name === "Read" ? `${String(i + 1).padStart(4)}  ${sentence(r, r.int(3, 10))}` : name === "Bash" ? ` PASS  test/${r.pick(WORDS)}.test.ts (${(r.next() * 3).toFixed(2)} s)` : `src/${r.pick(WORDS)}.ts:${r.int(1, 400)}: ${sentence(r, 5)}`)).join("\n");
  };
  // A turn's events, without seq/entry: started, prose, tool calls with results, prose, completed.
  let call = 0;
  const turn = (kind) => {
    const out = [{ type: "turn_started", input_kind: kind }, { type: "assistant_text", text: `${sentence(r, 18)} ${sentence(r, 12)}` }];
    for (let k = r.int(4, 12); k > 0; k--) {
      const name = r.pick(tools);
      const id = `toolu_${seed}_${++call}`;
      out.push({ type: "tool_call", call_id: id, name, input: JSON.stringify(input(name)) });
      out.push({ type: "tool_result", call_id: id, is_error: r.chance(0.08), summary: result(name) });
      if (r.chance(0.25)) out.push({ type: "assistant_text", text: r.chance(0.5) ? `${sentence(r, 14)}\n\n- ${sentence(r, 6)}\n- ${sentence(r, 7)}\n\n\`\`\`sh\nnpm run build && npm test\n\`\`\`` : sentence(r, 20) });
    }
    out.push({ type: "assistant_text", text: `${sentence(r, 16)} **${r.pick(WORDS)}** is done.` });
    out.push({ type: "turn_completed", stop_reason: "end_turn", usage: { input_tokens: r.int(5_000, 90_000), output_tokens: r.int(300, 6_000) } });
    return out;
  };
  const stream = (n, kind) => {
    const out = [];
    while (out.length < n) out.push(...turn(r.pick(kind)));
    return out.slice(0, n);
  };
  const t0 = now - 6 * 3_600_000;
  // History: 500 events, oldest first, in pages of 100 (c1 the oldest); `entry` numbers them.
  const older = stream(500, ["user", "inbox", "ask_answer"]).map((e, i) => ({ ts_ms: t0 + i * 20_000, entry: i, ...e }));
  const pages = {};
  for (let p = 0; p < 5; p++) pages[`c${p + 1}`] = { events: older.slice(p * 100, p * 100 + 100), next_before: p === 0 ? null : `c${p}` };
  // The ring (1,000) then the live stream (500): one sequence, so the stream continues the ring's last turn.
  let turnN = 0;
  let seq = 0;
  const numbered = stream(1_500, ["user", "inbox"]).map((e) => {
    if (e.type === "turn_started") turnN++;
    seq++;
    return { seq, ts_ms: now - 1_800_000 + seq * 1_000, turn: `trn_${seed}_${turnN}`, ...e };
  });
  const backlog = numbered.slice(0, 1_000);
  const live = numbered.slice(1_000);
  return { history: { offer: { type: "history", before: "c5" }, pages }, backlog, live };
}

/** What a project holds, generated. `big`: the open project's size; otherwise a smaller one (switching projects). */
function makeProject(id, name, seed, now, big, demo) {
  const r = rng(seed);
  const total = big ? 300 : 80;
  // 60% done; the rest in every other state.
  const mix = [["done", 0.6], ["cancelled", 0.05], ["draft", 0.07], ["ready", 0.08], ["assigned", 0.03], ["in_progress", 0.08], ["in_review", 0.06], ["stalled", 0.03]];
  const states = [];
  for (const [s, f] of mix) for (let k = Math.round(total * f); k > 0; k--) states.push(s);
  while (states.length < total) states.push("ready");
  states.length = total;
  // Templates by state: the demo fixture's task in that state (every field the API has).
  const byState = Object.fromEntries(demo.tasks.map((t) => [t.state, t]));
  const ids = Array.from({ length: total }, (_, i) => `tsk_${id.slice(4, 8)}${String(i + 1).padStart(4, "0")}`);
  const live = new Set(["assigned", "in_progress", "in_review"]);
  // Done first (oldest), then the rest, as a board that has run for weeks.
  const order = [...states.keys()].sort((a, b) => (states[a] === "done" ? 0 : 1) - (states[b] === "done" ? 0 : 1) || a - b);
  const tasks = order.map((k, i) => {
    const state = states[k];
    const tpl = byState[state] ?? byState.ready;
    const pr = ["in_review", "done"].includes(state) ? 100 + i : null;
    const created = now - (total - i) * 3 * 3_600_000;
    return {
      ...tpl,
      id: ids[i],
      title: title(r),
      body: state === "draft" && r.chance(0.5) ? "" : body(r),
      spec: state === "draft" ? null : spec(r),
      state,
      ord: i + 1,
      assignee: live.has(state) || state === "stalled" ? `agt_w${seed}${String(i).padStart(3, "0")}` : null,
      pr,
      start_error: state === "stalled" ? "nest refused the worker: max_agents reached (403)" : null,
      tainted: r.chance(0.1),
      blocked: null,
      prs: pr ? [{ ...(tpl.prs?.[0] ?? {}), pr, title: title(r), state: state === "done" ? "merged" : "open", repo: demo.repo }].map((p) => (tpl.prs?.[0] ? p : { pr, repo: demo.repo, title: p.title, state: p.state, attached_by: "worker", attached_ms: created, ended_ms: state === "done" ? created + DAY : null })) : [],
      blocked_by: [],
      blocks: [],
      waiting_on: [],
      issue: null,
      worker_live: live.has(state),
      created_ms: created,
      updated_ms: created + r.int(1, 48) * 3_600_000,
    };
  });
  // Some dependencies between open tasks.
  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.state));
  for (let k = 0; k < 20 && open.length > 2; k++) {
    const a = r.pick(open);
    const b = r.pick(open);
    if (a === b || a.blocked_by.includes(b.id)) continue;
    a.blocked_by.push(b.id);
    b.blocks.push(a.id);
  }
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  // A task's history, as the drawer reads it: created, the spec written (its copy), assignments, PRs, notes.
  const history = (t) => {
    const h = rng(seed * 10_000 + Number(t.id.slice(-4)));
    const rows = [{ at_ms: t.created_ms, actor: "agt_mgr7k2", action: "created", detail: JSON.stringify({ title: t.title, body: t.body }), tainted: false }];
    if (t.spec) for (let k = 0; k < 3; k++) rows.push({ at_ms: t.created_ms + (k + 1) * 60_000, actor: "agt_mgr7k2", action: k ? "body" : "spec", detail: JSON.stringify(k ? { body: t.body } : t.spec), tainted: false });
    for (let k = 0; k < 12; k++) rows.push({ at_ms: t.created_ms + (k + 5) * 600_000, actor: h.pick(["agt_mgr7k2", "app:auto-assign", "owner", t.assignee ?? "app"]), action: h.pick(["assign", "progress", "state", "note"]), detail: JSON.stringify({ text: sentence(h, h.int(8, 30)) }), tainted: false });
    return rows;
  };
  // Generated once per task, so an unchanged task answers the same (and its ETag holds).
  const histories = new Map();
  const detail = (tid) => {
    if (!byId[tid]) return null;
    if (!histories.has(tid)) histories.set(tid, history(byId[tid]));
    return { ...byId[tid], history: histories.get(tid) };
  };

  // 200 chat messages: the owner's questions, the manager's Markdown replies, a few of the app's notes.
  const chat = Array.from({ length: 200 }, (_, k) => {
    const sender = k % 17 === 9 ? "app" : k % 2 === 0 ? "owner" : "manager";
    const text = sender === "app" ? "The manager restarted (upgrade)." : sender === "owner" ? `${sentence(r, r.int(6, 20))} What about task:${r.pick(ids)}?` : reply(r, k, ids);
    return { seq: k + 1, at_ms: now - (200 - k) * 900_000, sender, text, delivered: true, status: "done", error: null };
  });

  // 100 review jobs (the demo's job shape), most done, with verdicts; one running (a reviewer's trace).
  const jobTpl = demo.reviews;
  const doneTpl = jobTpl.find((j) => j.state === "done" && j.verdict) ?? jobTpl[0];
  const reviews = Array.from({ length: 100 }, (_, k) => {
    const state = k === 0 ? "running" : k < 4 ? "queued" : k < 8 ? "held" : k < 10 ? "failed" : "done";
    const tpl = jobTpl.find((j) => j.state === state) ?? doneTpl;
    const pr = 400 - k;
    return { ...tpl, pr, sha: (pr * 7919).toString(16).padEnd(40, "a"), state, title: title(r), agent: state === "running" ? `agt_rv${seed}` : null, check_run: 5000 + pr, verdict: state === "done" ? doneTpl.verdict : null, created_ms: now - k * 3_600_000, updated_ms: now - k * 3_000_000 };
  });

  // Routines (the demo's) and 60 runs over them; the first running (a run's trace).
  const routinesAnswer = demo.routines;
  const rIds = routinesAnswer.routines.map((x) => x.id);
  const runTpl = demo.runs.find((x) => x.state !== "running" && x.summary) ?? demo.runs[0];
  const runs = Array.from({ length: 60 }, (_, k) => ({
    ...runTpl,
    id: `run_${seed}${String(k).padStart(4, "0")}`,
    routine: rIds[k % rIds.length],
    n: 60 - k,
    state: k === 0 ? "running" : "ended",
    outcome: k === 0 ? null : runTpl.outcome,
    agent: `agt_rn${seed}${k}`,
    summary: k === 0 ? null : [sentence(r, 30), `- ${sentence(r, 8)}\n- ${sentence(r, 10)}`, `Proposed: ${title(r)}.`].join("\n\n"),
    queued_ms: now - k * 6 * 3_600_000,
    started_ms: now - k * 6 * 3_600_000,
    ended_ms: k === 0 ? null : now - k * 6 * 3_600_000 + 9 * 60_000,
  }));

  // 40 issues (the demo's shape).
  const issueTpl = demo.issues[0];
  const issues = issueTpl ? Array.from({ length: 40 }, (_, k) => ({ ...issueTpl, number: 500 + k, title: title(r), body: sentence(r, r.int(20, 80)), opened_ms: now - k * DAY })) : [];

  // 30 secrets (the demo's shape).
  const secretsAnswer = { ...demo.secrets };
  const secretList = Object.entries(secretsAnswer).find(([, v]) => Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "name" in v[0]);
  if (secretList) {
    const [key, list] = secretList;
    secretsAnswer[key] = Array.from({ length: 30 }, (_, k) => ({ ...list[k % list.length], name: `${r.pick(WORDS).toUpperCase()}_${r.pick(WORDS).toUpperCase()}_${k}` }));
  }

  // The network view: the demo's, its role rules grown to 24 hosts each.
  const network = JSON.parse(JSON.stringify(demo.network));
  const grow = (o) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.length && typeof v[0] === "string" && /\./.test(v[0])) o[k] = Array.from({ length: 24 }, (_, i) => (i < v.length ? v[i] : `${r.pick(WORDS)}${i}.${r.pick(WORDS)}.example.com`));
      else if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && typeof v[0].host === "string") o[k] = Array.from({ length: 24 }, (_, i) => (i < v.length ? v[i] : { ...v[0], host: `${r.pick(WORDS)}${i}.${r.pick(WORDS)}.example.com` }));
      else grow(v);
    }
  };
  grow(network);

  return { id, name, tasks, byId, detail, chat, reviews, routinesAnswer, runs, issues, secrets: secretsAnswer, network };
}

/** The demo fixture's answers, used as templates (its project is `prj_demo`). */
function demoTemplates(now) {
  const { answer } = demoData("demo", now);
  const get = (p) => answer("GET", `/projects/prj_demo${p}`)[1];
  return {
    answer,
    project: get(""),
    tasks: get("/tasks"),
    reviews: get("/reviews"),
    routines: get("/routines"),
    runs: get("/routine-runs"),
    issues: get("/issues"),
    secrets: get("/secrets"),
    network: get("/network"),
    projects: answer("GET", "/projects")[1].projects,
    repo: get("").repo,
  };
}

const etagOf = (text) => `W/"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;

/**
 * The fixtures for one run. `answer(method, path, search, ifNoneMatch, body)` gives
 * `{ status, body (a string, or null for a 304), etag }`; `trace(agent)` an agent's trace.
 */
export function perfData({ seed = 1, shape = "summary", etag = true, now = Date.now() } = {}) {
  const demo = demoTemplates(now);
  const names = ["Gadgets", "Widgets", "Sprockets", "Cogs", "Gizmos", "Doohickeys"];
  const projectIds = ["prj_demo", "prj_other", "prj_sprk", "prj_cogs", "prj_gizm", "prj_dooh"];
  const cache = new Map();
  const project = (pid) => {
    if (!projectIds.includes(pid)) return null;
    if (!cache.has(pid)) {
      const i = projectIds.indexOf(pid);
      cache.set(pid, makeProject(pid, names[i], seed * 100 + i, now, pid === "prj_demo", demo));
    }
    return cache.get(pid);
  };
  const listed = projectIds.map((pid, i) => ({ ...(demo.projects.find((p) => p.id === pid) ?? demo.projects[1]), id: pid, name: names[i], repo: `by77er/${names[i].toLowerCase()}`, needs_you: i === 0 ? 4 : i % 2, state: "ready" }));
  const traces = new Map();
  const trace = (agent) => {
    if (!traces.has(agent)) traces.set(agent, makeTrace(seed * 1000 + traces.size + 1, now));
    return traces.get(agent);
  };
  const summary = ({ body: _b, spec: _s, ...t }) => t;

  /** The body for GET (or a write) on a path, or null when the demo fixture answers it. */
  const generated = (method, path, search, sent) => {
    if (path === "/projects" && method === "GET") return [200, { projects: listed }];
    const m = /^\/projects\/(prj_[a-z]+)(\/.*)?$/.exec(path);
    if (!m) return null;
    const p = project(m[1]);
    if (!p) return [404, { error: "unknown project" }];
    const q = m[2] ?? "";
    if (method === "GET") {
      if (q === "") return [200, { ...demo.project, id: p.id, name: p.name, repo: `by77er/${p.name.toLowerCase()}`, settings: { ...demo.project.settings, id: p.id, name: p.name } }];
      if (q === "/tasks") return [200, shape === "full" ? p.tasks : p.tasks.map(summary)];
      if (q.startsWith("/tasks/")) {
        const d = p.detail(q.split("/")[2]);
        return d ? [200, d] : [404, { error: "unknown task" }];
      }
      if (q === "/chat") {
        const before = search.get("before");
        const limit = Math.min(200, Number(search.get("limit")) || 50);
        const older = before === null ? p.chat : p.chat.filter((x) => x.seq < Number(before));
        return [200, older.slice(-limit)];
      }
      if (q === "/reviews") return [200, p.reviews];
      if (q === "/routines") return [200, p.routinesAnswer];
      if (q === "/routine-runs") return [200, p.runs];
      if (q === "/issues") return [200, p.issues];
      if (q === "/secrets") return [200, p.secrets];
      if (q === "/network") return [200, p.network];
    }
    // A row moved on the board: kept, so the next poll shows it where it was dropped.
    if (method === "PATCH" && /^\/tasks\/[^/]+$/.test(q) && typeof sent?.ord === "number") {
      const t = p.byId[q.split("/")[2]];
      if (!t) return [404, { error: "unknown task" }];
      t.ord = sent.ord;
      p.tasks.sort((a, b) => a.ord - b.ord);
      return [200, t];
    }
    if (method === "POST" && q === "/chat") {
      const seq = p.chat.length + 1;
      p.chat.push({ seq, at_ms: Date.now(), sender: "owner", text: String(sent?.text ?? ""), delivered: true, status: "done", error: null });
      return [200, { seq, delivered: true, status: "done" }];
    }
    // Everything else about another project: the demo project's answer, as if it were this one's.
    if (m[1] !== "prj_demo") return demo.answer(method, `/projects/prj_demo${q}`, search, sent);
    return null;
  };

  const answer = (method, path, search = new URLSearchParams(), ifNoneMatch = null, sent = null) => {
    const [status, value] = generated(method, path, search, sent) ?? demo.answer(method, path, search, sent);
    const text = JSON.stringify(value);
    if (!etag || method !== "GET" || status !== 200) return { status, body: text, etag: null };
    const tag = etagOf(text);
    const named = ifNoneMatch?.split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//, "") === tag.replace(/^W\//, ""));
    return named ? { status: 304, body: null, etag: tag } : { status, body: text, etag: tag };
  };

  return { answer, trace, project };
}
