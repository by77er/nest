// Round-trips every fixture in protocol/fixtures/control/ through the TypeScript schemas and checks
// that the fixtures of each directory cover exactly the variants of its message type; does the same
// for the guest types the control plane mirrors (protocol/fixtures/guest/); and asserts the shared
// code and enum lists (protocol/fixtures/codes.json, enums.json) that the Rust crate asserts too.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import codes from "../../protocol/fixtures/codes.json";
import enums from "../../protocol/fixtures/enums.json";
import platformTools from "../../protocol/schemas/control/platform-tools.json";
import * as C from "../src/protocol/control";
import * as G from "../src/protocol/gateway";
import * as M from "../src/protocol/model";

const files = import.meta.glob("../../protocol/fixtures/control/**/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;
const guestFiles = import.meta.glob("../../protocol/fixtures/guest/{cli,control}/*.json", { eager: true, import: "default" }) as Record<
  string,
  Record<string, unknown>
>;

type Entry = { schema: z.ZodType; variants: string[]; tag: (v: Record<string, unknown>) => string };
const reasonTag = (v: unknown) => {
  const p = C.egressReasonParts(v as string);
  return p.kind === "unit" ? p.name : p.kind;
};
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
  egress_reason: { schema: C.EgressReason, variants: [...C.EGRESS_REASONS, "upstream", "other"], tag: reasonTag },
  egress_audit_kind: { schema: C.EgressAuditKind, variants: ["request", "suppressed", "limit"], tag: typeTag },
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

describe("guest fixtures (the guest types the control plane mirrors)", () => {
  const byDir = (dir: string, prefix: string) =>
    Object.entries(guestFiles)
      .map(([path, value]) => ({ dir: path.split("/").at(-2), name: path.split("/").at(-1)!.replace(/\.json$/, ""), value }))
      .filter((f) => f.dir === dir && f.name.startsWith(prefix));
  const roundTrips = (schema: z.ZodType, value: unknown, what: string) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`${what}: ${parsed.error.message}`);
    expect(JSON.parse(JSON.stringify(parsed.data)), what).toEqual(value);
  };

  it("cli requests: each command round-trips through CliCommand, and every command has one", () => {
    const seen = new Set<string>();
    for (const { name, value } of byDir("cli", "request_")) {
      roundTrips(M.CliCommand, value.command, `guest/cli/${name}`);
      if (value.agent_id !== undefined) expect(M.AgentId.safeParse(value.agent_id).success, name).toBe(true);
      seen.add(String((value.command as Record<string, unknown>).command));
    }
    expect([...seen].sort()).toEqual(M.CliCommand.options.map((o) => String(o.shape.command.value)).sort());
  });

  it("cli responses: each result round-trips through CliResult, and every status has one", () => {
    const seen = new Set<string>();
    for (const { name, value } of byDir("cli", "response_")) {
      roundTrips(M.CliResult, value.result, `guest/cli/${name}`);
      seen.add(String((value.result as Record<string, unknown>).status));
    }
    expect([...seen].sort()).toEqual(M.CliResult.options.map((o) => String(o.shape.status.value)).sort());
  });

  it("control: task_exited's task round-trips through TaskInfo; the cli relay through CliCommand and CliResult", () => {
    const one = (name: string) => byDir("control", name).find((f) => f.name === name)!.value;
    roundTrips(M.TaskInfo, one("task_exited").task, "guest/control/task_exited");
    roundTrips(M.CliCommand, one("cli").command, "guest/control/cli");
    roundTrips(M.CliResult, one("cli_result").result, "guest/control/cli_result");
  });
});

