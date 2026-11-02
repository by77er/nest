// Templates, capabilities and spawn specs (docs/agents/capabilities/, docs/orchestration/): data, not
// code. A capability names platform tools, the permission rules they need and a prompt section; a
// template lists capabilities plus launch, hands and credential. Expanding a spawn spec
// against them gives the agent's stored spec. Everything here is pure and synchronous: the catalog
// is passed in, nothing is awaited, and errors are returned, not thrown.
import { z } from "zod";
import { Credential, LaunchConfig, setupTokenSecret, ToolRule } from "../protocol/control";
import { capabilityNameClash, checkMcpUrl, grantOf, type McpGrant, McpSource } from "./mcp";
import { actionOfTool, BROKERED_TOOL_NAMES, BrokeredSource, type BrokeredGrant, checkBrokered, grantOfEntry, scopeToRepos } from "./brokered";
import { canonicalRepos, narrowRepos, Repos } from "./repos";
import { MIN_IDLE_TTL_MS, narrowTtl } from "./lifetimes";

/** A catalog entry's name: lowercase, digits and `-`. */
export const CatalogName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "names are lowercase letters, digits and '-'");

export const HandsRule = z.enum(["required", "forbidden", "optional"]);

export const Capability = z.object({
  /** Platform tools (from `platform-tools.json`). */
  tools: z.array(z.string()).default([]),
  /** Permission rules the tools need, as the runner's hook rules (first match wins). */
  rules: z.array(ToolRule).default([]),
  /** Added to the system prompt (after the template's own text). */
  prompt: z.string().default(""),
  /** A remote MCP server whose tools it gives, as `<capability>_<tool>` (docs/agents/capabilities/mcp/). */
  mcp: McpSource.optional(),
  /** Brokered actions it grants, each scoped (docs/agents/capabilities/#brokered-actions): GitHub actions to repos, http profiles. */
  brokered: BrokeredSource.optional(),
  /** The templates its `agent_spawn` may spawn from (the spawn grant; docs/agents/#spawning). */
  spawn: z.array(CatalogName).optional(),
});
export type Capability = z.output<typeof Capability>;

export const Template = z.object({
  capabilities: z.array(CatalogName),
  /** Model, effort, built-in tools and the base system prompt; capability prompts are appended to its text. */
  launch: LaunchConfig,
  /** Whether a spawn from it takes a sandbox. */
  hands: HandsRule,
  credential: Credential,
  /**
   * The repos its agents may push to (docs/sandbox/networking/egress/policy/#repo-allowlists): joined to
   * its sandbox's allowlist while attached, and the scope of its unscoped GitHub brokered actions.
   */
  repos: Repos.optional(),
  /** Its agents stop themselves once their work is done (docs/agents/#lifetimes); a spawn may set it, never clear it. */
  ephemeral: z.boolean().optional(),
  /** The idle TTL of a sandbox `agent_spawn` creates for its agents (a spawn may only shorten it); absent: the cell default. */
  sandbox_idle_ttl_ms: z.number().int().min(MIN_IDLE_TTL_MS).optional(),
  /** A spawner may attach an agent of this template to the spawner's own sandbox (`agent_spawn{sandbox: share}`). */
  share_sandbox: z.boolean().optional(),
});
export type Template = z.output<typeof Template>;

/**
 * What the operator may change at spawn (the admin API only; it holds the root): replace the launch
 * or the rules, narrow the tools, and pick the setup token.
 */
export const OperatorOverrides = z.object({
  launch: LaunchConfig.optional(),
  rules: z.array(ToolRule).optional(),
  tools: z.array(z.string()).optional(),
  credential: Credential.optional(),
  /** The push allowlist, replacing the template's. */
  repos: Repos.optional(),
  /** Replaces the template's. */
  ephemeral: z.boolean().optional(),
});
export type OperatorOverrides = z.output<typeof OperatorOverrides>;

/**
 * What an agent spawning another may change: it can only narrow. `tools` is a subset of the
 * template's, and `rules` only `deny` or `ask`, placed before the template's (first match wins), so
 * they can only take permissions away. No launch, built-in tools or credential: those
 * stay the template's. Lifetimes only shorten: `ephemeral` can be set, never cleared, and the sandbox's
 * idle TTL only lowered. Anything else is refused (`strict`).
 */
