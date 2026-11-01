// Templates, capabilities and spawn-spec expansion (lib/spec.ts): pure functions, checked directly.
// The first seed must give exactly what the `worker` and `captain` roles gave, and the current one
// that plus the task ledger's capabilities; the properties
// below hold for any catalog and spec (a seeded generator, not fast-check: it isn't a dependency).
import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import {
  type Capability, type Catalog, checkCapability, checkTemplate, expandSpec, expandTemplate, OperatorOverrides, ROLE_SPECS, SEED_CATALOG,
  SEED_CATALOG_V1, SEED_STEPS, SEED_VERSION, seedMigration, SpawnerOverrides, specFromRole, type Template, templatesUsing, CHANNEL_CAPABILITIES,
  TASK_CAPABILITIES, EGRESS_CAPABILITIES, SPAWNING_CAPABILITIES,
} from "../src/lib/spec";
import { TASK_ADMIN_TOOLS, TASK_TOOLS } from "../src/lib/tasks";
import { Credential, type ToolRule } from "../src/protocol/control";
import type { ChannelGrant } from "../src/lib/channels";

// What the roles gave (the role-filtered `platform-tools.json` and AgentDO's defaults before templates),
// less `delegate`, `spawn_agent` and `kill`, which the registry no longer has: the first seed still
// lists them, and expansion ignores them.
const WORKER_TOOLS = ["notify", "emit", "ask", "fork_sandbox", "read_transcript", "checkpoint", "expose_port", "brokered"];
const CAPTAIN_TOOLS = ["notify", "ask", "fork_sandbox", "attach", "read_transcript", "brokered", "spawn_workstream", "send",
  "list_workstreams", "get_status", "wait_events", "approve", "deny", "merge", "memory_read", "memory_write", "notify_user"];
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
  it("worker: the worker tools, launch, rules and token; escalates to the workstream channel", () => {
    expect(expand(SEED_CATALOG_V1, "worker", true)).toEqual({
      template: "worker",
      tools: WORKER_TOOLS,
      launch: WORKER_LAUNCH,
      rules: [NEST_ALLOW, { pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }],
      credential: "claude_oauth_token:worker",
      escalate_to: "workstream",
      subscribe: [],
      params: {},
      channel_grants: [],
    });
  });

  it("captain: the captain tools, launch, rules and token; subscribes to its workstream, escalates to the user", () => {
    expect(expand(SEED_CATALOG_V1, "captain", false)).toEqual({
      template: "captain",
      tools: CAPTAIN_TOOLS,
      launch: CAPTAIN_LAUNCH,
      rules: [NEST_ALLOW],
      credential: "claude_oauth_token:captain",
      escalate_to: "user",
      subscribe: ["workstream"],
      params: {},
      channel_grants: [],
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
    const s = specFromRole({ role: "worker", grants: ["notify", "merge", "emit"], launch, rules: [NEST_ALLOW] });
    // `merge` was never a worker tool: ignored, as the role filter ignored it.
    expect(s).toMatchObject({ template: "worker", tools: ["notify", "emit"], launch, rules: [NEST_ALLOW], credential: "claude_oauth_token:worker" });
    expect(specFromRole({ role: "captain", grants: null, launch: CAPTAIN_LAUNCH as never, rules: [NEST_ALLOW] }).tools)
      .toEqual(CAPTAIN_TOOLS);
  });
});

