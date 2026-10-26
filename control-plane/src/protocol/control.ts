// Control plane <-> host wire types. Mirrors crates/nest-protocol/src/control.rs.
// Spec: docs/interfaces/control-host/.
import { z } from "zod";
import {
  AgentEvent, AgentId, AgentRole, AgentState, AskId, CallId, CliCommand, CliResult, CommandId, CommitReason, Epoch, ErrorBody,
  EgressPolicy, ForkMode, GenerationId, GenerationKind, GenerationRecord, HostId, HostRole, InjectionSecret,
  ManifestHash, MessageId, openEnum, RequestId, Resources, SandboxId, SandboxState, Seq, SessionId, SuspendMode,
  TaskInfo, TimestampMs, TurnId, TurnInputKind, WorkstreamEvent, WorkstreamId,
} from "./model";
import { BindingKey, GuestInfo, HandsTarget } from "./gateway";
export { GuestInfo, HandsTarget };

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HOST_FENCE_AFTER_MS = 20_000;
export const CP_LEASE_EXPIRY_MS = 30_000;

const U16 = z.number().int().min(0).max(65535);
const U64 = z.number().int().nonnegative();

// --- Enrollment ------------------------------------------------------------------------------------

export const EnrollmentProof = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aws_identity_document"), document_b64: z.string(), pkcs7_b64: z.string() }),
  z.object({ type: z.literal("enrollment_token"), token: z.string() }),
]);

export const EnrollRequest = z.object({
  protocol_version: z.number().int(),
  role: HostRole,
  cell: z.string(),
  proof: EnrollmentProof,
  proxy_ca_csr_pem: z.string(),
});
export type EnrollRequest = z.output<typeof EnrollRequest>;

export const CaCertificate = z.object({
  cert_pem: z.string(),
  chain_pem: z.string(),
  expires_ms: TimestampMs,
});
export type CaCertificate = z.output<typeof CaCertificate>;

export const EnrollResponse = z.object({
  host: HostId,
  host_token: z.string(),
  host_token_expires_ms: TimestampMs,
  fleet_ws_url: z.string(),
  proxy_ca: CaCertificate,
  /** The host's Cloudflare Tunnel token when the control plane created one for it; never on a command line. */
  tunnel_token: z.string().optional(),
  /** What clients will be told for this host's gateway; the control plane is the authority. */
  gateway_url: z.string().optional(),
});
export type EnrollResponse = z.output<typeof EnrollResponse>;

// --- Fleet channel ---------------------------------------------------------------------------------

export const ComponentVersions = z.object({
  nestd: z.string(),
  nest_proxy: z.string(),
  agent_runner: z.string(),
  claude_code: z.string(),
});

export const SandboxReport = z.object({
  sandbox: SandboxId,
  epoch: Epoch,
  state: SandboxState,
  head: GenerationId.optional(),
  dirty: z.boolean().default(false),
  guest: GuestInfo.optional(),
});
export type SandboxReport = z.output<typeof SandboxReport>;

/** The sandbox an agent's hands act in, by id and epoch only; the runner fetches the target with `hands_resolve`. */
export const HandsBinding = z.object({ sandbox: SandboxId, epoch: Epoch });
export type HandsBinding = z.output<typeof HandsBinding>;
/** Default working directory of an agent's slot (`agent_attach.cwd`). */
export const DEFAULT_CWD = "/workspace";

export const AgentReport = z.object({ agent: AgentId, state: AgentState });

export const LeaseClaim = z.object({ sandbox: SandboxId, epoch: Epoch });
export type LeaseClaim = z.output<typeof LeaseClaim>;

export const Capacity = z.object({
  vcpus_free: z.number().int().nonnegative(),
  memory_mib_free: z.number().int().nonnegative(),
  hugepages_mib_free: z.number().int().nonnegative(),
  /** The pool's size; 0 or absent means regular pages (placement packs by `memory_mib_free`). */
  hugepages_mib_total: z.number().int().nonnegative().optional(),
  sandboxes: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  warm: z.array(GenerationId).default([]),
});
export type Capacity = z.output<typeof Capacity>;

