// The MCP servers' tools (README.md#the-mcp-server-agents-see-only-their-own-work): one server per
// role, so a role's tool list is its URL's. The catalog (src/catalog.ts) names the same tools, and their
// read-only and idempotent marks, so nest's connector and retries agree with what the server does.

export const SERVERS = ["board", "task", "review"] as const;
export type Server = (typeof SERVERS)[number];
export type Role = "manager" | "worker" | "reviewer";

/** The role whose agents a server serves. */
export const ROLE_OF: Record<Server, Role> = { board: "manager", task: "worker", review: "reviewer" };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Reads only: nest may retry it, and it is not a sink. */
  readOnly?: boolean;
  /** Safe to run twice with the same arguments (a set, not an append). */
  idempotent?: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string, maxLength = 4000) => ({ type: "string", description, maxLength });
const strs = (description: string) => ({ type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 50, description });
const taskId = str("The task's id (tsk_…).", 64);
const dimension = (question: string) => ({
  ...obj({ verdict: { type: "string", enum: ["pass", "fail"], description: question }, notes: str("Why: specific files, lines and reasons.", 20000) }, ["verdict", "notes"]),
  description: question,
});

export const TOOLS: Record<Server, readonly ToolDef[]> = {
  board: [
    { name: "list_tasks", description: "The project's board: every task in board order with its state, assignee and PR, and the project's settings.", inputSchema: obj({}), readOnly: true, idempotent: true },
    { name: "get_task", description: "One task in full: its body, spec and history.", inputSchema: obj({ task: taskId }, ["task"]), readOnly: true, idempotent: true },
    { name: "create_task", description: "Add a task to the board as a draft. Spec it next with write_spec.", inputSchema: obj({ title: str("A short title.", 200), body: str("What is wanted and why.", 20000) }, ["title"]) },
    {
      name: "write_spec",
      description: "Write a draft or ready task's spec, which makes it ready to assign: its goal, acceptance criteria, the files it likely touches and its test plan.",
      inputSchema: obj({
        task: taskId,
        goal: str("What the change achieves, in a sentence or two."),
        acceptance_criteria: strs("Checkable statements that hold once it's done."),
        files: strs("Files or directories it likely touches."),
        test_plan: str("How the worker proves it works."),
      }, ["task", "goal", "acceptance_criteria", "files", "test_plan"]),
      idempotent: true,
    },
    { name: "update_task", description: "Change a task's title or body.", inputSchema: obj({ task: taskId, title: str("A short title.", 200), body: str("What is wanted and why.", 20000) }, ["task"]), idempotent: true },
    { name: "assign_task", description: "Assign a ready (or stalled) task: the app starts a worker for it.", inputSchema: obj({ task: taskId }, ["task"]), idempotent: true },
    { name: "cancel_task", description: "Cancel a task that isn't done; its worker, if any, is stopped.", inputSchema: obj({ task: taskId, reason: str("Why.", 1000) }, ["task"]), idempotent: true },
    {
      name: "block_task",
      description: "Mark a task blocked on the owner: a decision only they can make, or credentials or access you can't get. It shows at the top of the owner's board until they answer or you clear it. Not for anything you could resolve yourself.",
      inputSchema: obj({ task: taskId, reason: str("What blocks it, specifically.", 2000), question: str("What you need the owner to answer or do, if anything.", 2000) }, ["task", "reason"]),
    },
    { name: "unblock_task", description: "Clear a task's block (resolved another way).", inputSchema: obj({ task: taskId, note: str("How it was resolved.", 1000) }, ["task"]), idempotent: true },
  ],
  task: [
    { name: "get_task", description: "Your task: its title, body, spec, repo and the branch to push.", inputSchema: obj({}), readOnly: true, idempotent: true },
    { name: "report_progress", description: "Tell the board how your task is going.", inputSchema: obj({ text: str("What you did or found.") }, ["text"]) },
    {
      name: "report_blocked",
      description: "Mark your task blocked on the owner: a decision only they can make, or credentials or access you can't get. It reaches the owner and your manager; the owner's answer arrives in your inbox. Not for anything you could resolve yourself.",
      inputSchema: obj({ reason: str("What blocks you, specifically.", 2000), question: str("What you need the owner to answer or do, if anything.", 2000) }, ["reason"]),
    },
    { name: "clear_blocked", description: "Clear your task's block (you resolved it another way).", inputSchema: obj({ note: str("How it was resolved.", 1000) }), idempotent: true },
    { name: "report_pr", description: "Tell the board you opened your task's PR (from its task branch).", inputSchema: obj({ number: { type: "integer", minimum: 1, description: "The PR's number." } }, ["number"]), idempotent: true },
  ],
  review: [
    { name: "review_get", description: "The PR you review, as the app knows it: its repo, number, head commit (sha), base branch and title.", inputSchema: obj({}), readOnly: true, idempotent: true },
    {
      name: "submit_review",
      description: "Your review, once: pass or fail for each of correctness, quality and architectural cohesiveness, each with specific notes, and a summary. The PR's check passes only if all three pass.",
      inputSchema: obj({
        correctness: dimension("Does it do what it claims, without bugs?"),
        quality: dimension("Is it clear, tested, and free of needless code?"),
        architecture: dimension("Does it fit the repo's design, docs and conventions?"),
        summary: str("The review's summary, shown as the check's summary.", 20000),
      }, ["correctness", "quality", "architecture", "summary"]),
    },
  ],
};

export const toolOf = (server: Server, name: string): ToolDef | undefined => TOOLS[server].find((t) => t.name === name);