describe("records stored with a role read through a frozen table, not the seed", () => {
  it("the first seed still expands to what ROLE_SPECS freezes (so a seed edit can't change it unnoticed)", () => {
    for (const role of ["worker", "captain"] as const) {
      const { launch: _l, rules: _r, subscribe: _s, params: _p, channel_grants: _g, ...rest } = expand(SEED_CATALOG_V1, role, role === "worker");
      expect(rest, role).toEqual(ROLE_SPECS[role]);
    }
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
    const r = spawn({ tools: ["notify", "ask"], rules: [{ pattern: "mcp__nest__Bash(rm *)", decision: "deny" }, { pattern: "WebSearch", decision: "ask" }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.tools).toEqual(["notify", "ask"]);
    expect(r.value.rules).toEqual([{ pattern: "mcp__nest__Bash(rm *)", decision: "deny" }, { pattern: "WebSearch", decision: "ask" }, ...base.rules]);
    expect([r.value.launch, r.value.credential, r.value.escalate_to]).toEqual([base.launch, base.credential, base.escalate_to]);
    expect(spawn({ tools: ["merge"] }).ok).toBe(false);
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
    expect(expand(SEED_CATALOG, "worker", true, { tools: ["emit", "notify"] }).tools).toEqual(["notify", "emit"]);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "operator", overrides: { tools: ["notify", "merge"] } }))
      .toEqual({ ok: false, error: "template worker doesn't give merge" });
  });

  it("a stored capability naming a tool the registry dropped still expands, without it; a write still refuses it", () => {
    // Catalogs seeded with the first seed hold `management` with the retired tools: their captains must still spawn.
    for (const t of ["delegate", "spawn_agent", "kill"]) {
      expect(SEED_CATALOG_V1.capabilities.management!.tools).toContain(t);
      expect(PLATFORM_TOOL_NAMES).not.toContain(t);
    }
    expect(expand(SEED_CATALOG_V1, "captain", false).tools).toEqual(CAPTAIN_TOOLS);
    const stale: Catalog = { capabilities: { old: { tools: ["notify", "gone_tool"], rules: [], prompt: "", grants: [], params: [] } },
      templates: { t: { ...SEED_CATALOG.templates.captain!, capabilities: ["old"] } } };
    expect(expand(stale, "t", false).tools).toEqual(["notify"]);
    expect(checkCapability(stale.capabilities.old!, PLATFORM_TOOL_NAMES)).toEqual({ ok: false, error: "unknown platform tool gone_tool" });
  });

  it("unknown names, and inherited object keys, are unknown", () => {
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "nope", hands: false, by: "operator" }).ok).toBe(false);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "constructor", hands: false, by: "operator" }).ok).toBe(false);
    const broken: Catalog = { ...SEED_CATALOG, templates: { b: { ...SEED_CATALOG.templates.captain!, capabilities: ["toString"] } } };
    expect(expandSpec(broken, PLATFORM_TOOL_NAMES, { template: "b", hands: false, by: "operator" })).toEqual({ ok: false, error: "template b: unknown capability toString" });
    expect(checkCapability({ tools: ["nope"], rules: [], prompt: "", grants: [], params: [] }, PLATFORM_TOOL_NAMES).ok).toBe(false);
    expect(checkCapability({ tools: ["notify", "notify"], rules: [], prompt: "", grants: [], params: [] }, PLATFORM_TOOL_NAMES).ok).toBe(false);
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

