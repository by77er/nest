// Templates, capabilities and spawn specs (docs/agents/capabilities/, docs/orchestration/): data, not
// code. A capability names platform tools, the permission rules they need and a prompt section; a
// template lists capabilities plus launch, hands, credential and escalation. Expanding a spawn spec
// against them gives the agent's stored spec. Everything here is pure and synchronous: the catalog
// is passed in, nothing is awaited, and errors are returned, not thrown.
import { z } from "zod";
import { Credential, LaunchConfig, setupTokenSecret, ToolRule } from "../protocol/control";

/** A catalog entry's name: lowercase, digits and `-`. */
export const CatalogName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "names are lowercase letters, digits and '-'");

/**
 * Where an agent's questions go (`ask`, approvals) until channels exist: the user's notification
 * queue, or the workstream channel (a `needs_input` event that wakes its subscriber).
 */
export const EscalateTo = z.enum(["user", "workstream"]);
export type EscalateTo = z.output<typeof EscalateTo>;
export const HandsRule = z.enum(["required", "forbidden", "optional"]);
export const Subscription = z.enum(["workstream"]);

export const Capability = z.object({
  /** Platform tools (from `platform-tools.json`). */
  tools: z.array(z.string()).default([]),
  /** Permission rules the tools need, as the runner's hook rules (first match wins). */
  rules: z.array(ToolRule).default([]),
  /** Added to the system prompt (after the template's own text). */
  prompt: z.string().default(""),
});
export type Capability = z.output<typeof Capability>;

export const Template = z.object({
  capabilities: z.array(CatalogName),
  /** Model, effort, built-in tools and the base system prompt; capability prompts are appended to its text. */
  launch: LaunchConfig,
  /** Whether a spawn from it takes a sandbox. */
  hands: HandsRule,
  credential: Credential,
  escalate_to: EscalateTo,
  /** Channels the new agent subscribes to at spawn: `workstream` is its workstream's. */
  subscribe: z.array(Subscription).default([]),
});
export type Template = z.output<typeof Template>;

/**
 * What the operator may change at spawn (the admin API only; it holds the root): replace the launch
 * or the rules, narrow the tools, and pick the escalation and the setup token.
 */
export const OperatorOverrides = z.object({
  launch: LaunchConfig.optional(),
  rules: z.array(ToolRule).optional(),
  tools: z.array(z.string()).optional(),
  escalate_to: EscalateTo.optional(),
  credential: Credential.optional(),
});
export type OperatorOverrides = z.output<typeof OperatorOverrides>;

/**
 * What an agent spawning another may change: it can only narrow. `tools` is a subset of the
 * template's, and `rules` only `deny` or `ask`, placed before the template's (first match wins), so
 * they can only take permissions away. No launch, built-in tools, credential or escalation: those
 * stay the template's. Anything else is refused (`strict`).
 */
export const SpawnerOverrides = z.strictObject({
  tools: z.array(z.string()).optional(),
  rules: z.array(ToolRule.extend({ decision: z.enum(["deny", "ask"]) })).optional(),
});
export type SpawnerOverrides = z.output<typeof SpawnerOverrides>;

