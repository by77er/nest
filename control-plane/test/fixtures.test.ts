// Round-trips every fixture in protocol/fixtures/control/ through the TypeScript schemas and checks
// that the fixtures of each directory cover exactly the variants of its message type.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import platformTools from "../../protocol/schemas/control/platform-tools.json";
import * as C from "../src/protocol/control";
import * as M from "../src/protocol/model";

const files = import.meta.glob("../../protocol/fixtures/control/**/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;

type Entry = { schema: z.ZodType; variants: string[]; tag: (v: Record<string, unknown>) => string };
const byType = (variants: readonly { shape: { type: { value: unknown } } }[]): Entry["variants"] =>
  variants.map((v) => String(v.shape.type.value));
const typeTag = (v: Record<string, unknown>) => String(v.type);

const dirs: Record<string, Entry> = {
  host_to_fleet: { schema: C.HostToFleet, variants: byType(C.HostToFleetVariants), tag: typeTag },
  fleet_to_host: { schema: C.FleetToHost, variants: byType(C.FleetToHostVariants), tag: typeTag },
  command: { schema: C.Command, variants: byType(C.CommandBodyVariants), tag: typeTag },
  host_event: { schema: C.HostEvent, variants: byType(C.HostEventVariants), tag: typeTag },
  runner_to_agent: { schema: C.RunnerToAgent, variants: byType(C.RunnerToAgentVariants), tag: typeTag },
  agent_to_runner: { schema: C.AgentToRunner, variants: byType(C.AgentToRunnerVariants), tag: typeTag },
  agent_event: { schema: M.AgentEvent, variants: byType(M.AgentEventVariants), tag: typeTag },
  workstream_event: { schema: M.WorkstreamEvent, variants: byType(M.WorkstreamEventVariants), tag: typeTag },
  enroll_request: {
    schema: C.EnrollRequest,
    variants: ["aws_identity_document", "enrollment_token"],
    tag: (v) => String((v.proof as Record<string, unknown>).type),
  },
  enroll_response: { schema: C.EnrollResponse, variants: ["enroll_response"], tag: () => "enroll_response" },
  egress_policy: { schema: M.EgressPolicy, variants: ["egress_policy"], tag: () => "egress_policy" },
  generation_record: { schema: M.GenerationRecord, variants: ["generation_record"], tag: () => "generation_record" },
  manifest: { schema: M.Manifest, variants: ["manifest"], tag: () => "manifest" },
};

const grouped = new Map<string, { name: string; value: unknown }[]>();
for (const [path, value] of Object.entries(files)) {
  const m = /fixtures\/control\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!m) throw new Error(`unexpected fixture path ${path}`);
  const [, dir, name] = m as unknown as [string, string, string];
  grouped.set(dir, [...(grouped.get(dir) ?? []), { name, value }]);
}

describe("control fixtures", () => {
  it("every fixture directory has a schema", () => {
    expect([...grouped.keys()].sort()).toEqual(Object.keys(dirs).sort());
  });

  for (const [dir, entry] of Object.entries(dirs)) {
    it(`${dir}: round-trips and covers every variant`, () => {
      const fixtures = grouped.get(dir) ?? [];
      expect(fixtures.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const { name, value } of fixtures) {
        const parsed = entry.schema.safeParse(value);
        if (!parsed.success) throw new Error(`${dir}/${name}: ${parsed.error.message}`);
        // Serialize as the wire does (drops undefined) and compare to the original JSON.
        expect(JSON.parse(JSON.stringify(parsed.data)), `${dir}/${name}`).toEqual(value);
        const variant = entry.tag(parsed.data as Record<string, unknown>);
        expect(name === variant || name.startsWith(`${variant}.`), `${dir}/${name} is a \`${variant}\``).toBe(true);
        seen.add(variant);
      }
      expect([...seen].sort()).toEqual([...entry.variants].sort());
    });
  }

  it("platform tool catalog parses", () => {
    const tools = (platformTools as unknown[]).map((t) => C.ToolDef.parse(t));
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("policy decision semantics match Rust", () => {
    const p = M.EgressPolicy.parse({
      version: 1,
      allow: [
        { host: "github.com", ports: [443], layer: "base" },
        { host: "example.com", ports: [443], layer: "sandbox", expires_ms: 1000 },
        { host: "pinned.example.net", ports: [443], layer: "workstream" },
      ],
      passthrough: ["pinned.example.net"],
      limits: { max_connections: 256, bandwidth_mbps: 200, max_inspected_body_bytes: 512 << 20 },
    });
    expect(M.decideEgress(p, "github.com", 443, 0)).toBe("inspect");
    expect(M.decideEgress(p, "github.com", 80, 0)).toBe("deny");
    expect(M.decideEgress(p, "example.com", 443, 999)).toBe("inspect");
    expect(M.decideEgress(p, "example.com", 443, 1000)).toBe("deny");
    expect(M.decideEgress(p, "pinned.example.net", 443, 0)).toBe("passthrough");
    expect(M.hostPatternMatches("*.githubusercontent.com", "RAW.githubusercontent.com.")).toBe(true);
    expect(M.hostPatternMatches("*.githubusercontent.com", "githubusercontent.com")).toBe(false);
    expect(M.hostPatternMatches("*.githubusercontent.com", "evilgithubusercontent.com")).toBe(false);
  });
});
