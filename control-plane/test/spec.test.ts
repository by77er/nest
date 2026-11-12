// Templates, capabilities and spawn-spec expansion (lib/spec.ts): pure functions, checked directly.
// The first seed must give exactly what the `worker` and `captain` roles gave, and the current one
// that plus spawning, without the task ledger's capabilities version 6 removed, the channels' version 7
// removed or the messaging and workstream tools version 8 removed; the properties
// below hold for any catalog and spec (a seeded generator, not fast-check: it isn't a dependency).
import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import {
  type Capability, type Catalog, checkCapability, checkTemplate, expandSpec, expandTemplate, OperatorOverrides, ROLE_SPECS, SEED_CATALOG,
  SEED_CATALOG_V1, SEED_STEPS, SEED_VERSION, seedMigration, TIMER_CAPABILITIES, SpawnerOverrides, specFromRole, type Template, templatesUsing, CHANNEL_CAPABILITIES_REMOVED,
  CHANNEL_TOOLS_REMOVED, EGRESS_CAPABILITIES, joinRules, liveCapabilities, rewriteRules, type RuleSource, SEED_BUILTIN_RULES, templateRuleSources, MESSAGING_CAPABILITIES_REMOVED,
  MESSAGING_TOOLS_REMOVED, pruneCapability, pruneTemplate, REMOVED_CAPABILITIES, rewritePrompt, SPAWNING_CAPABILITIES, SPAWNING_PROMPT_V5,
} from "../src/lib/spec";
import { Credential, type ToolRule } from "../src/protocol/control";

// What the roles gave (the role-filtered `platform-tools.json` and AgentDO's defaults before templates),
// less the tools the registry no longer has (`delegate`, `spawn_agent` and `kill`; `notify`, `emit`, `ask`
// and the workstream tools): the first seed still lists them, and expansion ignores them.
const WORKER_TOOLS = ["fork_sandbox", "read_transcript", "checkpoint", "expose_port", "brokered"];
const CAPTAIN_TOOLS = ["fork_sandbox", "attach", "read_transcript", "brokered", "approve", "deny", "memory_read", "memory_write"];
const NEST_ALLOW: ToolRule = { pattern: "mcp__nest__*", decision: "allow" };
const WORKER_LAUNCH = {
  builtin_tools: ["TodoWrite", "Task", "WebSearch"],
  system_prompt: { mode: "append", text: "You work in a remote sandbox through the mcp__nest__* tools; they behave like Claude Code's built-ins." },
};
const CAPTAIN_LAUNCH = {
  builtin_tools: [],
  system_prompt: { mode: "replace", text: "You are a nest captain. You act only through mcp__nest__* platform tools." },
};

