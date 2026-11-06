// An agent's trace as nest serves it to the projects app: the socket's messages (an offer of history,
// the ring's events, `live`) and the history route's pages, oldest page last. Made-up ids only.
//
// The ring holds a finished turn whose reply is the demo chat's (`PLAN_REPLY`: the chat shows its steps
// behind "Used 4 tools"), then the current turn: a progress report, a long test run (collapsed to its first lines),
// a failing command (an error result), an answer in Markdown and a build still running. History holds two older turns in two
// pages: `c2` (the page before the ring, a long wrapped command and an unbroken URL) and `c1` (the
// first turn: a long file read and a failing test), whose `next_before: null` is the trace's beginning.

const MARKDOWN = [
  "The push was refused (`403`), so I'll open the PR **through the broker** instead. Building *first* to be sure.",
  "## Before the PR",
  "1. Build: `npm run build`\n2. Re-run the search suites\n   - `test/search.test.ts`\n   - `test/tags.test.ts`",
  "> The sandbox's grant covers the broker, not a direct push.",
  "```sh\nnpm run build && npx vitest run test/search.test.ts test/tags.test.ts --reporter=verbose --maxWorkers=2 --coverage.enabled=false\n```",
  "| suite | before | after |\n|---|---|---|\n| search | 12 failing | 0 failing |\n| tags | none | 9 passing |\n| the-integration-suite-for-the-whole-gadgets-api-and-its-search-endpoints | 3 failing | 0 failing |",
  "See [the broker's docs](https://docs.example.com/broker).",
  "---",
].join("\n\n");

/** The manager's reply that ends the ring's finished turn, word for word as the demo chat has it. */
export const PLAN_REPLY = 'Done: "Add search by tag" is specced and assigned. I left "Export gadgets as CSV" ready for later.';

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");

