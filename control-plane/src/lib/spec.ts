// Templates, capabilities and spawn specs (docs/agents/capabilities/, docs/orchestration/): data, not
// code. A capability names platform tools, the permission rules they need and a prompt section; a
// template lists capabilities plus launch, hands, credential and escalation. Expanding a spawn spec
// against them gives the agent's stored spec. Everything here is pure and synchronous: the catalog
// is passed in, nothing is awaited, and errors are returned, not thrown.
import { z } from "zod";
import { LaunchConfig, ToolRule } from "../protocol/control";

/** A catalog entry's name: lowercase, digits and `-`. */
export const CatalogName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "names are lowercase letters, digits and '-'");

/**
 * A Claude setup token's BrokerDO secret name. Only these names: a credential is resolved into
 * `agent_start` and sent to a brain host, so it must never name another kind of secret.
 */
export const Credential = z.string().regex(/^claude_oauth_token(:[A-Za-z0-9_.-]{1,64})?$/, "a credential is claude_oauth_token or claude_oauth_token:<name>");

/**
 * Where an agent's questions go (`ask`, approvals) until channels exist: the user's notification
 * queue, or the workstream channel (a `needs_input` event that wakes its subscriber).
 */
export const EscalateTo = z.enum(["user", "workstream"]);
export type EscalateTo = z.output<typeof EscalateTo>;

export const Capability = z.object({
  /** Platform tools (from `platform-tools.json`). */
  tools: z.array(z.string()).default([]),
  /** Permission rules the tools need, as the runner's hook rules. */
  rules: z.array(ToolRule).default([]),
  /** Added to the system prompt (after the template's own text). */
  prompt: z.string().default(""),
});
export type Capability = z.output<typeof Capability>;

export const Template = z.object({
  capabilities: z.array(CatalogName),
  /** Model, effort, built-in tools and the base system prompt; capability prompts are appended to its text. */
  launch: LaunchConfig,
  /** Whether a spawn from it takes a sandbox: `required`, `forbidden` or `optional`. */
  hands: z.enum(["required", "forbidden", "optional"]),
  credential: Credential,
  escalate_to: EscalateTo,
  /** Channels the new agent subscribes to at spawn: `workstream` is its workstream's. */
  subscribe: z.array(z.literal("workstream")).default([]),
});
export type Template = z.output<typeof Template>;

/** What a spawn may change. `tools` only narrows (no tool the template doesn't give). */
export const SpecOverrides = z.object({
  launch: LaunchConfig.optional(),
  rules: z.array(ToolRule).optional(),
  tools: z.array(z.string()).optional(),
  escalate_to: EscalateTo.optional(),
  credential: Credential.optional(),
});
export type SpecOverrides = z.output<typeof SpecOverrides>;

/** An agent's expanded spec, as AgentDO stores it: nothing refers back to the template. */
export interface AgentSpec {
  /** The template it came from (for display; never consulted again). */
  template: string;
  /** Platform tools, in registry order. */
  tools: string[];
  launch: LaunchConfig;
  rules: ToolRule[];
  credential: string;
  escalate_to: EscalateTo;
  subscribe: "workstream"[];
}