const expand = (catalog: Catalog, template: string, hands: boolean, overrides = {}) => {
  const r = expandSpec(catalog, PLATFORM_TOOL_NAMES, { template, hands, by: "operator", overrides });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("the first seed catalog is what the roles were", () => {
  it("worker: the worker tools, launch, rules and token", () => {
    expect(expand(SEED_CATALOG_V1, "worker", true)).toEqual({
      template: "worker",
      tools: WORKER_TOOLS,
      launch: WORKER_LAUNCH,
      rules: [NEST_ALLOW, { pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }],
      rule_sources: SEED_CATALOG_V1.templates.worker!.capabilities.map((capability) => ({ capability })),
      credential: "claude_oauth_token:worker",
    });
  });

  it("captain: the captain tools, launch, rules and token", () => {
    expect(expand(SEED_CATALOG_V1, "captain", false)).toEqual({
      template: "captain",
      tools: CAPTAIN_TOOLS,
      launch: CAPTAIN_LAUNCH,
      rules: [NEST_ALLOW],
      rule_sources: SEED_CATALOG_V1.templates.captain!.capabilities.map((capability) => ({ capability })),
      credential: "claude_oauth_token:captain",
    });
  });

  it("every entry of the current seed passes the checks the admin routes apply", () => {
    for (const c of Object.values(SEED_CATALOG.capabilities)) expect(checkCapability(c, PLATFORM_TOOL_NAMES).ok).toBe(true);
    for (const t of Object.values(SEED_CATALOG.templates)) expect(checkTemplate(t, SEED_CATALOG.capabilities).ok).toBe(true);
    // The first seed is what older catalogs hold, not what is written now: its templates still hold together.
    for (const t of Object.values(SEED_CATALOG_V1.templates)) expect(checkTemplate(t, SEED_CATALOG_V1.capabilities).ok).toBe(true);
  });

  it("a record stored with a role gets that role's spec, its stored launch and rules, and its grants as a narrowing", () => {
    const launch = { builtin_tools: [], system_prompt: { mode: "append" as const, text: "custom" } };
    const s = specFromRole({ role: "worker", grants: ["checkpoint", "merge", "read_transcript", "notify"], launch, rules: [NEST_ALLOW] });
    // `merge` was never a worker tool, and `notify` left the registry: ignored.
    expect(s).toMatchObject({ template: "worker", tools: ["read_transcript", "checkpoint"], launch, rules: [NEST_ALLOW], credential: "claude_oauth_token:worker" });
    expect(specFromRole({ role: "captain", grants: null, launch: CAPTAIN_LAUNCH as never, rules: [NEST_ALLOW] }).tools)
      .toEqual(CAPTAIN_TOOLS);
  });
});

describe("records stored with a role read through a frozen table, not the seed", () => {
  it("the first seed still expands to what ROLE_SPECS freezes (so a seed edit can't change it unnoticed)", () => {
    for (const role of ["worker", "captain"] as const) {
      const { launch: _l, rules: _r, rule_sources: _s, ...rest } = expand(SEED_CATALOG_V1, role, role === "worker");
      expect(rest, role).toEqual(ROLE_SPECS[role]);
    }
  });
});

describe("the seed's built-ins run without asking (the owner's decision, 2026-11-11)", () => {
  /** The first rule matching a bare built-in call (exact name or `*`), as the runner's first-match rules read it. */
  const decide = (rules: readonly ToolRule[], tool: string) =>
    rules.find((r) => r.pattern === tool || r.pattern === "*" || r.pattern === `${tool}(*)`)?.decision ?? "ask";

  it("every built-in a seed template launches, in either seed, is allowed by an exact-name rule", () => {
    for (const [catalog, template, hands] of [
      [SEED_CATALOG, "worker", true], [SEED_CATALOG, "captain", false], [SEED_CATALOG_V1, "worker", true], [SEED_CATALOG_V1, "captain", false],
    ] as const) {
      // A catalog seeded with the first seed and migrated: its `nest` rules are rewritten (version 10).
      const migrated: Catalog = catalog === SEED_CATALOG_V1
        ? { ...catalog, capabilities: { ...catalog.capabilities, nest: { ...catalog.capabilities.nest!, rules: [...SEED_CATALOG.capabilities.nest!.rules] } } }
        : catalog;
      const spec = expand(migrated, template, hands);
      for (const t of spec.launch.builtin_tools) expect(decide(spec.rules, t), `${template}: ${t}`).toBe("allow");
    }
    // Exact names only: nothing else becomes allowed (`Agent` stays `subagents`').
    expect(SEED_BUILTIN_RULES.every((r) => /^[A-Za-z]+$/.test(r.pattern) && r.decision === "allow")).toBe(true);
    expect(decide(expand(SEED_CATALOG, "worker", true).rules, "Agent")).toBe("ask");
  });

  it("version 10 rewrites `nest`'s rules only where they are still the first seed's", () => {
    const m = seedMigration({ capabilities: Object.keys(SEED_CATALOG.capabilities), templates: ["worker", "captain"] }, 9);
    expect(m.rules).toEqual([{ capability: "nest", was: [NEST_ALLOW], now: [NEST_ALLOW, ...SEED_BUILTIN_RULES] }]);
    const r = m.rules[0]!;
    const seeded = { tools: [], rules: [{ decision: "allow", pattern: "mcp__nest__*" }], prompt: "", later_field: 1 };
    expect(rewriteRules(seeded, r)).toEqual({ ...seeded, rules: [NEST_ALLOW, ...SEED_BUILTIN_RULES] });
    // An operator's edit stays, and so does one already rewritten.
    expect(rewriteRules({ ...seeded, rules: [NEST_ALLOW, { pattern: "WebFetch", decision: "deny" }] }, r)).toBeNull();
    expect(rewriteRules({ ...seeded, rules: [] }, r)).toBeNull();
    expect(rewriteRules({ ...seeded, rules: [NEST_ALLOW, ...SEED_BUILTIN_RULES] }, r)).toBeNull();
    expect(rewriteRules("not an object", r)).toBeNull();
    expect(seedMigration({ capabilities: [], templates: [] }, 10).rules).toEqual([]);
  });
});

describe("a spawner's overrides can only narrow", () => {
  const spawn = (overrides: unknown) =>
    expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "spawner", overrides: overrides as SpawnerOverrides });
  const base = expand(SEED_CATALOG, "worker", true);

  it("refuses launch, built-in tools, credential, escalation and allow rules", () => {
    for (const bad of [
      { launch: { builtin_tools: ["Bash"], system_prompt: { mode: "replace", text: "x" } } },
      { builtin_tools: ["Bash"] },
      { credential: "claude_oauth_token:captain" },
      { escalate_to: "user" },
      { rules: [{ pattern: "mcp__nest__merge", decision: "allow" }] },
    ]) {
      expect(SpawnerOverrides.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(spawn(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    // The operator's schema takes what a spawner's refuses.
    expect(OperatorOverrides.safeParse({ credential: "claude_oauth_token:captain", rules: [{ pattern: "x", decision: "allow" }] }).success).toBe(true);
  });

  it("narrows tools, and puts deny and ask rules first (first match wins), keeping launch and credential", () => {
    const r = spawn({ tools: ["checkpoint", "read_transcript"], rules: [{ pattern: "mcp__nest__Bash(rm *)", decision: "deny" }, { pattern: "WebSearch", decision: "ask" }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.tools).toEqual(["read_transcript", "checkpoint"]);
    expect(r.value.rules).toEqual([{ pattern: "mcp__nest__Bash(rm *)", decision: "deny" }, { pattern: "WebSearch", decision: "ask" }, ...base.rules]);
    expect([r.value.launch, r.value.credential]).toEqual([base.launch, base.credential]);
    expect(spawn({ tools: ["merge"] }).ok).toBe(false);
  });
});

describe("rule sources: an agent's own rules apart from its capabilities' (read as they are now)", () => {
  const deny = { pattern: "WebFetch", decision: "deny" as const };
  const ask = { pattern: "Bash(git push *)", decision: "ask" as const };
  const allowWeb: ToolRule = { pattern: "WebFetch", decision: "allow" };
  const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append" as const, text: "" } };
  const tpl = (capabilities: string[]): Template => ({ capabilities, launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" });
  const cat: Catalog = {
    capabilities: { nest: { tools: [], rules: [NEST_ALLOW], prompt: "" }, web: { tools: [], rules: [allowWeb], prompt: "" }, "acme/tools": { tools: [], rules: [allowWeb, ask], prompt: "" } },
    templates: { t: tpl(["nest", "web"]), "acme/t": tpl(["nest", "acme/tools"]) },
  };

  it("a spawner's narrowing is a source of its own, first; the capabilities follow, by name", () => {
    const r = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "t", hands: false, by: "spawner", overrides: { rules: [deny] } });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.rule_sources).toEqual([{ rules: [deny] }, { capability: "nest" }, { capability: "web" }]);
    // At spawn the stored rules are what the sources give now: the narrowing wins over the capability's allow.
    expect(r.value.rules).toEqual(joinRules(r.value.rule_sources!, { nest: [NEST_ALLOW], web: [allowWeb] }));
    expect(r.value.rules).toEqual([deny, NEST_ALLOW, allowWeb]);
    expect(r.value.rules_set).toBeUndefined();
  });

  it("joining reads each capability as it is now, keeps the narrowing first, and a deleted capability gives none", () => {
    const sources: RuleSource[] = [{ rules: [deny] }, { capability: "nest" }, { capability: "web" }];
    expect(joinRules(sources, { nest: [NEST_ALLOW], web: [allowWeb, ask] })).toEqual([deny, NEST_ALLOW, allowWeb, ask]);
    expect(joinRules(sources, { nest: [NEST_ALLOW], web: null })).toEqual([deny, NEST_ALLOW]);
    expect(joinRules(sources, { nest: [NEST_ALLOW] })).toEqual([deny, NEST_ALLOW]);
    // Each rule once, the first kept: a capability can't move a rule ahead of the narrowing.
    expect(joinRules(sources, { nest: [deny, NEST_ALLOW], web: [] })).toEqual([deny, NEST_ALLOW]);
    expect(liveCapabilities([...sources, { capability: "nest" }])).toEqual(["nest", "web"]);
  });

  it("the operator's rules replace the capabilities' (rules_set), keeping the sources for when they're cleared", () => {
    const r = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "t", hands: false, by: "operator", overrides: { rules: [ask] } });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.rules).toEqual([ask]);
    expect(r.value.rules_set).toBe(true);
    expect(r.value.rule_sources).toEqual([{ capability: "nest" }, { capability: "web" }]);
  });

  it("a client's capability is read live only in that client's subtree; the operator's agent keeps it as at spawn", () => {
    const inSubtree = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "acme/t", hands: false, by: "spawner" }, {}, "acme");
    if (!inSubtree.ok) throw new Error(inSubtree.error);
    expect(inSubtree.value.rule_sources).toEqual([{ capability: "nest" }, { capability: "acme/tools" }]);
    const operators = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "acme/t", hands: false, by: "operator" });
    if (!operators.ok) throw new Error(operators.error);
    expect(operators.value.rule_sources).toEqual([{ capability: "nest" }, { rules: [allowWeb, ask] }]);
    expect(templateRuleSources(cat, "acme/t", "other")).toEqual({ ok: true, value: [{ capability: "nest" }, { rules: [allowWeb, ask] }] });
    expect(templateRuleSources(cat, "nope", null).ok).toBe(false);
  });
});