/**
 * What the host says about its Cloudflare Tunnel: `none` (no token, no cloudflared binary, or a
 * nestd that predates the field), `connecting` (cloudflared runs but reports no ready connection
 * on its `/ready` endpoint) or `connected`. FleetDO advertises the tunnel hostname only on `connected`.
 */
export const TunnelState = z.enum(["none", "connecting", "connected"]);
export type TunnelState = z.output<typeof TunnelState>;

export const HostHello = z.object({
  protocol_version: z.number().int(),
  host: HostId,
  /** Random per nestd process; a change resets both seq lineages. */
  instance_id: z.string(),
  role: HostRole,
  cell: z.string(),
  versions: ComponentVersions,
  /** `ws://` or `wss://` base URL of this host's sandbox gateway; absent on a host without sandboxes. */
  gateway_url: z.string().optional(),
  /** Absent from a nestd that predates the field: `none`. */
  tunnel: TunnelState.optional(),
  last_command_seq: Seq.optional(),
  /** Set when nestd's VMMs should run in its delegated unit cgroup and that setup failed. */
  cgroup_delegation_error: z.string().optional(),
  sandboxes: z.array(SandboxReport),
  agents: z.array(AgentReport),
  capacity: Capacity,
});

export const LeaseTiming = z.object({
  heartbeat_ms: U64,
  host_fence_ms: U64,
  cp_expiry_ms: U64,
});
export const DEFAULT_LEASE_TIMING = {
  heartbeat_ms: HEARTBEAT_INTERVAL_MS,
  host_fence_ms: HOST_FENCE_AFTER_MS,
  cp_expiry_ms: CP_LEASE_EXPIRY_MS,
};

export const HelloAck = z.object({
  protocol_version: z.number().int(),
  server_ms: TimestampMs,
  last_event_seq: Seq.optional(),
  lease: LeaseTiming,
  host_token_expires_ms: TimestampMs,
  /** Seq of the first `commands` batch sent on this connection; no batch sent on it has a lower one. */
  next_command_seq: Seq.optional(),
});

// --- Commands ----------------------------------------------------------------------------------------

export const HostHeaderMode = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("localhost") }),
  z.object({ mode: z.literal("preserve") }),
  z.object({ mode: z.literal("custom"), value: z.string() }),
]);

export const CommitOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("committed"), generation: GenerationRecord }),
  z.object({ status: z.literal("orphaned"), generation: GenerationRecord }),
  z.object({ status: z.literal("rejected"), reason: z.string(), head: GenerationId.optional() }),
]);
export type CommitOutcome = z.output<typeof CommitOutcome>;

export const SegmentRef = z.object({
  offset: U64,
  len: U64,
  base: z.boolean().default(false),
  url: z.string(),
});
export type SegmentRef = z.output<typeof SegmentRef>;

export const SessionResume = z.object({
  session: SessionId,
  segments: z.array(SegmentRef),
  total_bytes: U64,
  fork: z.boolean().default(false),
});

export const SystemPrompt = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("append"), text: z.string() }),
  z.object({ mode: z.literal("replace"), text: z.string() }),
]);

export const LaunchConfig = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  builtin_tools: z.array(z.string()),
  system_prompt: SystemPrompt,
});
export type LaunchConfig = z.output<typeof LaunchConfig>;

const AgentStartFields = {
  agent: AgentId,
  role: AgentRole,
  workstream: WorkstreamId,
  resume: SessionResume.optional(),
  hands: HandsBinding.optional(),
  launch: LaunchConfig,
  oauth_token: z.string(),
  session_ws_url: z.string(),
};

