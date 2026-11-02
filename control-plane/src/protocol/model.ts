// Shared models. Mirrors crates/nest-protocol/src/model.rs; fixtures in
// protocol/fixtures/control/ are the cross-language source of truth.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const prefixed = (prefix: string) => z.string().startsWith(prefix);

export const HostId = prefixed("hst_");
export const SandboxId = prefixed("sbx_");
export const AgentId = prefixed("agt_");
export const WorkstreamId = prefixed("ws_");
export const GenerationId = prefixed("gen_");
export const SessionId = prefixed("ses_");
export const TurnId = prefixed("trn_");
export const CallId = prefixed("cal_");
export const CommandId = prefixed("cmd_");
export const RequestId = prefixed("req_");
export const AskId = prefixed("ask_");
export const MessageId = prefixed("msg_");

export const Epoch = z.number().int().nonnegative();
export const Seq = z.number().int().nonnegative();
export const TimestampMs = z.number().int();
const U16 = z.number().int().min(0).max(65535);
const U64 = z.number().int().nonnegative();

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
});
export type ErrorBody = z.output<typeof ErrorBody>;

/** Mirrors `model::error_codes` (`ALL`); both are asserted against protocol/fixtures/codes.json. */
export const ErrorCodes = {
  STALE_EPOCH: "stale_epoch",
  PARENT_MISMATCH: "parent_mismatch",
  UNKNOWN_SANDBOX: "unknown_sandbox",
  UNKNOWN_AGENT: "unknown_agent",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  /** The peer's protocol version isn't spoken here; one name on every boundary (read with `isUnsupportedVersion`). */
  UNSUPPORTED_VERSION: "unsupported_version",
  INVALID_MESSAGE: "invalid_message",
  UNKNOWN_TOOL: "unknown_tool",
  CAPACITY_EXHAUSTED: "capacity_exhausted",
  RATE_LIMITED: "rate_limited",
  NOT_BOUND: "not_bound",
  /** `resolve` can't hand out a binding yet (unplaced, placing, or the slot isn't configured): ask again. */
  SANDBOX_NOT_READY: "sandbox_not_ready",
  INTERNAL: "internal",
  /** The operation exists in the contract but has no implementation yet (passed through as a tool error). */
  NOT_IMPLEMENTED: "not_implemented",
  OUTCOME_UNKNOWN: "outcome_unknown",
  /** A compare-and-set lost: read the current state and decide again. HTTP 409. */
  CONFLICT: "conflict",
  /** The named object doesn't exist. HTTP 404. */
  NOT_FOUND: "not_found",
  /** A remote (MCP) tool ran and reported an error (`isError`): its text is the message. Passed through as an ordinary tool error. */
  TOOL_ERROR: "tool_error",
} as const;
/** What the control-host channels sent for `unsupported_version` before the names merged: read, never sent. */
export const LEGACY_UNSUPPORTED_VERSION = "unsupported_protocol_version";
/** `unsupported_version` under either name. */
export const isUnsupportedVersion = (code: string): boolean =>
  code === ErrorCodes.UNSUPPORTED_VERSION || code === LEGACY_UNSUPPORTED_VERSION;

/**
 * A string enum that parses a member it doesn't know (a newer sender's, or an older sender's free
 * text) as `fallback` instead of rejecting the message. The Rust side is a `#[serde(other)]` member.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(members: T, fallback: T[number]) {
  const known = new Set<string>(members);
  return z.string().transform((s): T[number] => (known.has(s) ? (s as T[number]) : fallback));
}

/** What a host is for: it runs sandboxes, or brains, never both (docs/compute/). */
export const HOST_KINDS = ["sandbox", "brain"] as const;
export type HostKind = (typeof HOST_KINDS)[number];
/**
 * The names a host kind goes by on the wire and in storage. Renamed by expand/contract over two
 * releases (dev/deploy.md): this release reads both `burst`/`controller` and `sandbox`/`brain`
 * but writes only the old names (stored rows, host tokens, launch records), so a Worker rolled back
 * to the previous release reads everything this one wrote; the next release writes the new names.
 */