describe("expansion refuses what it can't give", () => {
  it("hands: required needs a sandbox, forbidden refuses one, optional takes either", () => {
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: false, by: "operator" })).toEqual({ ok: false, error: "template worker needs a sandbox" });
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "captain", hands: true, by: "operator" })).toEqual({ ok: false, error: "template captain has no hands" });
    const optional: Catalog = { ...SEED_CATALOG, templates: { o: { ...SEED_CATALOG.templates.worker!, hands: "optional" } } };
    expect(expandSpec(optional, PLATFORM_TOOL_NAMES, { template: "o", hands: true, by: "operator" }).ok).toBe(true);
    expect(expandSpec(optional, PLATFORM_TOOL_NAMES, { template: "o", hands: false, by: "operator" }).ok).toBe(true);
  });

  it("tools: an override narrows and never widens", () => {
    expect(expand(SEED_CATALOG, "worker", true, { tools: ["checkpoint", "read_transcript"] }).tools).toEqual(["read_transcript", "checkpoint"]);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "operator", overrides: { tools: ["read_transcript", "merge"] } }))
      .toEqual({ ok: false, error: "template worker doesn't give merge" });
  });

  it("a stored capability naming a tool the registry dropped still expands, without it; a write still refuses it", () => {
    // Catalogs seeded with the first seed hold `management` with the retired tools: their captains must still spawn.
    for (const t of ["delegate", "spawn_agent", "kill"]) {
      expect(SEED_CATALOG_V1.capabilities.management!.tools).toContain(t);
      expect(PLATFORM_TOOL_NAMES).not.toContain(t);
    }
    expect(expand(SEED_CATALOG_V1, "captain", false).tools).toEqual(CAPTAIN_TOOLS);
    // As one naming a tool that left with workstreams (`notify`) still expands.
    const stale: Catalog = { capabilities: { old: { tools: ["notify", "read_transcript", "gone_tool"], rules: [], prompt: "" } },
      templates: { t: { ...SEED_CATALOG.templates.captain!, capabilities: ["old"] } } };
    expect(expand(stale, "t", false).tools).toEqual(["read_transcript"]);
    expect(checkCapability(stale.capabilities.old!, PLATFORM_TOOL_NAMES)).toEqual({ ok: false, error: "unknown platform tool notify" });
  });

  it("unknown names, and inherited object keys, are unknown", () => {
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "nope", hands: false, by: "operator" }).ok).toBe(false);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "constructor", hands: false, by: "operator" }).ok).toBe(false);
    const broken: Catalog = { ...SEED_CATALOG, templates: { b: { ...SEED_CATALOG.templates.captain!, capabilities: ["toString"] } } };
    expect(expandSpec(broken, PLATFORM_TOOL_NAMES, { template: "b", hands: false, by: "operator" })).toEqual({ ok: false, error: "template b: unknown capability toString" });
    expect(checkCapability({ tools: ["nope"], rules: [], prompt: "" }, PLATFORM_TOOL_NAMES).ok).toBe(false);
    expect(checkCapability({ tools: ["read_transcript", "read_transcript"], rules: [], prompt: "" }, PLATFORM_TOOL_NAMES).ok).toBe(false);
    expect(checkTemplate({ ...SEED_CATALOG.templates.worker!, capabilities: ["hands", "hands"] }, SEED_CATALOG.capabilities).ok).toBe(false);
    expect(templatesUsing(SEED_CATALOG, "hands")).toEqual(["worker"]);
  });

  it("a credential names a Claude setup token and nothing else", () => {
    for (const ok of ["claude_oauth_token", "claude_oauth_token:captain", "claude_oauth_token:team-a.1"]) expect(Credential.safeParse(ok).success).toBe(true);
    for (const bad of ["binding_key:use1", "access:gateway", "inject:github", "claude_oauth_token:", "claude_oauth_tokenX", "cap:x"]) {
      expect(Credential.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("the current seed: spawning added, the task ledger, the channels and the messaging tools removed (seed versions 6 to 8)", () => {
  it("worker drops `subagents` and launches with the design's built-ins; captain gains spawning; nothing else changes", () => {
    const v1w = expand(SEED_CATALOG_V1, "worker", true);
    const v1c = expand(SEED_CATALOG_V1, "captain", false);
    const w = expand(SEED_CATALOG, "worker", true);
    const c = expand(SEED_CATALOG, "captain", false);
    expect(w.tools).toEqual(WORKER_TOOLS);
    // The registry's order: the spawning tools sit where the stubs they replace were.
    expect(c.tools).toEqual(PLATFORM_TOOL_NAMES.filter((t) => [...CAPTAIN_TOOLS, "agent_spawn", "agent_stop"].includes(t)));
    expect(c.spawn).toEqual(["worker"]);
    // docs/agents/runner/: Claude Code's task and web tools, no `TodoWrite` and no `Agent` (nor its old
    // name `Task`), so no rule letting subagents run either.
    expect(w.launch.builtin_tools).toEqual(["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "WebSearch", "WebFetch"]);
    expect(w.rules).toEqual([NEST_ALLOW, ...SEED_BUILTIN_RULES]);
    expect(c.launch.builtin_tools).toEqual([]);
    for (const [v1, v2] of [[v1w, w], [v1c, c]] as const) {
      expect({ ...v2, tools: [], launch: null, rules: [], rule_sources: [], spawn: [] }).toEqual({ ...v1, tools: [], launch: null, rules: [], rule_sources: [], spawn: [] });
      expect(v2.launch.system_prompt.text.startsWith(v1.launch.system_prompt.text)).toBe(true);
    }
    for (const name of [...REMOVED_CAPABILITIES, ...CHANNEL_CAPABILITIES_REMOVED, ...MESSAGING_CAPABILITIES_REMOVED]) {
      expect(SEED_CATALOG.capabilities, name).not.toHaveProperty(name);
      expect(templatesUsing(SEED_CATALOG, name), name).toEqual([]);
    }
    // The channel and messaging tools are gone from the registry and from every seed capability.
    const gone = [...CHANNEL_TOOLS_REMOVED, ...MESSAGING_TOOLS_REMOVED];
    for (const t of gone) expect(PLATFORM_TOOL_NAMES, t).not.toContain(t);
    for (const [n, c] of Object.entries(SEED_CATALOG.capabilities)) expect(c.tools.filter((t) => gone.includes(t)), n).toEqual([]);
    expect(SEED_CATALOG.capabilities.spawning!.prompt).not.toContain("reach you");
  });

  it("seed steps: versions strictly increase, the last is the seed version, and every step's entries are the current seed's", () => {
    const versions = SEED_STEPS.map((s) => s.version);
    expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < versions.length; i++) expect(versions[i]!, String(i)).toBeGreaterThan(versions[i - 1]!);
    expect(SEED_VERSION).toBe(versions.at(-1));
    // No two steps name the same entry (one would never be applied to a catalog the other already reached).
    const names = SEED_STEPS.flatMap((s) => [...Object.keys(s.capabilities), ...Object.keys(s.templates)]);
    expect(new Set(names).size).toBe(names.length);
    // No step adds what a step removes.
    const removed = SEED_STEPS.flatMap((s) => s.removes?.capabilities ?? []);
    expect(names.filter((n) => removed.includes(n))).toEqual([]);
  });

  it("seedMigration: catalogs at versions 2 to 7 gain the steps they lack and lose the task ledger's, the channels' and the messaging entries", () => {
    const v2 = { capabilities: [...Object.keys(SEED_CATALOG_V1.capabilities), "channels", "messaging-tree"], templates: Object.keys(SEED_CATALOG_V1.templates) };
    const messaging = { capabilities: ["messaging", "events"], params: [], tools: [...MESSAGING_TOOLS_REMOVED], fields: [] };
    const channels = {
      capabilities: ["channels", "messaging-tree", ...messaging.capabilities], params: [], tools: [...CHANNEL_TOOLS_REMOVED, ...messaging.tools], fields: ["grants"],
    };
    const removes = { ...channels, capabilities: ["tasks", "tasks-admin", ...channels.capabilities], params: ["ledger"] };
    const prompts = [{ capability: "spawning", was: SPAWNING_PROMPT_V5, now: SPAWNING_CAPABILITIES.spawning!.prompt }];
    const rules = [{ capability: "nest", was: [NEST_ALLOW], now: [NEST_ALLOW, ...SEED_BUILTIN_RULES] }];
    const m = seedMigration(v2, 2);
    expect(m).toEqual({ capabilities: { ...EGRESS_CAPABILITIES, ...SPAWNING_CAPABILITIES, ...TIMER_CAPABILITIES }, templates: {}, version: 10, removes, prompts, rules });
    const v3 = [...v2.capabilities, "tasks", "tasks-admin"];
    expect(seedMigration({ ...v2, capabilities: v3 }, 3)).toEqual({ capabilities: { ...EGRESS_CAPABILITIES, ...SPAWNING_CAPABILITIES, ...TIMER_CAPABILITIES }, templates: {}, version: 10, removes, prompts, rules });
    expect(seedMigration({ ...v2, capabilities: [...v3, "egress"] }, 4)).toEqual({ capabilities: { ...SPAWNING_CAPABILITIES, ...TIMER_CAPABILITIES }, templates: {}, version: 10, removes, prompts, rules });
    expect(seedMigration({ ...v2, capabilities: [...v3, "egress", "spawning"] }, 5)).toEqual({ capabilities: TIMER_CAPABILITIES, templates: {}, version: 10, removes, prompts, rules });
    expect(seedMigration({ ...v2, capabilities: [...v2.capabilities, "egress", "spawning"] }, 6))
      .toEqual({ capabilities: TIMER_CAPABILITIES, templates: {}, version: 10, removes: channels, prompts, rules });
    expect(seedMigration({ ...v2, capabilities: [...v2.capabilities, "egress", "spawning"] }, 7))
      .toEqual({ capabilities: TIMER_CAPABILITIES, templates: {}, version: 10, removes: messaging, prompts: [], rules });
    // The live catalog before this release: only `timers`, added.
    expect(seedMigration({ ...v2, capabilities: [...v2.capabilities, "egress", "spawning"] }, 8))
      .toEqual({ capabilities: TIMER_CAPABILITIES, templates: {}, version: 10, removes: { capabilities: [], params: [], tools: [], fields: [] }, prompts: [], rules });
    // Version 2's step adds nothing now (its channels would only be removed again), and doesn't run twice.
    expect(Object.keys(seedMigration({ ...v2, capabilities: Object.keys(SEED_CATALOG_V1.capabilities) }, 1).capabilities).sort()).toEqual(["egress", "spawning", "timers"]);
    expect(Object.keys(seedMigration({ ...v2, capabilities: Object.keys(SEED_CATALOG_V1.capabilities) }, 2).capabilities).sort()).toEqual(["egress", "spawning", "timers"]);
    // Once it reached a version it adds and removes nothing, whatever is missing: deleted entries stay deleted.
    expect(seedMigration({ capabilities: [], templates: [] }, SEED_VERSION))
      .toEqual({ capabilities: {}, templates: {}, version: SEED_VERSION, removes: { capabilities: [], params: [], tools: [], fields: [] }, prompts: [], rules: [] });
    // Every step's entries are what the current seed holds.
    for (const step of SEED_STEPS) {
      for (const [n, cap] of Object.entries(step.capabilities)) expect(SEED_CATALOG.capabilities[n], n).toEqual(cap);
      for (const [n, t] of Object.entries(step.templates)) expect(SEED_CATALOG.templates[n], n).toEqual(t);
    }
  });

  it("pruneTemplate: drops only the removed capabilities and their parameters, keeps everything else, and leaves other templates alone", () => {
    const removes = { capabilities: ["tasks", "tasks-admin"], params: ["ledger"] };
    // An operator-edited captain: its own capability between the removed ones, a ledger default, a field this release doesn't know.
    const edited = { ...SEED_CATALOG.templates.captain!, capabilities: ["nest", "tasks", "mine", "tasks-admin", "spawning"], params: { ledger: "team" }, later: 1 };
    expect(pruneTemplate(edited, removes)).toEqual({ ...edited, capabilities: ["nest", "mine", "spawning"], params: {} });
    expect(pruneTemplate({ ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands", "tasks"] }, removes))
      .toEqual({ ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands"] });
    // A template listing none is not rewritten, nor is a row that isn't a template.
    expect(pruneTemplate({ ...SEED_CATALOG.templates.worker!, params: { ledger: "kept" } }, removes)).toBeNull();
    for (const junk of [null, 3, "x", [], { capabilities: "tasks" }]) expect(pruneTemplate(junk, removes), JSON.stringify(junk)).toBeNull();
  });

  it("pruneCapability: drops only the removed tools and fields, keeps everything else, and leaves other capabilities alone", () => {
    const removes = { tools: CHANNEL_TOOLS_REMOVED, fields: ["grants"] };
    // An operator's capability mixing channel tools with others, its channel grants, a field this release doesn't know.
    const mixed = { tools: ["post", "notify", "read", "emit"], rules: [{ pattern: "mcp__nest__*", decision: "allow" }], prompt: "p",
      grants: [{ action: "post", channel: "team/*" }], later: 1 };
    expect(pruneCapability(mixed, removes)).toEqual({ tools: ["notify", "emit"], rules: mixed.rules, prompt: "p", later: 1 });
    // Grants alone go too (an empty list as well: no release reads the field any more).
    expect(pruneCapability({ tools: ["notify"], grants: [] }, removes)).toEqual({ tools: ["notify"] });
    expect(pruneCapability({ tools: ["notify"], rules: [], prompt: "" }, removes)).toBeNull();
    for (const junk of [null, 3, "x", [], { tools: "post" }]) expect(pruneCapability(junk, removes), JSON.stringify(junk)).toBeNull();
  });

  it("rewritePrompt: replaces the seed's prompt only where it is unedited", () => {
    const r = { was: SPAWNING_PROMPT_V5, now: SPAWNING_CAPABILITIES.spawning!.prompt };
    const stored = { ...SPAWNING_CAPABILITIES.spawning!, prompt: SPAWNING_PROMPT_V5 };
    expect(rewritePrompt(stored, r)).toEqual(SPAWNING_CAPABILITIES.spawning);
    expect(rewritePrompt({ ...stored, prompt: `${SPAWNING_PROMPT_V5} Mine.` }, r)).toBeNull();
    expect(rewritePrompt(null, r)).toBeNull();
  });
});

// --- Properties over generated catalogs ----------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genCatalog(r: () => number): { catalog: Catalog; template: string; hands: boolean; overrides: { tools?: string[]; rules?: ToolRule[] } } {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const subset = <T>(xs: readonly T[], p: number) => xs.filter(() => r() < p);
  const rulePool: ToolRule[] = [NEST_ALLOW, { pattern: "Agent", decision: "allow" }, { pattern: "Bash", decision: "ask" }, { pattern: "Web*", decision: "deny", reason: "no" }];
  const capabilities: Record<string, Capability> = {};
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    capabilities[`c${i}`] = {
      tools: [...new Set(subset(PLATFORM_TOOL_NAMES, 0.2))].sort(() => r() - 0.5),
      rules: subset(rulePool, 0.4),
      prompt: r() < 0.5 ? `prompt ${i}` : "",
    };
  }
  const capNames = Object.keys(capabilities);
  const hands = pick(["required", "forbidden", "optional"] as const);
  const template: Template = {
    capabilities: subset(capNames, 0.6),
    launch: { builtin_tools: [], system_prompt: { mode: pick(["append", "replace"] as const), text: r() < 0.5 ? "base" : "" } },
    hands,
    credential: "claude_oauth_token",
  };
  const given = [...new Set(template.capabilities.flatMap((c) => capabilities[c]!.tools))];
  const overrides: { tools?: string[]; rules?: ToolRule[] } = {};
  if (r() < 0.4) overrides.tools = subset(given, 0.5);
  if (r() < 0.1) overrides.tools = [...(overrides.tools ?? []), pick(PLATFORM_TOOL_NAMES)];
  if (r() < 0.2) overrides.rules = subset(rulePool, 0.5);
  return { catalog: { capabilities, templates: { t: template } }, template: "t", hands: hands === "forbidden" ? false : hands === "required" ? true : r() < 0.5, overrides };
}

describe("expansion properties (500 generated catalogs)", () => {
  it("tools come from the capabilities, in registry order, once; overrides only narrow; rules and prompts come from the capabilities", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const g = genCatalog(rng(seed));
      const res = expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: g.hands, by: "operator", overrides: g.overrides });
      const tpl = g.catalog.templates[g.template]!;
      const caps = tpl.capabilities.map((c) => g.catalog.capabilities[c]!);
      const given = new Set(caps.flatMap((c) => c.tools));
      const ctx = `seed ${seed}`;
      if (g.overrides.tools?.some((t) => !given.has(t))) {
        expect(res.ok, ctx).toBe(false);
        continue;
      }
      if (!res.ok) throw new Error(`${ctx}: ${res.error}`);
      const spec = res.value;
      // Deterministic.
      expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: g.hands, by: "operator", overrides: g.overrides }), ctx).toEqual(res);
      // Tools: a subset of what the capabilities give (and of the override), each once, in registry order.
      expect(spec.tools.every((t) => given.has(t)), ctx).toBe(true);
      if (g.overrides.tools) expect(spec.tools.every((t) => g.overrides.tools!.includes(t)), ctx).toBe(true);
      else expect(new Set(spec.tools), ctx).toEqual(given);
      expect(spec.tools, ctx).toEqual(PLATFORM_TOOL_NAMES.filter((t) => spec.tools.includes(t)));
      // Rules: the override, or each capability rule once, in capability order.
      const key = (x: ToolRule) => JSON.stringify(x);
      if (g.overrides.rules) expect(spec.rules, ctx).toEqual(g.overrides.rules);
      else {
        expect(new Set(spec.rules.map(key)).size, ctx).toBe(spec.rules.length);
        expect(new Set(spec.rules.map(key)), ctx).toEqual(new Set(caps.flatMap((c) => c.rules).map(key)));
      }
      // Prompt: the template's text, then every non-empty capability prompt.
      const parts = [tpl.launch.system_prompt.text, ...caps.map((c) => c.prompt)].filter(Boolean);
      expect(spec.launch.system_prompt, ctx).toEqual({ mode: tpl.launch.system_prompt.mode, text: parts.join("\n\n") });
      expect(spec.credential, ctx).toEqual(tpl.credential);
      // Hands: the template's rule decides.
      if (tpl.hands === "required") expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: false, by: "operator" }).ok, ctx).toBe(false);
      if (tpl.hands === "forbidden") expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: true, by: "operator" }).ok, ctx).toBe(false);
    }
  });

  it("a spawner's spec never adds a tool, an allow rule, a built-in tool or another credential", () => {
    const decisions = ["allow", "deny", "ask"] as const;
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const g = genCatalog(r);
      const base = expandTemplate(g.catalog, PLATFORM_TOOL_NAMES, g.template);
      if (!base.ok) throw new Error(base.error);
      const overrides: Record<string, unknown> = {};
      if (r() < 0.5) overrides.tools = PLATFORM_TOOL_NAMES.filter(() => r() < 0.3);
      if (r() < 0.5) overrides.rules = [0, 1, 2].filter(() => r() < 0.5).map((i) => ({ pattern: `p${i}`, decision: decisions[Math.floor(r() * 3)] }));
      if (r() < 0.2) overrides.credential = "claude_oauth_token:other";
      if (r() < 0.2) overrides.params = { ledger: "other" };
      const res = expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: g.hands, by: "spawner", overrides: overrides as SpawnerOverrides });
      const ctx = `seed ${seed}`;
      const allowed = SpawnerOverrides.safeParse(overrides).success && ((overrides.tools as string[] | undefined) ?? []).every((t) => base.value.tools.includes(t));
      expect(res.ok, ctx).toBe(allowed);
      if (!res.ok) continue;
      const key = (x: ToolRule) => JSON.stringify(x);
      expect(res.value.tools.every((t) => base.value.tools.includes(t)), ctx).toBe(true);
      const allows = (rs: ToolRule[]) => new Set(rs.filter((x) => x.decision === "allow").map(key));
      expect(allows(res.value.rules), ctx).toEqual(allows(base.value.rules));
      const baseKeys = new Set(base.value.rules.map(key));
      expect(res.value.rules.filter((x) => !baseKeys.has(key(x))).every((x) => x.decision !== "allow"), ctx).toBe(true);
      expect([res.value.launch, res.value.credential], ctx).toEqual([base.value.launch, base.value.credential]);
    }
  });

  it("expanding the template alone never depends on hands", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = genCatalog(rng(seed));
      const a = expandTemplate(g.catalog, PLATFORM_TOOL_NAMES, g.template);
      for (const hands of [true, false]) {
        const b = expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands, by: "operator" });
        if (b.ok) expect(b, `seed ${seed}`).toEqual(a);
      }
    }
  });
});