export const CommandBodyVariants = [
  z.object({
    type: z.literal("sandbox_create"), sandbox: SandboxId, workstream: WorkstreamId, epoch: Epoch, image: z.string(),
    resources: Resources, policy: EgressPolicy, from: GenerationRecord.optional(),
  }),
  z.object({ type: z.literal("sandbox_suspend"), sandbox: SandboxId, epoch: Epoch, mode: SuspendMode }),
  z.object({ type: z.literal("sandbox_resume"), sandbox: SandboxId, epoch: Epoch }),
  z.object({ type: z.literal("sandbox_archive"), sandbox: SandboxId, epoch: Epoch }),
  z.object({ type: z.literal("sandbox_checkpoint"), sandbox: SandboxId, epoch: Epoch, reason: CommitReason }),
  z.object({
    type: z.literal("sandbox_fork"), parent: SandboxId, parent_epoch: Epoch, child: SandboxId, child_epoch: Epoch,
    child_workstream: WorkstreamId, mode: ForkMode, policy: EgressPolicy,
  }),
  z.object({ type: z.literal("sandbox_destroy"), sandbox: SandboxId, epoch: Epoch }),
  z.object({ type: z.literal("policy_update"), sandbox: SandboxId, epoch: Epoch, policy: EgressPolicy }),
  z.object({ type: z.literal("secrets_update"), sandbox: SandboxId, epoch: Epoch, secrets: z.array(InjectionSecret) }),
  z.object({ type: z.literal("port_expose"), sandbox: SandboxId, epoch: Epoch, port: U16, host_header: HostHeaderMode }),
  z.object({ type: z.literal("port_unexpose"), sandbox: SandboxId, epoch: Epoch, port: U16 }),
  z.object({ type: z.literal("commit_result"), request: RequestId, sandbox: SandboxId, outcome: CommitOutcome }),
  z.object({ type: z.literal("guest_cli_result"), request: RequestId, result: CliResult }),
  z.object({ type: z.literal("agent_start"), ...AgentStartFields }),
  z.object({ type: z.literal("agent_attach"), sandbox: SandboxId, epoch: Epoch, agent: AgentId, cwd: z.string().optional() }),
  z.object({ type: z.literal("agent_detach"), sandbox: SandboxId, epoch: Epoch, agent: AgentId, kill_processes: z.boolean().default(false) }),
  z.object({ type: z.literal("agent_stop"), agent: AgentId, reason: z.string() }),
  z.object({ type: z.literal("fence"), sandboxes: z.array(SandboxId), reason: z.string() }),
  z.object({ type: z.literal("drain"), reason: z.string(), deadline_ms: TimestampMs }),
] as const;
export const CommandBody = z.discriminatedUnion("type", CommandBodyVariants);
export type CommandBody = z.output<typeof CommandBody>;
export type AgentStart = Extract<CommandBody, { type: "agent_start" }>;

const commandBase = { cmd: CommandId, issued_ms: TimestampMs };
export const Command = z.discriminatedUnion(
  "type",
  CommandBodyVariants.map((v) => v.extend(commandBase)) as unknown as typeof CommandBodyVariants,
);
export type Command = CommandBody & { cmd: string; issued_ms: number };

// --- Host events -----------------------------------------------------------------------------------

export const CommandOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), detail: z.unknown().optional() }),
  z.object({ status: z.literal("error"), error: ErrorBody }),
]);
export type CommandOutcome = z.output<typeof CommandOutcome>;

export const EgressVerdict = z.enum(["allow", "passthrough", "deny", "alert"]);
export const EgressVia = z.enum(["dns", "http_transparent", "https_transparent", "explicit", "tcp_exception"]);