export const HOST_ROLES = ["burst", "controller"] as const;
export const HostRole = z.enum(["burst", "controller", "sandbox", "brain"]);
export type HostRole = z.output<typeof HostRole>;
/** The kind a role name means (either name). */
export const hostKind = (role: HostRole): HostKind => (role === "burst" || role === "sandbox" ? "sandbox" : "brain");
/** The name this release writes for a kind (the previous release's). */
export const roleName = (kind: HostKind): (typeof HOST_ROLES)[number] => (kind === "sandbox" ? "burst" : "controller");
/** Deprecated wire value, for one release only (`agent_start.role`, `ToolDef.roles`); nothing decides on it. */
export const AgentRole = z.enum(["worker", "captain"]);
export type AgentRole = z.output<typeof AgentRole>;

export const Resources = z.object({
  vcpus: z.number().int().nonnegative(),
  memory_mib: z.number().int().nonnegative(),
  disk_gib: z.number().int().nonnegative(),
});
export type Resources = z.output<typeof Resources>;

export const SandboxState = z.enum([
  "creating", "restoring", "running", "suspending", "suspended", "archiving", "archived", "fenced",
  "destroyed", "failed",
]);
export type SandboxState = z.output<typeof SandboxState>;
export const SuspendMode = z.enum(["memory", "disk_only"]);
export const ForkMode = z.enum(["disk_only", "live"]);
export const AgentState = z.enum([
  "starting", "ready", "working", "waiting_permission", "waiting_input", "compacting", "idle", "errored",
  "quota_parked", "stalled", "needs_attention", "detached",
]);
export type AgentState = z.output<typeof AgentState>;
/** AgentDO's own part of an agent's `state` (`ready`: the runner's last report, the activity, says the rest). */
export const AgentLifecycle = z.enum(["starting", "ready", "detached", "errored"]);
export type AgentLifecycle = z.output<typeof AgentLifecycle>;

// --- Egress policy -------------------------------------------------------------------------------

export const HostPattern = z.string();
export const PolicyLayer = z.enum(["base", "workstream", "sandbox"]);
export type PolicyLayer = z.output<typeof PolicyLayer>;

export const AllowRule = z.object({
  host: HostPattern,
  ports: z.array(U16).default([80, 443]),
  layer: PolicyLayer,
  expires_ms: TimestampMs.optional(),
});
export type AllowRule = z.output<typeof AllowRule>;

export const InjectionLocation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authorization_bearer") }),
  z.object({ type: z.literal("authorization_basic_password") }),
  z.object({ type: z.literal("header"), name: z.string() }),
]);

export const InjectionBinding = z.object({
  name: z.string(),
  hosts: z.array(HostPattern),
  placeholder: z.string(),
  locations: z.array(InjectionLocation),
});
export type InjectionBinding = z.output<typeof InjectionBinding>;

export const InjectionSecret = z.object({
  binding: z.string(),
  value: z.string(),
  expires_ms: TimestampMs.optional(),
});
export type InjectionSecret = z.output<typeof InjectionSecret>;

export const TcpException = z.object({ host: z.string(), port: U16 });

export const EgressLimits = z.object({
  max_connections: z.number().int().nonnegative(),
  bandwidth_mbps: z.number().int().nonnegative(),
  max_inspected_body_bytes: U64,
});
export type EgressLimits = z.output<typeof EgressLimits>;

/** A query parameter (decoded name) whose decoded value is one of `values` (any value when absent). */
export const QueryMatch = z.object({ name: z.string(), values: z.array(z.string()).optional() });
/** The JSON body's string at `pointer` (RFC 6901) is one of `values`. */
export const JsonFieldMatch = z.object({ pointer: z.string(), values: z.array(z.string()) });
/** One request matcher: every field given must match (docs/sandbox/networking/egress/policy/#request-guards). */
export const RequestMatch = z.object({
  methods: z.array(z.string()).optional(),
  methods_except: z.array(z.string()).optional(),
  /** `/`-separated segments: a literal, `*` (one segment) or `**` (any number). */
  path: z.string().optional(),
  query: z.array(QueryMatch).optional(),
  body_json: JsonFieldMatch.optional(),
  /** The proxy substituted this binding's credential into the request. */
  injected: z.string().optional(),
});
export type RequestMatch = z.output<typeof RequestMatch>;
/** On its hosts, a request a `scope` matcher covers is refused unless an `allow` matcher covers it too. */
export const RequestGuard = z.object({
  name: z.string(),
  hosts: z.array(HostPattern),
  scope: z.array(RequestMatch),
  allow: z.array(RequestMatch).optional(),
  reason: z.string().optional(),
  ignore_case: z.boolean().optional(),
});
export type RequestGuard = z.output<typeof RequestGuard>;

