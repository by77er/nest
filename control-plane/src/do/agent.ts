// AgentDO: authority for one agent (docs/control-plane/durable-objects/agent/). The session WebSocket
// (docs/interfaces/control-host/session/): native session segments into R2 (acked by offset only once
// durable), canonical events and state, the turn queue, inbox and interrupts, caches for local hook
// answers, and the platform tool relay.
//
// Concurrency: the input gate opens across awaits on R2 and other Durable Objects, so state is never
// saved from a copy loaded before an await (`update()` loads, mutates and saves synchronously), and
// inbound session messages are processed one at a time, in order (`SerialQueue`).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import { num, type Env } from "../env";
import {
  type Caller, type ChannelDelivery, clip, type DeliveryOutcome, envelopeText, EVENT_TEXT_BYTES, Filter,
  parseChannel, type PostInput, sessionTaint, SubscribeInput, takeBatch,
} from "../lib/channels";
import { admitDelivery, channelRequestId, inboxTurnText, moveNoteDue, TurnQueue, type TurnStatus } from "../lib/turns";
import type { ReadResult } from "./channel";
import { ChannelOutbox, OUTBOX_DEADLINE } from "../lib/outbox";
import { PLATFORM_TOOL_NAMES, toolDef, toolDefs } from "../lib/registry";
import { connectorName, type McpGrant, mcpTarget, mcpToolDefs, needsApproval, NEST_TOOL_PREFIX } from "../lib/mcp";
import { approves, argsDigest, gated, type SinkCall } from "../lib/sinks";
import {
  actionDef, actionOfTool, authorize, checkBaseUrl, type Authorized, BROKERED_ACTIONS, BROKERED_TOOL_NAMES, type BrokeredAction, BrokeredJournal, brokeredToolDefs,
  type GithubAction, type JournalEntry, type JournalRow, keyDigest, naturalKey, secretKinds, stringsOf,
} from "../lib/brokered";
import { actionRequest, createdOf, foundInState, type GhMade, ghError, githubApiOf, stateQuery } from "../lib/github";
import { type McpConnector, McpProxy, mcpToken } from "../lib/mcp-proxy";
import { Repo } from "../lib/repos";
import { Deadlines, ReliableChannels, SerialQueue } from "../lib/reliable";
import { type AgentSpec, EscalateTo, type RoleRecord, type SpawnerOverrides, specFromRole } from "../lib/spec";
import {
  AGENT_RECORD_RETENTION_MS, cellIdleTtlMs, END_GRACE_MS, END_RETRY_MS, type Ended, type EndReason, ephemeralDone, MAX_OWNER_HOPS, narrowTtl, ownsVia,
  spawnRefusal,
} from "../lib/lifetimes";
import {
  type Actor, ALL_TASK_TOOLS, type SpecGrant, type TaskFilter, type TaskOp, type TaskPriority, type TaskStatus, type TaskTool, TOOL_OPS,
} from "../lib/tasks";
import { signBlobUrl } from "../lib/tokens";
import { ledgerStub, type TaskView } from "./tasks";
import { asNestError, b64ToBytes, concatBytes, errorBody, keyedId, NestError, newId } from "../lib/util";
import type { EgressPolicy } from "../protocol/model";
import { addColumn, storedEnum } from "../lib/stored";
import { askRoute, CallLedger } from "../lib/calls";
import {
  agentState, type Brain, type BrainFields, type BrainPatch, brainRelease, epochlessExit, escalation, liveBrainStart, mergeIntent, NO_INTENT,
  phaseDeadlines, type PhaseDeadline, quietSinceStop, splitState, startFailure, type StartIntent, stoppedBrain, unresponsive, wakeDecision,
} from "../lib/brain";
import type { AgentFacts } from "../lib/abandoned";
import {
  type AgentCache, type AgentExitReason, type AgentStart, type AgentToRunner, handsResolved, type InboxMessage,
  RunnerToAgent, type SegmentRef, type ToolDef, type ToolOutcome, type ToolRule, type TurnInput,
} from "../protocol/control";
import {
  type AgentEvent, type AgentState, type CliCommand, type CliResult, ErrorCodes, type GenerationRecord, PROTOCOL_VERSION,
  type TaskInfo, type WorkstreamEvent,
} from "../protocol/model";

const CHAN = "runner";
/** Flush buffered session bytes after this long while the agent works / otherwise. */
const FLUSH_WORKING_MS = 5_000;
const FLUSH_IDLE_MS = 30_000;
/** Flush immediately once this much is buffered. */
const FLUSH_BYTES = 1024 * 1024;
const SIGNED_URL_TTL_MS = 15 * 60_000;
const WORKING_STATES: AgentState[] = ["working", "compacting", "waiting_permission", "waiting_input"];
const START_RETRY_MS = 5_000;
/**
 * A brain without a hello this long after `agent_start` is condemned. Above the runner's budget before
 * its hello (session rebuild 120 s, auth 20 s, version 10 s, channel open 10 s); doubled per
 * consecutive timeout, `START_BACKOFF_STEPS` times.
 */
const START_DEADLINE_MS = 240_000;
const START_BACKOFF_STEPS = 2;
/** A live brain with no current session this long (and no exit) is condemned. */
const NO_SESSION_MS = 10 * 60_000;
/** A failed `SandboxDO.agentActivity` is tried again after this long. */
const ACTIVITY_RETRY_MS = 5_000;
/** States with no brain running. */
const WAKE_STATES: AgentState[] = ["detached", "errored"];
/** A wake that found no host (or failed transiently) retries this often. */
const WAKE_RETRY_MS = 30_000;
/** `hands_resolved{error}` hint when the sandbox isn't ready: how long the runner waits before asking again. */
const HANDS_RETRY_MS = 2_000;
const RETENTION_MS = 7 * 86_400_000;
/** How long an owner without `read` is remembered as such. */
const OWNER_READS_NO_MS = 10 * 60_000;

const PRUNE_EVERY_MS = 3_600_000;
/** read_transcript: entries per call by default / at most, and a response size cap. */
const TRANSCRIPT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_MAX_LIMIT = 500;
const TRANSCRIPT_MAX_BYTES = 256 * 1024;
const EMIT_EVENTS = ["progress", "blocked", "pr_opened", "completed", "failed"] as const;
const iso = (ms: number) => new Date(ms).toISOString();

/** An agent, as AgentDO stores it, with its expanded spec copied in at spawn. */
export interface AgentInfo extends Omit<AgentSpec, "subscribe">, BrainFields {
  agent: string;
  workstream: string;
  cell: string;
  /** The agent this one reports to (`notify` to `captain`), of the same workstream; fixed at spawn. */
  owner: string | null;
  /** The bound sandbox, by id only: its epoch is SandboxDO's, never copied here. */
  hands: { sandbox: string } | null;
  /** Session of the committed base (what `--resume` restores). */
  session: string | null;
  current_turn: string | null;
  cache_version: number;
  /** Committed base: its generation and the bytes durable in R2 (what resume and transcripts read). */
  base_gen: number;
  durable_bytes: number;
  /** The stream being received: above `base_gen` while a rewritten file arrives (the base stays resumable until it's durable). */
  recv_base: number;
  recv_session: string | null;
  recv_durable: number;
  /** Logical end of the receive stream so far (durable + buffered). */
  received_bytes: number;
  /** Runner process (session `hello.instance_id`); a change starts a new channel lineage. */
  runner_instance: string | null;
  /** Claude Code `system/init.capabilities`, from the latest `capabilities` event. */
  capabilities?: string[];
  /** When the transcript was last made durable (a recovery turn says where it ends). */
  durable_ms?: number;
  /** When the bound sandbox last moved to a new lease (it was restored from its head). */
  hands_moved_ms?: number;
  /** What SandboxDO last acknowledged from `agentActivity`; absent = unknown (tell it again). */
  activity_sent?: boolean;
  /** The sandbox epoch the brain was last told of: a turn starting at another begins with what the move lost. */
  told_sandbox_epoch?: number;
  /** Stopped for good (docs/agents/#lifetimes): no turn, start or wake after it. Absent: it hasn't ended. */
  ended?: Ended;
  /** How many spawns deep: 0 for the operator's agents (absent: 0), its spawner's plus one. */
  depth?: number;
}

/** Tools that spawn or end agents: never from a sandbox. */
const LIFECYCLE_TOOLS = ["agent_spawn", "agent_stop", "exit"];
/** The tools an agent is offered: its spec's, and `exit`, which every agent has (it only gives up authority). */
const offered = (info: Pick<AgentSpec, "tools">): string[] => (info.tools.includes("exit") ? info.tools : [...info.tools, "exit"]);

/** The sender of the platform's own notes about an agent's work (not input: see `stop_quiet`). */
const SYSTEM_SENDER = "system";
/** What `info()` answers: the record plus the derived brain host and `state`. */
export type AgentView = AgentInfo & { host: string | null; state: AgentState };

/** Fields of records stored by the previous release, which `load()` migrates. */
interface PreviousReleaseFields {
  /** Still written by `save()`, for the previous release. */
  state?: AgentState;
  host?: string | null;
  role?: RoleRecord["role"];
  grants?: string[] | null;
  captain?: string | null;
}

/** AgentDO's alarm keys (each needs a handler in `alarm()`). */
type AgentDeadline = PhaseDeadline | "flush" | "activity" | "wake" | "wake_after_exit" | "intent" | "prune" | "end" | "reap" | typeof OUTBOX_DEADLINE;
/** A `sync` ask's window: `ask:<ask id>`. */
const ASK_DEADLINE = "ask:";
/** An approved sink call may be made once within this long. */
const APPROVAL_TTL_MS = 60 * 60_000;
/** How much of a sink call's arguments the approval question shows. */
const APPROVAL_ARGS_SHOWN = 2000;
type AskDeadline = `${typeof ASK_DEADLINE}${string}`;

/** Points where a test can force an interleaving (`testHooks`). */
export type HookPoint =
  | "intent:beforeCommit" | "resolveHands:afterResolve" | "dispatch:beforeWrite" | "sandboxMoved:enter" | "kill:beforeIssue"
  | "hostLost:enter" | "exited:enter" | "start:afterCommit" | "release:afterCommit" | "event:afterApply" | "escalate:afterProgress" | "escalate:afterStatus" | "pump:beforeSend"
  | "flush:beforePut" | "ask:beforeRoute";

export interface CreateAgent {
  agent: string;
  workstream: string;
  cell: string;
  /** The expanded spawn spec (CatalogDO checked the template's hands rule against `sandbox`). */
  spec: AgentSpec;
  owner?: string | null;
  sandbox?: string | null;
  /** The owner is the caller (`agent_spawn`): of this workstream by construction, so not asked (it awaits this call). */
  owner_is_caller?: boolean;
  /** Spawn depth (`agent_spawn`: its spawner's plus one). */
  depth?: number;
  /** It starts with its spawner's taint (docs/agents/tools/#taint-and-sinks). */
  tainted?: boolean;
}

/** How an agent is ended (`Ended` without the steps it records later). */
export interface EndOptions {
  by: string;
  reason: EndReason;
  kill: boolean;
  destroy_sandbox: boolean;
  note?: string;
}

/** What ending an agent did: it ended now, or had already. */
export interface EndResult {
  status: "stopped" | "already_stopped";
  ended: Ended;
}

interface Attachment {
  host: string;
  epoch: number;
  helloed: boolean;
  stale: boolean;
  instance: string;
  /** The runner acts on `tools_changed` (its hello said so); absent on older attachments. */
  tools_changed?: boolean;
}

type DispatchResult = ToolOutcome | "wait";
/** When the brain of `epoch` last asked for its tool list (`kv.tools_listed`); a change at or after `ms` isn't in it. */
interface ToolsListed { epoch: number; ms: number }
/** What `start()` did: issued, waiting for the condemned brain on `waiting_for` to be released, or nothing. */
export type StartResult =
  | { kind: "started"; host: string; cmd: string }
  | { kind: "waiting"; host: string | null; cmd: null; waiting_for: string }
  | { kind: "none"; host: string | null; cmd: null };
/** A condemned brain's escalation runs this long after its kill was sent, and again every so often. */
const EXIT_WAIT_MS = 60_000;
/** A kill that couldn't be sent is sent again after this long. */
const KILL_RETRY_MS = 5_000;
/** A condemned brain whose kill was processed but which is still indexed is waited for this long, then its host is wedged. */
const ESCALATION_CAP_MS = 15 * 60_000;
/** What AgentDO sends: `epoch` is required here, optional on the wire only for the previous release's commands. */
type AgentStartBody = Omit<AgentStart, "type" | "epoch"> & { epoch: number };

export interface TranscriptPage {
  lines: string[];
  /** Entry number (1-based JSONL line) of the last line returned, or `since_seq` if none. */
  next_seq: number;
  more: boolean;
  /** The transcript base the entry numbers belong to. A rewrite (compaction trim, new session) starts a new one. */
  base: number;
  /** The caller's cursor was for another base: this page starts again from entry 1. */
  reset?: boolean;
}

/** The retry of the `n`th consecutive start that found no brain host with room: 30 s doubling to 5 min. */
export function capacityRetryMs(n: number): number {
  return Math.min(WAKE_RETRY_MS * 2 ** Math.max(0, n - 1), CAPACITY_RETRY_MAX_MS);
}
const CAPACITY_RETRY_MAX_MS = 5 * 60_000;

/** The same record (a brain, an intent): equal as stored. */
const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

/** A rewritten file or another session starts a new receive stream; the committed base stays resumable until it is durable. */
function newStream(i: AgentInfo, session: string): void {
  i.recv_base = Math.max(i.recv_base, i.base_gen) + 1;
  i.recv_durable = 0;
  i.received_bytes = 0;
  i.recv_session = session;
}

function adoptSession(i: AgentInfo, session: string): void {
  i.recv_session = session;
  if (i.recv_base === i.base_gen && !i.session) i.session = session;
}