export const EgressAuditRecord = z.object({
  sandbox: SandboxId,
  epoch: Epoch,
  agent: AgentId.optional(),
  ts_ms: TimestampMs,
  via: EgressVia.optional(),
  host: z.string(),
  port: U16,
  method: z.string().optional(),
  path: z.string().optional(),
  status: U16.optional(),
  bytes_up: U64,
  bytes_down: U64,
  verdict: EgressVerdict,
  binding: z.string().optional(),
  reason: z.string().optional(),
  /** Aggregated records: how many requests this record stands for (absent = 1). */
  count: z.number().int().nonnegative().optional(),
});
export type EgressAuditRecord = z.output<typeof EgressAuditRecord>;

/**
 * Why a brain process ended (`agent_exited.reason`); AgentDO decides restarts from it. `host_lost`
 * is the control plane's own (a host reconnected without reporting the brain). Open: a reason this
 * build doesn't know, including an older nestd's free text, parses as `unknown`.
 */
export const AGENT_EXIT_REASONS = ["idle", "stopped", "fenced", "auth_failed", "crashed", "host_lost", "unknown"] as const;
export const AgentExitReason = openEnum(AGENT_EXIT_REASONS, "unknown");
export type AgentExitReason = z.output<typeof AgentExitReason>;

const hostEventBase = { ts_ms: TimestampMs };
export const HostEventVariants = [
  z.object({ ...hostEventBase, type: z.literal("command_result"), cmd: CommandId, outcome: CommandOutcome }),
  z.object({
    ...hostEventBase, type: z.literal("sandbox_state"), sandbox: SandboxId, epoch: Epoch, state: SandboxState,
    suspend_mode: SuspendMode.optional(), detail: z.string().optional(), guest: GuestInfo.optional(),
  }),
  /** A fenced or superseded incarnation is gone from the host (salvaged, nothing to salvage, or refused for good). */
  z.object({ ...hostEventBase, type: z.literal("incarnation_retired"), sandbox: SandboxId, epoch: Epoch }),
  z.object({
    ...hostEventBase, type: z.literal("commit_request"), request: RequestId, sandbox: SandboxId, epoch: Epoch,
    parent: GenerationId.optional(), kind: GenerationKind, disk_manifest: ManifestHash,
    mem_manifest: ManifestHash.optional(), reason: CommitReason,
  }),
  z.object({ ...hostEventBase, type: z.literal("workstream"), event: WorkstreamEvent }),
  z.object({ ...hostEventBase, type: z.literal("egress_audit"), records: z.array(EgressAuditRecord) }),
  z.object({ ...hostEventBase, type: z.literal("capacity"), capacity: Capacity }),
  /** Sent on every change of the host's tunnel state. */
  z.object({ ...hostEventBase, type: z.literal("tunnel_state"), state: TunnelState }),
  z.object({ ...hostEventBase, type: z.literal("spot_notice"), deadline_ms: TimestampMs }),
  z.object({
    ...hostEventBase, type: z.literal("agent_exited"), agent: AgentId, exit_code: z.number().int().optional(),
    signal: z.number().int().optional(), reason: AgentExitReason,
  }),
  z.object({
    ...hostEventBase, type: z.literal("guest_cli"), request: RequestId, sandbox: SandboxId, epoch: Epoch,
    agent: AgentId.optional(), command: CliCommand,
  }),
  z.object({ ...hostEventBase, type: z.literal("task_exited"), sandbox: SandboxId, epoch: Epoch, agent: AgentId, task: TaskInfo }),
] as const;
export const HostEvent = z.discriminatedUnion("type", HostEventVariants);
export type HostEvent = z.output<typeof HostEvent>;
export type CommitRequestEvent = Extract<HostEvent, { type: "commit_request" }>;

export const HostToFleetVariants = [
  HostHello.extend({ type: z.literal("hello") }),
  z.object({ type: z.literal("heartbeat"), sent_ms: TimestampMs, leases: z.array(LeaseClaim) }),
  z.object({ type: z.literal("events"), seq: Seq, events: z.array(HostEvent) }),
  z.object({ type: z.literal("ack"), up_to: Seq }),
  z.object({ type: z.literal("ca_renew"), csr_pem: z.string() }),
] as const;
export const HostToFleet = z.discriminatedUnion("type", HostToFleetVariants);
export type HostToFleet = z.output<typeof HostToFleet>;

