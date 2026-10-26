// Templates, capabilities and spawn-spec expansion (lib/spec.ts): pure functions, checked directly.
// The seed catalog must give exactly what the `worker` and `captain` roles gave; the properties
// below hold for any catalog and spec (a seeded generator, not fast-check: it isn't a dependency).
import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import {
  type Capability, type Catalog, checkCapability, checkTemplate, Credential, expandSpec, expandTemplate, SEED_CATALOG, specFromRole, type Template,
  templatesUsing,
} from "../src/lib/spec";
import type { ToolRule } from "../src/protocol/control";

// What the roles gave (the role-filtered `platform-tools.json` and AgentDO's defaults before templates).
const WORKER_TOOLS = ["notify", "emit", "ask", "fork_sandbox", "read_transcript", "checkpoint", "expose_port", "brokered"];
const CAPTAIN_TOOLS = ["notify", "ask", "spawn_agent", "fork_sandbox", "attach", "read_transcript", "brokered", "spawn_workstream", "send",
  "list_workstreams", "get_status", "wait_events", "approve", "deny", "merge", "kill", "delegate", "memory_read", "memory_write", "notify_user"];
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
  const r = expandSpec(catalog, PLATFORM_TOOL_NAMES, { template, hands, overrides });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("the seed catalog is what the roles were", () => {
  it("worker: the worker tools, launch, rules and token; escalates to the workstream channel", () => {
    expect(expand(SEED_CATALOG, "worker", true)).toEqual({
      template: "worker",
      tools: WORKER_TOOLS,
      launch: WORKER_LAUNCH,
      rules: [NEST_ALLOW, { pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }],
      credential: "claude_oauth_token:worker",
      escalate_to: "workstream",
      subscribe: [],
    });
  });

  it("captain: the captain tools, launch, rules and token; subscribes to its workstream, escalates to the user", () => {
    expect(expand(SEED_CATALOG, "captain", false)).toEqual({
      template: "captain",
      tools: CAPTAIN_TOOLS,
      launch: CAPTAIN_LAUNCH,
      rules: [NEST_ALLOW],
      credential: "claude_oauth_token:captain",
      escalate_to: "user",
      subscribe: ["workstream"],
    });
  });

  it("every seed entry passes the checks the admin routes apply", () => {
    for (const c of Object.values(SEED_CATALOG.capabilities)) expect(checkCapability(c, PLATFORM_TOOL_NAMES).ok).toBe(true);
    for (const t of Object.values(SEED_CATALOG.templates)) expect(checkTemplate(t, SEED_CATALOG.capabilities).ok).toBe(true);
  });

  it("a record stored with a role gets that role's spec, its stored launch and rules, and its grants as a narrowing", () => {
    const launch = { builtin_tools: [], system_prompt: { mode: "append" as const, text: "custom" } };
    const s = specFromRole(PLATFORM_TOOL_NAMES, { role: "worker", grants: ["notify", "merge", "emit"], launch, rules: [NEST_ALLOW] });
    // `merge` was never a worker tool: ignored, as the role filter ignored it.
    expect(s).toMatchObject({ template: "worker", tools: ["notify", "emit"], launch, rules: [NEST_ALLOW], credential: "claude_oauth_token:worker" });
    expect(specFromRole(PLATFORM_TOOL_NAMES, { role: "captain", grants: null, launch: CAPTAIN_LAUNCH as never, rules: [NEST_ALLOW] }).tools)
      .toEqual(CAPTAIN_TOOLS);
  });
});

describe("expansion refuses what it can't give", () => {
  it("hands: required needs a sandbox, forbidden refuses one, optional takes either", () => {
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: false })).toEqual({ ok: false, error: "template worker needs a sandbox" });
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "captain", hands: true })).toEqual({ ok: false, error: "template captain has no hands" });
    const optional: Catalog = { ...SEED_CATALOG, templates: { o: { ...SEED_CATALOG.templates.worker!, hands: "optional" } } };
    expect(expandSpec(optional, PLATFORM_TOOL_NAMES, { template: "o", hands: true }).ok).toBe(true);
    expect(expandSpec(optional, PLATFORM_TOOL_NAMES, { template: "o", hands: false }).ok).toBe(true);
  });

  it("tools: an override narrows and never widens", () => {
    expect(expand(SEED_CATALOG, "worker", true, { tools: ["emit", "notify"] }).tools).toEqual(["notify", "emit"]);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, overrides: { tools: ["notify", "merge"] } }))
      .toEqual({ ok: false, error: "template worker doesn't give merge" });
  });

  it("unknown names, and inherited object keys, are unknown", () => {
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "nope", hands: false }).ok).toBe(false);
    expect(expandSpec(SEED_CATALOG, PLATFORM_TOOL_NAMES, { template: "constructor", hands: false }).ok).toBe(false);
    const broken: Catalog = { ...SEED_CATALOG, templates: { b: { ...SEED_CATALOG.templates.captain!, capabilities: ["toString"] } } };
    expect(expandSpec(broken, PLATFORM_TOOL_NAMES, { template: "b", hands: false })).toEqual({ ok: false, error: "template b: unknown capability toString" });
    expect(checkCapability({ tools: ["nope"], rules: [], prompt: "" }, PLATFORM_TOOL_NAMES).ok).toBe(false);
    expect(checkCapability({ tools: ["notify", "notify"], rules: [], prompt: "" }, PLATFORM_TOOL_NAMES).ok).toBe(false);
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
    escalate_to: pick(["user", "workstream"] as const),
    subscribe: r() < 0.5 ? ["workstream"] : [],
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
      const res = expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: g.hands, overrides: g.overrides });
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
      expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: g.hands, overrides: g.overrides }), ctx).toEqual(res);
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
      // Hands: the template's rule decides.
      if (tpl.hands === "required") expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: false }).ok, ctx).toBe(false);
      if (tpl.hands === "forbidden") expect(expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands: true }).ok, ctx).toBe(false);
    }
  });

  it("expanding the template alone never depends on hands", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = genCatalog(rng(seed));
      const a = expandTemplate(g.catalog, PLATFORM_TOOL_NAMES, g.template, g.overrides);
      for (const hands of [true, false]) {
        const b = expandSpec(g.catalog, PLATFORM_TOOL_NAMES, { template: g.template, hands, overrides: g.overrides });
        if (b.ok) expect(b, `seed ${seed}`).toEqual(a);
      }
    }
  });
});