/** `busy`: the live turn has called a dozen tools (the chat folds its earlier steps). */
export function trace(now = Date.now(), { busy = false } = {}) {
  const t0 = now - 3_600_000;
  let entry = 0;
  const h = (type, more = {}) => ({ ts_ms: t0 + entry * 20_000, entry: entry++, type, ...more });
  const input = (o) => JSON.stringify(o);

  // The first turn (page c1, the beginning).
  const first = [
    h("turn_started", { input_kind: "user" }),
    h("assistant_text", { text: "I'll start by reading the task's spec and the current search code, then run its tests to see where they stand." }),
    h("tool_call", { call_id: "toolu_h1", name: "Read", input: input({ file_path: "src/routes/gadgets.ts" }) }),
    h("tool_result", { call_id: "toolu_h1", is_error: false, summary: lines(42, (i) => `${String(i).padStart(3)}  ${i === 1 ? 'import { Router } from "../router";' : i === 42 ? "export default router;" : `// line ${i} of the gadgets routes`}`) }),
    h("tool_call", { call_id: "toolu_h2", name: "Bash", input: input({ command: "npm test -- search", description: "Run the search tests" }) }),
    h("tool_result", { call_id: "toolu_h2", is_error: true, summary: "Error: Cannot find module './tags' from 'src/search/index.ts'\n    at Resolver.resolveModule (node_modules/jest-resolve/build/resolver.js:324:11)\n    at src/search/index.ts:3:1\n    at Object.<anonymous> (test/search.test.ts:1:1)\n    at Runtime._execModule (node_modules/jest-runtime/build/index.js:1439:24)" }),
    h("assistant_text", { text: "The tag index doesn't exist yet: that's the work. I'll write it next." }),
    h("turn_completed", { stop_reason: "end_turn", usage: { input_tokens: 18_420, output_tokens: 1_204 } }),
  ];
  // The second turn (page c2, just before the ring).
  const second = [
    h("turn_started", { input_kind: "inbox" }),
    h("assistant_text", { text: "The manager's note says to match tags by whole word. I'll build the index on write, so a search is one lookup, and keep the parser separate so its rules can be tested apart from storage.\n\nFirst the index, then the parser." }),
    h("tool_call", { call_id: "toolu_h3", name: "Grep", input: input({ pattern: "tags?\\b", path: "src" }) }),
    h("tool_result", { call_id: "toolu_h3", is_error: false, summary: lines(12, (i) => `src/${i % 2 ? "routes" : "search"}/file${i}.ts:${i * 7}: const tags = gadget.tags ?? [];`) }),
    h("tool_call", { call_id: "toolu_h4", name: "Write", input: input({ file_path: "src/search/tags.ts", content: "export function indexTags() {}\n" }) }),
    h("tool_result", { call_id: "toolu_h4", is_error: false, summary: "File created successfully at: src/search/tags.ts" }),
    h("tool_call", { call_id: "toolu_h5", name: "Bash", input: input({ command: "curl -sS 'https://staging.gadgets.example/api/gadgets?tag=outdoor&tag=waterproof&limit=200&fields=id,name,tags' | jq '.items | length'" }) }),
    h("tool_result", { call_id: "toolu_h5", is_error: false, summary: "https://staging.gadgets.example/api/gadgets?tag=outdoor&tag=waterproof&limit=200&fields=id,name,tags&cursor=eyJpZCI6Imdkd18wMDAxMjM0NTY3ODkwYWJjZGVmIiwidHMiOjE3MzAwMDAwMDAwMDB9\n137" }),
    h("tool_call", { call_id: "toolu_h6", name: "mcp__projects-task__report_progress", input: input({ text: "Index built; wiring the query parser." }) }),
    h("tool_result", { call_id: "toolu_h6", is_error: false, summary: "ok" }),
    h("turn_completed", { stop_reason: "end_turn", usage: { input_tokens: 31_877, output_tokens: 2_950 } }),
  ];
  const pages = {
    c2: { events: second, next_before: "c1" },
    c1: { events: first, next_before: null },
  };

  // The ring: the turn going on now.
  let seq = 0;
  const ev = (type, more = {}) => ({ seq: ++seq, ts_ms: now - 300_000 + seq * 15_000, type, turn: "trn_live", ...more });
  const plan = (type, more = {}) => ev(type, { turn: "trn_plan", ...more });
  const ring = [
    plan("turn_started", { input_kind: "user" }),
    plan("assistant_text", { text: "I'll look at the board first, then split the search work." }),
    plan("tool_call", { call_id: "toolu_p1", name: "mcp__projects-board__list_tasks", input: input({}) }),
    plan("tool_result", { call_id: "toolu_p1", is_error: false, summary: "6 tasks: 2 ready, 3 in progress, 1 in review" }),
    plan("tool_call", { call_id: "toolu_p2", name: "mcp__projects-board__create_task", input: input({ title: "Add search by tag", body: "Let people filter the gadget list by one or more tags, matched by whole word." }) }),
    plan("tool_result", { call_id: "toolu_p2", is_error: false, summary: "tsk_demo7 (draft)" }),
    plan("tool_call", { call_id: "toolu_p3", name: "mcp__projects-board__write_spec", input: input({ task: "tsk_demo7", spec: "A tag index built on write; a query parser for tag:a tag:b.", criteria: ["GET /gadgets?tag=a&tag=b returns gadgets with both tags", "The search suites pass"] }) }),
    plan("tool_result", { call_id: "toolu_p3", is_error: false, summary: "tsk_demo7 is ready" }),
    plan("tool_call", { call_id: "toolu_p4", name: "mcp__projects-board__assign_task", input: input({ task: "tsk_demo7" }) }),
    plan("tool_result", { call_id: "toolu_p4", is_error: false, summary: "assigned to agt_w8x2m4" }),
    plan("assistant_text", { text: PLAN_REPLY }),
    plan("turn_completed", { stop_reason: "end_turn" }),
    ev("state", { state: "working" }),
    ev("turn_started", { input_kind: "ask_answer" }),
    ev("assistant_text", { text: "You said to open the PR, so I'll run the whole suite first and then push." }),
    ev("tool_call", { call_id: "toolu_1", name: "Bash", input: input({ command: "npm test", description: "Run the whole suite" }) }),
    ev("tool_result", { call_id: "toolu_1", is_error: false, summary: lines(64, (i) => (i === 64 ? "Tests: 212 passed, 212 total" : ` PASS  test/suite${i}.test.ts (${(i * 0.137).toFixed(2)} s)`)) }),
    ev("tool_call", { call_id: "toolu_2", name: "Bash", input: input({ command: "git push origin search-by-tag" }) }),
    ev("tool_result", { call_id: "toolu_2", is_error: true, summary: "fatal: unable to access 'https://github.com/by77er/gadgets.git/': The requested URL returned error: 403\nhint: the sandbox's grant doesn't include a push to this repository" }),
    ev("rate_limited", { detail: "5-hour window at 80%; resets in 41 min" }),
    // Markdown, as an assistant writes it (README.md#the-live-trace): a heading, bold, italic, inline code, a
    // nested list, a quote, a fence with a line too long for the trace, a table wider than it, a link, a rule.
    ev("assistant_text", { text: MARKDOWN }),
    ev("tool_call", { call_id: "toolu_3", name: "Bash", input: input({ command: "npm run build" }) }),
  ];
  if (busy) {
    // The build answered, then a run of reads, searches and edits, the last still running.
    ring.push(ev("tool_result", { call_id: "toolu_3", is_error: false, summary: "built in 4.2 s" }));
    const files = ["src/search/tags.ts", "src/search/parse.ts", "src/routes/gadgets.ts", "test/search.test.ts", "test/tags.test.ts", "src/search/index.ts"];
    files.forEach((f, i) => {
      ring.push(ev("tool_call", { call_id: `toolu_b${i}r`, name: "Read", input: input({ file_path: f }) }));
      ring.push(ev("tool_result", { call_id: `toolu_b${i}r`, is_error: false, summary: `${40 + i * 7} lines` }));
      ring.push(ev("tool_call", { call_id: `toolu_b${i}g`, name: "Grep", input: input({ pattern: `tag${i}`, path: f }) }));
      ring.push(ev("tool_result", { call_id: `toolu_b${i}g`, is_error: false, summary: `${i} matches` }));
    });
    ring.push(ev("assistant_text", { text: "Found every caller. Updating the parser now." }));
    ring.push(ev("tool_call", { call_id: "toolu_b9e", name: "Edit", input: input({ file_path: "src/search/parse.ts", old_string: "split(',')", new_string: "split(/\\s*,\\s*/)" }) }));
  }
  const messages = [{ type: "history", before: "c2" }, ...ring, { type: "live" }];
  return { messages, pages };
}