/**
 * What FleetDO parses a frame with: `HostToFleet`, except that an `events` batch's events stay
 * unparsed for `parseHostEvents`, so one bad event (say, a malformed id that came from inside a
 * sandbox) is quarantined on its own instead of rejecting the batch and stalling the host's stream.
 */
export const HostToFleetFrame = z.discriminatedUnion("type", [
  HostToFleetVariants[0],
  HostToFleetVariants[1],
  z.object({ type: z.literal("events"), seq: Seq, events: z.array(z.unknown()) }),
  HostToFleetVariants[3],
  HostToFleetVariants[4],
]);
export type HostToFleetFrame = z.output<typeof HostToFleetFrame>;

/** One event of a batch that failed its schema: logged and skipped, never retried. */
export type QuarantinedEvent = { index: number; type: string; error: string };

/** Parse a batch's events one by one: the valid ones in order, and the rest quarantined. */
export function parseHostEvents(raw: readonly unknown[]): { events: HostEvent[]; quarantined: QuarantinedEvent[] } {
  const events: HostEvent[] = [];
  const quarantined: QuarantinedEvent[] = [];
  raw.forEach((value, index) => {
    const r = HostEvent.safeParse(value);
    if (r.success) {
      events.push(r.data);
      return;
    }
    const t = (value as { type?: unknown } | null)?.type;
    quarantined.push({ index, type: typeof t === "string" ? t.slice(0, 64) : "?", error: r.error.message.slice(0, 500) });
  });
  return { events, quarantined };
}

export const FleetToHostVariants = [
  HelloAck.extend({ type: z.literal("hello_ack") }),
  z.object({
    type: z.literal("heartbeat_ack"), sent_ms: TimestampMs, server_ms: TimestampMs, revoked: z.array(LeaseClaim).default([]),
  }),
  z.object({ type: z.literal("commands"), seq: Seq, commands: z.array(Command) }),
  z.object({ type: z.literal("ack"), up_to: Seq }),
  z.object({ type: z.literal("host_token"), token: z.string(), expires_ms: TimestampMs }),
  /** Every binding verification key still valid, for the sandbox gateway; replaces the set. */
  z.object({ type: z.literal("binding_key"), keys: z.array(BindingKey) }),
  CaCertificate.extend({ type: z.literal("proxy_ca") }),
  z.object({ type: z.literal("error"), error: ErrorBody }),
] as const;
export const FleetToHost = z.discriminatedUnion("type", FleetToHostVariants);
export type FleetToHost = z.output<typeof FleetToHost>;

// --- Session channel -------------------------------------------------------------------------------

export const RunnerHello = z.object({
  protocol_version: z.number().int(),
  agent: AgentId,
  host: HostId,
  instance_id: z.string(),
  epoch: Epoch,
  session: SessionId.optional(),
  local_bytes: U64.optional(),
  last_seq: Seq.optional(),
});

export const ToolCall = z.object({
  seq: Seq,
  call: CallId,
  turn: TurnId.optional(),
  name: z.string(),
  arguments: z.unknown(),
});

export const RunnerToAgentVariants = [
  RunnerHello.extend({ type: z.literal("hello") }),
  z.object({ type: z.literal("segment"), session: SessionId, offset: U64, base: z.boolean(), data_b64: z.string() }),
  z.object({ type: z.literal("events"), seq: Seq, events: z.array(AgentEvent) }),
  ToolCall.extend({ type: z.literal("tool_call") }),
  z.object({ type: z.literal("tools_list_request"), request: RequestId }),
  /** The runner's binding aged out or a gateway refused it: ask for the sandbox's current placement. */
  z.object({ type: z.literal("hands_resolve"), request: RequestId }),
  /** The runner abandoned a platform call (timed out locally); never run it if it hasn't started. */
  z.object({ type: z.literal("cancel_call"), seq: Seq, call: CallId, reason: z.string() }),
  z.object({ type: z.literal("ack"), up_to: Seq }),
] as const;
export const RunnerToAgent = z.discriminatedUnion("type", RunnerToAgentVariants);
export type RunnerToAgent = z.output<typeof RunnerToAgent>;