describe("shared lists (the Rust crate asserts the same files)", () => {
  it("error codes match codes.json", () => {
    expect([...Object.values(M.ErrorCodes)].sort()).toEqual([...codes.error_codes].sort());
    expect([...Object.values(G.GatewayErrorCodes)].sort()).toEqual([...codes.gateway_error_codes].sort());
    expect(M.isUnsupportedVersion("unsupported_version")).toBe(true);
    expect(M.isUnsupportedVersion("unsupported_protocol_version")).toBe(true);
    expect(codes.error_codes).not.toContain(M.LEGACY_UNSUPPORTED_VERSION);
  });

  // Every unit enum both sides define: name -> [schema, its members].
  const ours: Record<string, [z.ZodType, readonly string[]]> = {
    AgentExitReason: [C.AgentExitReason, C.AGENT_EXIT_REASONS],
    AgentRole: [M.AgentRole, M.AgentRole.options],
    AgentState: [M.AgentState, M.AgentState.options],
    BindingScope: [G.BindingScope, G.BindingScope.options],
    CommitReason: [M.CommitReason, M.CommitReason.options],
    EgressAlertReason: [M.EgressAlertReason, M.EGRESS_ALERT_REASONS],
    EgressVerdict: [C.EgressVerdict, C.EgressVerdict.options],
    EgressVia: [C.EgressVia, C.EgressVia.options],
    ForkMode: [M.ForkMode, M.ForkMode.options],
    GenerationKind: [M.GenerationKind, M.GenerationKind.options],
    HostRole: [M.HostRole, M.HostRole.options],
    LimitKind: [C.LimitKind, C.LimitKind.options],
    ManifestKind: [M.ManifestKind, M.ManifestKind.options],
    PolicyLayer: [M.PolicyLayer, M.PolicyLayer.options],
    RuleDecision: [C.RuleDecision, C.RuleDecision.options],
    SandboxState: [M.SandboxState, M.SandboxState.options],
    SuspendMode: [M.SuspendMode, M.SuspendMode.options],
    TaskStatus: [M.TaskStatus, M.TaskStatus.options],
    TunnelState: [C.TunnelState, C.TunnelState.options],
    TurnInputKind: [M.TurnInputKind, M.TurnInputKind.options],
    UpstreamStage: [C.UpstreamStage, C.UpstreamStage.options],
    Urgency: [M.Urgency, M.Urgency.options],
  };

  it("every enum in enums.json is mirrored here", () => {
    expect(Object.keys(ours).sort()).toEqual(Object.keys(enums).sort());
  });

  for (const [name, [schema, members]] of Object.entries(ours)) {
    it(`${name}: members match enums.json and each round-trips`, () => {
      const listed = (enums as Record<string, string[]>)[name] ?? [];
      expect([...members].sort()).toEqual([...listed].sort());
      for (const m of listed) expect(schema.parse(m), `${name}::${m}`).toBe(m);
    });
  }

  it("open enums parse a member they don't know (an older sender's free text) as `unknown`", () => {
    expect(C.AgentExitReason.parse("not running after host reconnect")).toBe("unknown");
    expect(C.AgentExitReason.parse("idle grace elapsed")).toBe("unknown");
    expect(M.EgressAlertReason.parse("placeholder sent outside binding hosts")).toBe("unknown");
    expect(C.AgentExitReason.safeParse(7).success).toBe(false);
  });

  it("egress reasons from a proxy one release older normalize as in Rust; unknown text is kept", () => {
    expect(C.EgressReason.parse("upstream: invalid peer certificate")).toBe("exchange: invalid peer certificate");
    expect(C.EgressReason.parse("suppressed: 9 duplicate or excess deny records")).toBe("suppressed");
    expect(C.EgressReason.parse("connect: a: b")).toBe("connect: a: b");
    expect(C.egressReasonParts("connect: a: b")).toEqual({ kind: "upstream", stage: "connect", detail: "a: b" });
    expect(C.EgressReason.parse("not in allowlist")).toBe("not in allowlist");
  });
});

describe("host event batches", () => {
  it("one malformed event is quarantined; the others parse, in order", () => {
    const good = (n: number) => ({ ts_ms: n, type: "spot_notice", deadline_ms: n });
    const bad = { ts_ms: 2, type: "guest_cli", request: "req_1", sandbox: "sbx_1", epoch: 1, agent: "x", command: { command: "whoami" } };
    const { events, quarantined } = C.parseHostEvents([good(1), bad, good(3), "garbage"]);
    expect(events.map((e) => e.ts_ms)).toEqual([1, 3]);
    expect(quarantined.map((q) => [q.index, q.type])).toEqual([[1, "guest_cli"], [3, "?"]]);
    // The frame still parses (so the batch is acked), where the strict schema rejects it whole.
    const frame = { type: "events", seq: 1, events: [good(1), bad] };
    expect(C.HostToFleetFrame.safeParse(frame).success).toBe(true);
    expect(C.HostToFleet.safeParse(frame).success).toBe(false);
  });
});

describe("absent, never null", () => {
  it("an unset optional field is dropped on the wire, and null is not accepted for it", () => {
    // Senders here leave an unset optional field `undefined`, which JSON drops; Rust skips `None`
    // (crates/nest-protocol/tests/shared_fixtures.rs checks every field). zod rejects null.
    const ev = C.HostEvent.parse({ ts_ms: 1, type: "agent_exited", agent: "agt_1", exit_code: undefined, reason: "idle" });
    expect(JSON.stringify(ev)).not.toContain("null");
    expect(C.HostEvent.safeParse({ ts_ms: 1, type: "agent_exited", agent: "agt_1", exit_code: null, reason: "idle" }).success).toBe(false);
  });
});
