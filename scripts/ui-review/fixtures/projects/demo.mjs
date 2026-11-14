// The projects app's API, served from fixtures: a demo project in every state only nest's events
// produce (stalled, in review, asks, blocked tasks, the manager's replies, reviews, a live trace),
// with tasks' attached PRs (open, merged, a fork's, one closed and detached) and their dependencies
// (a task waiting on two of three, one waited on by two, one whose blockers are all done).
// Made-up ids and repos only. `variant` is "demo", "long" (overlong names and titles), "empty" (no
// projects), "error" (the API fails), "connecting" (a trace that sends nothing yet), "rich" (a manager
// message with every kind of rich content), "chat-empty", "chat-sending" (the owner's messages still being sent), "chat-long" (thirty messages), "chat-paged"
// (120, paged by `before`) "chat-arriving" (a reply lands a few seconds in), "secrets-empty" (no secrets or live agents), "stops-failed" / "stops-long" (agents nest refused to stop; long titles and errors), "manager-ended" (past its automatic restarts), "creating" (a project still being created), "models-custom" (a custom model id for the workers), "workflows-refused" (workers may change workflows, which the App's installation doesn't grant),
// "board-many" (forty more tasks in every state, long titles), "board-empty" (a project with no tasks),
// "chat-code" (a reply with every syntax token), "chat-heavy" (a reply with a 60-line code block and a ten-column table), "turn-busy" (the live turn
// a dozen tool calls in), "secret-requests" (agents asking for credentials, one tainted), or "comments-set" / "comments-id-only" (whose
// PR comments reach workers: a user with a login, or by id only; nobody otherwise), "triage-empty" (no
// issues or proposals waiting) / "proposals-only" (no issues, two routines' proposals) / "issues-anyone" (issues from
// anyone) / "triage-dropped" (issues the cap on waiting ones left out) / "issues-no-one" (an org's repo, no comments user:
// no one's issues come in) / "held-reviews" and "held-many" (reviews waiting for the owner's approval: two, or a dozen with long titles and logins) / "reviews-open" (the review gate turned off) / "triage-long" (24 issues, long titles, bodies and logins), or "routines-empty" (no
// routines, runs, proposals or notes) / "routines-long" (many and long runs, proposals and notes). Traces come from
// trace.mjs: history pages plus a live ring, its turn still running (the chat's stream and Stop).

import { PLAN_REPLY, trace } from "./trace.mjs";

const DAY = 86_400_000;