export const TurnInput = z.object({ kind: TurnInputKind, text: z.string() });
export type TurnInput = z.output<typeof TurnInput>;

export const InboxMessage = z.object({
  id: MessageId,
  from: z.string(),
  text: z.string(),
  interrupt: z.boolean().default(false),
  ts_ms: TimestampMs,
});
export type InboxMessage = z.output<typeof InboxMessage>;

export const RuleDecision = z.enum(["allow", "deny", "ask"]);
export const ToolRule = z.object({ pattern: z.string(), decision: RuleDecision, reason: z.string().optional() });
export type ToolRule = z.output<typeof ToolRule>;

export const AgentCache = z.object({
  version: U64,
  rules: z.array(ToolRule),
  inbox: z.array(InboxMessage),
  max_stop_continuations: z.number().int().nonnegative(),
});
export type AgentCache = z.output<typeof AgentCache>;

export const ToolContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), media_type: z.string(), data_b64: z.string() }),
  z.object({ type: z.literal("json"), value: z.unknown() }),
]);
export type ToolContent = z.output<typeof ToolContent>;

export const ToolOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), content: z.array(ToolContent) }),
  z.object({ status: z.literal("error"), error: ErrorBody }),
  z.object({ status: z.literal("pending"), ask: AskId, message: z.string() }),
]);
export type ToolOutcome = z.output<typeof ToolOutcome>;

export const ToolDef = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.unknown(),
  roles: z.array(AgentRole),
  requires_approval: z.boolean().default(false),
});
export type ToolDef = z.output<typeof ToolDef>;

export const AgentToRunnerVariants = [
  z.object({ type: z.literal("hello_ack"), protocol_version: z.number().int(), durable_bytes: U64, last_seq: Seq.optional() }),
  z.object({ type: z.literal("segment_ack"), session: SessionId, durable_bytes: U64 }),
  z.object({ type: z.literal("run_turn"), seq: Seq, turn: TurnId, input: TurnInput }),
  z.object({ type: z.literal("inbox"), seq: Seq, message: InboxMessage }),
  z.object({ type: z.literal("interrupt"), seq: Seq, turn: TurnId.optional() }),
  z.object({ type: z.literal("cache_update"), seq: Seq, cache: AgentCache }),
  z.object({ type: z.literal("tool_result"), seq: Seq, call: CallId, outcome: ToolOutcome }),
  z.object({ type: z.literal("tools_list"), request: RequestId, tools: z.array(ToolDef) }),
  /** Answer to `hands_resolve`: exactly one of `hands` and `error` (`not_bound`, or `sandbox_not_ready` with `retry_after_ms`). */
  z.object({
    type: z.literal("hands_resolved"), request: RequestId, hands: HandsTarget.optional(), error: ErrorBody.optional(),
    retry_after_ms: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("ack"), up_to: Seq }),
  z.object({ type: z.literal("error"), error: ErrorBody }),
] as const;
export const AgentToRunner = z.discriminatedUnion("type", AgentToRunnerVariants);
export type AgentToRunner = z.output<typeof AgentToRunner>;

/** Reliable AgentToRunner messages carry a `seq` assigned by the outbox. */
export type ReliableAgentToRunner = Extract<AgentToRunner, { seq: number }>;
export type ReliableAgentToRunnerBody = ReliableAgentToRunner extends infer M
  ? M extends { seq: number } ? Omit<M, "seq"> : never
  : never;