describe("seed migration (pure)", () => {
  it("a version-1 catalog gains each later step's entries whose names are free; a current one gains nothing", () => {
    const all = { capabilities: Object.keys(SEED_CATALOG_V1.capabilities), templates: Object.keys(SEED_CATALOG_V1.templates) };
    const m = seedMigration(all, 1);
    expect(Object.keys(m.capabilities).sort()).toEqual([...Object.keys(EGRESS_CAPABILITIES), ...Object.keys(SPAWNING_CAPABILITIES), ...Object.keys(TIMER_CAPABILITIES)].sort());
    expect(m.templates).toEqual({});
    expect(m.version).toBe(SEED_VERSION);
    // A name the operator already uses is left alone (never overwritten).
    expect(Object.keys(seedMigration({ ...all, capabilities: [...all.capabilities, "egress"] }, 1).capabilities)).toEqual(["spawning", "timers"]);
    // Nothing for a catalog at the current version, so a deleted entry never comes back.
    expect(seedMigration({ capabilities: [], templates: [] }, SEED_VERSION).capabilities).toEqual({});
    // The version never goes back.
    expect(seedMigration(all, SEED_VERSION + 5).version).toBe(SEED_VERSION + 5);
  });
});

describe("mcp capabilities in a spec (docs/agents/capabilities/mcp/)", () => {
  const mcpCap = (tools?: string[]): Capability => ({
    tools: [], rules: [], prompt: "",
    mcp: { url: "https://mcp.example.com/mcp", auth: "cap:tracker", ...(tools ? { tools } : {}), idempotent: ["get"], read_only: { get: true, comment: false }, trusted: false, when_tainted: "approve" },
  });
  const tpl: Template = {
    capabilities: ["tracker", "transcripts"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } },
    hands: "optional", credential: "claude_oauth_token",
  };
  const cat: Catalog = { capabilities: { tracker: mcpCap(["get", "comment"]), transcripts: SEED_CATALOG.capabilities.transcripts! }, templates: { t: tpl } };

  it("the spec copies the server, allowlist, overrides, trust and sink rule; a spec without one has no mcp field", () => {
    const r = expandTemplate(cat, PLATFORM_TOOL_NAMES, "t");
    expect(r.ok && r.value.mcp).toEqual([{
      capability: "tracker", url: "https://mcp.example.com/mcp", auth: "cap:tracker", tools: ["get", "comment"], idempotent: { get: true },
      read_only: { get: true, comment: false }, trusted: false, when_tainted: "approve",
    }]);
    const plain = expandTemplate(SEED_CATALOG, PLATFORM_TOOL_NAMES, "worker");
    expect(plain.ok && plain.value).not.toHaveProperty("mcp");
  });

  it("an override naming tools narrows the allowlist to the remote tools it names, drops it when it names none, and never widens", () => {
    const narrow = (tools: string[], by: "operator" | "spawner" = "operator") =>
      expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "t", hands: false, by, overrides: { tools } } as never);
    const a = narrow(["tracker_get", "read_transcript"]);
    expect(a.ok && [a.value.tools, a.value.mcp?.[0]?.tools]).toEqual([["read_transcript"], ["get"]]);
    const b = narrow(["read_transcript"], "spawner");
    expect(b.ok && b.value).not.toHaveProperty("mcp");
    expect(narrow(["tracker_delete"])).toEqual({ ok: false, error: "template t doesn't give tracker_delete" });
    // With no allowlist the capability gives whatever the server lists, so any remote name narrows.
    const open: Catalog = { ...cat, capabilities: { ...cat.capabilities, tracker: mcpCap() } };
    const c = expandSpec(open, PLATFORM_TOOL_NAMES, { template: "t", hands: false, by: "operator", overrides: { tools: ["tracker_x"] } });
    expect(c.ok && c.value.mcp?.[0]?.tools).toEqual(["x"]);
  });

  it("checkCapability refuses a URL nest won't call and a name a platform tool starts with", () => {
    expect(checkCapability(mcpCap(), PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: false }).ok).toBe(true);
    expect(checkCapability(mcpCap(), PLATFORM_TOOL_NAMES, { name: "memory", allowLoopback: false })).toMatchObject({ ok: false });
    const http = { ...mcpCap(), mcp: { ...mcpCap().mcp!, url: "http://127.0.0.1:9/mcp" } };
    expect(checkCapability(http, PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: false }).ok).toBe(false);
    expect(checkCapability(http, PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: true }).ok).toBe(true);
  });
});
