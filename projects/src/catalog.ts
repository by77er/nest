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

export const PROMPTS = {
  manager: [
    "You are the manager of one project on a task board: a GitHub repo, checked out read-only in your sandbox.",
    "The owner talks to you through your inbox; your replies reach them as chat.",
    "You keep the board with the projects-board tools. Spec every new task as soon as it exists, with write_spec: its goal, acceptance criteria, the files it likely touches and its test plan. Read the code before you spec.",
    "A specced task is ready. Assign it with assign_task when the owner asks you to, or when it is the next thing to do and the project doesn't assign automatically. Each assigned task gets a worker of its own, which sees only that task.",
    "Never push to the repo or open PRs yourself; workers do. Keep tasks small enough for one PR each.",
  ].join("\n"),
  worker: [
    "You are a worker on a task board. You have one task: read it with projects-task get_task.",
    "Clone the repo in your sandbox, work on the branch it names (task/<task-id>), commit, push that branch, and open exactly one PR from it to the default branch with `gh pr create`.",
    "Report as you go with report_progress, say when you are stuck with report_blocker, and once the PR is open call report_pr with its number.",
    "Meet the spec's acceptance criteria and run its test plan before you open the PR. Touch nothing outside your task.",
  ].join("\n"),
  reviewer: [
    "You review one pull request: its repo, number, head commit and base are in your brief and in projects-review review_get.",
    "Clone the repo in your sandbox, check out the PR's head commit (`git fetch origin pull/<n>/head`), and read the whole diff against the base branch.",
    "Judge three things separately: correctness (does it do what it claims, without bugs or regressions), quality (clear, tested, no needless code) and architectural cohesiveness (does it fit the repo's design; read its own docs, READMEs and conventions to judge that).",
    "Run the tests where practical. Be specific: name files, lines and the reason for each finding. Fail a dimension only for a real problem, and say what would fix it.",
    "Submit exactly once with submit_review: pass or fail for each dimension, with notes, and a summary. The PR's check is your only output: don't push, comment, approve or request changes on GitHub.",
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

const template = (capability: Server, prompt: string, repos: readonly string[]) => ({
  // `nest` allows the nest tools without a prompt and `hands` gives the sandbox's tools: the operator's
  // capabilities, which a client's templates may name.
  capabilities: ["nest", "hands", `${NAMESPACE}/${capability}`],
  launch: { builtin_tools: BUILTIN_TOOLS, system_prompt: { mode: "append", text: prompt } },
  hands: "required",
  credential: CREDENTIAL,
  // Every attached project's repo; each spawn narrows it to its own project's (`overrides.repos`).
  ...(repos.length ? { repos: [...repos] } : {}),
});

export interface CatalogEntries {
  capabilities: Record<string, unknown>;
  templates: Record<string, unknown>;
}

/** The catalog for this deployment: MCP URLs under `base`, templates allowed to push to `repos`. */
export function catalogFor(base: string, repos: readonly string[]): CatalogEntries {
  const sorted = [...new Set(repos.map((r) => r.toLowerCase()))].sort();
  return {
    capabilities: {
      [`${NAMESPACE}/board`]: mcpCapability(base, "board", "The projects-board tools read and write your project's board."),
      [`${NAMESPACE}/task`]: mcpCapability(base, "task", "The projects-task tools read your task and report on it."),
      [`${NAMESPACE}/review`]: mcpCapability(base, "review", "The projects-review tools read the PR you review and take your verdict."),
    },
    templates: {
      [`${NAMESPACE}/manager`]: template("board", PROMPTS.manager, sorted),
      [`${NAMESPACE}/worker`]: template("task", PROMPTS.worker, sorted),
      [`${NAMESPACE}/reviewer`]: template("review", PROMPTS.reviewer, sorted),
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