export const SpawnerOverrides = z.strictObject({
  tools: z.array(z.string()).optional(),
  rules: z.array(ToolRule.extend({ decision: z.enum(["deny", "ask"]) })).optional(),
  /**
   * A subset of the template's push allowlist. Narrowed against the template, not the spawner's own:
   * the spawn grant on the template (a capability's `spawn`) is the operator's authorization for what
   * it gives, as for tools (a captain holds no repos, yet spawns workers that push).
   */
  repos: Repos.optional(),
  ephemeral: z.literal(true).optional(),
  sandbox_idle_ttl_ms: z.number().int().min(MIN_IDLE_TTL_MS).optional(),
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
  /** Its mcp capabilities' servers, in capability order; absent when it has none (as is every stored spec before them). */
  mcp?: McpGrant[];
  /** Its brokered action grants, in capability order; absent when it has none (as is every stored spec before them). */
  brokered?: BrokeredGrant[];
  /** Its push allowlist, canonical; absent when empty (as is every stored spec before it). */
  repos?: string[];
  /** The templates it may spawn from: the union of its capabilities' `spawn`; absent when none. */
  spawn?: string[];
  /** It stops itself once its work is done (docs/agents/#lifetimes); absent: it doesn't. */
  ephemeral?: true;
  /** The idle TTL of a sandbox created for it at spawn; absent: the cell default. */
  sandbox_idle_ttl_ms?: number;
}

export interface Catalog {
  capabilities: Readonly<Record<string, Capability>>;
  templates: Readonly<Record<string, Template>>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

// --- The seed catalog ---------------------------------------------------------------------------------

const cap = (tools: readonly string[], rules: ToolRule[] = [], prompt = ""): Capability => ({ tools: [...tools], rules, prompt });

/** The first seed (version 1): what the `worker` and `captain` roles gave. Frozen: catalogs seeded with it are migrated from it. */
export const SEED_CATALOG_V1: Catalog = {
  capabilities: {
    // Every agent's nest MCP tools run without a prompt: the platform checks each call itself.
    nest: cap([], [{ pattern: "mcp__nest__*", decision: "allow" }]),
    hands: cap(["checkpoint", "expose_port"], [],
      "You work in a remote sandbox through the mcp__nest__* tools; they behave like Claude Code's built-ins."),
    // Claude Code's subagents (`Agent`, `Task` before 2.1) without an approval.
    subagents: cap([], [{ pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }]),
    messaging: cap(["notify", "ask"]),
    transcripts: cap(["read_transcript"]),
    events: cap(["emit"]),
    sandboxes: cap(["fork_sandbox"]),
    brokered: cap(["brokered"]),
    management: cap(["spawn_agent", "attach", "spawn_workstream", "send", "list_workstreams", "get_status", "wait_events", "approve", "deny",
      "merge", "kill", "delegate", "notify_user"]),
    memory: cap(["memory_read", "memory_write"]),
  },
  templates: {
    worker: {
      capabilities: ["nest", "hands", "subagents", "messaging", "transcripts", "events", "sandboxes", "brokered"],
      launch: { builtin_tools: ["TodoWrite", "Task", "WebSearch"], system_prompt: { mode: "append", text: "" } },
      hands: "required",
      credential: setupTokenSecret("worker"),
    },
    captain: {
      capabilities: ["nest", "messaging", "transcripts", "sandboxes", "brokered", "management", "memory"],
      launch: {
        builtin_tools: [],
        system_prompt: { mode: "replace", text: "You are a nest captain. You act only through mcp__nest__* platform tools." },
      },
      hands: "forbidden",
      credential: setupTokenSecret("captain"),
    },
  },
};

/**
 * Version 4: widening its own sandbox's egress, a sink (docs/sandbox/networking/egress/policy/#rules).
 * Not added to the seed templates: giving it to a template is the operator's step.
 */
export const EGRESS_CAPABILITIES: Readonly<Record<string, Capability>> = {
  egress: cap(["egress_policy"], [], [
    "To reach a host your sandbox's egress refuses (a 403 egress_denied), ask for it with mcp__nest__egress_policy {allow: [{host}], ttl_s}.",
    "From a session that read untrusted content the operator approves it first: end your turn and the decision arrives as your next input.",
  ].join(" ")),
};

/**
 * Version 5: spawning and stopping agents (docs/agents/#spawning, docs/agents/#lifetimes). Spawns from
 * `worker` only; adding it to a template, or another template to its `spawn`, is the operator's step.
 */
export const SPAWNING_CAPABILITIES: Readonly<Record<string, Capability>> = {
  spawning: {
    ...cap(["agent_spawn", "agent_stop"], [], [
      "Spawn an agent with mcp__nest__agent_spawn {template, task, sandbox?: new | share, ephemeral?}. It is yours: you",
      "stop it, and the agents it spawned, with mcp__nest__agent_stop {agent, destroy_sandbox?}; nothing reports its",
      "progress or its end to you. Say in every task when the work counts as done. An ephemeral agent stops itself once a",
      "turn ends with nothing waiting for it, destroying the sandbox it was given.",
    ].join(" ")),
    spawn: ["worker"],
  },
};

/** `spawning`'s prompt as version 5 seeded it, when its events reached the spawner on a channel (version 7 replaces it). */
export const SPAWNING_PROMPT_V5 = [
  "Spawn an agent with mcp__nest__agent_spawn {template, task, sandbox?: new | share, ephemeral?}. It is yours: its",
  "events (its final text, its exit) reach you, and you stop it, and the agents it spawned, with mcp__nest__agent_stop",
  "{agent, destroy_sandbox?}. Say in every task when the work counts as done. An ephemeral agent stops itself once a",
  "turn ends with nothing waiting for it, destroying the sandbox it was given.",
].join(" ");

/**
 * The built-ins a new catalog's `worker` launches with (docs/agents/runner/#launch): the task tools and
 * the web tools. No `TodoWrite` (inert beside the task tools) and no `Agent` (`Task` before Claude Code
 * 2.1): in `-p` mode a subagent's result arrives in a later turn, which turn tracking doesn't model.
 */
export const WORKER_BUILTIN_TOOLS: readonly string[] = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "WebSearch", "WebFetch"];

/**
 * Tools the registry no longer has: `delegate` (inspecting without hands is a pattern,
 * docs/orchestration/captains/), `spawn_agent` and `kill` (stubs, replaced by `agent_spawn` and
 * `agent_stop`). A stored capability or spec naming one is read without it.
 */
export const RETIRED_TOOLS: readonly string[] = ["delegate", "spawn_agent", "kill"];

/**
 * Version 8: workstreams and the messaging tools left the platform (docs/README.md#principles): the
 * `messaging` (`notify`, `ask`) and `events` (`emit`) capabilities, and the workstream tools of
 * `management`, which no handler ever served.
 */
export const MESSAGING_CAPABILITIES_REMOVED: readonly string[] = ["messaging", "events"];
export const MESSAGING_TOOLS_REMOVED: readonly string[] = [
  "notify", "emit", "ask", "spawn_workstream", "send", "list_workstreams", "get_status", "wait_events", "merge", "notify_user",
];

/**
 * The seed of an empty catalog (the current version). Beyond version 1 it adds the later steps'
 * capabilities, leaves out what they removed, and, for new catalogs only (a seed step never edits an
 * entry a catalog already holds): `management` without the {@link RETIRED_TOOLS}, `captain` with
 * `spawning`, and `worker` without `subagents` and with {@link WORKER_BUILTIN_TOOLS}.
 */
export const SEED_CATALOG: Catalog = {
  capabilities: {
    ...Object.fromEntries(Object.entries(SEED_CATALOG_V1.capabilities).filter(([n]) => !MESSAGING_CAPABILITIES_REMOVED.includes(n))),
    management: {
      ...SEED_CATALOG_V1.capabilities.management!,
      tools: SEED_CATALOG_V1.capabilities.management!.tools.filter((t) => !RETIRED_TOOLS.includes(t) && !MESSAGING_TOOLS_REMOVED.includes(t)),
    },
    ...EGRESS_CAPABILITIES,
    ...SPAWNING_CAPABILITIES,
  },
  templates: {
    worker: {
      ...SEED_CATALOG_V1.templates.worker!,
      capabilities: SEED_CATALOG_V1.templates.worker!.capabilities.filter((c) => c !== "subagents" && !MESSAGING_CAPABILITIES_REMOVED.includes(c)),
      launch: { ...SEED_CATALOG_V1.templates.worker!.launch, builtin_tools: [...WORKER_BUILTIN_TOOLS] },
    },
    captain: {
      ...SEED_CATALOG_V1.templates.captain!,
      capabilities: [...SEED_CATALOG_V1.templates.captain!.capabilities.filter((c) => !MESSAGING_CAPABILITIES_REMOVED.includes(c)), "spawning"],
    },
  },
};

/**
 * Capabilities the platform took back, with the template parameters only they read: version 6 removed
 * the task ledger (`tasks`, `tasks-admin` and the `ledger` parameter), which left nest to become an
 * external integration (docs/README.md#principles).
 */
export const REMOVED_CAPABILITIES: readonly string[] = ["tasks", "tasks-admin"];
export const REMOVED_PARAMS: readonly string[] = ["ledger"];

/**
 * Version 7: channels left the platform (docs/README.md#principles): their capabilities (`channels`,
 * `messaging-tree`), their tools, and the channel grants a capability carried (`grants`).
 */
export const CHANNEL_CAPABILITIES_REMOVED: readonly string[] = ["channels", "messaging-tree"];
export const CHANNEL_TOOLS_REMOVED: readonly string[] = ["channel_create", "post", "read", "subscribe", "unsubscribe", "message"];
export const CHANNEL_FIELDS_REMOVED: readonly string[] = ["grants"];

/** What a seed step takes out of a stored catalog. */
export interface Removes {
  /** Capabilities deleted, by name, and dropped from every template's list (with the `params` they read). */
  capabilities: readonly string[];
  params: readonly string[];
  /** Platform tools dropped from every remaining capability's `tools`. */
  tools?: readonly string[];
  /** Capability fields dropped from every remaining capability. */
  fields?: readonly string[];
}

/** A seed capability's prompt a step replaces: only where the stored prompt is still `was` (an operator's edit stays). */
export interface PromptRewrite {
  capability: string;
  was: string;
  now: string;
}

export interface SeedStep {
  version: number;
  capabilities: Readonly<Record<string, Capability>>;
  templates: Readonly<Record<string, Template>>;
  removes?: Removes;
  prompts?: readonly PromptRewrite[];
}

/**
 * The entries each seed version introduced or removed, for a catalog seeded with an earlier one. A step
 * adds an entry only if the name is free, and runs once (CatalogDO records the version it reached), so an
 * entry the operator deletes later stays deleted. Adding never edits an existing entry: putting a step's
 * capabilities in the operator's templates is the operator's step (docs/control-plane/durable-objects/catalog/).
 * Removing does: the capability goes, and each template keeps its other capabilities. Versions only grow:
 * a release adds the next one.
 */
export const SEED_STEPS: readonly SeedStep[] = [
  // Added the channels' `channels` and `messaging-tree`, which version 7 removes: a catalog that skips
  // from before 2 to 7 never gains them.
  { version: 2, capabilities: {}, templates: {} },
  // Added the task ledger's `tasks` and `tasks-admin`, which version 6 removes: a catalog that skips
  // from before 3 to 6 never gains them.
  { version: 3, capabilities: {}, templates: {} },
  { version: 4, capabilities: EGRESS_CAPABILITIES, templates: {} },
  { version: 5, capabilities: SPAWNING_CAPABILITIES, templates: {} },
  { version: 6, capabilities: {}, templates: {}, removes: { capabilities: REMOVED_CAPABILITIES, params: REMOVED_PARAMS } },
  {
    version: 7, capabilities: {}, templates: {},
    removes: { capabilities: CHANNEL_CAPABILITIES_REMOVED, params: [], tools: CHANNEL_TOOLS_REMOVED, fields: CHANNEL_FIELDS_REMOVED },
    prompts: [{ capability: "spawning", was: SPAWNING_PROMPT_V5, now: SPAWNING_CAPABILITIES.spawning!.prompt }],
  },
  { version: 8, capabilities: {}, templates: {}, removes: { capabilities: MESSAGING_CAPABILITIES_REMOVED, params: [], tools: MESSAGING_TOOLS_REMOVED } },
];
export const SEED_VERSION = Math.max(1, ...SEED_STEPS.map((s) => s.version));

/**
 * What a catalog seeded at version `from`, holding entries named `have`, gains: the entries of every
 * later step whose names are free; what later steps remove (capabilities, the template parameters
 * they read, tools and capability fields); and the seed prompts they replace, in step order.
 * Pure: CatalogDO writes the result and the new version together.
 */
export function seedMigration(have: { capabilities: readonly string[]; templates: readonly string[] }, from: number): {
  capabilities: Record<string, Capability>; templates: Record<string, Template>; version: number;
  removes: { capabilities: string[]; params: string[]; tools: string[]; fields: string[] }; prompts: PromptRewrite[];
} {
  const capabilities: Record<string, Capability> = {};
  const templates: Record<string, Template> = {};
  const removes = { capabilities: [] as string[], params: [] as string[], tools: [] as string[], fields: [] as string[] };
  const prompts: PromptRewrite[] = [];
  const add = (into: string[], items: readonly string[] | undefined) => {
    for (const x of items ?? []) if (!into.includes(x)) into.push(x);
  };
  for (const step of SEED_STEPS) {
    if (step.version <= from) continue;
    for (const [name, c] of Object.entries(step.capabilities)) if (!have.capabilities.includes(name)) capabilities[name] = c;
    for (const [name, t] of Object.entries(step.templates)) if (!have.templates.includes(name)) templates[name] = t;
    for (const name of step.removes?.capabilities ?? []) delete capabilities[name];
    add(removes.capabilities, step.removes?.capabilities);
    add(removes.params, step.removes?.params);
    add(removes.tools, step.removes?.tools);
    add(removes.fields, step.removes?.fields);
    prompts.push(...(step.prompts ?? []));
  }
  return { capabilities, templates, version: Math.max(from, SEED_VERSION), removes, prompts };
}

/**
 * A stored capability's JSON without the tools and fields `removes` names; null when it has none of
 * them. Works on the raw row, as `pruneTemplate` does.
 */
export function pruneCapability(body: unknown, removes: Pick<Removes, "tools" | "fields">): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const c = body as Record<string, unknown>;
  const tools = removes.tools ?? [];
  const fields = (removes.fields ?? []).filter((f) => Object.hasOwn(c, f));
  const dropsTools = Array.isArray(c.tools) && c.tools.some((t) => tools.includes(t as string));
  if (!dropsTools && !fields.length) return null;
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(c).filter(([k]) => !fields.includes(k)));
  if (dropsTools) out.tools = (c.tools as unknown[]).filter((t) => !tools.includes(t as string));
  return out;
}

