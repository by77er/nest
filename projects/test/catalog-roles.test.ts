// Which roles may spawn what (src/catalog.ts): a worker runs Claude Code's own subagents, inside its
// one sandbox; no role gets nest-level spawning (new agents or sandboxes).
import { describe, expect, it } from "vitest";
import { catalogFor, NAMESPACE, REPO_GUIDANCE, roleTemplate } from "../src/catalog";

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

describe("the repo's own guidance (README.md#the-repos-own-guidance)", () => {
  const prompt = (t: unknown) => (t as { launch: { system_prompt: { text: string } } }).launch.system_prompt.text;

  it("every role that works on the repo's code is told to read its AGENTS.md (or CLAUDE.md) and its skills, through hands", () => {
    for (const role of ["manager", "worker", "reviewer", "routine"]) {
      expect(tpl(role).hands, role).toBe("required");
      expect(prompt(tpl(role)), role).toContain(REPO_GUIDANCE);
    }
    expect(REPO_GUIDANCE).toMatch(/AGENTS\.md \(or CLAUDE\.md if there is none\).*hands Read tool/);
    // Every session: a brain resumed after an idle exit or a host loss, or compacted, may have lost the read.
    expect(REPO_GUIDANCE).toMatch(/^At the start of each session, and again whenever the repo's guidance is no longer in your context \(after a resume or compaction\)/);
    expect(REPO_GUIDANCE).toContain(".claude/skills/");
    // A project's own templates on its models too.
    for (const role of ["manager", "worker"] as const) expect(prompt(roleTemplate(role, "prj_abc123", "Acme/App", "claude-opus-5-5").body), role).toContain(REPO_GUIDANCE);
  });

  it("a role without hands (dreaming) isn't, and no template carries repo-specific text", () => {
    expect(prompt(tpl("dreaming"))).not.toContain("AGENTS.md");
    for (const t of Object.values(cat.templates)) expect(prompt(t)).not.toContain("acme/app");
  });
});