describe("the current seed adds the task ledger (seed version 3) and drops what the design doesn't offer", () => {
  it("worker gains `tasks`; captain gains `tasks` and `tasks-admin`; the worker's launch and rules are the design's; nothing else changes", () => {
    const v1w = expand(SEED_CATALOG_V1, "worker", true);
    const v1c = expand(SEED_CATALOG_V1, "captain", false);
    const w = expand(SEED_CATALOG, "worker", true);
    const c = expand(SEED_CATALOG, "captain", false);
    expect(w.tools).toEqual([...WORKER_TOOLS, ...TASK_TOOLS]);
    // The registry's order: the spawning tools sit where the stubs they replace were.
    expect(c.tools).toEqual(PLATFORM_TOOL_NAMES.filter((t) => [...CAPTAIN_TOOLS, ...TASK_TOOLS, ...TASK_ADMIN_TOOLS, "agent_spawn", "agent_stop"].includes(t)));
    expect(c.spawn).toEqual(["worker"]);
    // docs/agents/runner/: the task and web tools, no `TodoWrite` and no `Agent` (nor its old name `Task`),
    // so no rule letting subagents run either.
    expect(w.launch.builtin_tools).toEqual(["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "WebSearch", "WebFetch"]);
    expect(w.rules).toEqual([NEST_ALLOW]);
    expect(c.launch.builtin_tools).toEqual([]);
    for (const [v1, v2] of [[v1w, w], [v1c, c]] as const) {
      expect({ ...v2, tools: [], launch: null, rules: [], spawn: [] }).toEqual({ ...v1, tools: [], launch: null, rules: [], spawn: [] });
      expect(v2.launch.system_prompt.text.startsWith(v1.launch.system_prompt.text)).toBe(true);
    }
    // No ledger unless the spawn names one; a spawn may name one, because `tasks` declares it.
    expect(w.params).toEqual({});
    expect(expand(SEED_CATALOG, "worker", true, { params: { ledger: "proj-a" } }).params).toEqual({ ledger: "proj-a" });
  });

  it("a capability parameter must be declared by a capability of the template, and be well-formed", () => {
    expect(expandSpec(SEED_CATALOG_V1, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "operator", overrides: { params: { ledger: "x" } } }))
      .toEqual({ ok: false, error: "no capability of template worker takes ledger" });
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "operator", overrides: { params: { ledger: "bad name" } } }).ok)
      .toBe(false);
    // A template's own default is checked the same way, and an override replaces it.
    const withDefault: Catalog = { ...SEED_CATALOG, templates: { t: { ...SEED_CATALOG.templates.worker!, params: { ledger: "dflt" } } } };
    expect(expand(withDefault, "t", true).params).toEqual({ ledger: "dflt" });
    expect(expand(withDefault, "t", true, { params: { ledger: "other" } }).params).toEqual({ ledger: "other" });
    const undeclared: Catalog = { ...SEED_CATALOG_V1, templates: { t: { ...SEED_CATALOG_V1.templates.worker!, params: { ledger: "dflt" } } } };
    expect(expandTemplate(undeclared, PLATFORM_TOOL_NAMES, "t")).toEqual({ ok: false, error: "no capability of template t takes ledger" });
    // The admin route's check refuses such a template up front (not at its first spawn).
    expect(checkTemplate(undeclared.templates.t!, undeclared.capabilities)).toEqual({ ok: false, error: "no capability of the template takes ledger" });
    expect(checkTemplate(withDefault.templates.t!, withDefault.capabilities).ok).toBe(true);
  });

  it("a spawner's child never gets a template's default ledger (it would reach a ledger the spawner may not hold)", () => {
    const withAdminDefault: Catalog = {
      ...SEED_CATALOG, templates: { lead: { ...SEED_CATALOG.templates.captain!, params: { ledger: "someone-elses" } } },
    };
    // The operator's spawn gets the default; a spawner's gets none, so its task tools refuse.
    expect(expand(withAdminDefault, "lead", false).params).toEqual({ ledger: "someone-elses" });
    const child = expandSpec(withAdminDefault, PLATFORM_TOOL_NAMES, { template: "lead", hands: false, by: "spawner" });
    expect(child.ok && child.value.params).toEqual({});
    expect(child.ok && child.value.tools).toEqual(expect.arrayContaining([...TASK_ADMIN_TOOLS]));
  });

  it("a spawner can't obtain tasks-admin from the worker template, nor name a ledger", () => {
    const spawn = (overrides: unknown) =>
      expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "spawner", overrides: overrides as SpawnerOverrides });
    for (const t of TASK_ADMIN_TOOLS) expect(spawn({ tools: [...TASK_TOOLS, t] })).toEqual({ ok: false, error: `template worker doesn't give ${t}` });
    const narrowed = spawn({ tools: ["task_list", "task_get"] });
    expect(narrowed.ok && narrowed.value.tools).toEqual(["task_list", "task_get"]);
    expect(spawn({ params: { ledger: "x" } }).ok).toBe(false);
    expect(SpawnerOverrides.safeParse({ params: { ledger: "x" } }).success).toBe(false);
    // Nor an allow rule: a spawner's rules are deny or ask only.
    expect(spawn({ rules: [{ pattern: "mcp__nest__task_assign", decision: "allow" }] }).ok).toBe(false);
  });

  it("seed steps: versions strictly increase, the last is the seed version, and every step's entries are the current seed's", () => {
    const versions = SEED_STEPS.map((s) => s.version);
    expect(versions).toEqual([2, 3, 4, 5]);
    for (let i = 1; i < versions.length; i++) expect(versions[i]!, String(i)).toBeGreaterThan(versions[i - 1]!);
    expect(SEED_VERSION).toBe(versions.at(-1));
    // No two steps name the same entry (one would never be applied to a catalog the other already reached).
    const names = SEED_STEPS.flatMap((s) => [...Object.keys(s.capabilities), ...Object.keys(s.templates)]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("seedMigration: a catalog at version 2 (channels applied) gains exactly the task, egress and spawning capabilities", () => {
    const v2 = { capabilities: [...Object.keys(SEED_CATALOG_V1.capabilities), ...Object.keys(CHANNEL_CAPABILITIES)], templates: Object.keys(SEED_CATALOG_V1.templates) };
    const m = seedMigration(v2, 2);
    expect(Object.keys(m.capabilities).sort()).toEqual(["egress", "spawning", "tasks", "tasks-admin"]);
    expect(m.capabilities).toEqual({ ...TASK_CAPABILITIES, ...EGRESS_CAPABILITIES, ...SPAWNING_CAPABILITIES });
    expect(m.templates).toEqual({});
    expect(m.version).toBe(5);
    // A catalog at version 3 gains egress and spawning; one at 4, spawning.
    expect(seedMigration({ ...v2, capabilities: [...v2.capabilities, "tasks", "tasks-admin"] }, 3).capabilities).toEqual({ ...EGRESS_CAPABILITIES, ...SPAWNING_CAPABILITIES });
    expect(seedMigration({ ...v2, capabilities: [...v2.capabilities, "tasks", "tasks-admin", "egress"] }, 4).capabilities).toEqual(SPAWNING_CAPABILITIES);
    // Even with channels' entries since deleted: version 2's step doesn't run again.
    expect(Object.keys(seedMigration({ ...v2, capabilities: Object.keys(SEED_CATALOG_V1.capabilities) }, 2).capabilities).sort()).toEqual(["egress", "spawning", "tasks", "tasks-admin"]);
    // An operator's own `tasks` stays theirs.
    expect(Object.keys(seedMigration({ ...v2, capabilities: [...v2.capabilities, "tasks"] }, 2).capabilities)).toEqual(["tasks-admin", "egress", "spawning"]);
    // Once it reached a version it adds nothing, whatever is missing: deleted entries stay deleted.
    expect(seedMigration({ capabilities: [], templates: [] }, SEED_VERSION)).toEqual({ capabilities: {}, templates: {}, version: SEED_VERSION });
    // Every step's entries are what the current seed holds.
    for (const step of SEED_STEPS) {
      for (const [n, cap] of Object.entries(step.capabilities)) expect(SEED_CATALOG.capabilities[n], n).toEqual(cap);
      for (const [n, t] of Object.entries(step.templates)) expect(SEED_CATALOG.templates[n], n).toEqual(t);
    }
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
  const grantPool: ChannelGrant[] = [{ action: "post", channel: "user" }, { action: "read", channel: "team/*" }, { action: "post", channel: "{owner}/inbox" }];
  const capabilities: Record<string, Capability> = {};
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    capabilities[`c${i}`] = {
      tools: [...new Set(subset(PLATFORM_TOOL_NAMES, 0.2))].sort(() => r() - 0.5),
      rules: subset(rulePool, 0.4),
      prompt: r() < 0.5 ? `prompt ${i}` : "",
      params: r() < 0.3 ? ["ledger"] : [],
      grants: subset(grantPool, 0.3),
    };
  }
  const capNames = Object.keys(capabilities);
  const hands = pick(["required", "forbidden", "optional"] as const);
  const template: Template = {
    capabilities: subset(capNames, 0.6),
    launch: { builtin_tools: [], system_prompt: { mode: pick(["append", "replace"] as const), text: r() < 0.5 ? "base" : "" } },
    hands,
    credential: "claude_oauth_token",
    escalate_to: pick(["user", "workstream"] as const),
    subscribe: r() < 0.5 ? ["workstream"] : [],
    params: {},
  };
  // A default ledger, where a listed capability takes one (so the spawner property meets defaults).
  if (template.capabilities.some((c) => capabilities[c]!.params.includes("ledger")) && r() < 0.6) template.params = { ledger: "dflt" };
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
      expect([spec.credential, spec.escalate_to, spec.subscribe], ctx).toEqual([tpl.credential, tpl.escalate_to, tpl.subscribe]);
      // Channel grants: every capability grant once, whatever the overrides (an operator's narrow only tools).
      const gk = (x: ChannelGrant) => `${x.action} ${x.channel}`;
      expect(new Set(spec.channel_grants.map(gk)).size, ctx).toBe(spec.channel_grants.length);
      expect(new Set(spec.channel_grants.map(gk)), ctx).toEqual(new Set(caps.flatMap((c) => c.grants).map(gk)));
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
      expect([res.value.launch, res.value.credential, res.value.escalate_to], ctx).toEqual([base.value.launch, base.value.credential, base.value.escalate_to]);
      // No parameters at all, whatever the template's defaults.
      expect(res.value.params, ctx).toEqual({});
      // A spawner never widens channel grants either.
      expect(res.value.channel_grants, ctx).toEqual(base.value.channel_grants);
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
    expect(Object.keys(m.capabilities).sort()).toEqual([...Object.keys(CHANNEL_CAPABILITIES), ...Object.keys(TASK_CAPABILITIES), ...Object.keys(EGRESS_CAPABILITIES),
      ...Object.keys(SPAWNING_CAPABILITIES)].sort());
    expect(m.templates).toEqual({});
    expect(m.version).toBe(SEED_VERSION);
    // A name the operator already uses is left alone (never overwritten).
    expect(Object.keys(seedMigration({ ...all, capabilities: [...all.capabilities, "channels"] }, 1).capabilities)).toEqual(["messaging-tree", "tasks", "tasks-admin", "egress", "spawning"]);
    // Nothing for a catalog at the current version, so a deleted entry never comes back.
    expect(seedMigration({ capabilities: [], templates: [] }, SEED_VERSION)).toEqual({ capabilities: {}, templates: {}, version: SEED_VERSION });
    // The version never goes back.
    expect(seedMigration(all, SEED_VERSION + 5).version).toBe(SEED_VERSION + 5);
  });
});