export interface Catalog {
  capabilities: Readonly<Record<string, Capability>>;
  templates: Readonly<Record<string, Template>>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

// --- The seed catalog: what the `worker` and `captain` roles did --------------------------------------

/** Seeded into an empty catalog; also what records stored with a role are migrated from. */
export const SEED_CATALOG: Catalog = {
  capabilities: {
    // Every agent's nest MCP tools run without a prompt: the platform checks each call itself.
    nest: { tools: [], rules: [{ pattern: "mcp__nest__*", decision: "allow" }], prompt: "" },
    hands: {
      tools: ["checkpoint", "expose_port"],
      rules: [],
      prompt: "You work in a remote sandbox through the mcp__nest__* tools; they behave like Claude Code's built-ins.",
    },
    // Claude Code's subagents (`Agent`, `Task` before 2.1) without an approval.
    subagents: { tools: [], rules: [{ pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }], prompt: "" },
    messaging: { tools: ["notify", "ask"], rules: [], prompt: "" },
    transcripts: { tools: ["read_transcript"], rules: [], prompt: "" },
    events: { tools: ["emit"], rules: [], prompt: "" },
    sandboxes: { tools: ["fork_sandbox"], rules: [], prompt: "" },
    brokered: { tools: ["brokered"], rules: [], prompt: "" },
    management: {
      tools: ["spawn_agent", "attach", "spawn_workstream", "send", "list_workstreams", "get_status", "wait_events", "approve", "deny",
        "merge", "kill", "delegate", "notify_user"],
      rules: [],
      prompt: "",
    },
    memory: { tools: ["memory_read", "memory_write"], rules: [], prompt: "" },
  },
  templates: {
    worker: {
      capabilities: ["nest", "hands", "subagents", "messaging", "transcripts", "events", "sandboxes", "brokered"],
      launch: { builtin_tools: ["TodoWrite", "Task", "WebSearch"], system_prompt: { mode: "append", text: "" } },
      hands: "required",
      credential: "claude_oauth_token:worker",
      escalate_to: "workstream",
      subscribe: [],
    },
    captain: {
      capabilities: ["nest", "messaging", "transcripts", "sandboxes", "brokered", "management", "memory"],
      launch: {
        builtin_tools: [],
        system_prompt: { mode: "replace", text: "You are a nest captain. You act only through mcp__nest__* platform tools." },
      },
      hands: "forbidden",
      credential: "claude_oauth_token:captain",
      escalate_to: "user",
      subscribe: ["workstream"],
    },
  },
};

// --- Validation of catalog entries -------------------------------------------------------------------

/** A capability names only platform tools, each once. */
export function checkCapability(cap: Capability, registry: readonly string[]): Result<Capability> {
  const seen = new Set<string>();
  for (const t of cap.tools) {
    if (!registry.includes(t)) return err(`unknown platform tool ${t}`);
    if (seen.has(t)) return err(`tool ${t} listed twice`);
    seen.add(t);
  }
  return ok(cap);
}

/** A template lists only capabilities that exist, each once. */
export function checkTemplate(tpl: Template, capabilities: Readonly<Record<string, Capability>>): Result<Template> {
  const seen = new Set<string>();
  for (const c of tpl.capabilities) {
    if (!Object.hasOwn(capabilities, c)) return err(`unknown capability ${c}`);
    if (seen.has(c)) return err(`capability ${c} listed twice`);
    seen.add(c);
  }
  return ok(tpl);
}

/** Templates that list capability `name` (it can't be deleted while any does). */
export function templatesUsing(catalog: Catalog, name: string): string[] {
  return Object.entries(catalog.templates).filter(([, t]) => t.capabilities.includes(name)).map(([n]) => n).sort();
}

// --- Expansion ---------------------------------------------------------------------------------------

const ruleKey = (r: ToolRule) => JSON.stringify([r.pattern, r.decision, r.reason ?? null]);

/**
 * Expand template `name` with `overrides`, without the hands check (records stored before templates
 * are migrated through this; a spawn goes through {@link expandSpec}).
 */
export function expandTemplate(catalog: Catalog, registry: readonly string[], name: string, overrides: SpecOverrides = {}): Result<AgentSpec> {
  if (!Object.hasOwn(catalog.templates, name)) return err(`unknown template ${name}`);
  const tpl = catalog.templates[name]!;
  const caps: Capability[] = [];
  for (const c of tpl.capabilities) {
    if (!Object.hasOwn(catalog.capabilities, c)) return err(`template ${name}: unknown capability ${c}`);
    const cap = catalog.capabilities[c]!;
    const checked = checkCapability(cap, registry);
    if (!checked.ok) return err(`capability ${c}: ${checked.error}`);
    caps.push(cap);
  }
  const given = new Set(caps.flatMap((c) => c.tools));
  let tools = registry.filter((t) => given.has(t));
  if (overrides.tools) {
    const wider = overrides.tools.filter((t) => !given.has(t));
    if (wider.length) return err(`template ${name} doesn't give ${wider.join(", ")}`);
    const narrowed = new Set(overrides.tools);
    tools = tools.filter((t) => narrowed.has(t));
  }
  // Rules in capability order, each once (first occurrence kept).
  let rules = overrides.rules;
  if (!rules) {
    const seen = new Set<string>();
    rules = [];
    for (const r of caps.flatMap((c) => c.rules)) {
      if (seen.has(ruleKey(r))) continue;
      seen.add(ruleKey(r));
      rules.push(r);
    }
  }
  const prompt = [tpl.launch.system_prompt.text, ...caps.map((c) => c.prompt)].filter((t) => t.length > 0).join("\n\n");
  const launch = overrides.launch ?? { ...tpl.launch, system_prompt: { ...tpl.launch.system_prompt, text: prompt } };
  return ok({
    template: name,
    tools,
    launch,
    rules,
    credential: overrides.credential ?? tpl.credential,
    escalate_to: overrides.escalate_to ?? tpl.escalate_to,
    subscribe: [...tpl.subscribe],
  });
}

/** A spawn spec: a template, whether a sandbox is given (hands), and overrides. */
export interface SpawnSpec {
  template: string;
  hands: boolean;
  overrides?: SpecOverrides;
}

/** Expand a spawn spec: the template's hands rule, then {@link expandTemplate}. */
export function expandSpec(catalog: Catalog, registry: readonly string[], spec: SpawnSpec): Result<AgentSpec> {
  const tpl = Object.hasOwn(catalog.templates, spec.template) ? catalog.templates[spec.template]! : undefined;
  if (!tpl) return err(`unknown template ${spec.template}`);
  if (tpl.hands === "required" && !spec.hands) return err(`template ${spec.template} needs a sandbox`);
  if (tpl.hands === "forbidden" && spec.hands) return err(`template ${spec.template} has no hands`);
  return expandTemplate(catalog, registry, spec.template, spec.overrides);
}

// --- Records stored with a role (the previous release) ----------------------------------------------

/** The fields an AgentInfo stored by the previous release carried instead of a spec. */
export interface RoleRecord {
  role: "worker" | "captain";
  grants?: string[] | null;
  launch: LaunchConfig;
  rules: ToolRule[];
}

/**
 * The spec a role-era record means: its role's seed template, with the launch and rules it stored
 * (they were already that role's defaults or the operator's overrides) and its grant list narrowing
 * the tools (names the role didn't offer are ignored, as they were).
 */
export function specFromRole(registry: readonly string[], rec: RoleRecord): AgentSpec {
  const r = expandTemplate(SEED_CATALOG, registry, rec.role, { launch: rec.launch, rules: rec.rules });
  if (!r.ok) throw new Error(`seed template ${rec.role}: ${r.error}`);
  const grants = rec.grants;
  return grants ? { ...r.value, tools: r.value.tools.filter((t) => grants.includes(t)) } : r.value;
}