export function data(variant = "demo", now = Date.now()) {
  const born = Date.now();
  const long = variant === "long";
  const name = long ? "Gadgets platform: the customer-facing catalogue, its search and the export pipeline" : "Gadgets";
  const repo = long ? "by77er/gadgets-platform-customer-facing-catalogue-and-search" : "by77er/gadgets";
  const spec = {
    goal: "Cache gadget thumbnails at the edge so the list renders in under 200 ms.",
    acceptance_criteria: ["Thumbnails are served from the cache after the first request", "A changed gadget's thumbnail is purged", "p95 list render under 200 ms on the staging data"],
    files: ["src/thumbs/cache.ts", "src/routes/gadgets.ts"],
    test_plan: "Unit tests for the purge; a load test against staging.",
  };
  // A description as the manager writes one (Markdown): a heading, nested and task lists, code, a link,
  // and a table, which the editor keeps as written.
  const SEARCH_BODY = [
    "Owners filter the gadget list by tag today by scrolling. Add a tag search to the list's filter bar, backed by an index, so a search answers in under 100 ms on the staging data.",
    "## Scope",
    "1. An index of tags per gadget\n   - rebuilt on each gadget write\n   - backfilled once for existing gadgets\n2. The query parser: `tag:outdoor tag:waterproof`, with `-tag:` to exclude\n3. Suggestions in the filter bar as you type",
    "- [x] Agree the query syntax with design\n- [ ] Load test against staging\n- [ ] Note the new endpoint in the [API docs](https://docs.example.com/api)",
    "```ts\nGET /api/gadgets?tag=outdoor&tag=waterproof&limit=200\n```",
    "| Endpoint | p95 now | Target |\n|---|---|---|\n| `/api/gadgets?tag=` | 840 ms | 100 ms |",
  ].join("\n\n");
  let i = 0;
  const t = (title, state, o = {}) => ({ id: `tsk_demo${++i}`, title, body: "", spec: state === "draft" ? null : spec, state, ord: i, assignee: null, pr: null, start_error: null, tainted: false, blocked: null, prs: [], blocked_by: [], blocks: [], waiting_on: [], issue: null, worker_live: ["assigned", "in_progress", "in_review"].includes(state), created_ms: now - 7_200_000, updated_ms: now - 600_000, ...o });
  const tasks = [
    t("Support dark gadget skins", "draft"),
    t("Rate-limit the public API", "draft", { tainted: true }),
    t("Cache gadget thumbnails", "ready"),
    t("Export gadgets as CSV", "ready"),
    t(long ? "Fix the flaky upload test that fails only when the fixture bucket is in another region_and_named_without_any_spaces_at_all" : "Fix the flaky upload test", "in_progress", { assignee: "agt_w3f9q1" }),
    t("Paginate the gadget list", "assigned"),
    t("Add search by tag", "in_review", { assignee: "agt_w8x2m4", pr: 118, tainted: true, body: SEARCH_BODY }),
    t("Migrate to the new auth library", "stalled", { assignee: "agt_w1k7c2", start_error: "nest refused the worker: max_agents reached (403)" }),
    // Made of an issue whose close GitHub refused (README.md#triage).
    t("Write the 0.5 changelog", "done", { pr: 112, issue: { number: 38, close: "failed", error: "nest 403: issues: write is outside the grant" } }),
    t("Drop the legacy XML export", "cancelled"),
  ];
  // "board-many": a long board, every state several times over, long titles, workers and PRs.
  if (variant === "board-many") {
    const states = ["draft", "ready", "assigned", "in_progress", "in_review", "stalled", "done", "cancelled"];
    const subjects = ["the tag index", "the CSV export", "thumbnail caching at the edge", "the auth library migration", "pagination with cursors", "the public API's rate limits", "dark skins", "search suggestions in the filter bar", "the changelog"];
    for (let k = 0; k < 40; k++) {
      const state = states[k % states.length];
      const long = k % 3 === 0;
      const title = `${["Rework", "Test", "Document", "Speed up", "Fix"][k % 5]} ${subjects[k % subjects.length]}${long ? ", including the migration for existing gadgets and a note in the API docs for integrators" : ""}`;
      const working = ["assigned", "in_progress", "in_review", "stalled", "done"].includes(state);
      tasks.push(t(title, state, { assignee: working ? `agt_w${(k * 7919).toString(36).slice(0, 4)}` : null, pr: ["in_review", "done"].includes(state) ? 200 + k : null, updated_ms: now - k * 3_600_000 * 5 }));
      const last = tasks.at(-1);
      if (last.pr) last.prs = [{ number: last.pr, state: state === "done" ? "merged" : "open", title, fork: false, attached_by: "app:branch", attached_ms: now - k * 60_000, auto_merge: null }];
    }
  }
  const byId = Object.fromEntries(tasks.map((x) => [x.id, x]));
  // Blocked flags, as "Needs you" lists them.
  const flag = (id, by, role, mins, reason, question) => (byId[id].blocked = { at_ms: now - mins * 60_000, by, role, reason, question, tainted: false });
  flag("tsk_demo8", "agt_w1k7c2", "worker", 95, "The staging database rejects the new driver's TLS settings.", "Should I pin the old driver for staging?");
  flag("tsk_demo5", "agt_w3f9q1", "worker", 40, "The test needs a fixture bucket I can't create.", null);
  flag("tsk_demo4", "agt_mgr7k2", "manager", 0.5, "Needs a product decision: which columns?", "Include prices?");
  // Attached PRs: the in-review task has four (open and reviewing, open with changes needed and a failed
  // auto-merge, merged, a fork's); the done one its merged PR.
  const am = (state, o = {}) => ({ state, method: state === "enabled" ? "squash" : null, error: null, at_ms: now - 900_000, ...o });
  const pr = (number, state, title, o = {}) => ({ number, state, title, fork: false, attached_by: "app:branch", attached_ms: now - number * 20_000, auto_merge: null, ...o });
  byId.tsk_demo7.prs = [
    pr(118, "open", long ? "Add search by tag: the index, the query parser, the tag suggestions and the migration for existing gadgets" : "Add search by tag", { auto_merge: am("enabled") }),
    pr(119, "merged", "Search: build the tag index", { attached_by: "agt_mgr7k2", auto_merge: am("enabled") }),
    pr(121, "open", "Search: tag suggestions in the filter bar", { attached_by: "owner", auto_merge: am("failed", { error: "GitHub refused: the base branch requires a linear history" }) }),
    pr(124, "open", "Tag search for nested categories", { fork: true, attached_by: "owner" }),
  ];
  byId.tsk_demo7.pr = 118;
  byId.tsk_demo9.prs = [pr(112, "merged", "Changelog for 0.5", { auto_merge: am("enabled") })];
  // Review-only (the task machine): a stalled task and a ready one, each holding an open PR.
  if (variant === "machine") {
    byId.tsk_demo8.prs = [pr(130, "open", "Auth: switch to the new library behind a flag", { auto_merge: am("enabled") })];
    byId.tsk_demo8.pr = 130;
    byId.tsk_demo3.prs = [pr(129, "closed", "Thumbnails: cache in R2", { attached_by: "agt_w3f9q1" }), pr(131, "open", "Thumbnails: cache in R2, take two", { attached_by: "owner" })];
    byId.tsk_demo3.pr = 131;
  }
  // Dependencies: the CSV export waits on two of three (thumbnails ready, search in review, the
  // changelog done); dark skins wait on the thumbnails; pagination's only blocker is done.
  const deps = { tsk_demo4: ["tsk_demo3", "tsk_demo7", "tsk_demo9"], tsk_demo1: ["tsk_demo3"], tsk_demo6: ["tsk_demo9"] };
  const ref = (id) => ({ id, title: byId[id].title, state: byId[id].state });
  for (const [id, on] of Object.entries(deps)) {
    byId[id].blocked_by = on.map(ref);
    byId[id].waiting_on = on.filter((b) => byId[b].state !== "done");
    for (const b of on) byId[b].blocks.push(ref(id));
  }
  const openPrs = [
    { number: 118, title: byId.tsk_demo7.prs[0].title, head: "task/tsk_demo7", fork: false, task: "tsk_demo7" },
    { number: 121, title: "Search: tag suggestions in the filter bar", head: "search-suggest", fork: false, task: "tsk_demo7" },
    { number: 124, title: "Tag search for nested categories", head: "nested-tags", fork: true, task: "tsk_demo7" },
    { number: 125, title: "Paginate with cursors, not offsets", head: "task/tsk_demo6", fork: false, task: "tsk_demo6" },
    { number: 126, title: "Bump vite to 7.1", head: "deps/vite", fork: false, task: null },
    { number: 127, title: "Thumbnail cache: purge on update", head: "thumbs-purge", fork: false, task: null },
    { number: 128, title: "Docs: the export formats", head: "docs-export", fork: true, task: null },
  ];
  const asks = [
    { ask: "ask_A1", agent: "agt_w8x2m4", role: "worker", task: "tsk_demo7", question: "Push to by77er/gadgets: open PR #118?", approval: { name: "github.create_pr", tool: "brokered" }, at_ms: now - 120_000 },
    { ask: "ask_A2", agent: "agt_mgr7k2", role: "manager", task: null, question: "Should search match tags by prefix or whole words only?", approval: null, at_ms: now - 60_000 },
  ];
  const blocked = (task, title, by, role, mins, reason, question) => ({ kind: "blocked", task, title, state: "in_progress", at_ms: now - mins * 60_000, by, role, reason, question, tainted: false });
  // The repo's issues waiting for triage (README.md#triage): anyone's text, one with markup that must show as text.
  const longBody = Array.from({ length: 40 }, (_, k) => `Paragraph ${k + 1}: when the gadget list has more than 10000 items the search box stalls; https://example.com/a/very/long/url/without/any/breaks/at/all/${"x".repeat(80)} and more words to wrap.`).join("\n\n");
  const issues = variant === "triage-empty" || variant === "proposals-only" ? [] : variant === "triage-long" ? Array.from({ length: 24 }, (_, k) => ({ number: 100 + k, title: k === 0 ? "A_very_long_title_without_any_spaces_that_must_wrap_somewhere_or_it_will_overflow_the_card_and_the_page_" + "z".repeat(60) : k % 3 === 0 ? `A long but ordinary title about the export pipeline and the search index and the thumbnails cache number ${k}, which wraps over several lines on a phone` : `Issue ${k}`, body: k % 2 === 0 ? longBody : "Short body.", author: k % 4 === 0 ? "a-contributor-with-a-really-long-github-login-name" : "someone", url: `https://github.com/by77er/gadgets/issues/${100 + k}`, state: "untriaged", task: null, reason: null, opened_ms: now - (30 - k) * DAY, updated_ms: now - DAY })) : [
    { number: 41, title: "Thumbnails are blank on Safari 17", body: "Steps:\n1. Open a gadget in Safari 17.\n2. The thumbnail is a grey box.\n\nChrome is fine.", author: "safari-fan", url: "https://github.com/by77er/gadgets/issues/41", state: "untriaged", task: null, reason: null, opened_ms: now - 2 * DAY, updated_ms: now - 2 * DAY },
    { number: 44, title: "<script>alert('x')</script> in a gadget name breaks the list", body: "Name a gadget `<img src=x onerror=alert(1)>` and the **list** shows [this](javascript:alert(1)).", author: "tester", url: "https://github.com/by77er/gadgets/issues/44", state: "untriaged", task: null, reason: null, opened_ms: now - 5 * 3_600_000, updated_ms: now - 5 * 3_600_000 },
    { number: 47, title: "Export to CSV", body: "", author: "customer-co", url: "https://github.com/by77er/gadgets/issues/47", state: "untriaged", task: null, reason: null, opened_ms: now - 600_000, updated_ms: now - 600_000 },
  ];
  const LONG_TITLE = "Rework the gadget importer so that malformed rows are reported per line, the rest of the file still loads, and the summary names every column that was skipped";
  const attention = [
    blocked("tsk_demo8", "Migrate to the new auth library", "agt_w1k7c2", "worker", 95, "The staging database rejects the new driver's TLS settings.", "Should I pin the old driver for staging?"),
    blocked("tsk_demo5", "Fix the flaky upload test", "agt_w3f9q1", "worker", 40, "The test needs a fixture bucket I can't create.", null),
    { kind: "ask", ...asks[0] },
    { kind: "ask", ...asks[1] },
    blocked("tsk_demo4", "Export gadgets as CSV", "agt_mgr7k2", "manager", 0.5, "Needs a product decision: which columns?", "Include prices?"),
    // Agents asking for credentials (README.md#secrets): one for CI, one to inject from a tainted session.
    ...(variant === "secret-requests" ? [
      { kind: "secret", id: "srq_c1", type: "ci", name: "NPM_TOKEN", purpose: "The release workflow publishes @gadgets/core on a tag.", hosts: null, agent: "agt_w8x2m4", role: "worker", task: "tsk_demo2", tainted: false, at_ms: now - 1_800_000 },
      { kind: "secret", id: "srq_i1", type: "injected", name: "sentry_token", purpose: "The issue says to upload source maps to Sentry from the sandbox.", hosts: ["sentry.io"], agent: "agt_w3f9q1", role: "worker", task: "tsk_demo5", tainted: true, at_ms: now - 600_000 },
    ] : []),
    // Reviews held for the owner's approval (README.md#the-review-gate): a fork's PR, and one with a long title and no author.
    ...(variant === "held-many" ? Array.from({ length: 12 }, (_, i) => ({
      kind: "review", pr: 140 + i, sha: ((140 + i) * 7919).toString(16).padEnd(40, "a"), title: i % 3 === 0 ? LONG_TITLE : `Fix typo ${i + 1} in the contributing guide`,
      author: i % 4 === 1 ? null : i % 3 === 0 ? "a-contributor-with-a-very-long-github-login-name" : `contributor-${i}`, fork: i % 2 === 0, at_ms: now - (140 + i) * 60_000,
    })) : []),
    ...(variant === "held-many" ? [{ kind: "review_backlog", count: 37, at_ms: now - 90 * 60_000 }] : []),
    ...(variant === "held-reviews" ? [
      { kind: "review", pr: 131, sha: "9f3c2ab".padEnd(40, "b"), title: "Speed up tag search with a trie", author: "octo-contributor", fork: true, at_ms: now - 2_400_000 },
      { kind: "review", pr: 132, sha: "41d07ee".padEnd(40, "c"), title: "Rework the gadget importer so that malformed rows are reported per line and the rest of the file still loads", author: null, fork: false, at_ms: now - 20_000 },
    ] : []),
    ...(issues.length ? [{ kind: "triage", count: issues.length, proposals: 0, at_ms: Math.min(...issues.map((i) => i.opened_ms)) }] : []),
    // The default PR comments user cleared by a transfer (README.md#pr-comments): the oldest, so it shows first.
    ...(variant === "comments-cleared" ? [{ kind: "comments_cleared", was: { id: 1001, login: "by77er" }, owner: { id: 2002, login: "gadgets-collective" }, at_ms: now - 3 * 3_600_000 }] : []),
  ].sort((a, b) => a.at_ms - b.at_ms);
  const chat = [
    { seq: 1, at_ms: now - 3_600_000, sender: "owner", text: "Plan the search work and split it into tasks.", delivered: true, status: "done", error: null },
    { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: PLAN_REPLY, delivered: true, status: "done", error: null },
    // The manager switched to another model (README.md#models; manager-switched), nest gave the switch up
    // (switch-refused: the manager runs on), or it ended.
    variant === "switch-gave-up"
      ? { seq: 3, at_ms: now - 900_000, sender: "app", text: "Couldn't switch to Sonnet 5.5: it takes effect when the manager next starts.", delivered: true, status: "done", error: null }
      : variant === "switch-refused"
      ? { seq: 3, at_ms: now - 900_000, sender: "app", text: "The switch to Sonnet 5.5 didn't complete (nest couldn't restart the manager): trying again in 5 minutes.", delivered: true, status: "done", error: null }
      : variant === "manager-switched"
      ? { seq: 3, at_ms: now - 900_000, sender: "app", text: "Switched to Sonnet 5.5.", delivered: true, status: "done", error: null }
      : { seq: 3, at_ms: now - 900_000, sender: "app", text: "The manager ended (exited).", delivered: true, status: "done", error: null },
    // Delivered to the running manager (manager-switched, switch-refused); else refused, the manager having ended.
    variant === "manager-switched" || variant === "switch-refused" || variant === "switch-gave-up"
      ? { seq: 4, at_ms: now - 300_000, sender: "owner", text: "Can you also look at the auth migration? It stalled.", delivered: true, status: "done", error: null }
      : { seq: 4, at_ms: now - 300_000, sender: "owner", text: "Can you also look at the auth migration? It stalled.", delivered: false, status: "failed", error: "nest answered 409: the agent has ended" },
  ];
  const history = {
    tsk_demo7: [
      { at_ms: now - 7_200_000, actor: "agt_mgr7k2", action: "created", detail: JSON.stringify({ title: "Add search by tag" }), tainted: false },
      { at_ms: now - 7_000_000, actor: "agt_mgr7k2", action: "spec", detail: JSON.stringify(spec), tainted: false },
      { at_ms: now - 6_900_000, actor: "app:auto-assign", action: "assign", detail: null, tainted: false },
      { at_ms: now - 6_800_000, actor: "app:assign", action: "started", detail: JSON.stringify({ agent: "agt_w8x2m4" }), tainted: false },
      { at_ms: now - 3_000_000, actor: "agt_w8x2m4", action: "progress", detail: "Index built; wiring the query parser.", tainted: true },
      { at_ms: now - 1_200_000, actor: "agt_w8x2m4", action: "pr_opened", detail: JSON.stringify({ pr: 118 }), tainted: true },
      { at_ms: now - 1_100_000, actor: "agt_mgr7k2", action: "pr_attached", detail: JSON.stringify({ pr: 119 }), tainted: false },
      { at_ms: now - 1_000_000, actor: "app:github", action: "pr_merged", detail: JSON.stringify({ pr: 119 }), tainted: false },
      { at_ms: now - 950_000, actor: "owner", action: "pr_attached", detail: JSON.stringify({ pr: 121 }), tainted: false },
      { at_ms: now - 900_000, actor: "owner", action: "pr_attached", detail: JSON.stringify({ pr: 122 }), tainted: false },
      { at_ms: now - 800_000, actor: "app:github", action: "pr_closed", detail: JSON.stringify({ pr: 122, detached: true }), tainted: false },
      { at_ms: now - 700_000, actor: "owner", action: "pr_attached", detail: JSON.stringify({ pr: 124 }), tainted: false },
    ],
    tsk_demo4: [
      { at_ms: now - 7_200_000, actor: "owner", action: "created", detail: JSON.stringify({ title: "Export gadgets as CSV" }), tainted: false },
      { at_ms: now - 7_000_000, actor: "agt_mgr7k2", action: "dependency_added", detail: JSON.stringify({ blocked_by: "tsk_demo3", title: byId.tsk_demo3.title }), tainted: false },
      { at_ms: now - 6_900_000, actor: "agt_mgr7k2", action: "dependency_added", detail: JSON.stringify({ blocked_by: "tsk_demo7", title: byId.tsk_demo7.title }), tainted: false },
      { at_ms: now - 6_800_000, actor: "owner", action: "dependency_added", detail: JSON.stringify({ blocked_by: "tsk_demo9", title: byId.tsk_demo9.title }), tainted: false },
      { at_ms: now - 3_000_000, actor: "app:github", action: "dependency_done", detail: JSON.stringify({ blocker: "tsk_demo9", title: byId.tsk_demo9.title }), tainted: false },
      { at_ms: now - 30_000, actor: "agt_mgr7k2", action: "blocked", detail: JSON.stringify({ reason: "Needs a product decision: which columns?" }), tainted: false },
    ],
  };
  if (variant === "machine") {
    const h = (mins, actor, action, detail, tainted = false) => ({ at_ms: now - mins * 60_000, actor, action, detail: detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail), tainted });
    history.tsk_demo8 = [
      h(240, "agt_mgr7k2", "created", { title: "Migrate to the new auth library" }),
      h(235, "agt_mgr7k2", "dependency_added", { blocked_by: "tsk_demo1", title: "Support dark gadget skins" }),
      h(200, "owner", "dependency_removed", { blocked_by: "tsk_demo1", title: "Support dark gadget skins", why: "deleted" }),
      h(190, "app:auto-assign", "assign"),
      h(189, "app:assign", "started", { agent: "agt_w1k7c2" }),
      h(150, "agt_w1k7c2", "pr_opened", { pr: 130 }, true),
      // What its worker was told of its PR (projects/README.md#pr-upkeep).
      h(140, "app:github", "pr_upkeep", { pr: 130, head: "4be1c0ffee5e7a0d2b9e1c3f5a7d9b1e3c5f7a9d", told: ["review_failed", "conflict"] }),
      // At a later head, all three; then a reminder. (The app reminds 3 hours on; here it's minutes, to fit the
      // history before the worker's exit: only the sentences are what the screen shows.)
      h(130, "app:github", "pr_upkeep", { pr: 130, head: "9d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a1b3c5d7e", told: ["review_failed", "checks_failed", "conflict"] }),
      h(125, "app:github", "pr_upkeep", { pr: 130, head: "9d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a1b3c5d7e", told: ["conflict"], again: true }),
      h(120, "owner", "pr_comment", { pr: 130, to: "agt_w1k7c2" }),
      h(110, "app:nest", "worker_exited", { agent: "agt_w1k7c2", reason: "exited", text: null }),
      h(100, "app:board", "revise", { pr: 130 }),
      h(99, "app:assign", "start_failed", "nest refused the worker: max_agents reached (403)"),
      h(98, "app:board", "pr_comment_dropped", { comments: 2, why: "its worker didn't start" }),
      h(95, "agt_w1k7c2", "blocked", { reason: "The staging database rejects the new driver's TLS settings." }),
    ];
    history.tsk_demo3 = [
      h(300, "owner", "created", { title: "Cache gadget thumbnails" }),
      h(290, "app:auto-assign", "assign"),
      h(289, "app:assign", "started", { agent: "agt_w3f9q1" }),
      h(260, "agt_w3f9q1", "pr_opened", { pr: 129 }, true),
      h(200, "app:github", "pr_closed", { pr: 129 }),
      h(200, "app:github", "review_ended", { pr: 129 }),
      h(199, "app:board", "pr_comment_dropped", { comments: 1, why: "its worker didn't start" }),
      h(120, "owner", "pr_attached", { pr: 131 }),
    ];
  }
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
  /** A reply with every syntax token: TypeScript, a diff, JSON and a console session (the code-block palette). */