export class AgentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // `!`: set in the constructor, except on the health instance, which serves only `health()`.
  private readonly rel!: ReliableChannels;
  private readonly deadlines!: Deadlines<AgentDeadline | AskDeadline>;
  private readonly inbound = new SerialQueue();
  /** The run of the intent in flight (single-flight, in memory only: the intent itself is stored). */
  private intentRun: Promise<StartResult | null> | null = null;
  /** Someone stored an intent while a run was in flight: run again (from the alarm) once it ends. */
  private intentDirty = false;
  /** The flush in flight (single-flight, see `flush`). */
  private flushing: Promise<void> | null = null;

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.AGENT)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.queue = new TurnQueue(this.sql);
    this.calls = new CallLedger(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS segments (base INTEGER NOT NULL, offset INTEGER NOT NULL, len INTEGER NOT NULL,
      key TEXT NOT NULL, PRIMARY KEY (base, offset))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seg_buffer (base INTEGER NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY (base, offset))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
    this.rel = new ReliableChannels(this.sql);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
    // This agent's channel subscriptions, with each one's delivery high-water seq (dedup).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_subs (channel TEXT NOT NULL, sub TEXT NOT NULL, hw INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel, sub))`);
    // Notices taken without delivery (no `read` tool): how many, and up to which seq.
    addColumn(this.sql, "channel_subs", "skipped", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.sql, "channel_subs", "skipped_to", "INTEGER");
    // The agents it spawned (an index: each child's `owner` decides), and whether each has ended.
    this.sql.exec("CREATE TABLE IF NOT EXISTS children (agent TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0)");
    // Its end was asked for (`ended` comes with the child's `childEnded`, once its end is done).
    addColumn(this.sql, "children", "asked", "INTEGER NOT NULL DEFAULT 0");
    this.mcp = new McpProxy({
      sql: this.sql,
      agent: () => this.load().agent,
      bearer: (g, refused) => mcpToken(env, g, refused),
      // The stub's RPC types can't see that ListedTool's `unknown` schema is plain JSON; it is.
      connector: (g) => env.MCP_CONNECTOR.get(env.MCP_CONNECTOR.idFromName(connectorName(g))) as unknown as McpConnector,
      background: (p) => ctx.waitUntil(p),
      callTimeoutMs: num(env.MCP_CALL_TIMEOUT_MS, 45_000),
      admitWaitMs: num(env.MCP_ADMIT_WAIT_MS, 10_000),
      allowLoopback: env.ALLOW_LOOPBACK_MCP === "1",
    });
    this.journal = new BrokeredJournal(this.sql);
    this.outbox = new ChannelOutbox(this.sql, this.deadlines, env, (p) => ctx.waitUntil(p), () => this.load().agent,
      async (owner) => ({ spawner_reads: await this.ownerReads(owner) }));
  }

  private readonly outbox!: ChannelOutbox;
  private readonly queue!: TurnQueue;
  private readonly calls!: CallLedger;
  /** The client of its mcp capabilities' servers (docs/agents/capabilities/mcp/). */
  private readonly mcp!: McpProxy;
  /** Every brokered action it ran or was refused (docs/agents/tools/#taint-and-sinks). */
  private readonly journal!: BrokeredJournal;

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  /** Work for a brain: a turn running or queued. */
  private hasWork(info: AgentInfo): boolean {
    return info.current_turn !== null || this.queue.hasQueued();
  }

  private load(): AgentInfo {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0];
    if (!row) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    const info = JSON.parse(row.value) as Partial<AgentInfo> & AgentInfo & PreviousReleaseFields;
    // Stored before the agent epoch: `hands.epoch` was the session epoch of the running brain.
    const legacy = info.hands as { sandbox: string; epoch?: number } | null;
    const agentEpoch = info.agent_epoch ?? legacy?.epoch ?? 0;
    const { host, role, grants, captain, state, ...rest } = info;
    // Stored with a role (the previous release): its seed template, expanded; `captain` is its owner.
    let spec: Omit<AgentSpec, "subscribe"> | undefined;
    if (info.tools === undefined) {
      spec = specFromRole({ role: role ?? (legacy ? "worker" : "captain"), grants, launch: info.launch, rules: info.rules });
    }
    let brain = info.brain;
    let migrated = false;
    if (brain === undefined) {
      // Stored by the previous release, which kept `host` after the brain exited: a detached or
      // errored one may still run, so it is condemned (its escalation proves it gone).
      brain = null;
      if (host) {
        const doubtful = state === "detached" || state === "errored";
        brain = doubtful
          ? { host, epoch: agentEpoch, phase: "condemned", since_ms: Date.now() }
          : { host, epoch: agentEpoch, phase: state === "starting" ? "starting" : "live", since_ms: Date.now() };
      }
      migrated = true;
    }
    const out: AgentInfo = {
      ...rest,
      ...spec,
      escalate_to: storedEnum(EscalateTo, (spec ?? rest).escalate_to, "kv.info.escalate_to"),
      // Stored before capability parameters: none.
      params: (spec ?? rest).params ?? {},
      // Stored before channels: no channel grants (only the built-in rules apply).
      channel_grants: (spec ?? rest).channel_grants ?? [],
      owner: info.owner !== undefined ? info.owner : captain ?? null,
      brain,
      intent: info.intent ?? null,
      hands: legacy ? { sandbox: legacy.sandbox } : null,
      agent_epoch: agentEpoch,
      recv_base: info.recv_base ?? info.base_gen,
      recv_session: info.recv_session ?? info.session,
      recv_durable: info.recv_durable ?? info.durable_bytes,
      runner_instance: info.runner_instance ?? null,
      start_attempts: info.start_attempts ?? 0,
      // `state` alone, or rewritten by the previous release since (a rollback), is the authority.
      ...(state !== undefined && (info.lifecycle === undefined || agentState(info) !== state) ? splitState(state) : {}),
    };
    if (migrated) {
      this.save(out);
      this.ctx.waitUntil(this.armPhase(out.brain, START_DEADLINE_MS, false));
    } else if (spec) {
      this.save(out);
    }
    return out;
  }

  private save(info: AgentInfo): void {
    const legacy: PreviousReleaseFields = { state: agentState(info) };
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('info', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ ...info, ...legacy }));
  }

  /** Load, mutate and save synchronously (never across an await). */
  private update(fn: (info: AgentInfo) => void): AgentInfo {
    const info = this.load();
    fn(info);
    this.save(info);
    return info;
  }

  private exists(): boolean {
    return this.sql.exec("SELECT 1 FROM kv WHERE key = 'info'").toArray().length > 0;
  }

  async create(req: CreateAgent): Promise<AgentInfo> {
    if (this.exists()) return this.load();
    // The owner must be an agent (`info()` refuses one never created) of this workstream.
    const owner = req.owner ?? null;
    if (owner !== null && !req.owner_is_caller) {
      const o = await this.env.AGENT.get(this.env.AGENT.idFromName(owner)).info();
      if (o.workstream !== req.workstream) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, `owner ${owner} is in workstream ${o.workstream}, not ${req.workstream}`, 409);
      }
    }
    let hands: AgentInfo["hands"] = null;
    if (req.sandbox) {
      // An agent's cell and workstream are its sandbox's (its FleetDO, its secrets and events).
      const stub = this.sandboxStub(req.sandbox);
      const cur = await stub.info();
      if (cur.cell !== req.cell || cur.workstream !== req.workstream) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE,
          `${req.sandbox} is in cell ${cur.cell}, workstream ${cur.workstream}; the agent must be too`, 409);
      }
      await stub.attach(req.agent, undefined, req.spec.repos ?? []);
      hands = { sandbox: req.sandbox };
    }
    if (this.exists()) return this.load();
    const { subscribe: _, ...spec } = req.spec;
    const info: AgentInfo = {
      ...spec,
      agent: req.agent,
      workstream: req.workstream,
      cell: req.cell,
      owner,
      hands,
      agent_epoch: 0,
      brain: null,
      intent: null,
      session: null,
      lifecycle: "detached",
      activity: null,
      current_turn: null,
      cache_version: 1,
      base_gen: 0,
      durable_bytes: 0,
      recv_base: 0,
      recv_session: null,
      recv_durable: 0,
      received_bytes: 0,
      runner_instance: null,
      start_attempts: 0,
      ...(req.depth ? { depth: req.depth } : {}),
    };
    this.save(info);
    if (req.tainted) this.kvPut("read_tainted", true);
    await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS, true);
    return info;
  }

  async info(): Promise<AgentView> {
    const info = this.load();
    return { ...info, host: info.brain?.host ?? null, state: agentState(info) };
  }

  private sandboxStub(id: string) {
    return this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id));
  }

  private fleet(cell: string) {
    return this.env.FLEET.get(this.env.FLEET.idFromName(cell));
  }

  private workstream(id: string) {
    return this.env.WORKSTREAM.get(this.env.WORKSTREAM.idFromName(id));
  }

  /** Rule 1: a session at `epoch` is current iff there is a brain, it isn't condemned, and `epoch` is its epoch. */
  private isCurrent(info: AgentInfo, epoch: number): boolean {
    const b = info.brain;
    return !!b && b.phase !== "condemned" && epoch === b.epoch;
  }

  /** `sandbox` and `epoch` for an event about the bound sandbox: SandboxDO's epoch, or `known` (one FleetDO just verified). */
  private async sandboxFields(info: AgentInfo, known?: number): Promise<{ sandbox?: string; epoch?: number }> {
    if (!info.hands) return {};
    const epoch = known ?? (await this.sandboxStub(info.hands.sandbox).info()).epoch;
    return { sandbox: info.hands.sandbox, epoch };
  }

  /** Working, for the sandbox's idle refcount: a brain busy or in a turn (SessionStart says `ready` mid-turn). */
  private working(info: AgentInfo): boolean {
    const state = agentState(info);
    return !WAKE_STATES.includes(state) && (WORKING_STATES.includes(state) || info.current_turn !== null);
  }

  /**
   * Tell SandboxDO "working" (an idempotent "set to") when it differs from what it acknowledged, or
   * with `force`. Never throws: a failed call retries from the alarm, so a lost one can't strand it.
   */
  private async syncActivity(force = false): Promise<void> {
    for (let n = 0; n < 3; n++) {
      const info = this.load();
      if (!info.hands) return;
      const want = this.working(info);
      if (!force && info.activity_sent === want) return;
      force = false;
      try {
        await this.sandboxStub(info.hands.sandbox).agentActivity(info.agent, want);
      } catch (e) {
        console.warn(`agent ${info.agent}: telling ${info.hands.sandbox} working=${want} failed; retrying`, e);
        this.update((i) => {
          delete i.activity_sent;
        });
        await this.deadlines.set("activity", Date.now() + ACTIVITY_RETRY_MS, true);
        return;
      }
      this.update((i) => {
        i.activity_sent = want;
      });
    }
    // Still changing under us: check again shortly.
    await this.deadlines.set("activity", Date.now() + ACTIVITY_RETRY_MS, true);
  }

  // ---------------------------------------------------------------------------------------------
  // Brain lifecycle (docs/control-plane/durable-objects/agent/; rules in lib/brain.ts). A start is
  // made only from `intent`; `brain` is cleared only by `release`. Every transition arms the alarm
  // that carries it on in the same synchronous step (the deadline row is written before any await).
  // ---------------------------------------------------------------------------------------------

  /** Test seam: awaited at named points so a test can force an interleaving there. */
  testHooks: Partial<Record<HookPoint, () => Promise<void>>> = {};

  private async hook(point: HookPoint): Promise<void> {
    const h = this.testHooks[point];
    if (h) await h();
  }

  /** An operator's start (optionally on a chosen host), recorded as the intent and run. */
  async start(hostHint?: string, avoid?: string, restart = false): Promise<StartResult> {
    const info = this.load();
    this.refuseEnded(info, "starts");
    // Hands still go through the sandbox's gateway, wherever the brain runs.
    if (hostHint) await this.requireBrainHost(info.cell, hostHint);
    await this.setIntent({ ...(hostHint ? { host_hint: hostHint } : {}), ...(avoid ? { avoid } : {}), reason: restart ? "restart" : "operator" });
    const r = await this.runIntent(true);
    return r ?? this.startStatus();
  }

  /** FleetDO saw room for a brain: run a waiting intent now instead of at its backed-off retry. */
  async pokeIntent(): Promise<boolean> {
    if (!this.load().intent) return false;
    await this.deadlines.set("intent", Date.now(), true);
    return true;
  }

  /** What a start that issued nothing answers: where the brain is, and what it waits for. */
  private startStatus(): StartResult {
    const info = this.load();
    const b = info.brain;
    if (b?.phase === "condemned") return { kind: "waiting", host: info.intent?.host_hint ?? null, cmd: null, waiting_for: b.host };
    return { kind: "none", host: b?.host ?? null, cmd: null };
  }

  /** Merge a start request into the intent, with a backstop alarm in the same step (an eviction mid-start). */
  private async setIntent(patch: StartIntent): Promise<void> {
    // Nothing starts an agent that ended for good.
    if (this.load().ended) return;
    this.update((i) => {
      i.intent = mergeIntent(i.intent, patch);
    });
    await this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true);
  }

  /**
   * Single-flight over `processIntent`. A caller finding a run in flight waits and runs again (`wait`;
   * never from inside a run), or leaves its intent to the alarm armed when the run ends (`wake()`).
   */
  private runIntent(wait: boolean): Promise<StartResult | null> {
    if (this.intentRun) {
      this.intentDirty = true;
      if (!wait) return Promise.resolve(null);
      return this.intentRun.then(() => this.runIntent(true), () => this.runIntent(true));
    }
    const p = this.processIntent();
    this.intentRun = p;
    const done = async () => {
      if (this.intentRun !== p) return;
      this.intentRun = null;
      if (this.intentDirty) {
        this.intentDirty = false;
        await this.deadlines.set("intent", Date.now(), true);
      }
    };
    p.then(done, done);
    return p;
  }

  /**
   * Act on the intent against the brain record (design rule 2): a lost host's brain is released first
   * (A2, A3); a condemned brain is waited for; a live one is decided by `liveBrainStart`; with none, a
   * start is issued. Decided from a snapshot, committed only if the brain and intent are unchanged.
   */
  private async processIntent(): Promise<StartResult | null> {
    for (let round = 0; round < 3; round++) {
      const snap = this.load();
      const intent = snap.intent;
      if (!intent) return null;
      const brain = snap.brain;
      try {
        if (brain && (await this.hostGone(snap.cell, brain.host))) {
          await this.release(brain.host, brain.epoch, "host_lost");
          continue;
        }
        if (brain?.phase === "condemned") {
          if (!this.deadlines.has("condemned")) await this.deadlines.set("condemned", Date.now(), true);
          return this.startStatus();
        }
        if (brain) {
          // Healthy by the host's status (N24): a brief socket drop isn't a reason to move a brain.
          const st = await this.fleet(snap.cell).hostStatus(brain.host);
          const healthy = !!st && st.status === "active" && !st.lost && !st.wedged;
          const decided = liveBrainStart(intent, brain, healthy);
          await this.hook("intent:beforeCommit");
          if (!this.unchanged(snap)) continue;
          if (decided === "condemn") {
            await this.condemn(intent.reason === "restart" ? "restarting" : `starting on ${intent.host_hint ?? "another host"}`, brain.epoch);
          } else if (decided === "drop") {
            this.update((i) => Object.assign(i, NO_INTENT));
            await this.deadlines.clear("intent");
          }
          return this.startStatus();
        }
        const host = await this.pickHost(snap, intent);
        const oauthRef = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).credentialRef(snap.credential);
        // `--resume` reads R2 only: make what's still buffered durable first, or the new brain would
        // resume from up to a flush interval ago.
        await this.flush();
        const resume = this.load().session ? await this.sessionResume(this.load()) : undefined;
        await this.hook("intent:beforeCommit");
        if (!this.unchanged(snap)) continue;
        return await this.issueStart(host, oauthRef, resume, intent);
      } catch (e) {
        await this.intentFailed(intent, e);
        throw e;
      }
    }
    // Changed under us three times: the alarm looks again.
    await this.deadlines.set("intent", Date.now() + START_RETRY_MS, true);
    return this.startStatus();
  }

  /** The brain record and intent are still what `snap` saw. */
  private unchanged(snap: AgentInfo): boolean {
    const now = this.load();
    return same(now.brain, snap.brain) && same(now.intent, snap.intent);
  }

  /**
   * A brain host of this release for a start: the hint, else FleetDO's `placeBrain`; where the sandbox
   * runs plays no part. Throws (retryable) when no host has room.
   */
  private async pickHost(info: AgentInfo, intent: StartIntent): Promise<string> {
    const fleet = this.fleet(info.cell);
    let host: string | null;
    if (intent.host_hint) {
      await this.requireBrainHost(info.cell, intent.host_hint);
      host = intent.host_hint;
    } else {
      host = await fleet.placeBrain({ prev: info.prev_host ?? null, avoid: intent.avoid ?? null, agent: info.agent });
      if (!host) throw new NestError(ErrorCodes.CAPACITY_EXHAUSTED, "no brain host available for this agent", 503, true);
    }
    // The sandbox wakes alongside, so hands are ready sooner; the brain never waits for it. Only one
    // that can never run again stops the start.
    if (info.hands) {
      try {
        await this.sandboxStub(info.hands.sandbox).wake();
      } catch (e) {
        if (!(asNestError(e)?.retryable ?? true)) throw e;
        console.warn(`agent ${info.agent}: waking ${info.hands.sandbox} alongside its brain failed; hands_resolve retries`, e);
      }
    }
    return host;
  }

  /** `host` is an active, connected brain host of this release, or the start is refused. */
  private async requireBrainHost(cell: string, host: string): Promise<void> {
    const st = await this.fleet(cell).hostStatus(host);
    if (!(st && st.status === "active" && st.connected && st.current && st.role === "brain")) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${host} is not an active, connected brain host of this release in ${cell}`, 409);
    }
  }

  private startDeadline(info: AgentInfo): number {
    return START_DEADLINE_MS * 2 ** Math.min(info.start_timeouts ?? 0, START_BACKOFF_STEPS);
  }

  /** Arm the phase deadlines of the record `b` just entered; the rows are written before this returns. */
  private armPhase(b: Brain | null, startMs = START_DEADLINE_MS, connected = true): Promise<unknown> {
    const at = phaseDeadlines(b, Date.now(), startMs, NO_SESSION_MS, connected);
    return Promise.all((Object.keys(at) as PhaseDeadline[]).map((k) => {
      const t = at[k];
      return t === null ? this.deadlines.clear(k) : this.deadlines.set(k, t, k !== "starting");
    }));
  }

  /**
   * Commit a start on `host` (new epoch, brain `starting`, intent consumed, deadline armed) in one
   * step, then send `agent_start`. A failed send may still have been queued: the brain is condemned
   * and the intent kept.
   */
  private async issueStart(host: string, oauthRef: string, resume: AgentStartBody["resume"], intent: StartIntent): Promise<StartResult> {
    const started = this.update((i) => {
      i.agent_epoch += 1;
      Object.assign(i, NO_INTENT, { brain: { host, epoch: i.agent_epoch, phase: "starting", since_ms: Date.now() }, lifecycle: "starting", activity: null });
    });
    const armed = Promise.all([this.deadlines.clear("intent"), this.armPhase(started.brain, this.startDeadline(started))]);
    await this.hook("start:afterCommit");
    await armed;
    const epoch = started.agent_epoch;
    const body: AgentStartBody = {
      agent: started.agent,
      workstream: started.workstream,
      epoch,
      ...(resume ? { resume } : {}),
      ...(started.hands ? { hands: { sandbox: started.hands.sandbox } } : {}),
      launch: started.launch,
      oauth_token: oauthRef,
      session_ws_url: `${this.env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/agents/${started.agent}/session`,
    };
    let cmd: string;
    try {
      [cmd] = (await this.fleet(started.cell).issueCommands(host, [{ type: "agent_start", ...body }])) as [string];
    } catch (e) {
      console.warn(`agent ${started.agent}: sending agent_start@${epoch} to ${host} failed; condemning it`, e);
      if (this.load().brain?.epoch === epoch) {
        // Still wanted unless a stop ended it meanwhile: it runs again once this one is released.
        await this.condemn("its start could not be confirmed sent", epoch, (i) => {
          if (!stoppedBrain(i, epoch)) i.intent = i.intent ?? intent;
        });
      }
      throw e;
    }
    return { kind: "started", host, cmd };
  }

  /**
   * A run of the intent failed. A retryable failure keeps it and retries; otherwise a failing hint is
   * dropped, and anything else ends the intent (`errored` if no brain is left).
   */
  private async intentFailed(intent: StartIntent, e: unknown): Promise<void> {
    const now = this.load();
    const ne = asNestError(e);
    if (!now.intent) {
      // A stop ended the intent meanwhile; a capacity wait this run recorded after the stop's notice goes too.
      if (ne?.code === ErrorCodes.CAPACITY_EXHAUSTED) await this.brainWaitEnded(now);
      return;
    }
    // A newer start merged in meanwhile: its own run (`intentDirty`) decides.
    if (!same(now.intent, intent)) return;
    if (ne?.retryable ?? true) {
      // No brain host with room: back off, so a cell at its cap isn't polled by every waiting agent.
      let delay = WAKE_RETRY_MS;
      if (ne?.code === ErrorCodes.CAPACITY_EXHAUSTED) {
        const n = this.update((i) => {
          i.capacity_waits = (i.capacity_waits ?? 0) + 1;
        }).capacity_waits ?? 1;
        delay = capacityRetryMs(n);
      }
      await this.deadlines.set("intent", Date.now() + delay, true);
      return;
    }
    if (intent.host_hint) {
      this.update((i) => {
        if (i.intent && i.intent.host_hint === intent.host_hint) delete i.intent.host_hint;
      });
      await this.deadlines.set("intent", Date.now() + START_RETRY_MS, true);
      return;
    }
    this.update((i) => {
      Object.assign(i, NO_INTENT);
      if (!i.brain && (i.lifecycle === "starting" || i.lifecycle === "detached")) i.lifecycle = "errored";
    });
    await this.deadlines.clear("intent");
  }

  /**
   * Condemn the brain at `epoch` (design rule 2): none of its sessions is current from here on, they
   * are closed, and its kill is owed with the `condemned` alarm armed in the same step (A1), so it is
   * sent until FleetDO stores it; escalation takes over from there.
   */
  private async condemn(why: string, epoch: number, also?: BrainPatch | ((i: AgentInfo) => void)): Promise<void> {
    let condemned: Brain | null = null;
    this.update((i) => {
      if (typeof also === "function") also(i);
      else Object.assign(i, also);
      // Only the brain at `epoch` (N7).
      if (i.brain && i.brain.phase !== "condemned" && i.brain.epoch === epoch) {
        i.brain = { host: i.brain.host, epoch: i.brain.epoch, phase: "condemned", since_ms: Date.now() };
        condemned = i.brain;
      }
    });
    if (!condemned) return;
    const armed = this.armPhase(condemned);
    this.fenceSessions(why);
    await armed;
    await this.sendKill(condemned, why);
  }

  /** Issue the condemned brain's kill (idempotent in FleetDO) and record it once stored. */
  private async sendKill(b: Brain, why: string): Promise<void> {
    const info = this.load();
    let cmd: string;
    try {
      await this.hook("kill:beforeIssue");
      cmd = await this.fleet(info.cell).issueKill(b.host, info.agent, b.epoch, why);
    } catch (e) {
      console.warn(`agent ${info.agent}: sending the kill for ${b.host}@${b.epoch} failed; retrying`, e);
      await this.deadlines.set("condemned", Date.now() + KILL_RETRY_MS, true);
      return;
    }
    const now = Date.now();
    let killMs: number | null = null;
    this.update((i) => {
      const cur = i.brain;
      if (cur && cur.phase === "condemned" && cur.host === b.host && cur.epoch === b.epoch) {
        if (cur.kill?.cmd !== cmd) i.brain = { ...cur, kill: { cmd, ms: now } };
        killMs = (i.brain as Extract<Brain, { phase: "condemned" }>).kill?.ms ?? now;
      }
    });
    if (killMs !== null) await this.deadlines.set("condemned", killMs + EXIT_WAIT_MS);
  }

  /**
   * A condemned brain whose exit hasn't come (design rule 4): released if its host is gone, its kill
   * re-sent if not stored, else `escalation`'s verdict. A wedged host is released only by STONITH.
   */
  private async escalate(): Promise<void> {
    const info = this.load();
    const b = info.brain;
    if (!b || b.phase !== "condemned") return;
    if (await this.hostGone(info.cell, b.host)) {
      await this.release(b.host, b.epoch, "host_lost");
      return;
    }
    if (!b.kill) {
      await this.sendKill(b, "condemned");
      return;
    }
    const st = await this.fleet(info.cell).hostStatus(b.host);
    await this.hook("escalate:afterStatus");
    // Re-checked after the await (N13).
    if (!same(this.load().brain, b)) return;
    if (!st?.current) {
      // A previous-release host's brain is released only by its loss; past the cap it is wedged
      // (N21), and its nestd kills every brain when its lease lapses (`self_fence`).
      if (Date.now() - b.kill.ms >= ESCALATION_CAP_MS) {
        await this.fleet(info.cell).hostWedged(b.host, `${info.agent}@${b.epoch} on a previous-release host outlived its kill`);
      } else {
        console.warn(`agent ${info.agent}: ${b.host}@${b.epoch} is on a previous-release host; waiting for its loss`);
      }
      await this.deadlines.set("condemned", Date.now() + EXIT_WAIT_MS);
      return;
    }
    const p = await this.fleet(info.cell).killProgress(b.kill.cmd, info.agent, b.host, b.epoch);
    await this.hook("escalate:afterProgress");
    // Decided only against the record it was asked for.
    if (!same(this.load().brain, b)) return;
    const age = Date.now() - b.kill.ms;
    const verdict = escalation(p, age, EXIT_WAIT_MS, ESCALATION_CAP_MS);
    if (verdict === "release") {
      await this.release(b.host, b.epoch, "stopped");
      return;
    }
    if (verdict !== "recheck") {
      const why = verdict === "stuck" ? `${b.host} processed no command in the ${age} ms since the kill for ${info.agent}@${b.epoch}` : `${info.agent}@${b.epoch} outlived its kill by ${age} ms`;
      await this.fleet(info.cell).hostWedged(b.host, why);
    }
    await this.deadlines.set("condemned", Date.now() + EXIT_WAIT_MS);
  }

  /** FleetDO says `host`'s brains are proven gone (A6): lease expired, death confirmed, or no such host. */
  private async hostGone(cell: string, host: string): Promise<boolean> {
    const st = await this.fleet(cell).hostStatus(host);
    return !st || st.lost;
  }

  /** Release the brain on `host` at `epoch` or later (`brainRelease`), with the alarm that carries on in the same step. */
  private async release(host: string, epoch: number, reason: AgentExitReason): Promise<boolean> {
    let d: ReturnType<typeof brainRelease> = null;
    const info = this.update((i) => {
      d = brainRelease(i, host, epoch, reason, this.hasWork(i));
      if (d) Object.assign(i, d.patch);
      // Ended for good: the turn it was in is dropped with it (no brain will recover it).
      if (d && i.ended && i.current_turn) {
        this.queue.dropAll(i.current_turn);
        i.current_turn = null;
      }
    });
    if (!d) return false;
    const { wakes, next } = d as NonNullable<typeof d>;
    this.reportExit(info, host, epoch, reason, !wakes);
    // An ended agent's remaining steps (its sandbox, its owner) wait for this release.
    const armed = Promise.all([this.armPhase(null), next ? this.deadlines.set(next, Date.now(), true) : undefined,
      info.ended && !info.ended.done_ms ? this.deadlines.set("end", Date.now(), true) : undefined]);
    await this.hook("release:afterCommit");
    await armed;
    console.log(`agent ${info.agent}: brain on ${host}@${epoch} released (${reason})`);
    this.fenceSessions(`brain released (${reason})`, host);
    await this.syncActivity();
    if (next === "wake" || next === "wake_after_exit") await this.wake(next === "wake_after_exit");
    return true;
  }

  /** An operator's stop: the brain finishes its turn and its exit releases it; nothing it ends restarts (`stop_epoch`). */
  async stop(reason: string): Promise<void> {
    // Every start wanted before the stop ends here, with its alarm (N20); a run in flight finds the
    // intent changed at its re-check (`unchanged`).
    const waited = this.load().intent !== null;
    const info = this.update((i) => Object.assign(i, NO_INTENT, { stop_epoch: i.agent_epoch, stop_quiet: true }));
    // Wakes armed before the stop (a release's, a sandbox move's) are for work the stop ends too.
    await Promise.all([this.deadlines.clear("intent"), this.deadlines.clear("wake"), this.deadlines.clear("wake_after_exit")]);
    if (waited) await this.brainWaitEnded(info);
    const b = info.brain;
    if (!b || b.phase === "condemned") return;
    await this.fleet(info.cell).issueCommands(b.host, [{ type: "agent_stop", agent: info.agent, reason, mode: "graceful", epoch: b.epoch }]);
  }

  // ---------------------------------------------------------------------------------------------
  // Ending for good (docs/agents/#lifetimes; lib/lifetimes.ts). An end is recorded in one synchronous
  // step with the `end` deadline: it is a stop (`stop_epoch`, quiet) that no input lifts, its queued
  // turns dropped. The steps after it (the brain, the agents it owns, its sandbox, its owner) run
  // from that deadline, each recorded once done, until `done_ms`; its records go after the retention.
  // ---------------------------------------------------------------------------------------------

  private agentStub(id: string) {
    return this.env.AGENT.get(this.env.AGENT.idFromName(id));
  }

  /**
   * An ended agent takes no more `what`. As a recipient (turns, messages) it is gone, `unknown_agent`
   * (404), which every sender already reads as "drop it" (a channel subscription, a ledger notice, a
   * workstream wake); a start or a spawn it would make is refused (409).
   */
  private refuseEnded(info: AgentInfo, what: "turns" | "messages" | "starts" | "spawns"): void {
    if (!info.ended) return;
    const message = `${info.agent} has ended (${info.ended.reason}); it takes no more ${what}`;
    if (what === "turns" || what === "messages") throw new NestError(ErrorCodes.UNKNOWN_AGENT, message, 404);
    throw new NestError(ErrorCodes.FORBIDDEN, message, 409);
  }

  /** End this agent for good: `agent_stop` from an agent that owns it, its owner's end, or the operator. Idempotent. */
  async end(o: EndOptions): Promise<EndResult> {
    return this.endAgent(o);
  }

  private async endAgent(o: EndOptions): Promise<EndResult> {
    const before = this.load();
    if (before.ended) return { status: "already_stopped", ended: before.ended };
    const now = Date.now();
    const ended: Ended = {
      ms: now, by: o.by, reason: o.reason, kill: o.kill, destroy_sandbox: o.destroy_sandbox || !!before.ephemeral,
      ...(o.note ? { note: clip(o.note, 500) } : {}),
    };
    let dropped = 0;
    // One step: the stop that nothing lifts, its queued turns (and with no brain, the turn it was in), and its deadline.
    const info = this.update((i) => {
      Object.assign(i, NO_INTENT, { stop_epoch: i.agent_epoch, stop_quiet: true, ended });
      dropped = this.queue.dropAll(i.brain ? null : i.current_turn);
      if (!i.brain) i.current_turn = null;
    });
    const armed = Promise.all([this.deadlines.clear("intent"), this.deadlines.clear("wake"), this.deadlines.clear("wake_after_exit"), this.deadlines.set("end", now)]);
    // With no brain there is no release to report its exit: reported here, once.
    if (!info.brain) {
      this.report(info, {
        kind: "exited", text: this.kvGet<string>("last_text") || `ended (${o.reason})`,
        data: { reason: "stopped", ended: o.reason, by: o.by, ...(ended.note ? { note: ended.note } : {}) }, idem_key: `${info.agent}/ended`,
      }, this.tainted(info));
    }
    await armed;
    console.log(`agent ${info.agent}: ended (${o.reason}) by ${o.by}${dropped ? `; ${dropped} turns dropped` : ""}`);
    if (before.intent !== null) await this.brainWaitEnded(info);
    await this.endBrain();
    return { status: "stopped", ended };
  }

  /**
   * An ended agent's brain: killed (condemned) for a kill; for a graceful end, stopped once its turn
   * is done (or killed past `END_GRACE_MS`). Its release carries the end on.
   */
  private async endBrain(): Promise<void> {
    const info = this.load();
    const e = info.ended;
    const b = info.brain;
    if (!e || !b || b.phase === "condemned") return;
    if (e.kill || Date.now() - e.ms >= END_GRACE_MS) {
      await this.condemn(`ended (${e.reason})`, b.epoch);
      return;
    }
    if (info.current_turn || e.stop_sent === b.epoch) return;
    await this.fleet(info.cell).issueCommands(b.host, [{ type: "agent_stop", agent: info.agent, reason: `ended (${e.reason})`, mode: "graceful", epoch: b.epoch }]);
    this.update((i) => {
      if (i.ended) i.ended.stop_sent = b.epoch;
    });
  }

  /** The `end` deadline: each remaining step of an end, recorded once done; re-armed until all are. */
  private async finishEnd(): Promise<void> {
    const e = this.load().ended;
    if (!e || e.done_ms) return;
    await this.endBrain();
    await this.endChildren(e);
    const info = this.load();
    // Its sandbox and its owner wait for the brain to be gone (a graceful end's turn still uses its hands),
    // and for the agents it owns to finish ending (one sharing its sandbox detaches only then).
    const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM children WHERE ended = 0").one().n;
    if (info.brain || waiting) {
      await this.deadlines.set("end", Date.now() + END_RETRY_MS, true);
      return;
    }
    if (info.hands && !info.ended!.sandbox) {
      const r = await this.sandboxStub(info.hands.sandbox).release(info.agent, info.ended!.destroy_sandbox);
      this.update((i) => {
        if (i.ended) i.ended.sandbox = r.destroyed ? "destroyed" : "detached";
      });
    }
    if (info.owner && !info.ended!.owner_told) {
      try {
        await this.agentStub(info.owner).childEnded(info.agent);
      } catch (err) {
        // An owner that is gone (its records pruned) has nobody to tell.
        if (asNestError(err)?.code !== ErrorCodes.UNKNOWN_AGENT) throw err;
      }
      this.update((i) => {
        if (i.ended) i.ended.owner_told = true;
      });
    }
    const done = this.update((i) => {
      if (i.ended) i.ended.done_ms = Date.now();
    });
    await this.deadlines.set("reap", done.ended!.ms + AGENT_RECORD_RETENTION_MS);
  }

  /** Ask every agent it owns that hasn't ended to end (each ends its own in turn, and says so: `childEnded`). */
  private async endChildren(e: Ended): Promise<void> {
    const me = this.load().agent;
    const rows = this.sql.exec<{ agent: string }>("SELECT agent FROM children WHERE ended = 0 AND asked = 0").toArray();
    const results = await Promise.allSettled(rows.map(async ({ agent }) => {
      try {
        await this.agentStub(agent).end({ by: me, reason: "owner_ended", kill: true, destroy_sandbox: e.destroy_sandbox });
        this.sql.exec("UPDATE children SET asked = 1 WHERE agent = ?", agent);
      } catch (err) {
        // Indexed but never created (its spawn failed; one still being made checks again: `spawnChild`), or pruned.
        if (asNestError(err)?.code !== ErrorCodes.UNKNOWN_AGENT) throw err;
        this.sql.exec("UPDATE children SET ended = 1 WHERE agent = ?", agent);
      }
    }));
    for (const r of results) if (r.status === "rejected") console.warn(`agent ${me}: ending an agent it owns failed; retrying`, r.reason);
  }

  /** An agent it owns finished ending (its end's last steps): it no longer counts against `MAX_LIVE_CHILDREN`, and an end waiting for it goes on. */
  async childEnded(child: string): Promise<void> {
    if (!this.exists()) return;
    this.sql.exec("UPDATE children SET ended = 1 WHERE agent = ?", child);
    const e = this.load().ended;
    if (e && !e.done_ms) await this.deadlines.set("end", Date.now(), true);
  }

  /** The agents it spawned, with whether each has ended (display, tests). */
  async children(): Promise<{ agent: string; ended: boolean }[]> {
    return this.sql.exec<{ agent: string; ended: number }>("SELECT agent, ended FROM children ORDER BY created_ms").toArray()
      .map((r) => ({ agent: r.agent, ended: r.ended === 1 }));
  }

  /** What the operator's lifetimes view reads (lib/abandoned.ts `AgentFacts`): a read, never a decision. */
  async lifetimeFacts(): Promise<AgentFacts> {
    const info = this.load();
    const e = info.ended;
    return {
      agent: info.agent,
      template: info.template ?? null,
      owner: info.owner,
      sandbox: info.hands?.sandbox ?? null,
      brain: info.brain !== null,
      starting: info.intent !== null,
      current_turn: info.current_turn !== null,
      queued: this.queue.queuedCount(),
      // A row from before `created_ms` reads 0: unknown, so counted as none.
      last_turn_ms: this.queue.lastTurnMs() || null,
      stopped_by_operator: !e && quietSinceStop(info),
      live_children: this.sql.exec<{ agent: string }>("SELECT agent FROM children WHERE ended = 0 ORDER BY created_ms").toArray().map((r) => r.agent),
      subscriptions: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channel_subs WHERE ended = 0").one().n,
      ended: e ? { ms: e.ms, reason: e.reason, done_ms: e.done_ms ?? null } : null,
    };
  }

  /**
   * The `reap` deadline, `AGENT_RECORD_RETENTION_MS` after the end: its R2 session segments, then its
   * storage. A brain never proven gone holds it (its release still needs the record).
   */
  private async reap(): Promise<void> {
    const info = this.load();
    const e = info.ended;
    if (!e?.done_ms) return;
    if (info.brain || Date.now() < e.ms + AGENT_RECORD_RETENTION_MS) {
      await this.deadlines.set("reap", Math.max(Date.now() + END_RETRY_MS, e.ms + AGENT_RECORD_RETENTION_MS));
      return;
    }
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix: `sessions/${info.agent}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await this.env.BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    console.log(`agent ${info.agent}: records pruned ${Math.round((Date.now() - e.ms) / 86_400_000)} days after it ended`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Empty again but readable: `load()` answers `unknown_agent`, and the alarm run that called this ends cleanly.
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /** `agent`'s owner, that owner's owner, and so on (`MAX_OWNER_HOPS` at most), stopping at this agent. */
  private async ownerChain(agent: string): Promise<(string | null)[]> {
    const me = this.load().agent;
    const chain: (string | null)[] = [];
    let cur = agent;
    for (let hop = 0; hop < MAX_OWNER_HOPS; hop++) {
      let owner: string | null;
      try {
        owner = (await this.agentStub(cur).info()).owner;
      } catch (e) {
        // The target itself must exist; a pruned ancestor ends the chain.
        if (hop === 0 || asNestError(e)?.code !== ErrorCodes.UNKNOWN_AGENT) throw e;
        break;
      }
      chain.push(owner);
      if (!owner || owner === me) break;
      cur = owner;
    }
    return chain;
  }

  /** `exit`, or `agent_stop` on itself: ended once this turn finishes. Never gated: it only gives up authority. */
  private async exitTool(info: AgentInfo, destroySandbox: boolean, note: string | undefined, live: () => Promise<void>): Promise<ToolOutcome> {
    await live();
    const r = await this.endAgent({ by: info.agent, reason: "exited", kill: false, destroy_sandbox: destroySandbox, ...(note ? { note } : {}) });
    const t = r.status === "already_stopped"
      ? "You have already ended."
      : "Ended: finish this turn and stop. No more turns, wakes or messages will come; the agents you own are stopped.";
    return { status: "ok", content: [{ type: "text", text: t }] };
  }

  /**
   * `agent_spawn` (docs/agents/#spawning): from a template its capabilities spawn from (`spec.spawn`),
   * with overrides that only narrow, a sandbox created for it (it owns it), the spawner's own (the
   * template allowing it), or none. The caller owns the child. Every id is derived from the call key,
   * so a re-run creates nothing twice.
   */
  private async spawnTool(info: AgentInfo, a: Record<string, unknown>, key: string, live: () => Promise<void>): Promise<ToolOutcome> {
    this.refuseEnded(info, "spawns");
    const template = String(a.template);
    if (!(info.spawn ?? []).includes(template)) throw new NestError(ErrorCodes.FORBIDDEN, `your capabilities don't spawn from template ${template}`, 403);
    const mode = a.sandbox === "new" || a.sandbox === "share" ? a.sandbox : null;
    if (mode === "share" && !info.hands) throw new NestError(ErrorCodes.INVALID_MESSAGE, "you have no sandbox to share");
    const child = await keyedId("agt_", key);
    const known = this.sql.exec("SELECT 1 FROM children WHERE agent = ?", child).toArray().length > 0;
    if (!known) {
      const live_ = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM children WHERE ended = 0").one().n;
      const refusal = spawnRefusal(info.depth ?? 0, live_);
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `can't spawn: ${refusal}`, 403);
    }
    const overrides: SpawnerOverrides = {
      ...(Array.isArray(a.tools) ? { tools: a.tools.map(String) } : {}),
      ...(Array.isArray(a.repos) ? { repos: a.repos.map(String) } : {}),
      ...(a.ephemeral === true ? { ephemeral: true as const } : {}),
      ...(typeof a.sandbox_idle_ttl_s === "number" ? { sandbox_idle_ttl_ms: a.sandbox_idle_ttl_s * 1000 } : {}),
    };
    const catalog = this.env.CATALOG.get(this.env.CATALOG.idFromName("catalog"));
    const spec = await catalog.expand({
      template, hands: mode !== null, by: "spawner", share: mode === "share", overrides, cell_idle_ttl_ms: cellIdleTtlMs(this.env, info.cell),
    });
    const tainted = this.tainted(info);
    const sandbox = mode === "new" ? await keyedId("sbx_", key) : mode === "share" ? info.hands!.sandbox : null;
    await live();
    // Indexed (in the fence's step) before anything is made: the index may name a child that never was
    // (its end finds none), never miss one. A refusal for good before the child exists takes the row back.
    if (!known && this.sql.exec("SELECT 1 FROM children WHERE agent = ?", child).toArray().length === 0) {
      // Checked again in the insert's step: two spawns in flight can't both take the last place.
      const refusal = spawnRefusal(info.depth ?? 0, this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM children WHERE ended = 0").one().n);
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `can't spawn: ${refusal}`, 403);
    }
    this.sql.exec("INSERT OR IGNORE INTO children (agent, created_ms) VALUES (?, ?)", child, Date.now());
    try {
      return await this.spawnChild(info, child, sandbox, mode === "new", template, spec, String(a.task), key, tainted, live);
    } catch (e) {
      if (!asNestError(e)?.retryable && !(await this.agentExists(child))) this.sql.exec("DELETE FROM children WHERE agent = ? AND ended = 0", child);
      throw e;
    }
  }

  /** Whether `agent` was created (its `info()` answers); a failure to ask counts as yes, so nothing is forgotten. */
  private async agentExists(agent: string): Promise<boolean> {
    try {
      await this.agentStub(agent).info();
      return true;
    } catch (e) {
      return asNestError(e)?.code !== ErrorCodes.UNKNOWN_AGENT;
    }
  }

  /** `agent_spawn`'s writes, each behind the epoch fence: the sandbox (owned by the child), the child, its task. */
  private async spawnChild(
    info: AgentInfo, child: string, sandbox: string | null, fresh: boolean, template: string, spec: AgentSpec, task: string, key: string, tainted: boolean,
    live: () => Promise<void>,
  ): Promise<ToolOutcome> {
    if (sandbox && fresh) {
      await this.sandboxStub(sandbox).create({
        sandbox, workstream: info.workstream, cell: info.cell, owner: child,
        ...(spec.sandbox_idle_ttl_ms !== undefined ? { idle_ttl_ms: spec.sandbox_idle_ttl_ms } : {}),
      });
      await live();
    }
    const stub = this.agentStub(child);
    await stub.create({
      agent: child, workstream: info.workstream, cell: info.cell, spec, owner: info.agent, sandbox, owner_is_caller: true,
      depth: (info.depth ?? 0) + 1, tainted,
    });
    // Ended meanwhile (its owner's end may have looked for this child before it existed): the child ends too.
    if (this.load().ended) {
      this.sql.exec("UPDATE children SET ended = 0, asked = 0 WHERE agent = ?", child);
      await this.deadlines.set("end", Date.now(), true);
      throw new NestError(ErrorCodes.FORBIDDEN, `${info.agent} ended while spawning ${child}; it ends too`, 409);
    }
    await live();
    await stub.postInbox(`${info.template}:${info.agent}`, task, false, `spawn/${key}`, tainted);
    const value = { agent: child, template, ...(sandbox ? { sandbox } : {}), ...(spec.ephemeral ? { ephemeral: true } : {}) };
    return {
      status: "ok",
      content: [
        { type: "text", text: `Spawned ${child} from ${template}${sandbox ? ` with sandbox ${sandbox}` : ""}${spec.ephemeral ? " (ephemeral)" : ""}. Its events reach you.` },
        { type: "json", value },
      ],
    };
  }

  /** Best effort: a row left behind lapses when this agent no longer retries (12 min). */
  private async brainWaitEnded(info: AgentInfo): Promise<void> {
    try {
      await this.fleet(info.cell).brainWaitEnded(info.agent);
    } catch (e) {
      console.warn(`agent ${info.agent}: telling FleetDO its wait for a brain host ended failed`, e);
    }
  }

  /** A write for agent epoch `epoch` goes out only while that epoch is current. */
  private assertEpoch(epoch: number): void {
    if (!this.isCurrent(this.load(), epoch)) {
      throw new NestError(ErrorCodes.STALE_EPOCH, `agent epoch ${epoch} is not the current brain's`, 409);
    }
  }

  /** Mark every session (on `host`, if given) stale and close it: nothing it sends is accepted from here on. */
  private fenceSessions(reason: string, host?: string): void {
    for (const ws of this.ctx.getWebSockets("session")) {
      const a = ws.deserializeAttachment() as Attachment;
      if (host !== undefined && a.host !== host) continue;
      ws.serializeAttachment({ ...a, helloed: false, stale: true });
      ws.close(4409, reason);
    }
  }

  /** The brain's host is draining: condemned at once with an intent that avoids the host (rule 5: never released by fiat). */
  async onHostDraining(host: string): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    const b = info.brain;
    if (!b || b.host !== host || b.phase === "condemned") return;
    // A stopped brain leaves without moving.
    if (stoppedBrain(info, b.epoch)) {
      await this.condemn(`its host ${host} is draining (stopped)`, b.epoch);
      return;
    }
    await this.setIntent({ avoid: host, reason: "drain" });
    try {
      await this.runIntent(true);
    } catch (e) {
      console.warn(`agent ${this.load().agent}: moving off draining ${host} failed`, e);
    }
  }

  /** `agent_start` at `epoch` failed on `host`: never a release (A4), but a condemn with its retry (`startFailure`) in one step. */
  async startFailed(host: string, error: { code: string; message: string; retryable?: boolean }, epoch?: number): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    const b = info.brain;
    if (!b || b.host !== host || epoch === undefined || epoch !== b.epoch) return;
    console.warn(`agent ${info.agent}: start on ${host}@${epoch} failed: ${error.code} ${error.message}`);
    const { patch, retry } = startFailure(info, epoch, !!error.retryable);
    const condemned = this.condemn(`its start failed (${error.code})`, epoch, patch);
    const armed = retry ? this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true) : undefined;
    await Promise.all([condemned, armed]);
  }

  /** A brain on `host` exited at `epoch` (rule 3); without one (a previous-release row), `epochlessExit`. */
  async onExited(host: string, reason: AgentExitReason, epoch?: number): Promise<void> {
    if (!this.exists()) return;
    await this.hook("exited:enter");
    const rec = this.load();
    // A previous-release host's exits prove nothing: only its loss releases its brain.
    if (rec.brain?.host === host && !(await this.fleet(rec.cell).hostStatus(host))?.current) return;
    if (epoch !== undefined) {
      await this.release(host, epoch, reason);
      return;
    }
    const now = this.load();
    const b = now.brain;
    if (!b || b.host !== host || b.phase === "condemned") return;
    const { patch, wake, afterExit } = epochlessExit(now, b, reason);
    await this.condemn(`an exit without an agent epoch (${reason})`, b.epoch, patch);
    if (wake) await this.wake(afterExit);
  }

  /** The brain's host is lost: released if `epoch` (the index row's) reaches it and FleetDO still says lost. */
  async onHostLost(host: string, epoch?: number): Promise<boolean> {
    if (!this.exists()) return true;
    await this.hook("hostLost:enter");
    const info = this.load();
    const b = info.brain;
    // Moot: no record on that host at or below the notice's epoch.
    if (!b || b.host !== host || (epoch !== undefined && epoch < b.epoch)) return true;
    // Declined (N6): the host isn't lost any more; FleetDO keeps the row.
    if (!(await this.hostGone(info.cell, host))) return false;
    await this.release(host, epoch ?? b.epoch, "host_lost");
    return true;
  }

  /** Input from outside the agent arrived (never the platform's `system` notes): a stop before it no longer quiets wakes. */
  private inputArrived(): void {
    const info = this.load();
    if (info.stop_quiet && !info.ended) {
      this.update((i) => {
        delete i.stop_quiet;
      });
    }
  }

  /** Start a brain for waiting work through the intent (`wakeDecision`). Never throws: the work stays queued. */
  private async wake(afterExit = false): Promise<void> {
    const info = this.load();
    if (info.ended) return;
    const decided = wakeDecision(info, this.hasWork(info), afterExit);
    if (decided === "none") return;
    if (decided === "errored") {
      this.update((i) => {
        i.lifecycle = "errored";
      });
      console.warn(`agent ${info.agent}: exited ${info.exit_restarts} times without completing a turn; waiting for new input`);
      return;
    }
    this.update((i) => {
      i.start_attempts = 0;
    });
    await this.setIntent({ reason: "wake" });
    if (info.brain) {
      // Condemned: runs once it is released.
      if (!this.deadlines.has("condemned")) await this.deadlines.set("condemned", Date.now(), true);
      return;
    }
    try {
      await this.runIntent(false);
    } catch (e) {
      console.warn(`agent ${info.agent}: wake failed`, e);
    }
  }

  /** The host reported this brain in its hello. One the record doesn't place there is an orphan (N1), killed at the highest epoch. */
  async hostReport(host: string, state: AgentState): Promise<void> {
    if (!this.exists()) return;
    const info = this.update((i) => {
      if (i.brain?.host === host && i.brain.phase !== "condemned" && agentState(i) === "detached") {
        i.lifecycle = "ready";
        i.activity = state;
      }
    });
    if (info.brain?.host === host) return;
    console.error(`agent ${info.agent}: ${host} reports a brain the record doesn't place there; killing it`);
    await this.fleet(info.cell).issueKill(host, info.agent, info.agent_epoch, "orphan: not this agent's recorded brain");
  }

  /** The bound sandbox got a new lease. The brain survives it (it resolves fresh hands); a stopped one with work wakes. */
  async onSandboxMoved(sandbox: string, epoch: number, host: string | null): Promise<void> {
    if (!this.exists()) return;
    await this.hook("sandboxMoved:enter");
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) return;
    this.update((i) => {
      i.hands_moved_ms = Date.now();
    });
    if (!host) return;
    // Mid-turn, the brain hears what the restore lost now; otherwise its next turn starts with it (`pump`).
    if (info.current_turn && info.told_sandbox_epoch !== undefined && info.told_sandbox_epoch !== epoch) {
      const note = await this.movedNote(info);
      // Only forward: a newer move told meanwhile says it all.
      let news = false;
      this.update((i) => {
        news = (i.told_sandbox_epoch ?? -1) < epoch;
        if (news) i.told_sandbox_epoch = epoch;
      });
      if (news) await this.postInbox(SYSTEM_SENDER, note);
    }
    // Never a start from here: this may run inside a start that placed the sandbox.
    await this.deadlines.set("wake", Date.now(), true);
  }

  /** What a sandbox restored from its head after a move lost, as told to the model. */
  private async movedNote(info: AgentInfo): Promise<string> {
    let head: GenerationRecord | null = null;
    try {
      if (info.hands) head = await this.sandboxStub(info.hands.sandbox).headGeneration();
    } catch (e) {
      console.warn(`agent ${info.agent}: reading the sandbox head failed`, e);
    }
    return head
      ? `Your sandbox moved to another machine and was restored from its state saved at ${iso(head.created_ms)}${head.kind === "disk_only" ? "; running processes stopped" : ""}. File changes after that were lost.`
      : "Your sandbox moved to another machine; it may have lost recent file changes and running processes.";
  }

  /** A fresh hands target from SandboxDO, or why there is none; it travels only here, never in a host command. */
  private async resolveHands(request: string): Promise<AgentToRunner> {
    const info = this.load();
    if (!info.hands) return handsResolved(request, { status: "error", error: errorBody(ErrorCodes.NOT_BOUND, "agent has no hands") });
    const stub = this.sandboxStub(info.hands.sandbox);
    try {
      // A suspended, unplaced sandbox is placed on demand: no brain start will place it.
      const cur = await stub.info();
      if (!cur.host && cur.placing === null && cur.state === "suspended") await stub.wake();
    } catch (e) {
      console.warn(`agent ${info.agent}: waking ${info.hands.sandbox} for hands failed`, e);
    }
    try {
      const hands = await stub.resolve(info.agent);
      return handsResolved(request, { status: "ok", hands });
    } catch (e) {
      const ne = asNestError(e);
      const error = ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, "resolving hands failed", true);
      return handsResolved(request, { status: "error", error, ...(error.retryable ? { retry_after_ms: HANDS_RETRY_MS } : {}) });
    }
  }

  /** Segments for `claude --resume`: signed GET URLs for the committed base, in offset order. */
  private async sessionResume(info: AgentInfo) {
    if (!info.session || info.durable_bytes === 0) return undefined;
    const exp = Date.now() + SIGNED_URL_TTL_MS;
    const rows = this.sql
      .exec<{ offset: number; len: number; key: string }>(
        "SELECT offset, len, key FROM segments WHERE base = ? AND offset < ? ORDER BY offset", info.base_gen, info.durable_bytes)
      .toArray();
    const segments: SegmentRef[] = [];
    for (const [i, r] of rows.entries()) {
      segments.push({
        offset: r.offset,
        len: r.len,
        base: i === 0,
        url: await signBlobUrl(this.env.HOST_TOKEN_SECRET, this.env.PUBLIC_BASE_URL, r.key, exp),
      });
    }
    return { session: info.session, segments, total_bytes: info.durable_bytes, fork: false };
  }

  // ---------------------------------------------------------------------------------------------
  // Session WebSocket
  // ---------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const host = request.headers.get("x-nest-host");
    const cell = request.headers.get("x-nest-cell");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !host) {
      return new Response("expected websocket upgrade", { status: 400 });
    }
    if (!this.exists()) return new Response("unknown agent", { status: 404 });
    const info = this.load();
    // Only the brain record's host, live and in the agent's cell. A condemned brain may still
    // connect: its hello is stale, so its bytes go to the orphan branch.
    if (!info.brain || info.brain.host !== host) return new Response("agent is not assigned to this host", { status: 403 });
    if (cell !== null && cell !== info.cell) return new Response("host is in another cell", { status: 403 });
    const status = await this.fleet(info.cell).hostStatus(host);
    if (!status || (status.status !== "active" && status.status !== "draining")) {
      return new Response("host is not live", { status: 403 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["session"]);
    pair[1].serializeAttachment({ host, epoch: -1, helloed: false, stale: false, instance: "" } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: RunnerToAgent;
    try {
      const r = RunnerToAgent.safeParse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
      if (!r.success) throw new Error(r.error.message);
      msg = r.data;
    } catch (e) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, e instanceof Error ? e.message : String(e)) });
      return;
    }
    const pre = ws.deserializeAttachment() as Attachment;
    if (!pre.helloed && msg.type !== "hello") {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, "first frame must be hello") });
      ws.close(4400, "expected hello");
      return;
    }
    if (msg.type === "ack") {
      this.rel.ack(CHAN, msg.up_to);
      return;
    }
    if (msg.type === "tools_list_request") {
      const info = this.load();
      const start = Date.now();
      const remote = await this.mcpToolDefs(info);
      this.send(ws, { type: "tools_list", request: msg.request, tools: [...toolDefs(offered(info)), ...brokeredToolDefs(info.brokered ?? []), ...remote] });
      const att = ws.deserializeAttachment() as Attachment;
      if (this.current(att)) {
        this.kvPut("tools_listed", { epoch: att.epoch, ms: start } satisfies ToolsListed);
        // A change that landed while this list was being made may not be in it: list again.
        if ((this.kvGet<number>("mcp_changed_ms") ?? 0) >= start) this.sendToolsChanged(ws);
      }
      return;
    }
    if (msg.type === "hands_resolve") {
      // Only the current runner process at the current epoch gets a binding, checked again after
      // resolving (a start or condemn may land meanwhile).
      const current = () => this.current(ws.deserializeAttachment() as Attachment);
      let answer = current() ? await this.resolveHands(msg.request) : null;
      if (answer) await this.hook("resolveHands:afterResolve");
      if (!answer || !current()) {
        answer = handsResolved(msg.request, { status: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "not the current runner process or epoch") });
      }
      this.send(ws, answer);
      return;
    }
    // Everything else is processed strictly one at a time, in arrival order.
    const m = msg;
    return this.inbound.run(async () => {
      const att = ws.deserializeAttachment() as Attachment;
      try {
        switch (m.type) {
          case "hello":
            return await this.onHello(ws, att, m);
          case "segment":
            return await this.onSegment(ws, att, m);
          case "events":
            return await this.onEvents(ws, att, m.seq, m.events);
          case "tool_call":
            return await this.onToolCall(ws, att, m);
          case "cancel_call":
            return this.onCancelCall(ws, att, m);
        }
      } catch (e) {
        // Not acked: close so the runner reconnects and resends from what was acknowledged.
        const ne = asNestError(e);
        console.error("AgentDO: message handling failed", e);
        this.send(ws, { type: "error", error: ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, "internal error; reconnect and resend", true) });
        try {
          ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), helloed: false, stale: true });
          ws.close(4500, "message handling failed; reconnect and resend");
        } catch {
          // already closed
        }
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    // The live brain's session went away: condemned unless a session or an exit follows.
    if (att && this.exists() && att.helloed && this.current(att) && this.load().brain?.phase === "live") {
      await this.deadlines.set("no_session", Date.now() + NO_SESSION_MS, true);
    }
  }

  private send(ws: WebSocket, msg: AgentToRunner): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket gone: reliable messages are resent after the next hello.
    }
  }

  /** The live, non-stale session socket of the current runner process at the current agent epoch, if any. */
  private socket(): WebSocket | undefined {
    const info = this.load();
    return this.ctx.getWebSockets("session").find((ws) => {
      const a = ws.deserializeAttachment() as Attachment;
      return a.helloed && !a.stale && a.instance === info.runner_instance && this.isCurrent(info, a.epoch);
    });
  }

  /** Persist a reliable message and send it if the runner is connected. */
  private pushReliable(make: (seq: number) => AgentToRunner & { seq: number }): void {
    const msg = this.rel.push(CHAN, make);
    const ws = this.socket();
    if (ws) this.send(ws, msg);
  }

  /** Only the current runner process at the current agent epoch is heard, even before a newer brain's hello. */
  private current(att: Attachment): boolean {
    const info = this.load();
    return !att.stale && att.instance === info.runner_instance && this.isCurrent(info, att.epoch);
  }

  private async onHello(ws: WebSocket, att: Attachment, hello: Extract<RunnerToAgent, { type: "hello" }>): Promise<void> {
    if (hello.protocol_version !== PROTOCOL_VERSION) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.UNSUPPORTED_VERSION, `server speaks ${PROTOCOL_VERSION}`) });
      ws.close(4426, "unsupported protocol version");
      return;
    }
    const before = this.load();
    if (hello.agent !== before.agent || hello.host !== att.host || before.brain?.host !== att.host) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.UNAUTHORIZED, "hello does not match agent/host") });
      ws.close(4401, "unauthorized");
      return;
    }
    // A stale epoch is still accepted, but its segments go to the orphan branch and nothing else flows.
    const stale = !this.isCurrent(before, hello.epoch);
    ws.serializeAttachment({
      host: att.host, epoch: hello.epoch, helloed: true, stale, instance: hello.instance_id, ...(hello.tools_changed ? { tools_changed: true } : {}),
    } satisfies Attachment);
    if (stale) {
      this.send(ws, {
        type: "hello_ack", protocol_version: PROTOCOL_VERSION, durable_bytes: hello.local_bytes ?? 0,
      });
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.STALE_EPOCH, `expected epoch ${before.agent_epoch}`) });
      return;
    }
    for (const old of this.ctx.getWebSockets("session")) {
      if (old === ws) continue;
      // Never pick a superseded socket for sending, even while its close is in flight.
      old.serializeAttachment({ ...(old.deserializeAttachment() as Attachment), helloed: false, stale: true });
      old.close(4000, "superseded by a new connection");
    }

    // A new runner process starts a new channel lineage: forget what the old one was sent and sent us.
    const newLineage = before.runner_instance !== null && before.runner_instance !== hello.instance_id;
    if (newLineage) {
      this.rel.reset(CHAN);
      this.sql.exec("DELETE FROM events");
    }
    const recovered = newLineage ? before.current_turn : null;
    const info = this.update((i) => {
      i.runner_instance = hello.instance_id;
      i.start_attempts = 0;
      if (recovered && i.current_turn === recovered) i.current_turn = null;
      if (hello.session && i.recv_session && hello.session !== i.recv_session) newStream(i, hello.session);
      else if (hello.session && !i.recv_session) adoptSession(i, hello.session);
      if (["starting", "detached", "errored"].includes(agentState(i))) {
        i.lifecycle = "ready";
        i.activity = null;
      }
      if (i.brain && i.brain.phase === "starting") i.brain = { ...i.brain, phase: "live" };
      i.start_timeouts = 0;
    });
    // Q4, in the step that cleared `current_turn`: nothing can start another turn ahead of it.
    if (recovered) this.queue.recover(recovered, this.recoveryNotes(info));
    const armed = this.armPhase(info.brain);
    this.sql.exec("DELETE FROM seg_buffer WHERE base < ?", info.recv_base);

    this.send(ws, {
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      durable_bytes: info.recv_durable,
      ...(this.rel.lastIn(CHAN) !== undefined ? { last_seq: this.rel.lastIn(CHAN) } : {}),
    });
    if (!newLineage && hello.last_seq !== undefined) this.rel.ack(CHAN, hello.last_seq);
    for (const m of this.rel.pendingAfter(CHAN, newLineage ? undefined : hello.last_seq)) this.send(ws, m as AgentToRunner);
    // A tool list change this brain wasn't told of (it was disconnected): tell it now.
    if (this.toolsOwed(info)) this.sendToolsChanged(ws);
    this.pushCache();
    await armed;
    // Re-assert working to SandboxDO: a call lost before this session must not outlive it.
    await this.syncActivity(true);
    await this.pump();
  }

  /**
   * A recovery turn's notes: what the model can't know from its transcript (where its durable part
   * ends). The only way an interrupted turn continues: the runner never sets
   * `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`. A sandbox move is `pump`'s to say.
   */
  private recoveryNotes(info: AgentInfo): string[] {
    const notes = ["Your session restarted while you were working on a turn."];
    if (info.durable_ms) {
      notes.push(`Your saved transcript ends at ${iso(info.durable_ms)}. Anything you did after that may be missing from it but may still have taken effect: check the workspace (e.g. git status) before redoing work.`);
    }
    notes.push("If the turn isn't finished, continue it.");
    return notes;
  }

  // --- session segments ---------------------------------------------------------------------------

  private async onSegment(ws: WebSocket, att: Attachment, seg: Extract<RunnerToAgent, { type: "segment" }>): Promise<void> {
    const data = b64ToBytes(seg.data_b64);
    const agent = this.load().agent;
    if (att.stale) {
      // Fenced connection: keep the bytes on the orphan branch, never in the live session.
      await this.env.BUCKET.put(`sessions/${agent}/orphan/e${att.epoch}/${seg.offset}`, data.slice().buffer);
      this.send(ws, { type: "segment_ack", session: seg.session, durable_bytes: seg.offset + data.length });
      return;
    }
    if (!this.current(att)) return;
    if (seg.base) {
      if (seg.offset !== 0) throw new NestError(ErrorCodes.INVALID_MESSAGE, "a base segment must start at offset 0");
      const i2 = this.update((i) => newStream(i, seg.session));
      this.sql.exec("DELETE FROM seg_buffer WHERE base < ?", i2.recv_base);
    } else {
      const cur = this.load();
      if (cur.recv_session && seg.session !== cur.recv_session) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, `segment for session ${seg.session}, expected ${cur.recv_session}`);
      }
      if (!cur.recv_session) this.update((i) => adoptSession(i, seg.session));
    }
    const info = this.load();
    const end = info.received_bytes;
    if (seg.offset > end) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `gap in session stream: expected offset ${end}, got ${seg.offset}`, 400, true);
    }
    if (seg.offset + data.length <= end) {
      this.send(ws, { type: "segment_ack", session: seg.session, durable_bytes: info.recv_durable });
      return; // duplicate
    }
    const fresh = data.subarray(end - seg.offset);
    this.sql.exec("INSERT INTO seg_buffer (base, offset, data) VALUES (?, ?, ?)", info.recv_base, end, fresh.slice().buffer);
    const after = this.update((i) => {
      i.received_bytes = end + fresh.length;
    });
    if (after.received_bytes - after.recv_durable >= FLUSH_BYTES) {
      await this.flush();
    } else {
      const delay = WORKING_STATES.includes(agentState(after)) ? FLUSH_WORKING_MS : FLUSH_IDLE_MS;
      await this.deadlines.set("flush", Date.now() + delay, true);
    }
  }

  /**
   * Write the buffered bytes to R2 as one segment, then ack the new durable offset; a pending base is
   * committed once durable and caught up. Single-flight: two flushes of the same rows write one key
   * twice, and the slower, shorter put could land last, losing acked bytes.
   */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    const p = this.flushOnce();
    this.flushing = p;
    try {
      await p;
    } finally {
      if (this.flushing === p) this.flushing = null;
    }
  }

  private async flushOnce(): Promise<void> {
    const info = this.load();
    const base = info.recv_base;
    const rows = this.sql
      .exec<{ offset: number; data: ArrayBuffer }>("SELECT offset, data FROM seg_buffer WHERE base = ? ORDER BY offset", base)
      .toArray();
    if (!rows.length) return;
    const start = rows[0]!.offset;
    const last = rows[rows.length - 1]!.offset;
    const bytes = concatBytes(rows.map((r) => new Uint8Array(r.data)));
    const key = `sessions/${info.agent}/b${base}/${start}`;
    await this.hook("flush:beforePut");
    await this.env.BUCKET.put(key, bytes.slice().buffer);
    // State may have moved on during the put: apply only what this flush made durable.
    this.sql.exec("INSERT OR REPLACE INTO segments (base, offset, len, key) VALUES (?, ?, ?, ?)", base, start, bytes.length, key);
    this.sql.exec("DELETE FROM seg_buffer WHERE base = ? AND offset <= ?", base, last);
    const after = this.update((i) => {
      if (i.recv_base !== base) return; // a newer stream started meanwhile; this one is superseded
      i.recv_durable = Math.max(i.recv_durable, start + bytes.length);
      i.durable_ms = Date.now();
      if (i.base_gen === base) {
        i.durable_bytes = i.recv_durable;
      } else if (i.recv_durable >= i.received_bytes) {
        i.base_gen = base;
        i.durable_bytes = i.recv_durable;
        i.session = i.recv_session;
      }
    });
    if (this.sql.exec("SELECT 1 FROM seg_buffer WHERE base = ?", after.recv_base).toArray().length) {
      await this.deadlines.set("flush", Date.now() + FLUSH_WORKING_MS, true);
    } else {
      await this.deadlines.clear("flush");
    }
    const ws = this.socket();
    if (ws && after.recv_base === base && after.recv_session) {
      this.send(ws, { type: "segment_ack", session: after.recv_session, durable_bytes: after.recv_durable });
    }
  }

  /** Durable transcript bytes of the committed base (admin and tests). */
  async transcript(): Promise<string> {
    const info = this.load();
    const rows = this.sql
      .exec<{ key: string }>("SELECT key FROM segments WHERE base = ? AND offset < ? ORDER BY offset", info.base_gen, info.durable_bytes)
      .toArray();
    const parts: Uint8Array[] = [];
    for (const r of rows) {
      const obj = await this.env.BUCKET.get(r.key);
      if (obj) parts.push(new Uint8Array(await obj.arrayBuffer()));
    }
    return new TextDecoder().decode(concatBytes(parts));
  }

  /**
   * Entries (1-based JSONL lines of the committed base) after `since`, streamed segment by segment:
   * never more than `limit` entries or about 256 KiB.
   */
  async readTranscript(since = 0, limit = TRANSCRIPT_DEFAULT_LIMIT, base?: number): Promise<TranscriptPage> {
    const info = this.load();
    // A cursor from another base would skip or repeat entries: start the new base from the top.
    const reset = base !== undefined && base !== info.base_gen && since > 0;
    if (reset) since = 0;
    const page = (lines: string[], next_seq: number, more: boolean): TranscriptPage =>
      ({ lines, next_seq, more, base: info.base_gen, ...(reset ? { reset } : {}) });
    const max = Math.max(1, Math.min(limit, TRANSCRIPT_MAX_LIMIT));
    const rows = this.sql
      .exec<{ key: string }>("SELECT key FROM segments WHERE base = ? AND offset < ? ORDER BY offset", info.base_gen, info.durable_bytes)
      .toArray();
    const decoder = new TextDecoder();
    const lines: string[] = [];
    let carry = "";
    let n = 0;
    let bytes = 0;
    const take = (line: string): boolean => {
      if (!line) return false;
      n += 1;
      if (n <= since) return false;
      lines.push(line);
      bytes += line.length;
      return lines.length >= max || bytes >= TRANSCRIPT_MAX_BYTES;
    };
    for (const r of rows) {
      const obj = await this.env.BUCKET.get(r.key);
      if (!obj) continue;
      const parts = (carry + decoder.decode(new Uint8Array(await obj.arrayBuffer()), { stream: true })).split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) if (take(p)) return page(lines, n, true);
    }
    take(carry + decoder.decode());
    return page(lines, lines.length ? n : since, false);
  }

  // --- events ---------------------------------------------------------------------------------------

  private async onEvents(ws: WebSocket, att: Attachment, seq: number, events: AgentEvent[]): Promise<void> {
    if (!this.current(att)) return;
    if (this.inOrder(seq) === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      return;
    }
    for (const ev of events) {
      // Rule 1 after every await: a brain condemned mid-batch applies nothing more, unacked.
      if (!this.current(ws.deserializeAttachment() as Attachment)) return;
      await this.applyEvent(ev, att.epoch);
      await this.hook("event:afterApply");
    }
    if (!this.current(ws.deserializeAttachment() as Attachment)) return;
    this.rel.markProcessed(CHAN, seq);
    this.send(ws, { type: "ack", up_to: seq });
  }

  private async applyEvent(ev: AgentEvent, sessionEpoch: number): Promise<void> {
    const before = this.load();
    // A cheap guard against a runner stamping another epoch than its session's.
    if (ev.agent !== before.agent || ev.epoch !== sessionEpoch) return;
    // Recorded as seen only after its side effects, each safe to repeat, succeeded: a throw leaves the batch unacked.
    if (this.sql.exec("SELECT 1 FROM events WHERE seq = ?", ev.seq).toArray().length) return;
    const completed = ev.type === "turn_completed" && !!ev.turn && ev.turn === before.current_turn;
    // A turn's trailing `idle` may arrive while the next turn runs: an event stamped with another turn changes no state.
    const stale = !!ev.turn && ev.turn !== before.current_turn;
    const info = this.update((i) => {
      switch (ev.type) {
        case "turn_started":
          if (!stale) i.activity = "working";
          break;
        case "state_changed":
          if (!stale) i.activity = ev.state;
          break;
        case "rate_limited":
          i.activity = "quota_parked";
          break;
        case "capabilities":
          i.capabilities = ev.capabilities;
          break;
        case "turn_completed":
          if (completed) {
            this.queue.complete(ev.turn!);
            i.current_turn = null;
            i.activity = "idle";
            i.exit_restarts = 0;
          }
          break;
      }
    });
    this.reportEvent(info, ev, completed, stale);
    // The emptied mirror goes before any later `run_turn` (one may start while this awaits): a requeued
    // message must not be shown again from the runner's old cache.
    if (completed) this.pushCache();
    if (ev.type === "rate_limited") {
      await this.workstream(info.workstream).ingest({
        workstream: info.workstream, ts_ms: ev.ts_ms, agent: info.agent, type: "quota_parked",
        ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
      }, `${info.agent}/${info.runner_instance ?? ""}/ev${ev.seq}`);
    } else if (ev.type === "inbox_delivered") {
      if (this.queue.confirm(ev.message)) this.pushCache();
    } else if (ev.type === "escalation") {
      // The runner denied the call as pending approval: an async ask, answered as the next turn.
      const input = JSON.stringify(ev.input ?? null);
      const question = `Allow ${ev.tool}? (request ${ev.call}) input: ${input.length > 500 ? `${input.slice(0, 500)}…` : input}`;
      await this.postAsk(info, ev.call, ev.epoch, question, "async", "escalation");
    }
    await this.syncActivity();
    if (completed) {
      // An ephemeral agent whose turn ended with nothing waiting is done (docs/agents/#lifetimes).
      const now = this.load();
      const liveChildren = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM children WHERE ended = 0").one().n;
      if (ephemeralDone({
        ephemeral: !!now.ephemeral, ended: !!now.ended, current: now.current_turn !== null, queued: this.queue.hasQueued(), openAsks: this.calls.openAsks(), liveChildren,
      })) {
        await this.endAgent({ by: now.agent, reason: "done", kill: false, destroy_sandbox: true });
      } else if (now.ended) {
        // A graceful end waited for this turn.
        await this.endBrain();
      }
      await this.pump();
    }
    this.sql.exec("INSERT OR IGNORE INTO events (seq, body) VALUES (?, ?)", ev.seq, JSON.stringify(ev));
    this.sql.exec("DELETE FROM events WHERE seq < ?", ev.seq - 500);
  }

  // ---------------------------------------------------------------------------------------------
  // Turns, inbox, interrupt, caches
  // ---------------------------------------------------------------------------------------------

  /** Queue a turn, once per `requestId`. */
  async enqueueTurn(input: TurnInput, requestId?: string, tainted = false, external = true): Promise<string> {
    const info = this.load(); // an agent never created (a subscriber id naming nobody) is refused
    const prior = requestId ? this.queue.turnFor(requestId) : undefined;
    if (prior) return prior;
    this.refuseEnded(info, "turns");
    const turn = this.queue.enqueue(input, requestId);
    if (tainted) this.kvPut("read_tainted", true);
    if (external) this.inputArrived();
    await this.pump();
    await this.wake();
    return turn;
  }

  /** Send the next queued turn when the runner is connected and no turn is running. */
  private async pump(): Promise<void> {
    if (!this.socket() || this.load().current_turn) return;
    const next = this.queue.claimNext();
    if (!next) return;
    const info = this.update((i) => {
      i.current_turn = next.turn;
      i.activity = "working";
    });
    const { turn, recovers } = next;
    const continued = recovers ? this.queue.startOf(recovers) : undefined;
    let epoch: number | null = null;
    if (info.hands) {
      try {
        epoch = (await this.sandboxStub(info.hands.sandbox).info()).epoch;
      } catch (e) {
        console.warn(`agent ${info.agent}: reading the sandbox epoch at turn start failed`, e);
      }
    }
    const due = !!info.hands && moveNoteDue({ epoch, told: info.told_sandbox_epoch, continued, movedMs: info.hands_moved_ms });
    const note = due ? await this.movedNote(info) : null;
    await this.hook("pump:beforeSend");
    // Re-checked: a new runner process may have recovered this turn meanwhile (its work would run twice).
    if (this.load().current_turn !== turn) return;
    if (epoch !== null) {
      const e = epoch;
      // Only forward: a move notice sent during the awaits above told the brain of a newer epoch.
      this.update((i) => {
        i.told_sandbox_epoch = Math.max(i.told_sandbox_epoch ?? e, e);
      });
      this.queue.recordHandsEpoch(turn, e);
    }
    const input: TurnInput = note ? { ...next.input, text: `${note}\n\n${next.input.text}` } : next.input;
    this.pushReliable((seq) => ({ type: "run_turn", seq, turn, input }));
    await this.syncActivity();
  }

  async turns(): Promise<{ turn: string; status: TurnStatus; input: TurnInput }[]> {
    return this.queue.list();
  }

  /**
   * Mid-turn: pushed to the runner and its hook cache (unconfirmed, it comes back as a turn:
   * `TurnQueue.complete`); between turns, the next turn. Once per `requestId`.
   */
  async postInbox(from: string, text: string, interrupt = false, requestId?: string, tainted = false): Promise<string> {
    const prior = requestId ? this.queue.messageFor(requestId) : undefined;
    if (prior) return prior;
    const info = this.load();
    if (info.ended) {
      // The platform's own notes about its work (a task's exit, a move) have nobody to tell any more.
      if (from === SYSTEM_SENDER) return "";
      this.refuseEnded(info, "messages");
    }
    const message: InboxMessage = { id: newId("msg_"), from, text, interrupt, ts_ms: Date.now() };
    // Another agent's text reaches the model inline: when it may be tainted, so is the session.
    if (tainted) this.kvPut("read_tainted", true);
    const external = from !== SYSTEM_SENDER;
    if (external) this.inputArrived();
    if (info.current_turn) {
      this.queue.mirror(message, info.current_turn, requestId);
      this.pushReliable((seq) => ({ type: "inbox", seq, message }));
      this.pushCache();
    } else {
      this.queue.recordAsTurn(message, requestId);
      await this.enqueueTurn({ kind: "inbox", text: inboxTurnText(message) }, requestId && `inbox/${requestId}`, false, external);
    }
    return message.id;
  }

  async interrupt(): Promise<void> {
    const turn = this.load().current_turn;
    this.pushReliable((seq) => ({ type: "interrupt", seq, ...(turn ? { turn } : {}) }));
  }

  async setRules(rules: ToolRule[]): Promise<void> {
    this.update((i) => {
      i.rules = rules;
    });
    this.pushCache();
  }

  private currentCache(info: AgentInfo): AgentCache {
    return { version: info.cache_version, rules: info.rules, inbox: this.queue.mirrored(), max_stop_continuations: 5 };
  }

  /** Replace the runner's hook caches (rules + inbox mirror); the version only ever grows. */
  private pushCache(): void {
    const info = this.update((i) => {
      i.cache_version += 1;
    });
    const cache = this.currentCache(info);
    this.pushReliable((seq) => ({ type: "cache_update", seq, cache }));
  }

  // ---------------------------------------------------------------------------------------------
  // Channels (docs/channels/): deliveries in, as any other input, and `<agt>/events` out.
  // ---------------------------------------------------------------------------------------------

  private kvGet<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private kvPut(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  /** The session's taint as far as it is tracked (`sessionTaint`). */
  private tainted(info: AgentInfo): boolean {
    return sessionTaint({ hands: !!info.hands, builtin_tools: info.launch.builtin_tools, read_tainted: this.kvGet<boolean>("read_tainted") ?? false });
  }

  /**
   * Its mcp capabilities' tools (each server's cached `tools/list`, filtered by the allowlist). A server
   * that can't be listed contributes nothing this time. An untrusted server's descriptions and schemas
   * are its text in the model's context, so handing them out taints the session.
   */
  private async mcpToolDefs(info: AgentInfo): Promise<ToolDef[]> {
    const lists = await Promise.all((info.mcp ?? []).map(async (g) => ({ g, listed: await this.mcp.list(g, true).catch(() => null) })));
    const out: ToolDef[] = [];
    for (const { g, listed } of lists) {
      const defs = listed ? mcpToolDefs(g, listed, [...PLATFORM_TOOL_NAMES, ...BROKERED_TOOL_NAMES]) : [];
      if (defs.length && !g.trusted) this.kvPut("read_tainted", true);
      out.push(...defs);
    }
    return out;
  }

  /**
   * A connector's notice (docs/agents/capabilities/mcp/#list_changed): the tool list of a server this
   * agent's brain was handed changed (`changed`), or a probe (`!changed`) asking whether it still wants
   * notices. Answers whether it does: it has a brain and that server is still in its spec. Synchronous
   * (the connector awaits this from its alarm): it records the change and tells the runner, which has
   * Claude Code list again; it never calls the connector back.
   */
  async mcpToolsChanged(server: Pick<McpGrant, "url" | "auth">, changed: boolean): Promise<boolean> {
    if (!this.exists()) return false;
    const info = this.load();
    if (!info.brain || !(info.mcp ?? []).some((g) => g.url === server.url && g.auth === server.auth)) return false;
    if (changed) {
      this.kvPut("mcp_changed_ms", Date.now());
      const ws = this.socket();
      if (ws) this.sendToolsChanged(ws);
    }
    return true;
  }

  /** Whether the current brain listed its tools before the last change it was told of (or should have been). */
  private toolsOwed(info: AgentInfo): boolean {
    const listed = this.kvGet<ToolsListed>("tools_listed");
    if (!listed || listed.epoch !== info.agent_epoch) return false; // this brain hasn't listed yet: its first list is current
    return (this.kvGet<number>("mcp_changed_ms") ?? 0) >= listed.ms;
  }

  /** `tools_changed`, to a runner that said it acts on it (an older one lists again at its next start). */
  private sendToolsChanged(ws: WebSocket): void {
    if ((ws.deserializeAttachment() as Attachment).tools_changed) this.send(ws, { type: "tools_changed" });
  }

  /** This agent as a channel caller, from its own record, never from a tool's arguments. */
  private channelCaller(info: AgentInfo): Caller {
    return { principal: info.agent, owner: info.owner, sandbox: info.hands?.sandbox ?? null, grants: info.channel_grants, tainted: this.tainted(info) };
  }

  /** For an agent's built-in channel, that agent's owner and whether it reads (for `{child}` grants and a spawner's read). */
  private async channelFacts(info: AgentInfo, channel: string): Promise<{ agent_owner?: string | null; target_reads?: boolean }> {
    const k = parseChannel(channel);
    if (!k.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, k.error);
    if (k.value.kind !== "inbox" && k.value.kind !== "events") return {};
    if (k.value.agent === info.agent) return { agent_owner: info.owner, target_reads: info.tools.includes("read") };
    const other = await this.env.AGENT.get(this.env.AGENT.idFromName(k.value.agent)).info();
    return { agent_owner: other.owner, target_reads: other.tools.includes("read") };
  }

  private channelStub(name: string) {
    return this.env.CHANNEL.get(this.env.CHANNEL.idFromName(name));
  }

  /** Queue a post on `<agt>/events` (synchronous; posted from the alarm). Model text carries the session's taint. */
  private report(info: AgentInfo, post: PostInput, tainted = false): void {
    this.outbox.push(`${info.agent}/events`, post, { tainted, agent_owner: info.owner });
  }

  /** A runner event's report, idempotent per lineage and event. A finished turn's state change (`stale`) changed nothing. */
  private reportEvent(info: AgentInfo, ev: AgentEvent, completed: boolean, stale: boolean): void {
    const idem_key = `${info.agent}/ev/${info.runner_instance ?? ""}/${ev.seq}`;
    if (ev.type === "assistant_text") {
      this.kvPut("last_text", clip(ev.text, EVENT_TEXT_BYTES));
    } else if (ev.type === "turn_started") {
      // A turn without text of its own never reports the previous turn's.
      this.kvPut("last_text", "");
    } else if (ev.type === "state_changed" && !stale) {
      this.report(info, { kind: "state_changed", text: `state: ${ev.state}`, data: { state: ev.state, epoch: ev.epoch }, idem_key });
    } else if (ev.type === "turn_completed" && completed) {
      this.report(info, {
        kind: "turn_completed", text: this.kvGet<string>("last_text") || `turn ${ev.turn} completed (${ev.stop_reason})`,
        data: { turn: ev.turn, stop_reason: ev.stop_reason, ...(ev.usage ? { usage: ev.usage } : {}) }, idem_key,
      }, this.tainted(info));
    } else if (ev.type === "escalation") {
      this.report(info, { kind: "escalation", text: `asked to approve ${ev.tool} (request ${ev.call})`, idem_key });
    } else if (ev.type === "rate_limited") {
      this.report(info, { kind: "quota_parked", text: "parked by a rate limit", idem_key });
    }
  }

  /**
   * A brain release's report: `exited` (with the last text) when the agent stopped (nothing restarts
   * and no start is wanted); else `brain_released`, housekeeping outside the spawner's default filter.
   */
  private reportExit(info: AgentInfo, host: string, epoch: number, reason: AgentExitReason, ends: boolean): void {
    const idem_key = `${info.agent}/exit/${host}/${epoch}`;
    if (ends && !info.intent) {
      const ended = info.ended ? { ended: info.ended.reason, by: info.ended.by } : {};
      this.report(info, { kind: "exited", text: this.kvGet<string>("last_text") || `stopped (${reason})`, data: { reason, epoch, host, ...ended }, idem_key },
        this.tainted(info));
    } else {
      this.report(info, { kind: "brain_released", text: `brain released (${reason})`, data: { reason, epoch, host }, idem_key });
    }
  }

  /** Whether `owner`'s spec has the `read` tool (its spec is fixed at spawn, so the answer is kept). */
  private async ownerReads(owner: string): Promise<boolean> {
    // A no is kept only for `OWNER_READS_NO_MS`, so a later grant of `read` (stage 2) is seen.
    const cached = this.kvGet<{ owner: string; reads: boolean; ms?: number }>("owner_reads");
    if (cached?.owner === owner && (cached.reads || Date.now() - (cached.ms ?? 0) < OWNER_READS_NO_MS)) return cached.reads;
    let reads = false;
    try {
      reads = (await this.env.AGENT.get(this.env.AGENT.idFromName(owner)).info()).tools.includes("read");
    } catch (e) {
      // An owner that isn't an agent can't read anything; anything else is retried with the row.
      if (asNestError(e)?.code !== ErrorCodes.UNKNOWN_AGENT) throw e;
    }
    this.kvPut("owner_reads", { owner, reads, ms: Date.now() });
    return reads;
  }

  /**
   * A ChannelDO delivers one subscription's batch (at least once, the same range on every retry),
   * deduplicated by the high-water seq and admitted as a notice (`admitDelivery`). The high-water
   * mark and the turn or inbox row are written in one synchronous step.
   */
  async deliverChannel(d: ChannelDelivery): Promise<DeliveryOutcome> {
    const now = Date.now();
    const info = this.load();
    // Ended for good: no longer a subscriber, so ChannelDO drops the subscription (as for an id naming nobody).
    if (info.ended) throw new NestError(ErrorCodes.UNKNOWN_AGENT, `${info.agent} has ended; its subscriptions end with it`, 404);
    const reads = info.tools.includes("read");
    const { up_to: upTo, shown, skipped } = takeBatch(d, reads);
    const ack: DeliveryOutcome = upTo < d.batch.to_seq ? { status: "ok", up_to: upTo } : { status: "ok" };
    // Deduplicated first: a retry of a batch already taken is acknowledged whatever the guards say.
    const hw = this.sql.exec<{ hw: number }>("SELECT hw FROM channel_subs WHERE channel = ? AND sub = ?", d.channel, d.subscription).toArray()[0]?.hw;
    if (hw !== undefined && hw >= upTo) return ack;
    const take = () => {
      this.sql.exec(`INSERT INTO channel_subs (channel, sub, hw, created_ms, ended, skipped, skipped_to) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, sub) DO UPDATE SET hw = excluded.hw, ended = excluded.ended, skipped = skipped + excluded.skipped,
          skipped_to = COALESCE(excluded.skipped_to, skipped_to)`,
      d.channel, d.subscription, upTo, now, d.batch.ends && upTo >= d.batch.to_seq ? 1 : 0, skipped ? 1 : 0, skipped ? upTo : null);
    };
    if (!shown.batch.inline.length && !reads) {
      take();
      return ack;
    }
    const text = envelopeText(shown, now, this.queue.lastTurnMs(), reads);
    const requestId = channelRequestId(d.channel, d.subscription, upTo);
    const admit = admitDelivery({
      midTurnInbox: !!info.current_turn && d.channel === `${info.agent}/inbox`,
      load: this.queue.load(now), waiting: this.queue.waitingChannelTurn(), text, now,
    });
    if (admit.kind === "defer") return { status: "defer", retry_after_ms: admit.retry_after_ms };
    // Each admits before its first await; a merge or a queued turn wakes the agent as any input does (Q1/Q6).
    take();
    if (admit.kind === "join") {
      await this.postInbox("platform", text, false, requestId);
    } else if (admit.kind === "merge") {
      this.queue.merge(admit.turn, admit.input, now);
      this.inputArrived();
      await this.wake();
    } else {
      await this.enqueueTurn({ kind: "event_batch", text }, requestId);
    }
    return ack;
  }

  /** This agent's channel subscriptions (display). */
  async channelSubscriptions(): Promise<{ channel: string; subscription: string; hw: number; ended: boolean; skipped: number; skipped_to: number | null }[]> {
    return this.sql.exec<{ channel: string; sub: string; hw: number; ended: number; skipped: number; skipped_to: number | null }>(
      "SELECT channel, sub, hw, ended, skipped, skipped_to FROM channel_subs ORDER BY created_ms")
      .toArray().map((r) => ({ channel: r.channel, subscription: r.sub, hw: r.hw, ended: r.ended === 1, skipped: r.skipped, skipped_to: r.skipped_to }));
  }

  /** The channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`, `message`). */
  private async channelTool(info: AgentInfo, name: string, a: Record<string, unknown>, key: string, live: () => Promise<void>): Promise<ToolOutcome> {
    const json = (text: string, value: unknown): ToolOutcome => ({ status: "ok", content: [{ type: "text", text }, { type: "json", value }] });
    const caller = this.channelCaller(info);
    if (name === "message") {
      const target = String(a.agent);
      if (!/^agt_[a-z0-9]+$/.test(target)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "agent must be an agent id (agt_...)");
      if (target === info.agent) throw new NestError(ErrorCodes.INVALID_MESSAGE, "that is you");
      const channel = `${target}/inbox`;
      const { target_reads, ...facts } = await this.channelFacts(info, channel);
      // A message only reaches an agent that can `read` it: refused rather than posted unseen.
      if (target_reads === false) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE,
          `${target} can't read channel messages (its template has no \`read\`): nothing was posted; reach it another way (e.g. notify)`);
      }
      const post: PostInput = {
        text: String(a.text), ...(typeof a.kind === "string" ? { kind: a.kind } : {}), ...(typeof a.reply_to === "number" ? { reply_to: a.reply_to } : {}),
        idem_key: key,
      };
      await live();
      const r = await this.channelStub(channel).post(channel, this.channelCaller(this.load()), post, facts);
      if (r.status === "conflict") throw new NestError(ErrorCodes.INVALID_MESSAGE, "unexpected conflict");
      return json(`Delivered to ${target} (seq ${r.seq}).`, r);
    }
    const channel = String(a.channel);
    const { target_reads: _reads, ...facts } = await this.channelFacts(info, channel);
    const stub = this.channelStub(channel);
    switch (name) {
      case "channel_create": {
        await live();
        const r = await stub.create(channel, caller, typeof a.retention_days === "number" ? a.retention_days : undefined);
        return json(`Channel ${channel} is yours.`, r);
      }
      case "post": {
        const post: PostInput = {
          text: String(a.text),
          ...(typeof a.kind === "string" ? { kind: a.kind } : {}), ...(a.data !== undefined ? { data: a.data } : {}),
          ...(typeof a.reply_to === "number" ? { reply_to: a.reply_to } : {}), ...(typeof a.key === "string" ? { key: a.key } : {}),
          ...(typeof a.if_seq === "number" ? { if_seq: a.if_seq } : {}), ...(Array.isArray(a.mentions) ? { mentions: a.mentions as string[] } : {}),
          idem_key: key,
        };
        await live();
        // Taint is read now, after the awaits: a read that tainted the session meanwhile counts.
        const r = await stub.post(channel, this.channelCaller(this.load()), post, facts);
        if (r.status === "conflict") {
          throw new NestError(ErrorCodes.CONFLICT, `conflict: key ${r.key} is at seq ${r.current_seq}, not ${post.if_seq}; read it and try again`, 409);
        }
        return json(r.status === "repeat" ? `Not stored: identical to your previous message (seq ${r.seq}).` : `Posted (seq ${r.seq}).`, r);
      }
      case "read": {
        await live();
        // Typed here: RPC typing drops a result holding `unknown` (a message's `data`).
        const r = (await stub.read(channel, caller, {
          ...(typeof a.since === "number" ? { since: a.since } : {}), ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
          ...(a.latest_by_key === true ? { latest_by_key: true } : {}), ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}),
          ...(a.keys_only === true ? { keys_only: true } : {}), ...(typeof a.after_key === "string" ? { after_key: a.after_key } : {}),
          idem_key: key,
        }, facts)) as unknown as ReadResult;
        // Reading tainted content taints the session (sticky; docs/agents/tools/#taint-and-sinks).
        if (r.tainted) this.kvPut("read_tainted", true);
        const n = r.messages?.length ?? r.keys?.length ?? 0;
        return json(`${n} ${r.keys ? "keys" : "messages"} from ${channel} (head ${r.head})${r.more ? "; more remain" : ""}.`, r);
      }
      case "subscribe": {
        const filter = Filter.parse({
          ...(Array.isArray(a.kinds) ? { kinds: a.kinds } : {}), ...(Array.isArray(a.from) ? { from: a.from } : {}),
          ...(Array.isArray(a.keys) ? { keys: a.keys } : {}), ...(a.mentions_me === true ? { mentions_me: true } : {}),
          ...(typeof a.reply_to === "number" ? { reply_to: a.reply_to } : {}),
        });
        const input = SubscribeInput.safeParse({
          filter, ...(typeof a.delivery === "string" ? { delivery: a.delivery } : {}), ...(typeof a.batch_ms === "number" ? { batch_ms: a.batch_ms } : {}),
          ...(typeof a.once === "boolean" ? { once: a.once } : {}), idem_key: key,
        });
        if (!input.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, input.error.issues.map((i) => i.message).join("; "));
        await live();
        const s = await stub.subscribe(channel, caller, info.agent, input.data, facts);
        this.sql.exec("INSERT OR IGNORE INTO channel_subs (channel, sub, hw, created_ms) VALUES (?, ?, 0, ?)", channel, s.id, Date.now());
        return json(`Subscribed to ${channel} (${s.id}, from seq ${s.cursor}).`, { subscription: s.id, cursor: s.cursor, delivery: s.delivery });
      }
      case "unsubscribe": {
        await live();
        const r = await stub.unsubscribe(channel, caller, String(a.subscription));
        this.sql.exec("DELETE FROM channel_subs WHERE channel = ? AND sub = ?", channel, String(a.subscription));
        return json(r.removed ? "Unsubscribed." : "No such subscription.", r);
      }
      default:
        throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${name} is not implemented yet`, 501);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Platform tool relay
  // ---------------------------------------------------------------------------------------------

  /**
   * Marked processed only once the call ran (or waits for an ask), so one cut short by an eviction is
   * run again; its writes carry the key `<agent>/<epoch>/<call>`, so a re-run repeats no side effect.
   */
  private async onToolCall(ws: WebSocket, att: Attachment, call: Extract<RunnerToAgent, { type: "tool_call" }>): Promise<void> {
    const verdict = this.admitCallMessage(ws, att, call.seq);
    if (!verdict) return;
    const prior = this.calls.call(call.call);
    const epoch = prior?.epoch ?? att.epoch;
    const resend = () => {
      const outcome = prior?.outcome;
      if (outcome) this.pushReliable((seq) => ({ type: "tool_result", seq, call: call.call, outcome }));
    };
    if (verdict === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      resend();
      return;
    }
    if (prior?.outcome) {
      resend();
    } else if (prior?.status !== "waiting") {
      if (!prior) this.calls.begin(epoch, call.call, call.name);
      let result: DispatchResult;
      try {
        result = await this.dispatch(epoch, call.call, call.name, call.arguments, undefined, att.epoch);
      } catch (e) {
        const ne = asNestError(e);
        if (!ne) console.error(`AgentDO: tool ${call.name} failed`, e);
        result = { status: "error", error: ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, `${call.name} failed`, true) };
      }
      if (result === "wait") this.calls.wait(epoch, call.call);
      else this.finishCall(epoch, call.call, result);
    }
    this.rel.markProcessed(CHAN, call.seq);
    this.send(ws, { type: "ack", up_to: call.seq });
  }

  /** The runner gave up on a call (its outcome unknown to the model): `CallLedger.cancel`; no `tool_result`. */
  private onCancelCall(ws: WebSocket, att: Attachment, m: Extract<RunnerToAgent, { type: "cancel_call" }>): void {
    const verdict = this.admitCallMessage(ws, att, m.seq);
    if (!verdict) return;
    if (verdict === "process") {
      const outcome: ToolOutcome = { status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, `cancelled by the runner: ${m.reason}`) };
      const prior = this.calls.call(m.call);
      this.calls.cancel(prior?.epoch ?? att.epoch, m.call, outcome, prior);
      this.rel.markProcessed(CHAN, m.seq);
    }
    this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
  }

  /** A call message's admission: null for a stale (told) or non-current session; a gap throws. */
  private admitCallMessage(ws: WebSocket, att: Attachment, seq: number): "process" | "duplicate" | null {
    if (att.stale) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "stale epoch") });
      return null;
    }
    if (!this.current(att)) return null;
    return this.inOrder(seq);
  }

  /** A reliable runner message's place in order: new or a duplicate; a gap throws (the runner resends). */
  private inOrder(seq: number): "process" | "duplicate" {
    const verdict = this.rel.classify(CHAN, seq);
    if (verdict === "gap") {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `message ${seq} out of order; expected ${this.rel.lastIn(CHAN)! + 1}`, 400, true);
    }
    return verdict;
  }

  private finishCall(epoch: number, call: string, outcome: ToolOutcome): void {
    this.calls.finish(epoch, call, outcome);
    this.pushReliable((seq) => ({ type: "tool_result", seq, call, outcome }));
  }

  /**
   * `sandboxEpoch`: a guest CLI call's sandbox epoch, verified by FleetDO's lease check, which fences
   * it instead of the agent epoch (a brain start mid-call must not fail it).
   */
  private async dispatch(epoch: number, call: string, name: string, args: unknown, sandboxEpoch?: number, fence: number = epoch): Promise<DispatchResult> {
    const guest = sandboxEpoch !== undefined;
    const info = this.load();
    const def = toolDef(name);
    if (!def) {
      // A brokered action's own tool, when its spec grants that action; else a remote MCP tool.
      const action = actionOfTool(name);
      if (action && (info.brokered ?? []).some((g) => g.action === action)) return await this.brokeredTool(info, epoch, call, action, args, guest, fence);
      return await this.mcpTool(info, epoch, call, name, args, guest, fence);
    }
    if (!offered(info).includes(name)) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${name} is not granted to this agent`, 403);
    }
    // Spawning and ending need a brain: nothing inside a sandbox may ask for them.
    if (guest && LIFECYCLE_TOOLS.includes(name)) throw new NestError(ErrorCodes.FORBIDDEN, `${name} isn't callable from a sandbox`, 403);
    const a = validateArgs(def.input_schema, args);
    const text = (t: string): ToolOutcome => ({ status: "ok", content: [{ type: "text", text: t }] });
    // A guest call is keyed by the sandbox lease it was relayed under.
    const key = guest ? `${info.agent}/s${sandboxEpoch}/${call}` : `${info.agent}/${epoch}/${call}`;
    // A newer start or a condemn may land during any await: no write goes out for a brain that isn't current.
    const live = async () => {
      await this.hook("dispatch:beforeWrite");
      if (!guest) this.assertEpoch(fence);
    };

    if (ALL_TASK_TOOLS.includes(name)) return await this.taskTool(info, name, a, key, live);

    switch (name) {
      case "notify": {
        const to = String(a.to);
        const message = String(a.message);
        const target = to === "captain" ? await this.captainOf(info) : to;
        if (target === "user") {
          await live();
          await this.workstream(info.workstream).notifyUser(message, a.urgency === "high" ? "high" : "normal", key);
        } else {
          if (!target?.startsWith("agt_")) throw new NestError(ErrorCodes.INVALID_MESSAGE, `no recipient for ${to}`);
          const stub = this.env.AGENT.get(this.env.AGENT.idFromName(target));
          // Only within the workstream: a prompt-injected agent can't reach others.
          const other = await stub.info();
          if (other.workstream !== info.workstream) throw new NestError(ErrorCodes.FORBIDDEN, `${target} is in another workstream`, 403);
          await live();
          await stub.postInbox(`${info.template}:${info.agent}`, message, false, key, this.tainted(this.load()));
        }
        return text(`Delivered to ${to}.`);
      }
      case "emit": {
        const base = {
          workstream: info.workstream, ts_ms: Date.now(), agent: info.agent, ...(await this.sandboxFields(info, sandboxEpoch)),
        };
        const summary = String(a.summary);
        let event: WorkstreamEvent;
        switch (a.event) {
          case "progress": event = { ...base, type: "progress", summary }; break;
          case "blocked": event = { ...base, type: "blocked", reason: summary }; break;
          case "completed": event = { ...base, type: "completed", summary }; break;
          case "failed": event = { ...base, type: "failed", error: errorBody(ErrorCodes.INTERNAL, summary) }; break;
          case "pr_opened":
            if (typeof a.url !== "string") throw new NestError(ErrorCodes.INVALID_MESSAGE, "pr_opened needs url");
            event = { ...base, type: "pr_opened", url: a.url, title: typeof a.title === "string" ? a.title : summary };
            break;
          default: throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown event ${String(a.event)}`);
        }
        await live();
        await this.workstream(info.workstream).ingest(event, key);
        return text(`Recorded ${event.type}.`);
      }
      case "ask": {
        const question = String(a.question);
        const options = Array.isArray(a.options) ? (a.options as unknown[]).map(String) : [];
        const full = options.length ? `${question} (options: ${options.join(" | ")})` : question;
        await this.postAsk(info, call, epoch, full, "sync", a.to === "user" ? "user" : "escalation", sandboxEpoch, fence);
        return "wait";
      }
      case "read_transcript": {
        const target = String(a.agent);
        if (!/^agt_[a-z0-9]+$/.test(target)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${target} is not an agent id`);
        const since = typeof a.since_seq === "number" ? Math.max(0, a.since_seq) : 0;
        const limit = typeof a.limit === "number" ? a.limit : TRANSCRIPT_DEFAULT_LIMIT;
        const base = typeof a.base === "number" ? a.base : undefined;
        let page: TranscriptPage;
        if (target === info.agent) {
          page = await this.readTranscript(since, limit, base);
        } else {
          const stub = this.env.AGENT.get(this.env.AGENT.idFromName(target));
          const other = await stub.info();
          if (other.workstream !== info.workstream) throw new NestError(ErrorCodes.FORBIDDEN, "transcript is in another workstream", 403);
          page = await stub.readTranscript(since, limit, base);
          // Another agent's transcript (its taint unknown here): this session is tainted from now on.
          this.kvPut("read_tainted", true);
        }
        return {
          status: "ok",
          content: [
            { type: "text", text: page.lines.join("\n") },
            { type: "json", value: { entries: page.lines.length, next_seq: page.next_seq, more: page.more, base: page.base, ...(page.reset ? { reset: true } : {}) } },
          ],
        };
      }
      case "expose_port": {
        if (!info.hands) throw new NestError(ErrorCodes.NOT_BOUND, "agent has no sandbox", 409);
        if (a.share === true) {
          // A public link bypasses Cloudflare Access: agents can't mint one; an operator can.
          throw new NestError(ErrorCodes.FORBIDDEN, "public share links need operator approval; ask the user to share the port", 403);
        }
        await live();
        const r = await this.sandboxStub(info.hands.sandbox).exposePort(
          Number(a.port), false, a.host_header === "preserve" ? "preserve" : "localhost");
        return { status: "ok", content: [{ type: "text", text: r.url }, { type: "json", value: r }] };
      }
      case "channel_create":
      case "post":
      case "read":
      case "subscribe":
      case "unsubscribe":
      case "message":
        return await this.channelTool(info, name, a, key, live);
      case "agent_spawn":
        return await this.spawnTool(info, a, key, live);
      case "agent_stop": {
        const target = String(a.agent);
        if (!/^agt_[a-z0-9]+$/.test(target)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${target} is not an agent id`);
        const reason = typeof a.reason === "string" ? a.reason : undefined;
        if (target === info.agent) return await this.exitTool(info, a.destroy_sandbox === true, reason, live);
        // Ownership is transitive (the grant on an agent covers what it owns): the target's owner chain must reach the caller.
        if (!ownsVia(info.agent, await this.ownerChain(target))) throw new NestError(ErrorCodes.FORBIDDEN, `${target} isn't an agent you own`, 403);
        await live();
        const r = await this.agentStub(target).end({ by: info.agent, reason: "stopped", kill: true, destroy_sandbox: a.destroy_sandbox === true, ...(reason ? { note: reason } : {}) });
        return text(r.status === "already_stopped" ? `${target} had already ended (${r.ended.reason}).` : `${target} stopped${a.destroy_sandbox === true ? "; its sandbox is destroyed once its brain is gone, unless another agent is attached" : ""}.`);
      }
      case "exit":
        return await this.exitTool(info, a.destroy_sandbox === true, typeof a.reason === "string" ? a.reason : undefined, live);
      case "brokered":
        return await this.brokeredTool(info, epoch, call, String(a.action), a.args, guest, fence);
      case "egress_policy":
        return await this.egressTool(info, epoch, call, a, guest, fence, live);
      default:
        throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${name} is not implemented yet`, 501);
    }
  }

  /**
   * A remote tool (`<capability>_<tool>`) of one of its mcp capabilities, through the proxy
   * (docs/agents/capabilities/mcp/): only for a capability in its spec and a tool on its allowlist,
   * never from a sandbox. An untrusted server's answer taints the session.
   */
  private async mcpTool(info: AgentInfo, epoch: number, call: string, name: string, args: unknown, guest: boolean, fence: number): Promise<ToolOutcome> {
    const target = mcpTarget(info.mcp ?? [], name);
    if (!target) throw new NestError(ErrorCodes.UNKNOWN_TOOL, `unknown tool ${name}`);
    if (target === "forbidden") throw new NestError(ErrorCodes.FORBIDDEN, `${name} is not on its capability's allowlist`, 403);
    if (guest) throw new NestError(ErrorCodes.FORBIDDEN, "remote MCP tools aren't callable from a sandbox", 403);
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "arguments must be an object");
    const key = `${info.agent}/${epoch}/${call}`;
    if (!this.mcp.forwarded(key)
      && needsApproval(target.grant, target.tool, await this.mcp.listed(target.grant, target.tool), this.tainted(this.load()))) {
      const held = await this.sinkGate(info, epoch, call, key, { name, tool: `${NEST_TOOL_PREFIX}${name}`, what: `${name} to ${new URL(target.grant.url).host}`, args }, fence);
      if (held) return held;
    }
    const r = await this.mcp.call(target.grant, target.tool, args as Record<string, unknown>, {
      agent: info.agent, epoch, key,
      live: async () => {
        await this.hook("dispatch:beforeWrite");
        this.assertEpoch(fence);
      },
      tainted: () => this.tainted(this.load()),
    });
    if (r.from_server && !target.grant.trusted) this.kvPut("read_tainted", true);
    return r.outcome;
  }

  /**
   * The sink gate (lib/sinks.ts) for a call `gated` holds: an unexpired approval of exactly this call
   * lets it through (spent on `key`, before the call's own awaits: a call fenced before it leaves
   * wastes its approval); otherwise the operator is asked and the call answers `pending`.
   */
  private async sinkGate(info: AgentInfo, epoch: number, call: string, key: string, s: SinkCall, fence: number): Promise<ToolOutcome | null> {
    const digest = await argsDigest(s.args);
    if (this.calls.takeApproval(s.name, digest, key, Date.now())) return null;
    return await this.askApproval(info, epoch, call, s, digest, fence);
  }

  /**
   * A sink call from a tainted session (docs/agents/tools/#taint-and-sinks): it isn't sent; the operator
   * is asked, once per exact call, and the decision comes as a turn. An approval lets one call with the
   * same sink and arguments through within `APPROVAL_TTL_MS`.
   */
  private async askApproval(info: AgentInfo, epoch: number, call: string, s: SinkCall, digest: string, fence: number): Promise<ToolOutcome> {
    const pending = this.calls.pendingApproval(s.name, digest);
    let ask = pending?.ask;
    if (!ask) {
      const json = JSON.stringify(s.args);
      const shown = json.length > APPROVAL_ARGS_SHOWN ? `${json.slice(0, APPROVAL_ARGS_SHOWN)}… (${json.length} bytes in all)` : json;
      const question = `Approve ${s.what} from a tainted session? arguments: ${shown} (options: approve | deny)`;
      ask = await this.postAsk(info, call, epoch, question, "async", "escalation", undefined, fence, { name: s.name, digest, tool: s.tool });
    }
    return {
      status: "pending", ask,
      message: `Not sent: ${s.tool} from a tainted session needs the operator's approval (${ask}). End your turn; the decision arrives as your next input.`,
    };
  }

  // Brokered actions and egress widening (docs/agents/tools/#taint-and-sinks)
  // ---------------------------------------------------------------------------------------------

  private broker() {
    return this.env.BROKER.get(this.env.BROKER.idFromName("broker"));
  }

  /**
   * A brokered action, through the pipeline: the grant (an action its spec's capabilities give, for the
   * repo or profile asked for) → the hourly cap → the secret scan → the sink gate → the current
   * external state → the request under the action's natural idempotency key → the journal. Never from
   * a sandbox. A redelivered call key skips the checks it passed already and reads the provider first.
   */
  private async brokeredTool(info: AgentInfo, epoch: number, call: string, action: string, args: unknown, guest: boolean, fence: number): Promise<ToolOutcome> {
    if (guest) throw new NestError(ErrorCodes.FORBIDDEN, "brokered actions aren't callable from a sandbox", 403);
    const def = actionDef(action);
    if (!def) throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown brokered action ${action}`);
    if (def.kind === "none") throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${action} is not implemented: no provider is configured`, 501);
    const a = validateArgs(def.input_schema, args);
    const auth = authorize(info.brokered ?? [], action as BrokeredAction, a);
    if (!auth.ok) throw new NestError(ErrorCodes.FORBIDDEN, auth.error, 403);
    const key = `${info.agent}/${epoch}/${call}`;
    const prior = this.journal.get(key);
    if (prior?.outcome) return prior.outcome;
    // Refused before: the same refusal (the journal's detail names stored secrets, which the model isn't told).
    if (prior?.status === "refused") throw secretRefusal("a credential");
    const kd = await keyDigest(key);
    const row: JournalRow = {
      key, action, target: auth.value.target, idem: naturalKey(action as BrokeredAction, a, kd), digest: await argsDigest(a),
      args: JSON.stringify(a), tainted: this.tainted(this.load()),
    };
    if (!prior) {
      const since = Date.now() - 3_600_000;
      if (this.journal.sentSince(action, since) >= auth.value.per_hour) {
        const frees = (this.journal.oldestSince(action, since) ?? Date.now()) + 3_600_000;
        throw new NestError(ErrorCodes.RATE_LIMITED, `${action}: at most ${auth.value.per_hour} an hour for this agent; the next one is free at ${iso(frees)}`, 429, true);
      }
      const strings = stringsOf(a);
      const kinds = secretKinds(strings);
      const names = await this.broker().scanSecrets(strings);
      if (kinds.length || names.length) {
        // The journal names what matched (for the operator); the model is told only the kind.
        const why = [...kinds, ...names.map((n) => `the value of ${n}`)].join(", ");
        this.journal.refuse(row, why);
        throw secretRefusal(kinds.length ? kinds.join(", ") : "a credential nest holds");
      }
      // A fork widens the push allowlist: the operator approves it from any session, tainted or not.
      if (def.kind === "github_user" || gated({ sink: auth.value.sink, when_tainted: auth.value.when_tainted, tainted: this.tainted(this.load()) })) {
        const held = await this.sinkGate(info, epoch, call, key, {
          name: action, tool: `${NEST_TOOL_PREFIX}${def.tool}`, what: `${action} on ${auth.value.target}`, args: a,
        }, fence);
        if (held) return held;
      }
    }
    const live = async () => {
      await this.hook("dispatch:beforeWrite");
      this.assertEpoch(fence);
    };
    if (def.kind === "github_user") return await this.runFork(info, auth.value, row, live);
    return def.kind === "github"
      ? await this.runGithub(info, action as GithubAction, a, auth.value, row, kd, !!prior, live)
      : await this.runHttp(a, auth.value, row, kd, !!prior, live);
  }

  /**
   * `github.fork` (docs/agents/capabilities/brokered/#forks): forks a public upstream into the operator's
   * account with their own token (`github_user`; the App can't fork from an account it isn't installed
   * on), then adds the fork to its sandbox's push allowlist while it is attached. The upstream pull
   * request is the operator's: the result carries the compare link. GitHub answers an existing fork
   * for a repeated request (unverified), so a lost answer or a redelivery asks again.
   */
  private async runFork(info: AgentInfo, auth: Authorized, row: JournalRow, live: () => Promise<void>): Promise<ToolOutcome> {
    const upstream = auth.target;
    if (!Repo.safeParse(upstream).success) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${upstream} isn't owner/name`);
    const token = await this.broker().githubUserToken();
    const api = githubApiOf(this.env, num(this.env.BROKERED_TIMEOUT_MS, 30_000));
    let r: Awaited<ReturnType<typeof api.request>> = { kind: "lost", why: "not sent" };
    for (let attempt = 1; attempt <= 2 && r.kind !== "ok" && !(r.kind === "refused"); attempt++) {
      await live();
      this.journal.sending(row);
      r = await api.request(token, "POST", `/repos/${upstream}/forks`, { default_branch_only: true });
    }
    if (r.kind !== "ok") {
      if (r.kind === "lost") return this.unknownOutcome(row, `github.fork ${upstream}: ${r.why}`);
      const e = ghError(r, "github.fork");
      const outcome: ToolOutcome = { status: "error", error: e.body() };
      this.journal.settle(row, "failed", outcome, e.detail);
      return outcome;
    }
    const j = (r.json ?? {}) as { full_name?: unknown; html_url?: unknown; default_branch?: unknown; parent?: { default_branch?: unknown } };
    const fork = typeof j.full_name === "string" && Repo.safeParse(j.full_name).success ? j.full_name.toLowerCase() : null;
    if (!fork || typeof j.html_url !== "string") return this.unknownOutcome(row, `github.fork ${upstream}: GitHub answered HTTP ${r.status} without the fork`);
    if (info.hands) await this.sandboxStub(info.hands.sandbox).allowAgentRepos(info.agent, [fork]);
    const base = typeof j.parent?.default_branch === "string" ? j.parent.default_branch : typeof j.default_branch === "string" ? j.default_branch : "main";
    const [fo, fn] = fork.split("/");
    const value = { fork, url: j.html_url, compare: `https://github.com/${upstream}/compare/${encodeURIComponent(base)}...${fo}:${fn}:<branch>`, push_allowed: !!info.hands };
    const outcome: ToolOutcome = {
      status: "ok", content: [{ type: "text", text: `Forked ${upstream} to ${fork}${info.hands ? "; it's on your sandbox's push allowlist" : ""}.` }, { type: "json", value }],
    };
    this.journal.settle(row, "done", outcome, fork);
    return outcome;
  }

  /** A `github.*` action with an installation token narrowed to its repo and permissions (BrokerDO). */
  private async runGithub(
    info: AgentInfo, action: GithubAction, a: Record<string, unknown>, auth: Authorized, row: JournalRow, kd: string, redelivered: boolean,
    live: () => Promise<void>,
  ): Promise<ToolOutcome> {
    const { token } = await this.broker().githubToken(auth.target, BROKERED_ACTIONS[action].permissions, { agent: info.agent, call: row.key });
    const api = githubApiOf(this.env, num(this.env.BROKERED_TIMEOUT_MS, 30_000));
    const made = (m: GhMade): ToolOutcome => {
      const what = m.existing ? `Already open: ${m.url}` : `Done: ${m.url}`;
      const outcome: ToolOutcome = { status: "ok", content: [{ type: "text", text: what }, { type: "json", value: m }] };
      this.journal.settle(row, "done", outcome, JSON.stringify(m));
      return outcome;
    };
    const look = async (): Promise<GhMade | null | "unreadable"> => {
      const r = await api.request(token, "GET", stateQuery(action, a));
      return r.kind === "ok" ? foundInState(action, r.json, kd) : "unreadable";
    };
    // The current external state: a pull request from the same head to the same base, or what an
    // earlier attempt of this very call posted (its marker).
    if (action === "github.create_pr" || redelivered) {
      const found = await look();
      if (found && found !== "unreadable") return made(found);
      if (found === "unreadable" && redelivered) return this.unknownOutcome(row, `${action}: an earlier attempt's result couldn't be checked on GitHub`);
    }
    const req = actionRequest(action, a, kd);
    await live();
    this.journal.sending(row);
    const r = await api.request(token, req.method, req.path, req.body);
    if (r.kind === "ok") {
      const m = createdOf(r.json);
      if (m) return made(m);
      return this.unknownOutcome(row, `${action}: GitHub answered HTTP ${r.status} without the created resource`);
    }
    if (r.kind === "lost" || (r.kind === "refused" && r.status === 422 && action === "github.create_pr")) {
      // Lost: it may have been made. 422 on a pull request: often one from that head to that base already exists.
      const found = await look();
      if (found && found !== "unreadable") return made(found);
      if (r.kind === "lost") return this.unknownOutcome(row, `${action}: ${r.why}`);
    }
    const e = ghError(r, action);
    const outcome: ToolOutcome = { status: "error", error: e.body() };
    this.journal.settle(row, "failed", outcome, e.detail);
    return outcome;
  }

  private unknownOutcome(row: JournalRow, why: string): ToolOutcome {
    const outcome: ToolOutcome = {
      status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, `${why}; it may or may not have taken effect. Check before calling again.`),
    };
    this.journal.settle(row, "unknown", outcome, why);
    return outcome;
  }

  /**
   * `http.request` through an operator's profile: the base URL, methods and paths it allows, its
   * credential attached here. Redirects aren't followed (the credential never goes elsewhere), and a
   * reflected credential is masked. A lost answer is retried once for an idempotent method (or a
   * profile with an idempotency header). Its answer taints unless the profile is trusted.
   */
  private async runHttp(a: Record<string, unknown>, auth: Authorized, row: JournalRow, kd: string, redelivered: boolean, live: () => Promise<void>): Promise<ToolOutcome> {
    const g = auth.profile!;
    // Checked again at each use, as when the capability was written.
    const base = checkBaseUrl(g.base_url, this.env.ALLOW_LOOPBACK_BROKERED === "1");
    if (!base.ok) throw new NestError(ErrorCodes.FORBIDDEN, `profile ${g.profile}: ${base.error}`, 403);
    const method = String(a.method);
    const body = typeof a.body === "string" ? a.body : undefined;
    if (body !== undefined && (method === "GET" || method === "HEAD")) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${method} takes no body`);
    if (body !== undefined && body.length > HTTP_BODY_MAX) throw new NestError(ErrorCodes.INVALID_MESSAGE, `body is over ${HTTP_BODY_MAX} bytes`);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries((a.query ?? {}) as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof v)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `query.${k} must be a string, number or boolean`);
      query.append(k, String(v));
    }
    const secret = g.auth ? await this.broker().brokeredSecret(g.auth.secret) : null;
    if (g.auth && secret === null) throw new NestError(ErrorCodes.FORBIDDEN, `profile ${g.profile}: no credential is stored (${g.auth.secret})`, 409);
    const retryable = IDEMPOTENT_METHODS.has(method) || g.idempotency_header !== null;
    if (redelivered && !retryable) return this.unknownOutcome(row, `http.request ${g.profile}: an earlier attempt of this call left with no answer`);
    const url = `${g.base_url}${String(a.path)}${query.size ? `?${query}` : ""}`;
    const headers: Record<string, string> = { accept: "*/*", "user-agent": "nest-control-plane" };
    if (body !== undefined) headers["content-type"] = typeof a.content_type === "string" ? a.content_type.slice(0, 128) : "application/json";
    if (g.auth && secret !== null) headers[g.auth.header.toLowerCase()] = g.auth.scheme ? `${g.auth.scheme} ${secret}` : secret;
    if (g.idempotency_header) headers[g.idempotency_header.toLowerCase()] = kd;
    const timeoutMs = num(this.env.BROKERED_TIMEOUT_MS, 30_000);
    let why = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      await live();
      this.journal.sending(row);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        // The global fetch, called as a plain function (as a method of another object it throws in workerd).
        const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: ctl.signal });
        const answer = await readText(res, HTTP_ANSWER_MAX);
        const text = { text: mask(answer.text, secret), truncated: answer.truncated };
        if (!g.trusted) this.kvPut("read_tainted", true);
        const value = {
          status: res.status, content_type: res.headers.get("content-type") ?? null,
          ...(res.headers.get("location") ? { location: mask(res.headers.get("location")!, secret) } : {}),
          ...(text.truncated ? { truncated: true } : {}),
        };
        const outcome: ToolOutcome = { status: "ok", content: [{ type: "text", text: text.text }, { type: "json", value }] };
        this.journal.settle(row, "done", outcome, `HTTP ${res.status}`);
        return outcome;
      } catch (e) {
        why = ctl.signal.aborted ? `no answer within ${timeoutMs} ms` : `network: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
      if (!retryable) break;
    }
    return this.unknownOutcome(row, `http.request ${g.profile}: ${why}`);
  }

  /**
   * `egress_policy` on its own bound sandbox: read it, widen it (temporary grants, a sink: gated), or
   * narrow it (revoke hosts it was widened to: never gated). SandboxDO's grant machinery applies it.
   */
  private async egressTool(info: AgentInfo, epoch: number, call: string, a: Record<string, unknown>, guest: boolean, fence: number, live: () => Promise<void>): Promise<ToolOutcome> {
    if (!info.hands) throw new NestError(ErrorCodes.NOT_BOUND, "agent has no sandbox", 409);
    if (guest) throw new NestError(ErrorCodes.FORBIDDEN, "egress_policy isn't callable from a sandbox", 403);
    const stub = this.sandboxStub(info.hands.sandbox);
    const allow = (a.allow ?? []) as unknown[];
    const revoke = (a.revoke ?? []) as unknown[];
    if (allow.length && revoke.length) throw new NestError(ErrorCodes.INVALID_MESSAGE, "widen (allow) and narrow (revoke) in separate calls");
    const shown = (p: EgressPolicy, what: string): ToolOutcome => ({
      status: "ok",
      content: [{ type: "text", text: what }, {
        type: "json", value: { version: p.version, allow: p.allow.map((r) => ({ host: r.host, ports: r.ports, layer: r.layer, ...(r.expires_ms ? { expires_ms: r.expires_ms } : {}) })) },
      }],
    });
    if (revoke.length) {
      const hosts = revoke.map((h) => egressHost(h));
      await live();
      return shown(await stub.narrowEgress(hosts), `Revoked ${hosts.join(", ")}.`);
    }
    if (!allow.length) return shown(await stub.policy(), "The effective egress policy.");
    const rules = allow.map(egressRule);
    const ttl = typeof a.ttl_s === "number" ? a.ttl_s : EGRESS_DEFAULT_TTL_S;
    const request = { allow: rules, ttl_s: ttl };
    const key = `${info.agent}/${epoch}/${call}`;
    // Widening is a sink, `approve` when tainted (the template default; docs/agents/tools/#taint-and-sinks).
    if (gated({ sink: true, when_tainted: "approve", tainted: this.tainted(this.load()) })) {
      const held = await this.sinkGate(info, epoch, call, key, {
        name: "egress_policy", tool: `${NEST_TOOL_PREFIX}egress_policy`,
        what: `egress_policy widening ${info.hands.sandbox}'s egress to ${rules.map((r) => r.host).join(", ")} for ${ttl} s`, args: request,
      }, fence);
      if (held) return held;
    }
    await live();
    const p = await stub.widenEgress(key, rules, ttl * 1000);
    return shown(p, `Allowed ${rules.map((r) => r.host).join(", ")} for ${ttl} s.`);
  }

  /** The operator's view of its brokered actions, newest first (`GET /v1/agents/:agent/brokered`). */
  async brokeredJournal(limit = 100, before?: number): Promise<JournalEntry[]> {
    return this.journal.list(limit, before);
  }

  /**
   * The task ledger tools, on the one ledger the spec names. Privilege is the tool (`TOOL_OPS`). Other
   * agents' specs are read here, so the ledger never calls into an AgentDO mid-call.
   */
  private async taskTool(info: AgentInfo, name: string, a: Record<string, unknown>, key: string, live: () => Promise<void>): Promise<ToolOutcome> {
    const ledger = info.params.ledger;
    if (!ledger) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${name}: this agent has no task ledger (it was spawned without its tasks capability's \`ledger\` param)`, 403);
    }
    if (a.ledger !== undefined && a.ledger !== ledger) {
      throw new NestError(ErrorCodes.FORBIDDEN, `this agent may use only ledger ${ledger}, not ${String(a.ledger)}`, 403);
    }
    const tool = name as TaskTool;
    /** Taint read now: a read that tainted the session meanwhile counts. */
    const actor = (): Actor => ({ kind: "agent", agent: info.agent, ledger, tainted: this.tainted(this.load()) });
    const stub = ledgerStub(this.env, ledger);
    /** Text a tainted session wrote taints this one (sticky). */
    const seen = <T extends { tainted: boolean }>(r: T): T => {
      if (r.tainted) this.kvPut("read_tainted", true);
      return r;
    };
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    const strOrNull = (k: string) => (a[k] === null ? null : str(k));
    const int = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
    const task = () => String(a.task);
    const out = (line: string, value: unknown): ToolOutcome => ({ status: "ok", content: [{ type: "text", text: line }, { type: "json", value }] });
    const line = (t: TaskView) => `${t.key} [${t.status}${t.priority === "none" ? "" : `, ${t.priority}`}] ${t.title}` +
      `${t.assignee ? ` (${t.assignee})` : ""} v${t.version}`;
    const grantOf = async (id: string | null): Promise<SpecGrant | null> => {
      if (id === null) return null;
      if (!id.startsWith("agt_")) throw new NestError(ErrorCodes.INVALID_MESSAGE, `expected an agent id (agt_...) or null, not ${id}`);
      const other = id === info.agent ? info : await this.env.AGENT.get(this.env.AGENT.idFromName(id)).info();
      return { agent: id, ledger: other.params?.ledger ?? null, tools: other.tools };
    };
    const write = async (op: TaskOp) => {
      if (TOOL_OPS[tool] !== op.kind) throw new NestError(ErrorCodes.INTERNAL, `${name} asks for ${TOOL_OPS[tool]}, not ${op.kind}`, 500);
      await live();
      return seen(await stub.apply(ledger, actor(), op, key));
    };
    const edits = {
      title: str("title"), description: str("description"), status: str("status") as TaskStatus | undefined,
      labels: Array.isArray(a.labels) ? (a.labels as string[]) : undefined,
    };
    switch (tool) {
      case "task_list": {
        const assignee = strOrNull("assignee");
        const filter: TaskFilter = {
          status: str("status") as TaskStatus | undefined, label: str("label"), text: str("text"), parent: str("parent"),
          assignee: assignee === "me" ? info.agent : assignee,
        };
        const page = seen(await stub.list(ledger, actor(), filter, int("cursor") ?? 0, int("limit")));
        const text = page.tasks.length ? page.tasks.map(line).join("\n") : "No tasks match.";
        return out(page.next_cursor === null ? text : `${text}\n(more: cursor ${page.next_cursor})`, page);
      }
      case "task_get": {
        const d = seen(await stub.get(ledger, actor(), task()));
        return out(`${line(d.task)}\n\n${d.task.description}`, d);
      }
      case "task_create": {
        const r = await write({ kind: "create", ...edits, title: String(a.title), parent: str("parent") });
        return out(`Created ${line(r.task!)}`, r.task);
      }
      case "task_update": {
        const r = await write({ kind: "update", task: task(), expected_version: int("expected_version"), ...edits });
        return out(`Updated ${line(r.task!)}`, r.task);
      }
      case "task_claim": {
        const r = await write({ kind: "claim", task: task(), expected_version: int("expected_version") });
        return out(`Claimed ${line(r.task!)}`, r.task);
      }
      case "task_comment": {
        const r = await write({ kind: "comment", task: task(), body: String(a.body) });
        return out(`Commented on ${r.task!.key}`, r);
      }
      case "task_assign": {
        const assignee = await grantOf(strOrNull("assignee") ?? null);
        const r = await write({ kind: "assign", task: task(), expected_version: int("expected_version"), assignee });
        return out(`${r.task!.assignee ? "Assigned" : "Unassigned"} ${line(r.task!)}`, r.task);
      }
      case "task_update_any": {
        const r = await write({
          kind: "update_any", task: task(), expected_version: int("expected_version"), ...edits,
          priority: str("priority") as TaskPriority | undefined, parent: strOrNull("parent"),
        });
        return out(`Updated ${line(r.task!)}`, r.task);
      }
      case "task_cancel": {
        const r = await write({ kind: "cancel", task: task(), expected_version: int("expected_version"), reason: str("reason") });
        return out(`Canceled ${line(r.task!)}`, r.task);
      }
      case "task_set_watcher": {
        const watcher = await grantOf(strOrNull("watcher") ?? null);
        const r = await write({ kind: "set_watcher", watcher });
        return out(r.watcher ? `${r.watcher} watches ledger ${ledger}` : `Ledger ${ledger} has no watcher`, { ledger, watcher: r.watcher ?? null });
      }
      default:
        throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${name} is not implemented yet`, 501);
    }
  }

  /** Who `notify` to `captain` reaches: the owner, else the agent's escalation channel's reader. */
  private async captainOf(info: AgentInfo): Promise<string | null> {
    if (info.owner) return info.owner;
    if (info.escalate_to === "user") return "user";
    return (await this.workstream(info.workstream).info()).subscriber;
  }

  /**
   * Record an ask and route it to the user or the escalation channel. `sync`: a tool call waits (until
   * the window's deadline); `cli`: a guest `nest ask` waits in memory; `async`: the answer is a turn.
   */
  private async postAsk(
    info: AgentInfo, call: string, epoch: number, question: string, status: "sync" | "cli" | "async", to: "escalation" | "user",
    sandboxEpoch?: number, fence: number = epoch, approval?: { name: string; digest: string; tool: string },
  ): Promise<string> {
    // A re-run for the same call routes the same ask again, under the same key.
    const prior = this.calls.askOf(call, epoch);
    if (prior?.status === "answered") return prior.ask;
    const ask = prior?.ask ?? newId("ask_");
    const deadline = prior?.deadline ?? Date.now() + num(this.env.ASK_SYNC_WINDOW_MS, 120_000);
    if (!prior) {
      this.calls.recordAsk({ ask, call, epoch, question, status, deadline });
      // Before routing's awaits: an answer that comes meanwhile finds the approval it decides.
      if (approval) this.calls.requestApproval(ask, approval.name, approval.digest, approval.tool);
    }
    if ((prior?.status ?? status) === "sync") await this.deadlines.set(`${ASK_DEADLINE}${ask}`, deadline);
    const q = prior?.question ?? question;
    if (sandboxEpoch === undefined) this.assertEpoch(fence);
    await this.hook("ask:beforeRoute");
    if (to === "user" || info.escalate_to === "user") {
      await this.workstream(info.workstream).notifyUser(`[${ask}] ${info.agent} asks: ${q}`, "high", `${info.agent}/${ask}`);
    } else {
      await this.workstream(info.workstream).ingest({
        workstream: info.workstream, ts_ms: Date.now(), agent: info.agent, type: "needs_input", ask, question: q,
        ...(await this.sandboxFields(info, sandboxEpoch)),
      }, `${info.agent}/${ask}`);
    }
    return ask;
  }

  /** In-memory waiters for guest `nest ask` (lost on eviction: the ask then falls back to async). */
  private readonly cliWaiters = new Map<string, (answer: string) => void>();

  /**
   * A `nest` CLI command from this agent's sandbox, mapped onto the platform tools. `epoch` is the
   * sandbox's: FleetDO relays only from the host holding that lease (`holds()`), which is the fence.
   */
  async guestCli(sandbox: string, epoch: number, command: CliCommand): Promise<CliResult> {
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) {
      return { status: "error", error: errorBody(ErrorCodes.NOT_BOUND, `${info.agent} is not bound to ${sandbox}`) };
    }
    const call = newId("cal_cli-");
    const key = info.agent_epoch;
    const run = async (name: string, args: Record<string, unknown>): Promise<CliResult> => {
      const r = await this.dispatch(key, call, name, args, epoch);
      if (r === "wait") return { status: "error", error: errorBody(ErrorCodes.INTERNAL, "unexpected wait", true) };
      if (r.status === "error") return { status: "error", error: r.error };
      return { status: "ok", data: r.status === "ok" ? (r.content.find((c) => c.type === "json") as { value?: unknown } | undefined)?.value ?? null : null };
    };
    try {
      switch (command.command) {
        case "notify":
          // The CLI's `low` urgency is delivered like `normal` (the tool has no lower level).
          return await run("notify", { to: command.to, message: command.message, ...(command.urgency === "high" ? { urgency: "high" } : {}) });
        case "emit": {
          if (!(EMIT_EVENTS as readonly string[]).includes(command.event)) {
            return { status: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, `nest emit: event must be one of ${EMIT_EVENTS.join(", ")}`) };
          }
          const p = (command.payload && typeof command.payload === "object" ? command.payload : {}) as Record<string, unknown>;
          const summary = typeof p.summary === "string" ? p.summary
            : command.payload === null || command.payload === undefined ? command.event : JSON.stringify(command.payload);
          return await run("emit", {
            event: command.event, summary,
            ...(typeof p.url === "string" ? { url: p.url } : {}), ...(typeof p.title === "string" ? { title: p.title } : {}),
          });
        }
        case "expose":
          if (command.port < 1) return { status: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, "port must be 1-65535") };
          if (!command.exposed) {
            await this.sandboxStub(sandbox).unexposePort(command.port);
            return { status: "ok", data: { port: command.port, exposed: false } };
          }
          return await run("expose_port", { port: command.port });
        case "ask": {
          const full = command.options.length ? `${command.question} (options: ${command.options.join(" | ")})` : command.question;
          const ask = await this.postAsk(info, call, key, full, "cli", "escalation", epoch);
          const waitMs = Math.min(command.wait_s, 120) * 1000;
          const answer = await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => { this.cliWaiters.delete(ask); resolve(null); }, waitMs);
            this.cliWaiters.set(ask, (a) => { clearTimeout(timer); resolve(a); });
          });
          if (answer !== null) return { status: "answered", answer };
          this.calls.toAsync(ask, "cli");
          return { status: "pending", question_id: ask };
        }
        case "whoami":
          return { status: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, "whoami is answered by the guest agent") };
      }
    } catch (e) {
      const ne = asNestError(e);
      return { status: "error", error: ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, "nest CLI command failed", true) };
    }
  }

  /** A background hands task exited (fenced by FleetDO's `holds()`): surfaced mid-turn. */
  async onTaskExited(sandbox: string, _epoch: number, task: TaskInfo): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) return;
    const how = task.status === "exited" ? `exited with code ${task.exit_code ?? "?"}` : task.status.replace("_", " ");
    const what = task.description ? `${task.task_id} (${task.description})` : task.task_id;
    if (info.current_turn) await this.postInbox(SYSTEM_SENDER, `Background task ${what} ${how}.`);
  }

  /** Answer a pending `ask` (`askRoute`): inside the sync window it completes the tool call; otherwise it becomes a turn. */
  async answerAsk(ask: string, answer: string): Promise<"sync" | "async" | "already_answered"> {
    const row = this.calls.ask(ask);
    if (!row) throw new NestError(ErrorCodes.INVALID_MESSAGE, "unknown ask", 404);
    const waiter = row.status === "cli" ? this.cliWaiters.get(ask) : undefined;
    const route = askRoute(row.status, !!waiter, this.isCurrent(this.load(), row.epoch));
    if (route === "already_answered") return route;
    this.calls.answer(ask, answer);
    this.cliWaiters.delete(ask);
    const approval = this.calls.approvalOf(ask);
    if (approval) {
      const ok = approves(answer);
      this.calls.decide(ask, ok, Date.now() + APPROVAL_TTL_MS);
      // Rows written before `tool` was kept are remote MCP tools'.
      const tool = approval.tool ?? `${NEST_TOOL_PREFIX}${approval.name}`;
      await this.enqueueTurn({
        kind: "ask_answer",
        text: ok
          ? `Approved (${ask}): call ${tool} again with exactly the same arguments. The approval is for that one call, within ${APPROVAL_TTL_MS / 60_000} minutes.`
          : `Denied (${ask}): ${tool} with those arguments wasn't sent and won't be. The operator answered: ${answer}`,
      });
      return "async";
    }
    if (route === "waiter") {
      waiter!(answer);
      return "sync";
    }
    if (row.status === "sync") {
      // Its result if its brain still waits, else ended unsent (the answer becomes a turn).
      const outcome: ToolOutcome = { status: "ok", content: [{ type: "text", text: answer }] };
      if (route === "result") this.finishCall(row.epoch, row.call, outcome);
      else this.calls.finish(row.epoch, row.call, outcome);
      await this.deadlines.clear(`${ASK_DEADLINE}${ask}`);
      if (route === "result") return "sync";
    }
    await this.enqueueTurn({ kind: "ask_answer", text: `Answer to your question ${ask}: ${answer}` });
    return "async";
  }

  // ---------------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const handlers: Record<AgentDeadline, () => Promise<void>> = {
      flush: () => this.flush(),
      starting: () => this.unresponsiveBrain("starting"),
      no_session: () => this.unresponsiveBrain("no_session"),
      activity: () => this.syncActivity(),
      wake: () => this.wake(),
      // Counted by the crash-loop guard (a no-op once the inline wake started one).
      wake_after_exit: () => this.wake(true),
      condemned: () => this.escalate(),
      intent: async () => {
        try {
          await this.runIntent(true);
        } catch (e) {
          // `intentFailed` armed any retry.
          console.warn(`agent ${this.load().agent}: running the start intent failed`, e);
        }
      },
      [OUTBOX_DEADLINE]: () => this.outbox.flush(),
      prune: async () => {
        this.prune();
        await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS);
      },
      end: () => this.finishEnd(),
      reap: () => this.reap(),
    };
    // An end's deadlines a rolled-back release dropped (it has no handler for them) come back here: the
    // hourly `prune` keeps the alarm running.
    if (this.exists()) {
      const e = this.load().ended;
      if (e && !e.done_ms && !this.deadlines.has("end")) await this.deadlines.set("end", Date.now());
      if (e?.done_ms && !this.deadlines.has("reap")) await this.deadlines.set("reap", e.ms + AGENT_RECORD_RETENTION_MS);
    }
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key.startsWith(ASK_DEADLINE)) return this.askWindowLapsed(key.slice(ASK_DEADLINE.length));
      const run = handlers[key as AgentDeadline] as (() => Promise<void>) | undefined;
      if (run) await run();
      else console.error(`agent ${this.load().agent}: no handler for deadline ${key}; dropped`);
    }, 5_000, [OUTBOX_DEADLINE]);
  }

  /** No hello within the start deadline, or no session for `NO_SESSION_MS`: condemned (`unresponsive`). */
  private async unresponsiveBrain(kind: "starting" | "no_session"): Promise<void> {
    const info = this.load();
    const b = info.brain;
    if (b?.phase !== (kind === "starting" ? "starting" : "live") || this.socket()) return;
    console.warn(kind === "starting"
      ? `agent ${info.agent}: no brain connected within ${this.startDeadline(info)} ms of agent_start@${b.epoch}`
      : `agent ${info.agent}: brain ${b.host}@${b.epoch} had no session for ${NO_SESSION_MS} ms`);
    const { patch, wake } = unresponsive(info, b, kind);
    await this.condemn(kind === "starting" ? "no hello before the start deadline" : "no session", b.epoch, patch);
    if (wake) await this.wake(true);
  }

  /** A `sync` ask's window lapsed: the call answers `pending`, and the answer comes as a turn. */
  private async askWindowLapsed(ask: string): Promise<void> {
    const row = this.calls.ask(ask);
    if (row?.status === "sync") {
      this.calls.toAsync(ask, "sync");
      this.finishCall(row.epoch, row.call, {
        status: "pending",
        ask,
        message: "Question posted. End your turn; the answer arrives as your next input.",
      });
    }
  }

  /** Finished calls, asks, turns and inbox messages older than a week go. */
  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.calls.prune(cutoff);
    this.mcp.prune(cutoff);
    this.journal.prune(cutoff);
    this.queue.prune(cutoff);
    this.sql.exec("DELETE FROM channel_subs WHERE ended = 1 AND created_ms < ?", cutoff);
  }
}

/** Minimal JSON-schema check for platform tool arguments (required, additionalProperties, types, enums, bounds, item types). */
export function validateArgs(schema: unknown, args: unknown): Record<string, unknown> {
  type Prop = { type?: string | string[]; enum?: unknown[]; minimum?: number; maximum?: number; items?: { type?: string } };
  const s = schema as { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: boolean };
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "arguments must be an object");
  }
  const a = args as Record<string, unknown>;
  for (const k of s.required ?? []) {
    if (!(k in a)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `missing argument ${k}`);
  }
  const typeOk = (t: string | string[] | undefined, v: unknown): boolean =>
    t === undefined ||
    (Array.isArray(t) && t.some((x) => typeOk(x, v))) ||
    (t === "null" && v === null) ||
    (t === "string" && typeof v === "string") ||
    (t === "integer" && Number.isInteger(v)) ||
    (t === "number" && typeof v === "number" && Number.isFinite(v)) ||
    (t === "boolean" && typeof v === "boolean") ||
    (t === "array" && Array.isArray(v)) ||
    (t === "object" && typeof v === "object" && v !== null && !Array.isArray(v));
  for (const [k, v] of Object.entries(a)) {
    const p = s.properties?.[k];
    if (!p) {
      if (s.additionalProperties === false) throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown argument ${k}`);
      continue;
    }
    if (!typeOk(p.type, v)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be ${[p.type].flat().join(" or ")}`);
    if (p.enum && !p.enum.includes(v)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be one of ${p.enum.join(", ")}`);
    if (typeof v === "number") {
      if (p.minimum !== undefined && v < p.minimum) throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be >= ${p.minimum}`);
      if (p.maximum !== undefined && v > p.maximum) throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be <= ${p.maximum}`);
    }
    if (Array.isArray(v) && p.items?.type && !v.every((x) => typeOk(p.items!.type, x))) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be an array of ${p.items.type}`);
    }
  }
  return a;
}

/** The refusal of a call whose arguments hold a credential: names the kind, never the value. */
function secretRefusal(kind: string): NestError {
  return new NestError(ErrorCodes.FORBIDDEN, `Not sent: the arguments contain ${kind}. Remove it and call again.`, 403);
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const HTTP_BODY_MAX = 1024 * 1024;
/** How much of an http profile's answer reaches the model. */
const HTTP_ANSWER_MAX = 64 * 1024;
const EGRESS_DEFAULT_TTL_S = 3600;
const EGRESS_HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** A host an agent may widen its egress to: a DNS name or `*.` and one, lowercase (no IP literals). */
function egressHost(h: unknown): string {
  const v = typeof h === "string" ? h.trim().toLowerCase() : "";
  if (v.length > 253 || !EGRESS_HOST.test(v)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${String(h)} isn't a host name (a DNS name or *.domain)`);
  return v;
}

function egressRule(r: unknown): { host: string; ports?: number[] } {
  const o = (r && typeof r === "object" ? r : {}) as { host?: unknown; ports?: unknown };
  const host = egressHost(o.host);
  if (o.ports === undefined) return { host };
  if (!Array.isArray(o.ports) || o.ports.length > 8 || !o.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, `${host}: ports must be up to 8 integers 1-65535`);
  }
  return { host, ports: [...new Set(o.ports as number[])].sort((x, y) => x - y) };
}

/** A body as text, at most `max` bytes. */
async function readText(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) {
      chunks.push(value.subarray(0, max - n));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    n += value.byteLength;
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(concatBytes(chunks)), truncated };
}

/** A credential the answer reflects, replaced with `*` of its length. */
function mask(v: string, secret: string | null): string {
  return secret ? v.split(secret).join("*".repeat(secret.length)) : v;
}
