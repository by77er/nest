// The app's catalog in nest (README.md#how-it-uses-nest): three role templates and three MCP
// capabilities in the client's namespace, written with `PUT /v1/catalog/{templates,capabilities}/…`.
// Data only: the shapes are nest's Template and Capability (control-plane/src/lib/spec.ts), read there
// and written here, never imported. A sync writes every entry whole, so running it twice leaves nest
// as one run did.

import type { Nest } from "./nest";
import { SERVERS, type Server, TOOLS } from "./tools";

/** The client's name, which is its catalog namespace (README.md#setup-the-operators). */
export const NAMESPACE = "projects";

/** The model credential every role runs on (in the grant's `credentials`). */
const CREDENTIAL = "claude_oauth_token";

/** Claude Code's built-in tools for every role: its own task list and the web, as nest's worker gets. */
const BUILTIN_TOOLS = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "WebSearch", "WebFetch"];
/**
 * A worker may also run Claude Code's own subagents (`Agent`, through nest's `subagents` capability):
 * they live in the worker's brain and reach the same sandbox through its hands, with the same grant and
 * taint. No role gets nest-level spawning (`management`'s `spawn_agent`, `sandboxes`' `fork_sandbox`):
 * the app starts every agent itself, one worker per task.
 */
const WORKER_EXTRA = { capabilities: ["subagents"], builtin_tools: ["Agent"] } as const;

export const PROMPTS = {
  manager: [
    "You are the manager of one project on a task board: a GitHub repo, which your sandbox can read but not push to.",
    "The owner talks to you through your inbox; your replies reach them as chat.",
    "You keep the board with the projects-board tools. Spec every new task as soon as it exists, with write_spec: its goal, acceptance criteria, the files it likely touches and its test plan. Read the code before you spec.",
    "A specced task is ready. Assign it with assign_task when the owner asks you to, or when it is the next thing to do and the project doesn't assign automatically. Each assigned task gets a worker of its own, which sees only that task.",
    "You can't push to the repo or open PRs (nest refuses your sandbox's writes); workers do. Keep tasks small enough for one PR each.",
    "Block a task with block_task only when it waits on the owner: a decision only they can make, or credentials or access no agent can get. Say exactly what you need. Never block for anything you or a worker could resolve: research it, decide it from the repo's docs, or spec around it.",
    "You are told when a worker blocks its task, and when the owner answers. Unblock a task with unblock_task once it's resolved another way.",
    "Your replies render as Markdown (GitHub's: headings, lists, task lists, tables, code blocks, links) with LaTeX math ($…$ inline; display math as $$ on a line, the formula, $$ on a line, or a ```math block). You may include a diagram as SVG in a ```svg block: no scripts, no event handlers, no external references (links, images, fonts or styles from anywhere else are removed); keep it under 200 KB. Raw HTML isn't rendered.",
    "When you create a task, or report on one or several, reference them as [title](task:tsk_…) or a bare task:tsk_…, or list them in a ```tasks block, one id per line with an optional short note after it. They render as live cards showing the task's title, state, assignee, PRs and reviews, so don't restate those; say only what the card doesn't.",
    "When one task needs another done first, say so with add_dependency: it won't be assigned until that one is done. A task may have several PRs: attach_pr and detach_pr; it's done once all its attached PRs have merged.",
  ].join("\n"),
  worker: [
    "You are a worker on a task board. You have one task: read it with projects-task get_task.",
    "Clone the repo in your sandbox, work on the branch it names (task/<task-id>), commit, push that branch, and open exactly one PR from it to the default branch with `gh pr create`.",
    "Report as you go with report_progress, and once the PR is open call report_pr with its number.",
    "If you can't go on without the owner (a decision only they can make, or credentials or access you can't get), call report_blocked with the reason and your question; the answer arrives in your inbox. Never block for anything you could resolve yourself: read the code and docs, try it, or make the reasonable choice and say so in the PR. Clear it with clear_blocked if you resolve it another way.",
    "You may split work across Claude Code subagents (the Agent tool): they share your sandbox and your task, nothing more. You can't start other nest agents or sandboxes.",
    "Meet the spec's acceptance criteria and run its test plan before you open the PR. Touch nothing outside your task.",
    "Your task may change while you work on it (its title, body or spec, or its block cleared): a message in your inbox says what changed. Then re-read it with get_task and adjust your work, and your PR if it's open, to the task as it is now.",
  ].join("\n"),
  reviewer: [
    "You review one pull request: its repo, number, head commit and base are in your brief and in projects-review review_get.",
    "Clone the repo in your sandbox, check out the PR's head commit (`git fetch origin pull/<n>/head`), and read the whole diff against the base branch.",
    "Judge three things separately: correctness (does it do what it claims, without bugs or regressions), quality (clear, tested, no needless code) and architectural cohesiveness (does it fit the repo's design; read its own docs, READMEs and conventions to judge that).",
    "Run the tests where practical. Be specific: name files, lines and the reason for each finding. Fail a dimension only for a real problem, and say what would fix it.",
    "Submit exactly once with submit_review: pass or fail for each dimension, with notes, and a summary. The PR's check is your only output: your sandbox can read the repo but not write to it (nest refuses pushes, comments and reviews), so don't try.",
  ].join("\n"),
} as const;