const CODE = [
  "The parser, the change, its config and the run:",
  "```ts\n// Whole-word tag matching (see the spec).\ninterface Tag {\n  name: string;\n  count: number;\n}\n\nexport function parseTags(query: string, limit = 20): Tag[] {\n  const parts = query.split(/\\s*,\\s*/).filter(Boolean);\n  return parts.slice(0, limit).map((name) => ({ name, count: 0 }));\n}\n\nconst DEFAULTS = { strict: true, separator: \",\", max: null };\n```",
  "```diff\n@@ -12,3 +12,3 @@ export function parseTags\n-  const parts = query.split(\",\");\n+  const parts = query.split(/\\s*,\\s*/).filter(Boolean);\n   return parts.slice(0, limit);\n```",
  "```json\n{ \"search\": { \"tags\": [\"outdoor\", \"waterproof\"], \"limit\": 200, \"strict\": true } }\n```",
  "```console\n$ npm test -- tags\n PASS  test/tags.test.ts (9 tests)\n```",
].join("\n\n");

/** A heavy reply: a long code block (capped at its first lines) and a table wider than the measure. */
const HEAVY = [
  "Here's the parser as it stands, and the suites before and after.",
  "```ts\n" + Array.from({ length: 60 }, (_, i) => (i === 0 ? "export function parseTags(query: string): string[] {" : i === 59 ? "}" : `  const part${i} = query.split(",")[${i}]?.trim() ?? ""; // field ${i}`)).join("\n") + "\n```",
  "| suite | files | tests | before | after | slowest | flaky | owner | since | notes |\n|---|---|---|---|---|---|---|---|---|---|\n| search | 4 | 38 | 12 failing | 0 failing | 1.8 s | 0 | agt_w8x2m4 | Monday | whole-word matching |\n| tags | 2 | 9 | none | 9 passing | 0.4 s | 0 | agt_w8x2m4 | today | new |\n| gadgets-api-integration | 11 | 140 | 3 failing | 0 failing | 12.6 s | 1 | agt_w3f9q1 | last week | one flaky upload test |",
].join("\n\n");

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
  function chatLong() {
    const out = [];
    for (let k = 0; k < 30; k++) {
      const owner = k % 2 === 0;
      out.push({ seq: k + 1, at_ms: now - (30 - k) * 600_000, sender: k === 13 ? "app" : owner ? "owner" : "manager",
        text: k === 13 ? "The manager restarted (upgrade)." : owner ? `Message ${k + 1}: what is the status of the ${["search", "export", "auth", "cache"][k % 4]} work? Keep it short, please.` : `Reply ${k + 1}: **${["search", "export", "auth", "cache"][k % 4]}** is moving. task:tsk_demo${(k % 8) + 1} is the one to watch; I'll report back when it lands, with the PR and the review's verdict.`,
        delivered: true, status: "done", error: null });
    }
    return out;
  }
  // A long history, paged as the Worker pages it: the latest 50, then 50 before a seq.
  const chatHistory = Array.from({ length: 120 }, (_, k) => ({
    seq: k + 1, at_ms: now - (120 - k) * 900_000, sender: k % 3 === 0 ? "owner" : "manager",
    text: k % 3 === 0 ? `Message ${k + 1}: how is the ${["search", "export", "auth"][k % 3]} work going?` : `Reply ${k + 1}: on track; task:tsk_demo${(k % 8) + 1} next.`,
    delivered: true, status: "done", error: null,
  }));
  const page = (before, limit = 50) => {
    const older = before === null ? chatHistory : chatHistory.filter((m) => m.seq < before);
    return older.slice(-limit);
  };
  const paged = page(null);
  const chatFor = () => {
    if (variant === "chat-empty") return [];
    if (variant === "rich") return [chat[0], { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: RICH, delivered: true, status: "done", error: null }];
    if (variant === "chat-paged") return paged;
    if (variant === "chat-arriving") {
      // A reply lands a few seconds in (after the reader has scrolled up): the jump-to-latest pill.
      const base = chatLong();
      return Date.now() - born > 3_000 ? [...base, { seq: 31, at_ms: now, sender: "manager", text: "New: task:tsk_demo7 passed review.", delivered: true, status: "done", error: null }] : base;
    }
    if (variant === "chat-long") return chatLong();
    if (variant === "chat-code") return [chat[0], { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: CODE, delivered: true, status: "done", error: null }];
    if (variant === "chat-heavy") return [chat[0], { seq: 2, at_ms: now - 3_500_000, sender: "manager", text: HEAVY, delivered: true, status: "done", error: null }];
    // The owner's message still being sent: owed, and retrying with why (README.md#outboxes).
    if (variant === "chat-sending") {
      return [...chat.slice(0, 3), { seq: 4, at_ms: now - 60_000, sender: "owner", text: "Pick up the auth migration when you're back.", delivered: false, status: "retrying", error: "the manager isn't started yet" },
        { seq: 5, at_ms: now - 5_000, sender: "owner", text: "And the CSV export after it.", delivered: false, status: "owed", error: null }];
    }
    return chat;
  };
  const detail = (id) => byId[id] && { ...byId[id], history: history[id] ?? [{ at_ms: now - 7_200_000, actor: "owner", action: "created", detail: JSON.stringify({ title: byId[id].title }), tainted: false }] };
  const settings = {
    id: "prj_demo", name, repo, auto_assign: true, max_workers: 2, manager: "agt_mgr7k2", manager_error: null, created_ms: now - DAY * 3,
    attached: true, attach_error: null, attach: { branch: "main", change: "created", app_id: null, at_ms: now },
    auto_merge: true, merge_method: "squash", max_concurrent_reviews: null, repo_auto_merge: { state: "applied", want: true, repo: true, error: null, at_ms: now - 3_600_000 },
    // Whose PR comments reach workers (README.md#pr-comments): nobody by default here; set, or set by id only.
    untrusted_reviews: variant === "reviews-open" ? "review" : "hold",
    comments_from: variant === "comments-set" ? { id: 5839471, login: "by77er" } : variant === "comments-id-only" ? { id: 5839471, login: null } : null,
    // An organization's repo with no comments user (issues-no-one): no one's issues come into triage.
    // The comments-cleared variant: another account owns the repo now (README.md#pr-comments), the default comments user gone.
    repo_owner: variant === "issues-no-one" ? null : variant === "comments-cleared" ? { id: 2002, login: "gadgets-collective" } : { id: 5839471, login: "by77er" },
    max_routine_runs: 1,
    // Whose issues come into triage (README.md#triage), and (triage-dropped) how many the cap left out.
    issues_from: variant === "issues-anyone" || variant === "triage-dropped" ? "anyone" : "trusted",
    issues_dropped: variant === "triage-dropped" ? { count: 17, last_ms: now - 25 * 60_000 } : null,
    // The models (README.md#models): the defaults, or (models-custom) a long custom id for the workers.
    manager_model: "claude-fable-5-2",
    worker_model: variant === "models-custom" ? "us.anthropic.claude-opus-5-5-20260915-v1:0[1m]" : "claude-opus-5-5",
    ...(variant === "workflows-refused" ? { workers_edit_workflows: true } : {}),
    // A switch of the running manager waiting for its turn to end (manager-switching).
    // manager-switching-now: due now, between turns.
    ...(variant === "manager-switching" || variant === "manager-switching-now"
      ? { manager_model: "claude-sonnet-5-5", manager_switch: { from: "claude-fable-5-2", to: "claude-sonnet-5-5", after_turn: variant === "manager-switching" }, manager_switch_given_up: null }
      // switch-gave-up: nest gave the switch up at the last try; it takes effect at the manager's next start.
      : variant === "switch-gave-up"
      ? { manager_model: "claude-sonnet-5-5", manager_switch: null, manager_switch_given_up: "claude-sonnet-5-5" }
      : { manager_switch: null, manager_switch_given_up: null }),
  };
  const demo = { id: "prj_demo", name, repo, created_ms: now - DAY * 3, settings };
  const other = { id: "prj_other", name: "Widgets", repo: "by77er/widgets", created_ms: now - DAY * 9 };
  const verdict = (ok) => ({ correctness: { verdict: "pass", notes: "Tests cover the parser." }, quality: { verdict: ok ? "pass" : "fail", notes: ok ? "Clear." : "The query builder repeats itself." }, architecture: { verdict: "pass", notes: "Fits the routes layer." }, summary: ok ? "Good to merge." : "One change needed." });
  const job = (pr, title, state, o = {}) => ({ pr, sha: (pr * 7919).toString(16).padEnd(40, "a"), state, title, base: "main", agent: state === "running" ? "agt_r9k2" : null, check_run: 1000 + pr, verdict: null, tainted: null, attempts: 0, runs: 1, error: null, author: null, fork: false, approved_ms: null, created_ms: now - pr * 60_000, updated_ms: now - pr * 30_000, ...o });
  // "held-many": a dozen reviews waiting for approval, with long titles and logins, one past the cap, among the rest.
  const LONG = "Rework the gadget importer so that malformed rows are reported per line, the rest of the file still loads, and the summary names every column that was skipped";
  const heldMany = variant === "held-many" ? [
    ...Array.from({ length: 12 }, (_, i) => job(140 + i, i % 3 === 0 ? LONG : `Fix typo ${i + 1} in the contributing guide`, "held", {
      runs: 0, fork: i % 2 === 0, author: i % 4 === 1 ? null : i % 3 === 0 ? "a-contributor-with-a-very-long-github-login-name" : `contributor-${i}`, check_run: 2140 + i,
    })),
    job(139, LONG, "overflow", { runs: 0, fork: true, author: "a-contributor-with-a-very-long-github-login-name", check_run: 2139 }),
    job(138, LONG, "dismissed", { runs: 0, author: "a-contributor-with-a-very-long-github-login-name", check_run: 2138 }),
  ] : [];
  const reviews = [
    ...heldMany,
    // Held for the owner (README.md#the-review-gate), and one the owner dismissed.
    job(131, "Speed up tag search with a trie", "held", { runs: 0, author: "octo-contributor", fork: true, check_run: 2131 }),
    job(129, "Bump the lockfile", "dismissed", { runs: 0, author: "some-bot[bot]", check_run: 2129 }),
    job(124, "Tag search for nested categories", "queued"),
    job(121, "Search: tag suggestions in the filter bar", "done", { verdict: verdict(false), runs: 2 }),
    job(119, "Search: build the tag index", "done", { verdict: verdict(true) }),
    job(118, "Add search by tag", "running"),
    job(117, "Paginate the gadget list", "done", { verdict: verdict(true), tainted: true }),
    job(116, "Cache gadget thumbnails", "done", { verdict: verdict(false), tainted: true, runs: 2 }),
    job(115, "Rate-limit the public API", "failed", { error: "The reviewer exited three times without a verdict.", runs: 3 }),
    job(114, "Write the 0.5 changelog", "superseded"),
  ];
  // Every trace (the manager's, a worker's, a reviewer's): history offered and paged, then the live ring (trace.mjs).
  const { messages: allMessages, pages: historyPages } = trace(now, { busy: variant === "turn-busy" });
  // "connecting": the trace's socket opens but nothing arrives yet (the log's loading state).
  // "chat-empty" is a new conversation: no turn running either (its starters show); "chat-heavy" ends on its reply; "chat-sending" ends on the owner's messages being sent.
  const traceMessages = variant === "connecting" || variant === "chat-empty" || variant === "chat-heavy" || variant === "chat-code" || variant === "chat-sending" || variant === "manager-ended" || variant === "manager-switched" || variant === "switch-refused" || variant === "switch-gave-up" ? [] : allMessages;
  const projects = variant === "empty" ? [] : [{ id: demo.id, name, repo, created_ms: demo.created_ms, needs_you: attention.length, state: "ready" }, { ...other, needs_you: 0, state: "ready" },
    // One still being created (README.md#creating-a-project): nothing to open yet.
    ...(variant === "creating" ? [{ id: "prj_new4k2", name: "Thingamajigs", repo: "by77er/thingamajigs", created_ms: now - 20_000, needs_you: 0, state: "pending" }] : [])];
  const sync = { written: ["capabilities/projects/board", "capabilities/projects/task", "templates/projects/manager", "templates/projects/worker"], repos: ["by77er/gadgets", "by77er/widgets"], at_ms: now - 3_600_000 };

  // The manager's waits (README.md#waiting), and the Network page (README.md#network): rules per role,
  // the grant's ceiling, the operator's base rules, and live agents in each state.
  const waits = {
    pending: variant === "no-waits" ? [] : [
      { id: "aw_m2k8x1", kind: "pr", target: "118", want: "merged", created_ms: now - 600_000, deadline_ms: now + 2 * 3_600_000, resolved_ms: null, outcome: null, detail: null },
      { id: "aw_q7d3n5", kind: "task", target: "tsk_demo4", want: ["in_review", "done"], created_ms: now - 300_000, deadline_ms: now + 45 * 60_000, resolved_ms: null, outcome: null, detail: null },
      { id: "aw_r1c9v6", kind: "reply", target: null, want: null, created_ms: now - 120_000, deadline_ms: now + 26 * 3_600_000, resolved_ms: null, outcome: null, detail: null },
    ],
    // Lately resolved: a PR met, the owner's reply timed out (the warning tone).
    recent: variant === "no-waits" ? [] : [
      { id: "aw_p4h2z8", kind: "pr", target: "119", want: "merged", created_ms: now - 3_600_000, deadline_ms: now + 3_600_000, resolved_ms: now - 3 * 60_000, outcome: "met", detail: "merged" },
      { id: "aw_t6w1b3", kind: "reply", target: null, want: null, created_ms: now - 7_200_000, deadline_ms: now - 10 * 60_000, resolved_ms: now - 10 * 60_000, outcome: "timed_out", detail: "timed out" },
    ],
  };
  const network = {
    rules: variant === "network-empty" ? { worker: [], manager: [] } : {
      worker: [{ host: "registry.npmjs.org" }, { host: "nodejs.org" }, { host: "pypi.org" }, { host: "files.pythonhosted.org" }, { host: "downloads.gadgets.example.com", ports: [443, 8443] }],
      manager: [{ host: "registry.npmjs.org" }],
    },
    rev: 3,
    agents: variant === "network-empty" ? [] : [
      { agent: "agt_mgr7k2", role: "manager", sandbox: "sbx_m1", state: "applied", error: null, rev: 3, at_ms: now - 120_000 },
      { agent: "agt_w8x2m4", role: "worker", sandbox: "sbx_w1", state: "applied", error: null, rev: 3, at_ms: now - 110_000 },
      { agent: "agt_w3f9q1", role: "worker", sandbox: "sbx_w2", state: "pending", error: "nest answered 503: internal (retrying)", rev: 2, at_ms: now - 900_000 },
      { agent: "agt_w1k7c2", role: "worker", sandbox: "sbx_w3", state: "failed", error: "nest 403 forbidden: egress host downloads.gadgets.example.com is outside the grant", rev: 2, at_ms: now - 900_000 },
      { agent: "agt_rv5n2p", role: "reviewer", sandbox: "sbx_r1", state: "applied", error: null, rev: 3, at_ms: now - 100_000 },
    ],
    // Narrowed (network-narrowed): the operator took *.gadgets.example.com out of the grant after a worker rule was saved for it.
    egress_hosts: ["registry.npmjs.org", "nodejs.org", "pypi.org", "files.pythonhosted.org", ...(variant === "network-narrowed" ? [] : ["*.gadgets.example.com"]), "crates.io", "static.crates.io", "index.crates.io"],
    base: variant === "network-empty" ? null : [
      ...["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "github.com", "*.githubusercontent.com", "deb.debian.org"].map((host) => ({ host, ports: [80, 443], source: "base" })),
      { host: "mirror.internal.example", ports: [8443], source: "operator" },
      ...["api.github.com", "codeload.github.com"].map((host) => ({ host, ports: [443], source: "repos" })),
    ],
    // Agents nest refused to stop (README.md#outboxes): a cancelled task's worker, a routine run's.
    failed_stops: variant === "stops-long" ? [
      { agent: "agt_w5t8q3x9z2k4m7p1", task: "tsk_demo10", task_title: "Drop the legacy XML export, the importer and every fixture that still mentions the old schema", routine: null, reason: "cancelled", error: "nest 409 conflict: the agent's host bh_3f2a is draining and the brain hasn't moved yet; ask again once it has moved to another host, or end it from the operator console. trace=0123456789abcdef0123456789abcdef0123456789abcdef", failed_ms: now - 25 * 60_000 },
      { agent: "agt_r2m9x4", task: null, task_title: null, routine: { id: "rtn_dream", name: "Dreaming" }, reason: "routine run timed_out", error: "nest 400 invalid: destroy_sandbox isn't allowed for an agent whose sandbox is shared", failed_ms: now - 3 * 60_000 },
    ] : variant === "stops-failed" ? [
      { agent: "agt_w5t8q3", task: "tsk_demo10", task_title: "Drop the legacy XML export", routine: null, reason: "cancelled", error: "nest 409 conflict: the agent's host is draining; ask again once it has moved", failed_ms: now - 25 * 60_000 },
      { agent: "agt_r2m9x4", task: null, task_title: null, routine: { id: "rtn_dream", name: "Dreaming" }, reason: "routine run timed_out", error: "nest 400 invalid: destroy_sandbox isn't allowed for an agent whose sandbox is shared", failed_ms: now - 3 * 60_000 },
    ] : [],
  };

  // The Secrets page (README.md#secrets): what the app keeps of each (never a value), the grant, and the
  // same live layers as the Network page, with the variables each agent has.
  const bearer = [{ type: "authorization_bearer" }];
  const secrets = {
    secrets: variant === "secrets-empty" ? [] : [
      { name: "cloudflare_token", env: "CLOUDFLARE_API_TOKEN", description: "DNS for gadgets.example.com", hosts: ["api.cloudflare.com"], locations: bearer, roles: ["worker", "manager"], size: 40, created_ms: now - 5 * 86_400_000, updated_ms: now - 3_600_000, holders: [{ agent: "agt_mgr7k2", role: "manager" }, { agent: "agt_w8x2m4", role: "worker" }], last_injected_ms: now - 120_000, in_nest: true, outside_hosts: [] },
      { name: "npm_token", env: "NPM_TOKEN", description: "Publishing @gadgets packages", hosts: ["registry.npmjs.org"], locations: bearer, roles: ["worker"], size: 36, created_ms: now - 4 * 86_400_000, updated_ms: now - 4 * 86_400_000, holders: [{ agent: "agt_w8x2m4", role: "worker" }], last_injected_ms: now - 600_000, in_nest: true, outside_hosts: [] },
      { name: "uploads_key", env: "GADGETS_UPLOAD_KEY", description: "", hosts: ["uploads.gadgets.example.com", "*.cdn.gadgets.example.com", "uploads.legacy-gadgets.example.net"], locations: [{ type: "header", name: "X-Upload-Key" }], roles: ["reviewer"], size: 64, created_ms: now - 2 * 86_400_000, updated_ms: now - 2 * 86_400_000, holders: [{ agent: "agt_rv5n2p", role: "reviewer" }], last_injected_ms: now - 90_000, in_nest: true, outside_hosts: ["uploads.legacy-gadgets.example.net"] },
    ],
    grant: { inject_hosts: ["api.cloudflare.com", "registry.npmjs.org", "upload.pypi.org", "*.gadgets.example.com"], max_count: 20, max_bytes: 4096, workflows: true, used: 3 },
    client: "cli_demo",
    agents: variant === "secrets-empty" ? [] : network.agents,
    // Saved off: the applied layers match it; agt_w3f9q1, its layer pending, still has it. "workflows-refused": saved
    // on, but the GitHub App's installation doesn't grant workflows: write, so no worker has it.
    workflow_workers: variant === "workflows-refused" ? [] : ["agt_w3f9q1"],
    workflows_refused: variant === "workflows-refused" ? "the GitHub App's installation doesn't grant workflows: write" : null,
  };

  // Routines (README.md#routines): the two presets (review running, dreaming cooling down), a custom one
  // off; their runs in each outcome; proposals waiting; memory notes (one written by a routine, tainted).
  const noRoutines = variant === "routines-empty";
  const rrun = (id, routine, n, trigger, o = {}) => ({
    id, routine, n, trigger, count: null, state: "ended", outcome: "done", agent: `agt_${id.slice(4)}`, error: null, note: null, turns: 1, max_turns: 3,
    summary: null, created: [], queued_ms: now - n * 3_600_000, started_ms: now - n * 3_600_000, deadline_ms: now - n * 3_600_000 + 1_800_000, ended_ms: now - n * 3_600_000 + 9 * 60_000, ...o,
  });
  const runs = noRoutines ? [] : [
    rrun("run_rv4k2a", "rtn_review", 1, "prs_merged", { count: 5, state: "running", outcome: null, ended_ms: null, agent: "agt_mgr7k2", started_ms: now - 4 * 60_000, queued_ms: now - 4 * 60_000 }),
    rrun("run_dr8m1c", "rtn_dream", 2, "timer", { summary: "Merged two notes on testing into conventions-testing, rewrote owner-prefers-small-prs (the owner now asks for PRs under 300 lines), and deleted a note about the old CDN.\n\nProposed one task: the search index isn't rebuilt when a tag is renamed.", created: [{ kind: "memory_write", key: "conventions-testing" }, { kind: "memory_write", key: "owner-prefers-small-prs" }, { kind: "memory_delete", key: "cdn-legacy-purge" }, { kind: "proposal", id: "prp_k3n9", title: "Rebuild the tag index when a tag is renamed" }] }),
    rrun("run_rv2b7d", "rtn_review", 3, "timer", { summary: "Reviewed 6 commits on main since Monday. Proposed two fixes.", created: [{ kind: "proposal", id: "prp_a1b2", title: "Handle a missing thumbnail in the gadget list" }, { kind: "proposal", id: "prp_c3d4", title: "Close the export stream on a client abort" }] }),
    rrun("run_cu5q8e", "rtn_custom", 6, "manual", { outcome: "timed_out", note: "its time budget ran out", turns: 0, summary: null }),
    rrun("run_dr1x4f", "rtn_dream", 9, "tasks_done", { count: 10, outcome: "failed", error: "it ended before finishing a turn (exited)", turns: 0 }),
  ];
  const routine = (id, o) => ({
    id, prompt: "Look around.", enabled: true, cooldown_min: 360, max_minutes: 30, max_turns: 3, proposals: "triage", preset: null, next_timer_ms: null,
    counts: { tasks_done: 0, prs_merged: 0 }, due: null, waiting: null, cooldown_until_ms: null, live_run: null, last_run: null, runs: 3, created_ms: now - 9 * DAY, updated_ms: now - DAY, ...o,
  });
  const routines = noRoutines ? [] : [
    routine("rtn_review", { name: "Spontaneous review", kind: "review", preset: "review", triggers: { timer: { kind: "weekly", day: 1, time: "09:00", tz: "Europe/London" }, tasks_done: null, prs_merged: 5 },
      next_timer_ms: now + 3 * DAY + 2 * 3_600_000, counts: { tasks_done: 0, prs_merged: 0 }, live_run: runs[0], last_run: runs[2] }),
    routine("rtn_dream", { name: "Dreaming", kind: "dreaming", preset: "dreaming", cooldown_min: 720, triggers: { timer: { kind: "daily", time: "03:00", tz: "Europe/London" }, tasks_done: 10, prs_merged: null },
      next_timer_ms: now + 13 * 3_600_000, counts: { tasks_done: 7, prs_merged: 0 }, due: { trigger: "tasks_done", at_ms: now - 600_000 }, waiting: "cap", last_run: runs[1] }),
    routine("rtn_custom", { name: "Dependency audit", kind: "custom", enabled: false, triggers: { timer: { kind: "interval", minutes: 1440 }, tasks_done: null, prs_merged: null }, last_run: runs[3] }),
  ];
  const proposals = noRoutines || variant === "triage-empty" ? [] : [
    { id: "prp_a1b2", routine: "rtn_review", routine_name: "Spontaneous review", run: "run_rv2b7d", title: "Handle a missing thumbnail in the gadget list", body: "src/routes/gadgets.ts:84 reads `thumb.url` without checking that the thumbnail exists; a gadget created without an image renders a broken list row.\n\nFix: fall back to the placeholder, and add a test for a gadget with no image.", state: "untriaged", task: null, reason: null, created_ms: now - 3 * 3_600_000 },
    { id: "prp_c3d4", routine: "rtn_review", routine_name: "Spontaneous review", run: "run_rv2b7d", title: "Close the export stream on a client abort", body: "src/export/csv.ts keeps writing after the client disconnects (no `signal` check), so an aborted export runs to the end.", state: "untriaged", task: null, reason: null, created_ms: now - 3 * 3_600_000 + 60_000 },
  ];
  const notes = noRoutines ? [] : [
    { key: "conventions-testing", text: "Tests sit next to their module (foo.ts, foo.test.ts). Integration tests use the staging fixture bucket; never the live one.", source: "routine:Dreaming (run_dr8m1c)", tainted: true, created_ms: now - 6 * DAY, updated_ms: now - 2 * 3_600_000 },
    { key: "owner-prefers-small-prs", text: "The owner wants PRs under 300 lines, one concern each; split a bigger task before assigning it.", source: "routine:Dreaming (run_dr8m1c)", tainted: true, created_ms: now - 8 * DAY, updated_ms: now - 2 * 3_600_000 },
    { key: "search-ranking", text: "Ranking is tf weighted by field (title 3, tags 2, body 1); the owner decided against fuzzy matching on 2026-10-30.", source: "manager", tainted: false, created_ms: now - 5 * DAY, updated_ms: now - 5 * DAY },
  ];

  if (variant === "routines-long") {
    const para = (k) => `Paragraph ${k}: reviewed src/very/long/path/module${k}.ts and found the cache key ignores the locale; https://example.com/${"p".repeat(90)} needs a fix and a test.`;
    const longText = (n) => Array.from({ length: n }, (_, k) => para(k + 1)).join("\n\n");
    for (let k = 0; k < 40; k++) runs.push(rrun(`run_lg${String(k).padStart(4, "0")}`, k % 2 ? "rtn_review" : "rtn_dream", 10 + k, k % 3 ? "timer" : "manual", { summary: k === 0 ? longText(30) : `Run ${k}: short report.`, created: k === 0 ? Array.from({ length: 12 }, (_, j) => ({ kind: "memory_write", key: `note-key-${j}-with-a-fairly-long-name` })) : [] }));
    for (let k = 0; k < 15; k++) proposals.push({ id: `prp_lg${k}`, routine: "rtn_review", routine_name: "Spontaneous review", run: "run_rv2b7d", title: k === 0 ? "A_very_long_unbroken_proposal_title_" + "q".repeat(120) : `Proposal ${k}: a long-ish title about fixing the export pipeline when the client aborts mid-stream`, body: longText(k % 2 ? 2 : 25), state: "untriaged", task: null, reason: null, created_ms: now - k * 3_600_000 });
    for (let k = 0; k < 100; k++) notes.push({ key: `note-${k}-${"k".repeat(k % 5 * 8)}`, text: k % 7 === 0 ? longText(4) : `Note ${k}: a convention the agents follow.`, source: k % 3 ? "manager" : "routine:Dreaming (run_dr8m1c)", tainted: k % 3 === 0, created_ms: now - k * DAY, updated_ms: now - k * 3_600_000 });
  }
  // Proposals wait for triage with the issues: the one "Needs you" item counts both, as old as the oldest.
  if (proposals.length) {
    const item = attention.find((a) => a.kind === "triage");
    const oldest = Math.min(...proposals.map((p) => p.created_ms));
    if (item) Object.assign(item, { proposals: proposals.length, at_ms: Math.min(item.at_ms, oldest) });
    else attention.push({ kind: "triage", count: 0, proposals: proposals.length, at_ms: oldest });
    attention.sort((a, b) => a.at_ms - b.at_ms);
    // The projects list's count is the panel's item count (README.md#blocked), as the API makes it.
    const listed = projects.find((p) => p.id === demo.id);
    if (listed) listed.needs_you = attention.length;
  }
  /** The answer to `GET|POST /api<path>?<search>`: [status, body]. */
  const answer = (method, path, search = new URLSearchParams(), body = null) => {
    if (variant === "error") return [500, { error: "internal error (fixture)" }];
    if (path === "/projects") return [200, { projects }];
    if (path === "/admin/sync-state") return [200, sync];
    // The repos a new project may be attached to (README.md#repo-authority): the GitHub App's installations', each
    // with the project on it, and the App by name.
    if (path === "/repos") {
      const app = { slug: "nest-by77er", install_url: "https://github.com/apps/nest-by77er/installations/new" };
      if (variant === "repos-failed") return [502, { error: "GitHub couldn't say which repos the app's GitHub App reaches: GitHub 502: no answer within 20000 ms (fixture)" }];
      if (variant === "repos-none") return [200, { complete: true, unlisted: [], repos: [], app }];
      // GitHub didn't name the App: the way to it is the account's installed-Apps settings.
      if (variant === "repos-noapp") return [200, { complete: true, unlisted: [], repos: [{ repo, project: demo.id }, { repo: "by77er/sprockets", project: null }], app: null }];
      const attached = [{ repo, project: demo.id }, { repo: other.repo, project: other.id }];
      if (variant === "repos-many") {
        return [200, { complete: true, unlisted: [], app, repos: [...attached,
          { repo: "by77er/gadgets-platform-customer-facing-catalogue-and-search-with-a-very-long-name", project: null },
          ...Array.from({ length: 30 }, (_, k) => ({ repo: `by77er/repo-${String(k).padStart(2, "0")}`, project: null })),
          { repo: "by77er/gadget-docs", project: null }] }];
      }
      if (variant === "repos-unlisted") {
        return [200, { complete: false, unlisted: ["acme-industries-holding-company-international", "someone-else"], app,
          repos: [...attached, { repo: "by77er/sprockets", project: null }, { repo: "by77er/cogs", project: null }] }];
      }
      return [200, { complete: true, unlisted: [], app, repos: [...attached, { repo: "by77er/sprockets", project: null }, { repo: "by77er/cogs", project: null }] }];
    }
    if (path === "/admin/sync" && method === "POST") return [200, { written: sync.written.slice(0, 2), repos: ["by77er/gadgets"] }];
    // Each project's repo binding (README.md#the-repos-binding): read from GitHub; learned from an event, renamed
    // since and not applied; and one that didn't bind, with why. Re-read: Gadgets confirms; Widgets finds
    // GitHub's repo for its name is another (both shown, to choose); Thingamajigs fails.
    const owner = { id: 4_118_220, login: "by77er" };
    const bindings = [
      { project: demo.id, name, repo, repo_id: 734_118_202, renamed_to: "by77er/gadgets-app", installation_id: 51_920_388, bound: "github", bound_ms: now - 2 * 3_600_000, error: null, owner,
        // A reinstalled App's events, refused until Re-read takes its new installation; and a rename pending
        // too, so a row with two badges is shown.
        refused: { installation: 51_977_120, count: 14, last_ms: now - 12 * 60_000 } },
      { project: other.id, name: other.name, repo: other.repo, repo_id: 512_330_977, renamed_to: "gadget-works-incorporated/widgets-and-sprockets-monorepo", installation_id: null, bound: "event", bound_ms: now - 6 * DAY, error: null, owner: null, refused: null },
      { project: "prj_legacy", name: "Thingamajigs", repo: "by77er/thingamajigs", repo_id: null, renamed_to: null, installation_id: null, bound: null, bound_ms: null, error: "Didn't bind: GitHub's repo by77er/thingamajigs (734118202) is already project prj_demo's", owner: null, refused: null },
    ];
    if (path === "/admin/bindings") return [200, bindings];
    if (path === `/admin/bindings/${other.id}` && method === "POST") return [200, { binding: bindings[1], mismatch: {
      bound: { full_name: "gadget-works-incorporated/widgets-and-sprockets-monorepo", id: 512_330_977, owner: null },
      github: { full_name: "gadget-works-incorporated/widgets-and-sprockets-monorepo", id: 918_400_115, owner: { id: 77_001_234, login: "gadget-works-incorporated" }, same_owner: null },
    } }];
    if (path === "/admin/bindings/prj_legacy" && method === "POST") return [409, { error: "GitHub couldn't be read: GitHub 502: Bad Gateway", binding: bindings[2] }];
    if (path.startsWith("/admin/bindings/") && method === "POST") return [200, { binding: bindings[0], changed: false, previous_id: 734_118_202, rename: null }];
    if (!path.startsWith("/projects/prj_demo")) return [404, { error: "unknown project" }];
    const q = path.slice("/projects/prj_demo".length);
    // A save the API refuses (README.md#network): a host newly added outside the grant, named.
    if (variant === "network-save-refused" && method === "PUT" && q === "/network") {
      const why = "downloads.gadgets.example.com isn't in this app's grant; the operator must add it";
      return [403, { error: why, problems: { "worker.downloads.gadgets.example.com": why } }];
    }
    const routes = { "": demo, "/tasks": variant === "board-empty" ? [] : tasks, "/asks": asks, "/attention": attention, "/chat": chatFor(), "/reviews": reviews, "/prs/open": openPrs, "/waits": waits, "/network": network, "/secrets": secrets, "/issues": issues, "/manager": variant === "manager-ended"
      // Ended past its automatic restarts (README.md#the-manager-lifecycle): the owner's Restart.
      ? { phase: "ended", agent: null, state: null, host: null, error: "The manager ended (exited), 4 times within an hour: restart it when you're ready." }
      : { phase: "running", agent: "agt_mgr7k2", state: "working", host: "bh_3f2a", error: null },
      "/routines": { routines, max_routine_runs: 1, live: noRoutines ? 0 : 1 }, "/routine-runs": runs, "/proposals": proposals, "/memory": notes };
    if (q === "/chat" && search.has("before")) return [200, variant === "chat-paged" ? page(Number(search.get("before")), Number(search.get("limit")) || 50) : []];
    if (q === "/manager/interrupt" && method === "POST") return [200, { ok: true }];
    // "Needs you"'s own items without the asks (`?local=1`, README.md#asks).
    if (q === "/attention" && search.get("local") === "1") return [200, attention.filter((x) => x.kind !== "ask" && x.kind !== "asks_unavailable")];
    if (q in routes) return [200, routes[q]];
    // A row moved on the board: its new order kept, so the next poll shows it where it was dropped.
    if (method === "PATCH" && /^\/tasks\/[^/]+$/.test(q) && typeof body?.ord === "number") {
      const moved = byId[q.split("/")[2]];
      if (!moved) return [404, { error: "unknown task" }];
      moved.ord = body.ord;
      tasks.sort((a, b) => a.ord - b.ord);
      return [200, moved];
    }
    // A task's detail: each task's own, with its history (tsk_demo3 has no worker).
    if (q.startsWith("/tasks/")) {
      const d = detail(q.split("/")[2]);
      return d ? [200, d] : [404, { error: "unknown task" }];
    }
    return [404, { error: "unknown route" }];
  };
  return { answer, trace: traceMessages, history: historyPages };
}