export const EgressPolicy = z.object({
  version: U64,
  allow: z.array(AllowRule),
  passthrough: z.array(HostPattern).default([]),
  inject: z.array(InjectionBinding).default([]),
  tcp: z.array(TcpException).default([]),
  limits: EgressLimits,
  /** Absent when there are none (an old proxy ignores the field). */
  guards: z.array(RequestGuard).optional(),
});
export type EgressPolicy = z.output<typeof EgressPolicy>;

/** Same semantics as `HostPattern::matches` in Rust. */
export function hostPatternMatches(pattern: string, host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  const p = pattern.replace(/\.+$/, "").toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return h.length > suffix.length + 1 && h.endsWith(`.${suffix}`);
  }
  return h === p;
}

export type EgressDecision = "deny" | "passthrough" | "inspect";

/** Same semantics as `EgressPolicy::decide` in Rust. */
export function decideEgress(policy: EgressPolicy, host: string, port: number, nowMs: number): EgressDecision {
  const allowed = policy.allow.some(
    (r) => hostPatternMatches(r.host, host) && r.ports.includes(port) && (r.expires_ms === undefined || nowMs < r.expires_ms),
  );
  if (!allowed) return "deny";
  return policy.passthrough.some((p) => hostPatternMatches(p, host)) ? "passthrough" : "inspect";
}

// --- Canonical agent events ------------------------------------------------------------------------

export const TurnInputKind = z.enum(["user", "event_batch", "inbox", "ask_answer", "recovery"]);
export type TurnInputKind = z.output<typeof TurnInputKind>;

export const Usage = z.object({
  input_tokens: U64,
  output_tokens: U64,
  cache_read_input_tokens: U64.default(0),
  cache_creation_input_tokens: U64.default(0),
  cost_usd_estimate: z.number().optional(),
});

// --- Guest types referenced by control messages (docs/interfaces/host-guest/) ---------------------

export const TaskStatus = z.enum(["running", "exited", "killed", "timed_out"]);
export const TaskInfo = z.object({
  task_id: z.string(),
  description: z.string().optional(),
  status: TaskStatus,
  exit_code: z.number().int().optional(),
  output_path: z.string(),
  output_bytes: U64,
  started_ms: TimestampMs,
  ended_ms: TimestampMs.optional(),
});
export type TaskInfo = z.output<typeof TaskInfo>;

export const Urgency = z.enum(["low", "normal", "high"]);
/** A `nest` CLI command run by a program inside a sandbox (guest `CliCommand`). */
export const CliCommand = z.discriminatedUnion("command", [
  z.object({ command: z.literal("notify"), to: z.string(), message: z.string(), urgency: Urgency.default("normal") }),
  z.object({ command: z.literal("emit"), event: z.string(), payload: z.unknown().default(null) }),
  z.object({
    command: z.literal("ask"), question: z.string(), options: z.array(z.string()).default([]),
    wait_s: z.number().int().nonnegative().default(120),
  }),
  z.object({ command: z.literal("expose"), port: z.number().int().min(0).max(65535), exposed: z.boolean() }),
  z.object({ command: z.literal("whoami") }),
]);
export type CliCommand = z.output<typeof CliCommand>;

export const CliResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: z.unknown().default(null) }),
  z.object({ status: z.literal("answered"), answer: z.string() }),
  z.object({ status: z.literal("pending"), question_id: z.string() }),
  z.object({ status: z.literal("error"), error: ErrorBody }),
]);
export type CliResult = z.output<typeof CliResult>;

const agentEventBase = {
  agent: AgentId,
  epoch: Epoch,
  seq: Seq,
  ts_ms: TimestampMs,
  turn: TurnId.optional(),
};