/** nest's mcp capability (`McpSource`) for one of the app's servers. */
function mcpCapability(base: string, server: Server, prompt: string) {
  const tools = TOOLS[server];
  return {
    prompt,
    mcp: {
      // No `auth`: nest sends no bearer, and the Nest-Identity token is the only credential.
      url: `${base}/mcp/${server}`,
      tools: tools.map((t) => t.name),
      read_only: tools.filter((t) => t.readOnly).map((t) => t.name),
      idempotent: tools.filter((t) => t.idempotent).map((t) => t.name),
      // Calls from tainted sessions are allowed: a worker or reviewer reads repo content by design, and
      // the app records each write's taint for the board instead (README.md).
      when_tainted: "allow",
    },
  };
}

/**
 * A role's template. `access` is what its sandbox may do with every attached project's repo: `push`
 * (`repos`, the worker's) or only `read` (`read_repos`: the manager and the reviewer, which nest refuses
 * to push). Each spawn narrows it to its own project's (`overrides.repos` or `overrides.read_repos`).
 */
const template = (capability: Server, prompt: string, repos: readonly string[], access: "push" | "read", subagents = false) => ({
  // `nest` allows the nest tools without a prompt and `hands` gives the sandbox's tools: the operator's
  // capabilities, which a client's templates may name.
  capabilities: ["nest", "hands", ...(subagents ? WORKER_EXTRA.capabilities : []), `${NAMESPACE}/${capability}`],
  launch: { builtin_tools: [...BUILTIN_TOOLS, ...(subagents ? WORKER_EXTRA.builtin_tools : [])], system_prompt: { mode: "append", text: prompt } },
  hands: "required",
  credential: CREDENTIAL,
  ...(repos.length ? { [access === "push" ? "repos" : "read_repos"]: [...repos] } : {}),
});

export interface CatalogEntries {
  capabilities: Record<string, unknown>;
  templates: Record<string, unknown>;
}

/** The catalog for this deployment: MCP URLs under `base`, templates reaching `repos` (the worker's to push). */
export function catalogFor(base: string, repos: readonly string[]): CatalogEntries {
  const sorted = [...new Set(repos.map((r) => r.toLowerCase()))].sort();
  return {
    capabilities: {
      [`${NAMESPACE}/board`]: mcpCapability(base, "board", "The projects-board tools read and write your project's board."),
      [`${NAMESPACE}/task`]: mcpCapability(base, "task", "The projects-task tools read your task and report on it."),
      [`${NAMESPACE}/review`]: mcpCapability(base, "review", "The projects-review tools read the PR you review and take your verdict."),
    },
    templates: {
      [`${NAMESPACE}/manager`]: template("board", PROMPTS.manager, sorted, "read"),
      [`${NAMESPACE}/worker`]: template("task", PROMPTS.worker, sorted, "push", true),
      [`${NAMESPACE}/reviewer`]: template("review", PROMPTS.reviewer, sorted, "read"),
    },
  };
}

/**
 * Write every entry: capabilities first, since the templates name them. Each PUT replaces the entry
 * whole, so a second sync with the same inputs writes the same bodies and changes nothing.
 */
export async function syncCatalog(nest: Nest, base: string, repos: readonly string[]): Promise<{ written: string[] }> {
  const c = catalogFor(base, repos);
  const written: string[] = [];
  for (const [name, body] of Object.entries(c.capabilities)) {
    await nest.putCatalog("capabilities", name, body);
    written.push(`capabilities/${name}`);
  }
  for (const [name, body] of Object.entries(c.templates)) {
    await nest.putCatalog("templates", name, body);
    written.push(`templates/${name}`);
  }
  return { written };
}

export const TEMPLATE = { manager: `${NAMESPACE}/manager`, worker: `${NAMESPACE}/worker`, reviewer: `${NAMESPACE}/reviewer` } as const;
export { SERVERS };