describe("mcp capabilities in a spec (docs/agents/capabilities/mcp/)", () => {
  const mcpCap = (tools?: string[]): Capability => ({
    tools: [], rules: [], prompt: "", grants: [], params: [],
    mcp: { url: "https://mcp.example.com/mcp", auth: "cap:tracker", ...(tools ? { tools } : {}), idempotent: ["get"], read_only: { get: true, comment: false }, trusted: false, when_tainted: "approve" },
  });
  const tpl: Template = {
    capabilities: ["tracker", "messaging"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } },
    hands: "optional", credential: "claude_oauth_token", escalate_to: "user", subscribe: [], params: {},
  };
  const cat: Catalog = { capabilities: { tracker: mcpCap(["get", "comment"]), messaging: SEED_CATALOG.capabilities.messaging! }, templates: { t: tpl } };

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
    const a = narrow(["tracker_get", "notify"]);
    expect(a.ok && [a.value.tools, a.value.mcp?.[0]?.tools]).toEqual([["notify"], ["get"]]);
    const b = narrow(["notify"], "spawner");
    expect(b.ok && b.value).not.toHaveProperty("mcp");
    expect(narrow(["tracker_delete"])).toEqual({ ok: false, error: "template t doesn't give tracker_delete" });
    // With no allowlist the capability gives whatever the server lists, so any remote name narrows.
    const open: Catalog = { ...cat, capabilities: { ...cat.capabilities, tracker: mcpCap() } };
    const c = expandSpec(open, PLATFORM_TOOL_NAMES, { template: "t", hands: false, by: "operator", overrides: { tools: ["tracker_x"] } });
    expect(c.ok && c.value.mcp?.[0]?.tools).toEqual(["x"]);
  });

  it("checkCapability refuses a URL nest won't call and a name a platform tool starts with", () => {
    expect(checkCapability(mcpCap(), PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: false }).ok).toBe(true);
    expect(checkCapability(mcpCap(), PLATFORM_TOOL_NAMES, { name: "channel", allowLoopback: false })).toMatchObject({ ok: false });
    const http = { ...mcpCap(), mcp: { ...mcpCap().mcp!, url: "http://127.0.0.1:9/mcp" } };
    expect(checkCapability(http, PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: false }).ok).toBe(false);
    expect(checkCapability(http, PLATFORM_TOOL_NAMES, { name: "tracker", allowLoopback: true }).ok).toBe(true);
  });
});