/** An agent's expanded spec, as AgentDO stores it: nothing refers back to the template. */
export interface AgentSpec {
  /** The template it came from: shown, and the sender label of its inbox posts; never consulted again. */
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

// --- The seed catalog ---------------------------------------------------------------------------------

/** Seeded into an empty catalog: what the `worker` and `captain` roles gave. */
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
      credential: setupTokenSecret("worker"),
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
      credential: setupTokenSecret("captain"),
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
const dedupeRules = (rules: readonly ToolRule[]): ToolRule[] => {
  const seen = new Set<string>();
  const out: ToolRule[] = [];
  for (const r of rules) {
    if (seen.has(ruleKey(r))) continue;
    seen.add(ruleKey(r));
    out.push(r);
  }
  return out;
};

/** Template `name` expanded as it stands: no overrides, no hands check. */
export function expandTemplate(catalog: Catalog, registry: readonly string[], name: string): Result<AgentSpec> {
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
  const prompt = [tpl.launch.system_prompt.text, ...caps.map((c) => c.prompt)].filter((t) => t.length > 0).join("\n\n");
  return ok({
    template: name,
    tools: registry.filter((t) => given.has(t)),
    launch: { ...tpl.launch, system_prompt: { ...tpl.launch.system_prompt, text: prompt } },
    // In capability order, each once (first occurrence kept).
    rules: dedupeRules(caps.flatMap((c) => c.rules)),
    credential: tpl.credential,
    escalate_to: tpl.escalate_to,
    subscribe: [...tpl.subscribe],
  });
}

/** `tools` narrowed to `subset`, which must not name a tool `tools` lacks. */
function narrowTools(name: string, tools: string[], subset: readonly string[] | undefined): Result<string[]> {
  if (!subset) return ok(tools);
  const wider = subset.filter((t) => !tools.includes(t));
  if (wider.length) return err(`template ${name} doesn't give ${wider.join(", ")}`);
  return ok(tools.filter((t) => subset.includes(t)));
}

/**
 * A spawn spec: a template, whether a sandbox is given (hands), and overrides, from the operator (the
 * admin API) or from a spawning agent (which can only narrow; see {@link SpawnerOverrides}).
 */
export type SpawnSpec =
  | { template: string; hands: boolean; by: "operator"; overrides?: OperatorOverrides }
  | { template: string; hands: boolean; by: "spawner"; overrides?: SpawnerOverrides };

/** Expand a spawn spec: the template's hands rule, the template, then the overrides its author may make. */
export function expandSpec(catalog: Catalog, registry: readonly string[], spec: SpawnSpec): Result<AgentSpec> {
  const tpl = Object.hasOwn(catalog.templates, spec.template) ? catalog.templates[spec.template]! : undefined;
  if (!tpl) return err(`unknown template ${spec.template}`);
  if (tpl.hands === "required" && !spec.hands) return err(`template ${spec.template} needs a sandbox`);
  if (tpl.hands === "forbidden" && spec.hands) return err(`template ${spec.template} has no hands`);
  const base = expandTemplate(catalog, registry, spec.template);
  if (!base.ok) return base;
  if (spec.by === "spawner") {
    // Parsed again: a caller's object that carries anything else is refused, whatever its type said.
    const o = SpawnerOverrides.safeParse(spec.overrides ?? {});
    if (!o.success) return err(`a spawner can only narrow tools and add deny or ask rules: ${o.error.issues.map((i) => i.message).join("; ")}`);
    const tools = narrowTools(spec.template, base.value.tools, o.data.tools);
    if (!tools.ok) return tools;
    return ok({ ...base.value, tools: tools.value, rules: dedupeRules([...(o.data.rules ?? []), ...base.value.rules]) });
  }
  const o = spec.overrides ?? {};
  const tools = narrowTools(spec.template, base.value.tools, o.tools);
  if (!tools.ok) return tools;
  return ok({
    ...base.value,
    tools: tools.value,
    launch: o.launch ?? base.value.launch,
    rules: o.rules ?? base.value.rules,
    credential: o.credential ?? base.value.credential,
    escalate_to: o.escalate_to ?? base.value.escalate_to,
  });
}

/** The previous release's `grants` field on the admin route: intersects the tools silently, as it did. */
export function intersectTools(spec: AgentSpec, grants: readonly string[]): AgentSpec {
  return { ...spec, tools: spec.tools.filter((t) => grants.includes(t)) };
}

// --- Records stored with a role (the previous release) ----------------------------------------------

/**
 * What each role meant when records were stored with one, frozen here so editing the seed (or the
 * catalog) never changes how an old record is read. (A test checks the seed still expands to it.)
 */
export const ROLE_SPECS: Readonly<Record<"worker" | "captain", Omit<AgentSpec, "launch" | "rules" | "subscribe">>> = {
  worker: {
    template: "worker",
    tools: ["notify", "emit", "ask", "fork_sandbox", "read_transcript", "checkpoint", "expose_port", "brokered"],
    credential: setupTokenSecret("worker"),
    escalate_to: "workstream",
  },
  captain: {
    template: "captain",
    tools: ["notify", "ask", "spawn_agent", "fork_sandbox", "attach", "read_transcript", "brokered", "spawn_workstream", "send",
      "list_workstreams", "get_status", "wait_events", "approve", "deny", "merge", "kill", "delegate", "memory_read", "memory_write",
      "notify_user"],
    credential: setupTokenSecret("captain"),
    escalate_to: "user",
  },
};

/** The fields an AgentInfo stored by the previous release carried instead of a spec. */
export interface RoleRecord {
  role: "worker" | "captain";
  grants?: string[] | null;
  launch: LaunchConfig;
  rules: ToolRule[];
}

/**
 * The spec a role-era record means: its role's frozen spec, with the launch and rules it stored
 * (they were already that role's defaults or the operator's overrides) and its grant list narrowing
 * the tools (names the role didn't offer are ignored, as they were).
 */
export function specFromRole(rec: RoleRecord): Omit<AgentSpec, "subscribe"> {
  const r = ROLE_SPECS[rec.role];
  const grants = rec.grants;
  return { ...r, tools: grants ? r.tools.filter((t) => grants.includes(t)) : [...r.tools], launch: rec.launch, rules: rec.rules };
}
