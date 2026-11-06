// Which roles may spawn what (src/catalog.ts): a worker runs Claude Code's own subagents, inside its
// one sandbox; no role gets nest-level spawning (new agents or sandboxes).
import { describe, expect, it } from "vitest";
import { catalogFor, NAMESPACE } from "../src/catalog";

const NEST_SPAWNING = ["management", "sandboxes", "spawning"];
const cat = catalogFor("https://projects.test", ["acme/app"]);
const tpl = (role: string) => cat.templates[`${NAMESPACE}/${role}`] as { capabilities: string[]; launch: { builtin_tools: string[] }; repos?: string[]; read_repos?: string[]; ephemeral?: boolean; hands: string };

describe("role templates: spawning", () => {
  it("a worker may run Claude Code subagents: the subagents capability and the Agent tool", () => {
    expect(tpl("worker").capabilities).toContain("subagents");
    expect(tpl("worker").launch.builtin_tools).toContain("Agent");
  });

  it("no role can start nest agents or sandboxes", () => {
    for (const role of ["manager", "worker", "reviewer", "routine", "dreaming"]) {
      for (const cap of NEST_SPAWNING) expect(tpl(role).capabilities, `${role} has ${cap}`).not.toContain(cap);
    }
  });

  it("only the worker gets subagents", () => {
    for (const role of ["manager", "reviewer", "routine"]) {
      expect(tpl(role).capabilities).not.toContain("subagents");
      expect(tpl(role).launch.builtin_tools).not.toContain("Agent");
    }
  });
});

describe("the routine template (README.md#routines)", () => {
  it("reads the repo and never pushes, ends itself, and has no timers", () => {
    const t = tpl("routine");
    expect(t.read_repos).toEqual(["acme/app"]);
    expect(t.repos).toBeUndefined();
    expect(t.ephemeral).toBe(true);
    expect(t.capabilities).not.toContain("timers");
    expect(t.capabilities).toContain(`${NAMESPACE}/routine`);
  });
});

describe("the dreaming template (README.md#routines)", () => {
  it("has no hands, no repo and no web: the board, memory and transcripts only; it ends itself", () => {
    const t = tpl("dreaming");
    expect(t.hands).toBe("forbidden");
    expect(t.capabilities).toEqual(["nest", `${NAMESPACE}/routine`]);
    expect(t.repos).toBeUndefined();
    expect(t.read_repos).toBeUndefined();
    expect(t.launch.builtin_tools.filter((b) => /^Web/.test(b))).toEqual([]);
    expect(t.ephemeral).toBe(true);
  });
});