export const AgentEventVariants = [
  z.object({ ...agentEventBase, type: z.literal("turn_started"), input_kind: TurnInputKind }),
  z.object({ ...agentEventBase, type: z.literal("assistant_text"), text: z.string() }),
  z.object({ ...agentEventBase, type: z.literal("tool_call"), call_id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    ...agentEventBase, type: z.literal("tool_result"), call_id: z.string(), is_error: z.boolean(), summary: z.string().optional(),
  }),
  z.object({ ...agentEventBase, type: z.literal("turn_completed"), stop_reason: z.string(), usage: Usage.optional() }),
  z.object({
    ...agentEventBase, type: z.literal("rate_limited"), retry_after_ms: U64.optional(), detail: z.string(),
  }),
  z.object({ ...agentEventBase, type: z.literal("error"), error: ErrorBody }),
  z.object({ ...agentEventBase, type: z.literal("usage"), usage: Usage }),
  z.object({ ...agentEventBase, type: z.literal("state_changed"), state: AgentState, detail: z.string().optional() }),
  /** A PreToolUse call matched no grant rule; AgentDO treats it like an `ask`. */
  z.object({ ...agentEventBase, type: z.literal("escalation"), call: CallId, tool: z.string(), input: z.unknown() }),
  z.object({ ...agentEventBase, type: z.literal("capabilities"), capabilities: z.array(z.string()) }),
  z.object({ ...agentEventBase, type: z.literal("task_exited"), task: TaskInfo }),
  /** An inbox message reached the model; prune it from the runner's inbox mirror. */
  z.object({ ...agentEventBase, type: z.literal("inbox_delivered"), message: MessageId }),
] as const;
export const AgentEvent = z.discriminatedUnion("type", AgentEventVariants);
export type AgentEvent = z.output<typeof AgentEvent>;

// --- Workstream events -----------------------------------------------------------------------------

const wsEventBase = {
  workstream: WorkstreamId,
  ts_ms: TimestampMs,
  agent: AgentId.optional(),
  sandbox: SandboxId.optional(),
  epoch: Epoch.optional(),
};

/** Why nest-proxy raised an egress alert; open (an unknown reason parses as `unknown`). */
export const EGRESS_ALERT_REASONS = ["placeholder_wrong_host", "domain_fronting", "injection_after_expiry", "unknown"] as const;
export const EgressAlertReason = openEnum(EGRESS_ALERT_REASONS, "unknown");
export type EgressAlertReason = z.output<typeof EgressAlertReason>;

export const WorkstreamEventVariants = [
  z.object({ ...wsEventBase, type: z.literal("started"), goal: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("progress"), summary: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("needs_input"), ask: AskId, question: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("blocked"), reason: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("pr_opened"), url: z.string(), title: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("completed"), summary: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("failed"), error: ErrorBody }),
  z.object({ ...wsEventBase, type: z.literal("budget_exceeded"), detail: z.string() }),
  z.object({ ...wsEventBase, type: z.literal("quota_parked"), retry_after_ms: U64.optional() }),
  z.object({ ...wsEventBase, type: z.literal("orphaned_work"), generation: GenerationId, stale_epoch: Epoch }),
  z.object({ ...wsEventBase, type: z.literal("egress_denied"), host: z.string(), port: U16 }),
  z.object({ ...wsEventBase, type: z.literal("egress_alert"), host: z.string(), binding: z.string().optional(), reason: EgressAlertReason }),
  z.object({ ...wsEventBase, type: z.literal("port_opened"), port: U16 }),
  z.object({ ...wsEventBase, type: z.literal("port_exposed"), port: U16, url: z.string() }),
] as const;
export const WorkstreamEvent = z.discriminatedUnion("type", WorkstreamEventVariants);
export type WorkstreamEvent = z.output<typeof WorkstreamEvent>;

const DECISION_EVENTS = new Set([
  "needs_input", "blocked", "completed", "failed", "pr_opened", "budget_exceeded", "orphaned_work", "egress_alert",
]);
/** Only these wake a captain. */
export function isDecisionEvent(e: Pick<WorkstreamEvent, "type">): boolean {
  return DECISION_EVENTS.has(e.type);
}

// --- Generations -------------------------------------------------------------------------------------

export const ManifestHash = z.string().regex(/^blake3:[0-9a-f]{64}$/);
export const GenerationKind = z.enum(["disk_only", "checkpoint"]);
export const ManifestKind = z.enum(["disk", "memory"]);
export const CommitReason = z.enum([
  "turn_end", "timer", "dirty_threshold", "suspend", "drain", "spot_notice", "checkpoint", "fork", "salvage", "archive",
]);

export const GenerationRecord = z.object({
  id: GenerationId,
  sandbox: SandboxId,
  parent: GenerationId.optional(),
  epoch: Epoch,
  kind: GenerationKind,
  disk_manifest: ManifestHash,
  mem_manifest: ManifestHash.optional(),
  reason: CommitReason,
  created_ms: TimestampMs,
});
export type GenerationRecord = z.output<typeof GenerationRecord>;

export const Manifest = z.object({
  format: z.number().int(),
  kind: ManifestKind,
  chunk_size: z.number().int(),
  size_bytes: U64,
  chunks: z.array(z.string().nullable()),
  prefetch: z.array(z.number().int().nonnegative()).default([]),
});