/** A stored capability's JSON with its prompt replaced, if it is still `r.was`; null otherwise. */
export function rewritePrompt(body: unknown, r: Pick<PromptRewrite, "was" | "now">): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const c = body as Record<string, unknown>;
  return c.prompt === r.was ? { ...c, prompt: r.now } : null;
}

/**
 * A stored template's JSON without the capabilities `removes` names and, if it listed one, without the
 * parameters they read; null when it lists none. Works on the raw row, so fields this release doesn't
 * know survive, and a previous release reading it after a rollback finds no parameter its remaining
 * capabilities don't declare.
 */
export function pruneTemplate(body: unknown, removes: { capabilities: readonly string[]; params: readonly string[] }): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const t = body as Record<string, unknown>;
  if (!Array.isArray(t.capabilities) || !t.capabilities.some((c) => removes.capabilities.includes(c as string))) return null;
  const out: Record<string, unknown> = { ...t, capabilities: t.capabilities.filter((c) => !removes.capabilities.includes(c as string)) };
  if (typeof t.params === "object" && t.params !== null && !Array.isArray(t.params)) {
    out.params = Object.fromEntries(Object.entries(t.params).filter(([k]) => !removes.params.includes(k)));
  }
  return out;
}

// --- Validation of catalog entries -------------------------------------------------------------------

/**
 * A capability names only platform tools, each once. Its `mcp` source, if any, has a URL nest will call
 * (`allowLoopback`: local development only), a name no platform tool starts with, and its allowlist and
 * overrides name each tool once.
 */
export function checkCapability(
  cap: Capability, registry: readonly string[], mcp?: { name: string; allowLoopback: boolean; allowLoopbackBrokered?: boolean },
): Result<Capability> {
  const seen = new Set<string>();
  for (const t of cap.tools) {
    if (!registry.includes(t)) return err(`unknown platform tool ${t}`);
    if (seen.has(t)) return err(`tool ${t} listed twice`);
    seen.add(t);
  }
  if (cap.mcp) {
    if (!mcp) return err("an mcp capability is checked with its name");
    const url = checkMcpUrl(cap.mcp.url, mcp.allowLoopback);
    if (!url.ok) return err(`mcp.url: ${url.error}`);
    // Brokered actions' tools (`github_comment`, …) are platform tools too.
    const clash = capabilityNameClash(mcp.name, [...registry, ...BROKERED_TOOL_NAMES]);
    if (clash) return err(clash);
    const tools = cap.mcp.tools ?? [];
    if (new Set(tools).size !== tools.length) return err("mcp.tools lists a tool twice");
    const idem = cap.mcp.idempotent;
    if (Array.isArray(idem) && new Set(idem).size !== idem.length) return err("mcp.idempotent lists a tool twice");
    const auth = cap.mcp.auth;
    if (typeof auth !== "string" && auth.client === auth.oauth) return err("mcp.auth: the client secret and the token record must be different names");
  }
  if (cap.brokered) {
    const b = checkBrokered(cap.brokered, mcp?.allowLoopbackBrokered ?? false);
    if (!b.ok) return err(`brokered: ${b.error}`);
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

/** The first of each set of items with the same key, in order. */
function dedupeBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const dedupeRules = (rules: readonly ToolRule[]) => dedupeBy(rules, (r) => JSON.stringify([r.pattern, r.decision, r.reason ?? null]));

/** Template `name` expanded as it stands: no overrides, no hands check. */
export function expandTemplate(catalog: Catalog, registry: readonly string[], name: string): Result<AgentSpec> {
  if (!Object.hasOwn(catalog.templates, name)) return err(`unknown template ${name}`);
  const tpl = catalog.templates[name]!;
  const caps: Capability[] = [];
  const mcp: McpGrant[] = [];
  const brokered: BrokeredGrant[] = [];
  const spawn: string[] = [];
  for (const c of tpl.capabilities) {
    if (!Object.hasOwn(catalog.capabilities, c)) return err(`template ${name}: unknown capability ${c}`);
    const cap = catalog.capabilities[c]!;
    caps.push(cap);
    if (cap.mcp) mcp.push(grantOf(c, cap.mcp));
    for (const t of cap.spawn ?? []) if (!spawn.includes(t)) spawn.push(t);
    for (const e of cap.brokered ?? []) {
      const g = grantOfEntry(c, e);
      if (g) brokered.push(g);
    }
  }
  // A stored capability may name a tool the registry no longer has (`delegate`, in catalogs seeded
  // before it went): ignored, not a failed spawn. Writes still refuse one (`checkCapability`).
  const given = new Set(caps.flatMap((c) => c.tools).filter((t) => registry.includes(t)));
  const prompt = [tpl.launch.system_prompt.text, ...caps.map((c) => c.prompt)].filter((t) => t.length > 0).join("\n\n");
  return ok({
    template: name,
    tools: registry.filter((t) => given.has(t)),
    launch: { ...tpl.launch, system_prompt: { ...tpl.launch.system_prompt, text: prompt } },
    // In capability order, each once (first occurrence kept).
    rules: dedupeRules(caps.flatMap((c) => c.rules)),
    credential: tpl.credential,
    ...(mcp.length ? { mcp } : {}),
    ...(brokered.length ? { brokered } : {}),
    ...(tpl.repos?.length ? { repos: canonicalRepos(tpl.repos) } : {}),
    ...(spawn.length ? { spawn } : {}),
    ...(tpl.ephemeral ? { ephemeral: true as const } : {}),
    ...(tpl.sandbox_idle_ttl_ms !== undefined ? { sandbox_idle_ttl_ms: tpl.sandbox_idle_ttl_ms } : {}),
  });
}

/** The spec with this push allowlist: recorded, and its unscoped GitHub grants narrowed to it (`scopeToRepos`). */
function withRepos(spec: AgentSpec, repos: readonly string[]): AgentSpec {
  const { repos: _, brokered, ...rest } = spec;
  const r = canonicalRepos(repos);
  const scoped = brokered ? scopeToRepos(brokered, r) : undefined;
  return { ...rest, ...(scoped?.length ? { brokered: scoped } : {}), ...(r.length ? { repos: r } : {}) };
}

/**
 * A spec's tools narrowed to `subset`, which must not name a tool the spec lacks: platform tools by
 * name, a remote tool as `<capability>_<tool>`, a brokered action by its tool (`github_comment`). A
 * given subset narrows each mcp grant's allowlist to the remote tools it names, and drops a grant it
 * names none of; it keeps only the brokered grants of the actions it names.
 */
function narrowTools(name: string, spec: AgentSpec, subset: readonly string[] | undefined): Result<Pick<AgentSpec, "tools" | "mcp" | "brokered">> {
  if (!subset) return ok({ tools: spec.tools, ...(spec.mcp ? { mcp: spec.mcp } : {}), ...(spec.brokered ? { brokered: spec.brokered } : {}) });
  const grants = spec.mcp ?? [];
  const remote = new Map<string, string[]>();
  const actions = new Set<string>();
  const wider: string[] = [];
  for (const t of subset) {
    if (spec.tools.includes(t)) continue;
    const action = actionOfTool(t);
    if (action && (spec.brokered ?? []).some((g) => g.action === action)) {
      actions.add(action);
      continue;
    }
    const g = grants.find((x) => t.startsWith(`${x.capability}_`));
    const tool = g ? t.slice(g.capability.length + 1) : "";
    if (!g || !tool || (g.tools && !g.tools.includes(tool))) {
      wider.push(t);
      continue;
    }
    remote.set(g.capability, [...(remote.get(g.capability) ?? []), tool]);
  }
  if (wider.length) return err(`template ${name} doesn't give ${wider.join(", ")}`);
  const mcp = grants.filter((g) => remote.has(g.capability)).map((g) => ({ ...g, tools: [...new Set(remote.get(g.capability))] }));
  const brokered = (spec.brokered ?? []).filter((g) => actions.has(g.action));
  return ok({ tools: spec.tools.filter((t) => subset.includes(t)), ...(mcp.length ? { mcp } : {}), ...(brokered.length ? { brokered } : {}) });
}

/**
 * A spawn spec: a template, whether a sandbox is given (hands), and overrides, from the operator (the
 * admin API) or from a spawning agent (which can only narrow; see {@link SpawnerOverrides}).
 */
export type SpawnSpec =
  | { template: string; hands: boolean; by: "operator"; overrides?: OperatorOverrides }
  /**
   * `share`: the hands are the spawner's own sandbox (the template must allow it: `share_sandbox`).
   * `cell_idle_ttl_ms`: the cell default a spawn's idle TTL may not exceed when the template sets none.
   */
  | { template: string; hands: boolean; by: "spawner"; share?: boolean; cell_idle_ttl_ms?: number; overrides?: SpawnerOverrides };

/** Expand a spawn spec: the template's hands rule, the template, then the overrides its author may make. */
export function expandSpec(catalog: Catalog, registry: readonly string[], spec: SpawnSpec): Result<AgentSpec> {
  const tpl = Object.hasOwn(catalog.templates, spec.template) ? catalog.templates[spec.template]! : undefined;
  if (!tpl) return err(`unknown template ${spec.template}`);
  if (tpl.hands === "required" && !spec.hands) return err(`template ${spec.template} needs a sandbox`);
  if (tpl.hands === "forbidden" && spec.hands) return err(`template ${spec.template} has no hands`);
  const base = expandTemplate(catalog, registry, spec.template);
  if (!base.ok) return base;
  if (spec.by === "spawner") {
    if (spec.share && !tpl.share_sandbox) return err(`template ${spec.template} doesn't share its spawner's sandbox`);
    // Parsed again: a caller's object that carries anything else is refused, whatever its type said.
    const o = SpawnerOverrides.safeParse(spec.overrides ?? {});
    if (!o.success) return err(`a spawner can only narrow tools and add deny or ask rules: ${o.error.issues.map((i) => i.message).join("; ")}`);
    const tools = narrowTools(spec.template, base.value, o.data.tools);
    if (!tools.ok) return tools;
    const repos = narrowRepos(base.value.repos ?? [], o.data.repos ?? base.value.repos ?? []);
    if (!repos.ok) return err(`template ${spec.template}: ${repos.error}`);
    const { mcp: _mcp, brokered: _brokered, ephemeral: _e, sandbox_idle_ttl_ms: _t, ...rest } = base.value;
    // Lifetimes only shorten: ephemeral once set stays, and the shorter TTL wins.
    const ephemeral = base.value.ephemeral || o.data.ephemeral;
    // The template's TTL (an operator's choice, longer than the cell's or not), else the cell default, bounds the spawn's.
    const asked = o.data.sandbox_idle_ttl_ms;
    const tplTtl = base.value.sandbox_idle_ttl_ms;
    const ttl = asked !== undefined ? narrowTtl(tplTtl ?? spec.cell_idle_ttl_ms ?? Infinity, asked) : tplTtl;
    const lifetimes = { ...(ephemeral ? { ephemeral: true as const } : {}), ...(ttl !== undefined ? { sandbox_idle_ttl_ms: ttl } : {}) };
    return ok(withRepos({ ...rest, ...tools.value, ...lifetimes, rules: dedupeRules([...(o.data.rules ?? []), ...base.value.rules]) }, repos.value));
  }
  const o = spec.overrides ?? {};
  const tools = narrowTools(spec.template, base.value, o.tools);
  if (!tools.ok) return tools;
  const { mcp: _mcp, brokered: _brokered, ephemeral: _ephemeral, ...rest } = base.value;
  const ephemeral = o.ephemeral ?? base.value.ephemeral ?? false;
  return ok(withRepos({
    ...rest,
    ...tools.value,
    ...(ephemeral ? { ephemeral: true as const } : {}),
    launch: o.launch ?? base.value.launch,
    rules: o.rules ?? base.value.rules,
    credential: o.credential ?? base.value.credential,
  }, o.repos ?? base.value.repos ?? []));
}

// --- Records stored with a role (the previous release) ----------------------------------------------

/**
 * What each role meant when records were stored with one, frozen here so editing the seed (or the
 * catalog) never changes how an old record is read. (A test checks the first seed still expands to it.)
 */
export const ROLE_SPECS: Readonly<Record<"worker" | "captain", Omit<AgentSpec, "launch" | "rules">>> = {
  // Without the tools the registry no longer has: the retired ones (`delegate`, `spawn_agent`, `kill`)
  // and those that left with workstreams ({@link MESSAGING_TOOLS_REMOVED}). A stored record naming
  // one lists a tool its runner is never offered.
  worker: {
    template: "worker",
    tools: ["fork_sandbox", "read_transcript", "checkpoint", "expose_port", "brokered"],
    credential: setupTokenSecret("worker"),
  },
  captain: {
    template: "captain",
    tools: ["fork_sandbox", "attach", "read_transcript", "brokered", "approve", "deny", "memory_read", "memory_write"],
    credential: setupTokenSecret("captain"),
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
export function specFromRole(rec: RoleRecord): AgentSpec {
  const r = ROLE_SPECS[rec.role];
  const grants = rec.grants;
  return {
    ...r, tools: grants ? r.tools.filter((t) => grants.includes(t)) : [...r.tools], launch: rec.launch, rules: rec.rules,
  };
}
