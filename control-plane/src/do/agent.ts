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
import { z } from "zod";
import { num, type Env } from "../env";
import {
  type Caller, type ChannelDelivery, clip, type DeliveryOutcome, envelopeText, EVENT_TEXT_BYTES, Filter,
  parseChannel, type PostInput, sessionTaint, SubscribeInput,
} from "../lib/channels";
import { admitDelivery, channelRequestId, inboxTurnText, moveNoteDue, TurnQueue, type TurnStatus } from "../lib/turns";
import type { ReadResult } from "./channel";
import { ChannelOutbox, OUTBOX_DEADLINE } from "../lib/outbox";
import { toolDef, toolDefs } from "../lib/registry";
import { Deadlines, ReliableChannels, SerialQueue } from "../lib/reliable";
import { type AgentSpec, EscalateTo, type RoleRecord, specFromRole } from "../lib/spec";
import {
  type Actor, ALL_TASK_TOOLS, type SpecGrant, type TaskFilter, type TaskOp, type TaskPriority, type TaskStatus, type TaskTool, TOOL_OPS,
} from "../lib/tasks";
import { signBlobUrl } from "../lib/tokens";
import { ledgerStub, type TaskView } from "./tasks";
import { asNestError, b64ToBytes, concatBytes, errorBody, NestError, newId } from "../lib/util";
import { addColumn, storedEnum } from "../lib/stored";
import { askRoute, CallLedger } from "../lib/calls";
import {
  agentState, type Brain, type BrainFields, type BrainPatch, brainRelease, epochlessExit, escalation, liveBrainStart, mergeIntent, NO_INTENT,
  phaseDeadlines, type PhaseDeadline, splitState, startFailure, type StartIntent, stoppedBrain, unresponsive, wakeDecision,
} from "../lib/brain";
import {
  type AgentCache, type AgentExitReason, type AgentStart, type AgentToRunner, handsResolved, type InboxMessage,
  RunnerToAgent, type SegmentRef, type ToolOutcome, type ToolRule, type TurnInput,
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
 * A brain that hasn't said hello this long after its `agent_start` (the command was lost, or the host
 * never ran it) is condemned. Above the runner's own budget before its hello: session rebuild
 * (120 s), `claude auth status` (20 s), `claude --version` (10 s) and the session channel's open
 * (10 s), plus a margin. Doubled for each consecutive timeout, up to `START_BACKOFF_STEPS` times,
 * so a slow start isn't condemned for ever.
 */
const START_DEADLINE_MS = 240_000;
const START_BACKOFF_STEPS = 2;
/** A live brain with no current session this long (and no exit) is condemned. */
const NO_SESSION_MS = 10 * 60_000;
/** A failed `SandboxDO.agentActivity` is tried again after this long. */
const ACTIVITY_RETRY_MS = 5_000;
/** States with no brain running, which waiting work starts one from (see `wake()`). */
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

/**
 * An agent, as AgentDO stores it. Its expanded spec (`AgentSpec`: template name, tools, launch,
 * rules, credential, escalation) is copied in at spawn; nothing about it is decided by a role.
 */
export interface AgentInfo extends Omit<AgentSpec, "subscribe">, BrainFields {
  agent: string;
  workstream: string;
  cell: string;
  /**
   * The agent this one reports to (its spawner, or the one the operator named), recorded once at
   * spawn and checked then to be an agent of the same workstream: `notify` to `captain` reaches it.
   */
  owner: string | null;
  /**
   * The bound sandbox, by id only. Its epoch is SandboxDO's (read there when needed, and fenced by
   * FleetDO's lease check for host-relayed calls); AgentDO keeps no copy.
   */
  hands: { sandbox: string } | null;
  /** Session of the committed base (what `--resume` restores). */
  session: string | null;
  current_turn: string | null;
  cache_version: number;
  /** Committed base: its generation and the bytes durable in R2 (what resume and transcripts read). */
  base_gen: number;
  durable_bytes: number;
  /**
   * The stream being received. Equal to `base_gen` normally; one higher while a rewritten file (`base:
   * true`, or a new session) is arriving: the committed base stays resumable until the new one is
   * durable and caught up.
   */
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
  /**
   * The bound sandbox's epoch the brain was last told about (at a turn's start, or by a mid-turn
   * note): a turn starting at another epoch begins with what the move lost.
   */
  told_sandbox_epoch?: number;
}

/** The sender of the platform's own notes about an agent's work (not input: see `AgentInfo.stop_quiet`). */
const SYSTEM_SENDER = "system";
/**
 * What `info()` answers: the stored record plus the brain's host (derived, never stored) and
 * `state` (derived; stored too, for the previous release, which reads it).
 */
export type AgentView = AgentInfo & { host: string | null; state: AgentState };

/**
 * Fields of records stored by the previous release (`load()` migrates them): `state` (`lifecycle`
 * and `activity` replaced it), `host` (the brain record did), and `role`, `grants` and `captain`
 * (the expanded spec and `owner` did).
 */
interface PreviousReleaseFields {
  /** The previous release's one field for both parts (`agentState`, still written by `save()`). */
  state?: AgentState;
  host?: string | null;
  role?: RoleRecord["role"];
  grants?: string[] | null;
  captain?: string | null;
}

/** AgentDO's alarm keys: each has its handler in `alarm()`'s table, so a key without one doesn't compile. */
type AgentDeadline = PhaseDeadline | "flush" | "activity" | "wake" | "wake_after_exit" | "intent" | "prune" | typeof OUTBOX_DEADLINE;
/** A `sync` ask's window: `ask:<ask id>`. */
const ASK_DEADLINE = "ask:";
type AskDeadline = `${typeof ASK_DEADLINE}${string}`;
/** `Deadlines`, taking AgentDO's keys only (the class takes any string). */
type AgentDeadlines = Pick<Deadlines, "runDue" | "reschedule"> & {
  set(key: AgentDeadline | AskDeadline, at: number, keepEarlier?: boolean): Promise<void>;
  clear(key: AgentDeadline | AskDeadline): Promise<void>;
  has(key: AgentDeadline | AskDeadline): boolean;
};

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
}

interface Attachment {
  host: string;
  epoch: number;
  helloed: boolean;
  stale: boolean;
  instance: string;
}

type DispatchResult = ToolOutcome | "wait";
/**
 * What `start()` did: `started` (the host and the `agent_start` command); `waiting` (the brain on
 * `waiting_for` was condemned, and the start happens once it is released); or `none` (nothing was
 * wanted any more: another call's run took the intent).
 */
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

/** A host a brain may start on: an active, connected brain host of this release (docs/compute/brain-hosts/). */
function brainHostUsable(st: { status: string; connected: boolean; current: boolean; role: string } | null): boolean {
  return !!st && st.status === "active" && st.connected && st.current && st.role === "brain";
}

export class AgentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // `!`: set in the constructor, except on the health instance, which serves only `health()`.
  private readonly rel!: ReliableChannels;
  private readonly deadlines!: AgentDeadlines;
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
    const deadlines = new Deadlines(this.sql, ctx.storage);
    this.deadlines = deadlines;
    // Channels (docs/channels/): this agent's subscriptions (for display and cleanup) with the
    // high-water seq of each one's deliveries (dedup), and its queued posts to `<agt>/events`.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_subs (channel TEXT NOT NULL, sub TEXT NOT NULL, hw INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel, sub))`);
    // Notices taken without delivery (no `read` tool): how many, and up to which seq.
    addColumn(this.sql, "channel_subs", "skipped", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.sql, "channel_subs", "skipped_to", "INTEGER");
    this.outbox = new ChannelOutbox(this.sql, deadlines, env, (p) => ctx.waitUntil(p), () => this.load().agent,
      async (owner) => ({ spawner_reads: await this.ownerReads(owner) }));
  }

  private readonly outbox!: ChannelOutbox;
  /** The turn queue and inbox: the one owner of the `turns`, `inbox` and `chan_wakes` tables. */
  private readonly queue!: TurnQueue;
  /** Platform tool calls and asks: the one owner of the `tool_calls` and `asks` tables. */
  private readonly calls!: CallLedger;

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
    // Stored with a role (the previous release): its role's seed template, expanded with the launch,
    // rules and grant list it stored; its `captain` is its owner. Persisted once, below.
    let spec: Omit<AgentSpec, "subscribe"> | undefined;
    if (info.tools === undefined) {
      spec = specFromRole({ role: role ?? (legacy ? "worker" : "captain"), grants, launch: info.launch, rules: info.rules });
    }
    let brain = info.brain;
    let migrated = false;
    if (brain === undefined) {
      // Stored by the previous release: `host` was the brain's host, and it kept it after the brain
      // exited (detached or errored). Such a brain may or may not still run, so it is condemned:
      // its kill and escalation prove it gone. Any other is live (or starting). Migrated once, and
      // persisted with its alarm, below.
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
      // Stored with `state` alone, or `state` written since by the previous release (a rollback):
      // `state` is the authority.
      ...(state !== undefined && (info.lifecycle === undefined || agentState(info) !== state) ? splitState(state) : {}),
    };
    if (migrated) {
      this.save(out);
      // Each migrated record's alarm, armed with it (the rows are written now; the alarm set in
      // the background).
      this.ctx.waitUntil(this.armPhase(out.brain, START_DEADLINE_MS, false));
    } else if (spec) {
      this.save(out);
    }
    return out;
  }

  private save(info: AgentInfo): void {
    // `state` for the previous release, which reads it (`agentState`); `load()` drops it.
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
    // The owner is recorded once, here: it must be an agent (`info()` refuses one never created) of
    // this workstream, the only agents `notify` reaches.
    const owner = req.owner ?? null;
    if (owner !== null) {
      const o = await this.env.AGENT.get(this.env.AGENT.idFromName(owner)).info();
      if (o.workstream !== req.workstream) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, `owner ${owner} is in workstream ${o.workstream}, not ${req.workstream}`, 409);
      }
    }
    let hands: AgentInfo["hands"] = null;
    if (req.sandbox) {
      // An agent's cell and workstream are its sandbox's: its brain starts through that cell's
      // FleetDO, and its sandbox's secrets and events belong to that workstream. Checked before
      // attaching.
      const stub = this.sandboxStub(req.sandbox);
      const cur = await stub.info();
      if (cur.cell !== req.cell || cur.workstream !== req.workstream) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE,
          `${req.sandbox} is in cell ${cur.cell}, workstream ${cur.workstream}; the agent must be too`, 409);
      }
      await stub.attach(req.agent);
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
    };
    this.save(info);
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

  /**
   * `sandbox` and `epoch` for an event about the bound sandbox. The epoch is SandboxDO's current one
   * (or `known`, one FleetDO's lease check just verified), never AgentDO's cached copy.
   */
  private async sandboxFields(info: AgentInfo, known?: number): Promise<{ sandbox?: string; epoch?: number }> {
    if (!info.hands) return {};
    const epoch = known ?? (await this.sandboxStub(info.hands.sandbox).info()).epoch;
    return { sandbox: info.hands.sandbox, epoch };
  }

  /**
   * Working, as the sandbox's idle refcount should see it: a brain is running and is busy or in a turn
   * (SessionStart says `ready` mid-turn, so a turn in progress is work whatever state it reports).
   */
  private working(info: AgentInfo): boolean {
    const state = agentState(info);
    return !WAKE_STATES.includes(state) && (WORKING_STATES.includes(state) || info.current_turn !== null);
  }

  /**
   * AgentDO owns "working": tell SandboxDO (an idempotent "set to") whenever it differs from what
   * SandboxDO last acknowledged, or always with `force`. Never throws: a failed call is retried from
   * the alarm, so a lost call can neither suspend a sandbox mid-turn nor keep it awake for ever.
   * Loops because a concurrent change may land while a call is in flight.
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
  // Brain lifecycle (docs/control-plane/durable-objects/agent/: one brain record)
  //
  // `brain` is the only authority for where this agent's brain runs. A session is current iff
  // `brain` is set, isn't condemned, and the session's epoch is `brain.epoch` (`isCurrent`). A start
  // is made only from `intent`. `brain` is cleared only by `release`: the brain's exit at its epoch
  // or later, or its host's loss (A3: a start never outlives a lease lapse or an expiry, so nothing
  // runs on a lost host). A brain on a host of the previous release (no brain epochs) is released
  // only by that host's loss. Every transition arms the alarm that
  // carries it on in the same synchronous step (the deadline row is written before any await).
  // ---------------------------------------------------------------------------------------------

  /** Test seam: awaited at named points so a test can force an interleaving there. */
  testHooks: Partial<Record<HookPoint, () => Promise<void>>> = {};

  private async hook(point: HookPoint): Promise<void> {
    const h = this.testHooks[point];
    if (h) await h();
  }

  /**
   * An operator's start (`POST /start`, optionally on a chosen host), or the API's start at create.
   * Recorded as the intent, then run: see `processIntent`. The setup token travels as a BrokerDO
   * reference, resolved by FleetDO when it sends.
   */
  async start(hostHint?: string, avoid?: string, restart = false): Promise<StartResult> {
    const info = this.load();
    // Hands still go through the sandbox's gateway, wherever the brain runs.
    if (hostHint) await this.requireBrainHost(info.cell, hostHint);
    await this.setIntent({ ...(hostHint ? { host_hint: hostHint } : {}), ...(avoid ? { avoid } : {}), reason: restart ? "restart" : "operator" });
    const r = await this.runIntent(true);
    return r ?? this.startStatus();
  }

  /**
   * FleetDO saw room for brains appear (a brain host said hello, a brain's slot freed) while this
   * agent waited for one: run the kept intent now instead of at its backed-off retry. Nothing to do
   * without an intent. Returns whether one was waiting.
   */
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

  /**
   * Merge a start request into the intent (`mergeIntent`), with a backstop alarm in the same step,
   * so it runs even if nothing else runs it (an eviction mid-start).
   */
  private async setIntent(patch: StartIntent): Promise<void> {
    this.update((i) => {
      i.intent = mergeIntent(i.intent, patch);
    });
    await this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true);
  }

  /**
   * Single-flight over `processIntent`. A caller that finds a run in flight either waits for it and
   * runs again (`wait`: the operator's start, the alarm; never nested inside a run), or leaves its
   * intent to the alarm that fires once the run ends (`wake()`, which may be reached from anywhere).
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
   * Act on the intent against the brain record (design rule 2):
   * - the brain's host dead, expired or unknown (A2): release it first (nothing runs there, A3);
   * - no brain: pick a host (the hint, else the previous brain host if healthy, for a warm
   *   session, else today's placement; never `avoid`), bump the agent epoch, record the brain
   *   `starting` and send `agent_start{epoch}`;
   * - a brain that isn't condemned is never started again (no same-host re-issue): a start moves
   *   it (another hint, its host avoided, or its host no longer active and connected) or restarts
   *   it (an operator's explicit restart) by condemning it with the intent kept; an operator's
   *   plain start keeps its intent, so it runs once the brain exits (a graceful stop's `stopped`
   *   exit included), and answers `none`. A start without a hint never moves a healthy live
   *   brain, least of all to follow its sandbox;
   * - a brain elsewhere: condemn it (fenced at once, killed) and keep the intent, which runs once
   *   the brain is released;
   * - a condemned brain: keep waiting (its escalation armed).
   * Decisions are taken from a snapshot and committed synchronously only if the brain and intent
   * are still what the snapshot saw; otherwise it looks again. Any failure keeps or ends the intent
   * through `intentFailed`, which arms its retry.
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
          // A brain that isn't condemned is never started again (`liveBrainStart`); a condemned
          // one's intent starts once it is released (maybe on the same host). Healthy by the host's
          // status (N24): a brief socket drop isn't a reason to move a brain.
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
   * Where a start with no brain goes (see `processIntent`): a brain host, never a sandbox host, and
   * never one of the previous release (its hello didn't say `brain_epochs`). The hint if it names
   * such a host; else FleetDO's `placeBrain` (the last brain host if it has room, for a warm session,
   * else the fullest with room; never `avoid`). Where the agent's sandbox runs plays no part. Throws
   * when no host can take it now (retryable: the intent stays, and FleetDO launches a brain host).
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
    // The sandbox wakes alongside (a suspended one resumes, an unplaced one is placed), so hands are
    // ready sooner; the brain never waits for it (`hands_resolve` answers not-ready until it runs).
    // Only a sandbox that can never run again (destroyed, archived) stops the start.
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

  /** `host` is one a brain may start on (`brainHostUsable`), or the start is refused. */
  private async requireBrainHost(cell: string, host: string): Promise<void> {
    if (!brainHostUsable(await this.fleet(cell).hostStatus(host))) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${host} is not an active, connected brain host of this release in ${cell}`, 409);
    }
  }

  /** The `starting` deadline: above the runner's budget before its hello, doubling per consecutive timeout. */
  private startDeadline(info: AgentInfo): number {
    return START_DEADLINE_MS * 2 ** Math.min(info.start_timeouts ?? 0, START_BACKOFF_STEPS);
  }

  /**
   * Arm the phase deadlines of the brain record `b` just entered (`phaseDeadlines`), each row
   * written before this returns (the alarm is set as the promise runs), so the step that changed
   * the record also armed its continuation. `startMs`: a starting brain's deadline; `connected`: a
   * live brain has a session.
   */
  private armPhase(b: Brain | null, startMs = START_DEADLINE_MS, connected = true): Promise<unknown> {
    const at = phaseDeadlines(b, Date.now(), startMs, NO_SESSION_MS, connected);
    return Promise.all((Object.keys(at) as PhaseDeadline[]).map((k) => {
      const t = at[k];
      return t === null ? this.deadlines.clear(k) : this.deadlines.set(k, t, k !== "starting");
    }));
  }

  /**
   * Commit a start on `host`: bump the agent epoch, record the brain `starting`, consume the
   * intent, and arm the `starting` deadline, all in
   * one synchronous step; then send `agent_start`. A send that fails may still have been queued, so
   * the brain is never just forgotten: it is condemned (its host refuses the start under the kill's
   * tombstone, or kills it) and the intent kept.
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
    // Any other session (the replaced brain on this host, still flushing) is of an older epoch now:
    // `current()` refuses what it sends, and the new brain's hello supersedes it.
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
        // The start is still wanted (unless a stop ended it while it was being sent): it runs again
        // once this one is released.
        await this.condemn("its start could not be confirmed sent", epoch, (i) => {
          if (!stoppedBrain(i, epoch)) i.intent = i.intent ?? intent;
        });
      }
      throw e;
    }
    return { kind: "started", host, cmd };
  }

  /**
   * A run of the intent failed. A retryable failure (no host yet, an infrastructure error) keeps the
   * intent and retries from the alarm. Otherwise a hint that no longer works is dropped (the rest
   * of the intent retries), and anything else ends the intent (`errored` if no brain is left).
   */
  private async intentFailed(intent: StartIntent, e: unknown): Promise<void> {
    const now = this.load();
    const ne = asNestError(e);
    if (!now.intent) {
      // A stop ended the intent while this run awaited: nothing to keep, retry or fail. A wait for
      // capacity this run recorded at FleetDO after the stop's notice goes too (no start wants it).
      if (ne?.code === ErrorCodes.CAPACITY_EXHAUSTED) {
        try {
          await this.fleet(now.cell).brainWaitEnded(now.agent);
        } catch (err) {
          console.warn(`agent ${now.agent}: telling FleetDO its wait for a brain host ended failed`, err);
        }
      }
      return;
    }
    // A newer start merged into the intent while this run awaited: its own run (queued behind this
    // one, `intentDirty`) decides; this failure says nothing about it.
    if (!same(now.intent, intent)) return;
    if (ne?.retryable ?? true) {
      // No brain host with room (FleetDO launches one): the wait backs off, 30 s doubling to 5 min,
      // so a cell at its cap isn't asked twice a minute by every waiting agent. New input sets the
      // intent's alarm again at 30 s (`setIntent` keeps the earlier deadline).
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
   * Condemn the brain (design rule 2): from here on none of its sessions is current (rule 1), its
   * open sessions are closed before anything is made durable (late bytes go to the orphan branch),
   * and its host is told to kill it (`agent_stop{kill, epoch}`, applied on arrival; the host and
   * its runner refuse any start at or below that epoch). Amendment A1: the kill is part of the
   * transition. The record says it is owed (no `kill`) and the `condemned` alarm is armed in
   * the same synchronous step, so the kill is issued (idempotently: FleetDO keeps one per agent
   * and epoch) until FleetDO has stored it, whatever happens to this call; escalation takes over
   * once it is stored.
   */
  private async condemn(why: string, epoch: number, also?: BrainPatch | ((i: AgentInfo) => void)): Promise<void> {
    let condemned: Brain | null = null;
    this.update((i) => {
      if (typeof also === "function") also(i);
      else Object.assign(i, also);
      // Only the brain at `epoch` (N7): a record replaced meanwhile is not condemned by this call.
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
   * Escalation for a condemned brain whose exit hasn't come (design rule 4, amendments A1/A2):
   * - its host dead, expired or unknown (the loss notice may have been lost): released;
   * - no kill stored yet: sent again, never a wedge;
   * - the kill processed and FleetDO's index has no start at or below the brain's epoch on that
   *   host: the brain is gone, released;
   * - the kill not processed and the host not processing commands at all (no result from it since
   *   the kill was stored, and nothing older than the kill still pending there) for 60 s: wedged;
   * - otherwise (an older nestd working through commands queued before the kill, or finishing a
   *   graceful turn): checked again every 60 s, and wedged after `ESCALATION_CAP_MS`.
   * A wedged host is released only by STONITH (FleetDO), never by its own watchdog.
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
    // Re-checked after the await (N13): one released or replaced meanwhile isn't decided for.
    if (!same(this.load().brain, b)) return;
    if (!st?.current) {
      // A host of the previous release (no brain epochs): its brain is released only by that
      // host's loss (confirmed death or lease expiry), never by a processed kill without a row or
      // an exit. Past the cap the host is wedged like any other (N21): no start ever reaches it,
      // and its nestd kills every brain when its lease lapses (origin/main crates/nestd/src/host.rs
      // :1085-1090, `self_fence`), so its loss ends the wait.
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
    // Decided only against the record it was asked for: one released or replaced meanwhile isn't wedged for.
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

  /**
   * Whether FleetDO says `host`'s brains are proven gone (A6): its lease expired, or its death was
   * confirmed (EC2/STONITH, an operator), or there is no such host. A retired host merely marked
   * dead doesn't count.
   */
  private async hostGone(cell: string, host: string): Promise<boolean> {
    const st = await this.fleet(cell).hostStatus(host);
    return !st || st.lost;
  }

  /**
   * Release the brain (design rule 3) if `host` and `epoch` match it (`epoch` at or above the
   * record's). Committed with the alarm that carries on (the intent if one is wanted, else a wake
   * for waiting work) in one synchronous step; then sessions on that host are closed, activity
   * re-synced, and an exit that restarts wakes the brain at once. Returns whether it released.
   */
  private async release(host: string, epoch: number, reason: AgentExitReason): Promise<boolean> {
    let d: ReturnType<typeof brainRelease> = null;
    const info = this.update((i) => {
      d = brainRelease(i, host, epoch, reason, this.hasWork(i));
      if (d) Object.assign(i, d.patch);
    });
    if (!d) return false;
    const { wakes, next } = d as NonNullable<typeof d>;
    // Reported on `<agt>/events` (queued in this step; posted from the alarm). Not part of the decision.
    this.reportExit(info, host, epoch, reason, !wakes);
    const armed = Promise.all([this.armPhase(null), next ? this.deadlines.set(next, Date.now(), true) : undefined]);
    await this.hook("release:afterCommit");
    await armed;
    console.log(`agent ${info.agent}: brain on ${host}@${epoch} released (${reason})`);
    this.fenceSessions(`brain released (${reason})`, host);
    await this.syncActivity();
    if (next === "wake" || next === "wake_after_exit") await this.wake(next === "wake_after_exit");
    return true;
  }

  /**
   * Stop the brain (an operator's request): it finishes its turn, and its exit releases it. A plain
   * start meanwhile is kept as the intent and runs after that exit. The stop is stored as
   * `stop_epoch`: the brain it ends restarts nothing, however it ends.
   */
  async stop(reason: string): Promise<void> {
    // Every start wanted before this stop ends here, so only a start made after it runs (N20): an
    // operator's start kept beside the brain this stop ends, a move or restart waiting for a condemned
    // brain's release, and a start still waiting for a brain host, which its capacity retry or
    // FleetDO's poke would otherwise run, launching a host and a brain for a stopped agent. The intent
    // and its alarm go in this synchronous step; a run already in flight finds the intent changed at
    // its re-check before committing (`unchanged`), and `intentFailed` arms nothing for it. A start
    // already committed (its brain at the current epoch) that then fails is not retried either
    // (`stop_epoch`: `issueStart`'s failed send, `startFailed`).
    const waited = this.load().intent !== null;
    const info = this.update((i) => Object.assign(i, NO_INTENT, { stop_epoch: i.agent_epoch, stop_quiet: true }));
    // Wakes armed before the stop (a release's, a sandbox move's) are for work the stop ends too.
    await Promise.all([this.deadlines.clear("intent"), this.deadlines.clear("wake"), this.deadlines.clear("wake_after_exit")]);
    if (waited) {
      // Best effort: a row left behind lapses when this agent no longer retries (12 min).
      try {
        await this.fleet(info.cell).brainWaitEnded(info.agent);
      } catch (e) {
        console.warn(`agent ${info.agent}: telling FleetDO its wait for a brain host ended failed`, e);
      }
    }
    const b = info.brain;
    if (!b || b.phase === "condemned") return;
    await this.fleet(info.cell).issueCommands(b.host, [{ type: "agent_stop", agent: info.agent, reason, mode: "graceful", epoch: b.epoch }]);
  }

  /** A write for agent epoch `epoch` goes out only while that epoch is current (`stale_epoch` otherwise). */
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

  /**
   * The host running this brain is going away (a spot drain): the brain is condemned there at once,
   * whether or not another host can take it, with an intent that avoids the host; it starts
   * elsewhere once its exit (or the host's loss) releases it (rule 5: a drained host's brains are
   * never released by fiat).
   */
  async onHostDraining(host: string): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    const b = info.brain;
    if (!b || b.host !== host || b.phase === "condemned") return;
    // A stopped brain leaves the host without moving: condemned (killed now), with no intent.
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

  /**
   * `agent_start` at agent epoch `epoch` failed on `host`. It never releases the record (an older
   * brain on that host may still run, and the refusal's own exit is owed until it has gone, A4): it
   * records the retry (an intent, up to `MAX_START_ATTEMPTS`, or `errored`) and condemns the brain
   * at that epoch, so its host kills anything at or below it and the exit or the host's loss
   * releases it.
   */
  async startFailed(host: string, error: { code: string; message: string; retryable?: boolean }, epoch?: number): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    const b = info.brain;
    if (!b || b.host !== host || epoch === undefined || epoch !== b.epoch) return;
    console.warn(`agent ${info.agent}: start on ${host}@${epoch} failed: ${error.code} ${error.message}`);
    // The retry (or `errored`) and the condemn are one step, with both alarms armed in it.
    const { patch, retry } = startFailure(info, epoch, !!error.retryable);
    const condemned = this.condemn(`its start failed (${error.code})`, epoch, patch);
    const armed = retry ? this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true) : undefined;
    await Promise.all([condemned, armed]);
  }

  /**
   * A brain on `host` exited at agent epoch `epoch` (rule 3: releases the record only at its epoch
   * or later). Without an epoch (FleetDO's row for that host has none: stored by the previous
   * release) the exit proves nothing about which start it was, but it isn't ignored: the brain is
   * condemned, and escalation proves it gone (its kill processed, no start left indexed there).
   */
  async onExited(host: string, reason: AgentExitReason, epoch?: number): Promise<void> {
    if (!this.exists()) return;
    await this.hook("exited:enter");
    const rec = this.load();
    // A brain on a host of the previous release is released only by that host's loss: its exits
    // (without an epoch, or one FleetDO filled in) prove nothing.
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

  /**
   * The host running this brain is lost (dead, or expired: its lease lapsed, and nestd refused or
   * killed every start it held). Releases the record only if `epoch` (the index row's; absent for a
   * row stored by the previous release) is at or above it, and FleetDO still reports the host lost
   * now. A brain follows its own host, never its sandbox.
   */
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

  /**
   * Input from outside the agent arrived (a turn, an inbox message, a merged delivery): a stop before
   * it no longer quiets wakes. Not called for the platform's `system` notes about the agent's own
   * work (a sandbox move, a background task's exit): they are not new work.
   */
  private inputArrived(): void {
    if (this.load().stop_quiet) {
      this.update((i) => {
        delete i.stop_quiet;
      });
    }
  }

  /**
   * Start a brain for waiting work (a queued turn, or the turn it was in the middle of) when it has
   * none, through the intent. A condemned brain's intent waits for its release. Never throws:
   * callers are queuing work, which stays queued (a failure retries from the alarm). `afterExit`
   * applies the crash-loop guard (exits are counted where they happen, once); new input always
   * gets a fresh try.
   */
  private async wake(afterExit = false): Promise<void> {
    const info = this.load();
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
      // Condemned: runs once it is released. Its escalation is armed.
      if (!this.deadlines.has("condemned")) await this.deadlines.set("condemned", Date.now(), true);
      return;
    }
    try {
      await this.runIntent(false);
    } catch (e) {
      console.warn(`agent ${info.agent}: wake failed`, e);
    }
  }

  /**
   * The host reported this brain in its hello (e.g. after a nestd restart). A brain the record
   * doesn't place on that host is an orphan (N1 backstop: one whose record was released or moved
   * while it ran): it is killed there, at the highest agent epoch issued, so nothing of the agent
   * at or below it runs there.
   */
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

  /**
   * The bound sandbox got a new lease (and maybe a new host). The brain survives it: nothing is
   * restarted or reconnected, and the agent epoch stays. Its cached target is refused at its next
   * hands call, and it resolves fresh hands (the new placement and binding) through `hands_resolve`.
   * A brain that isn't running starts now if work is waiting, since its sandbox has a host again.
   */
  async onSandboxMoved(sandbox: string, epoch: number, host: string | null): Promise<void> {
    if (!this.exists()) return;
    await this.hook("sandboxMoved:enter");
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) return;
    this.update((i) => {
      i.hands_moved_ms = Date.now();
    });
    if (!host) return;
    // Mid-turn, the brain hears what the restore lost now (an inbox message, queued reliably even
    // without a live session). Otherwise its next turn starts with it: `pump` compares the sandbox's
    // epoch with the one it was last told about.
    if (info.current_turn && info.told_sandbox_epoch !== undefined && info.told_sandbox_epoch !== epoch) {
      const note = await this.movedNote(info);
      // Only forward: a newer move told meanwhile (another notice, or a turn's start) says it all.
      let news = false;
      this.update((i) => {
        news = (i.told_sandbox_epoch ?? -1) < epoch;
        if (news) i.told_sandbox_epoch = epoch;
      });
      if (news) await this.postInbox(SYSTEM_SENDER, note);
    }
    // Never a start from here: this may run inside a start that placed the sandbox. The alarm wakes
    // a stopped brain with work waiting, now that its sandbox has a host.
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

  /**
   * The runner's binding aged out or a gateway refused it: a fresh target from SandboxDO, or the
   * reason there is none now. The target travels only here, AgentDO to runner; never through a
   * host command (docs/interfaces/gateway/).
   */
  private async resolveHands(request: string): Promise<AgentToRunner> {
    const info = this.load();
    if (!info.hands) return handsResolved(request, { status: "error", error: errorBody(ErrorCodes.NOT_BOUND, "agent has no hands") });
    const stub = this.sandboxStub(info.hands.sandbox);
    try {
      // A sandbox left unplaced (evicted, suspended, from a host going away while nobody worked in
      // it) is placed on demand: its brain keeps running across the move, so no start places it.
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
    // Only the host of the agent's brain record, in the agent's cell, while that host is live. A
    // condemned brain may still connect: its hello is stale, so its bytes go to the orphan branch.
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
      this.send(ws, { type: "tools_list", request: msg.request, tools: toolDefs(info.tools) });
      return;
    }
    if (msg.type === "hands_resolve") {
      // Only the current runner process at the current epoch gets a target: a superseded or stale
      // brain must never hold a binding for the new epoch.
      if (!this.current(pre)) {
        this.send(ws, handsResolved(msg.request, { status: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "not the current runner process or epoch") }));
        return;
      }
      const answer = await this.resolveHands(msg.request);
      await this.hook("resolveHands:afterResolve");
      // A newer start may have been issued, or the brain condemned, while resolving: never hand a
      // brain that isn't current a binding.
      if (!this.current(ws.deserializeAttachment() as Attachment)) {
        this.send(ws, handsResolved(msg.request, { status: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "not the current runner process or epoch") }));
        return;
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
    // The live brain's current session went away: if no session and no exit follow, it is condemned.
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

  /**
   * A message from a socket that isn't the current runner process at the current agent epoch is
   * ignored: once a start issued a newer epoch, the older brain's session gets nothing (no tool call
   * runs, no event applies, no binding) even before the new brain's hello supersedes it.
   */
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
    ws.serializeAttachment({ host: att.host, epoch: hello.epoch, helloed: true, stale, instance: hello.instance_id } satisfies Attachment);
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
      // A different session file than the one being received: start a new receive stream; the
      // committed base stays resumable until the new one is durable.
      if (hello.session && i.recv_session && hello.session !== i.recv_session) {
        i.recv_base = Math.max(i.recv_base, i.base_gen) + 1;
        i.recv_durable = 0;
        i.received_bytes = 0;
        i.recv_session = hello.session;
      } else if (hello.session && !i.recv_session) {
        i.recv_session = hello.session;
        if (i.recv_base === i.base_gen && !i.session) i.session = hello.session;
      }
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
    this.pushCache();
    await armed;
    // Re-assert working to SandboxDO: a call lost before this session must not outlive it.
    await this.syncActivity(true);
    await this.pump();
  }

  /**
   * A turn whose brain restarted mid-turn comes back first, as a recovery turn: the one way an
   * interrupted turn continues (the runner never sets `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, so the two
   * can't both continue it). Its notes say what the model can't know from its transcript: where the
   * durable transcript ends (actions after that may have taken effect without appearing in it). Whether
   * the sandbox was restored meanwhile is `pump`'s to say, when the turn starts.
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
      const i2 = this.update((i) => {
        i.recv_base = Math.max(i.recv_base, i.base_gen) + 1;
        i.recv_durable = 0;
        i.received_bytes = 0;
        i.recv_session = seg.session;
      });
      this.sql.exec("DELETE FROM seg_buffer WHERE base < ?", i2.recv_base);
    } else {
      const cur = this.load();
      if (cur.recv_session && seg.session !== cur.recv_session) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, `segment for session ${seg.session}, expected ${cur.recv_session}`);
      }
      if (!cur.recv_session) {
        this.update((i) => {
          i.recv_session = seg.session;
          if (i.recv_base === i.base_gen && !i.session) i.session = seg.session;
        });
      }
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
   * Write the receive stream's buffered bytes to R2 as one segment object, then (and only then) ack
   * the new durable offset. A pending base becomes the committed base once it is durable and caught up.
   */
  async flush(): Promise<void> {
    // Single-flight: two flushes reading the same rows would write one R2 key twice, and the slower,
    // shorter put could land last, losing bytes already acked. A flush called during one waits for it,
    // then writes what is left.
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
    // Every event on a session speaks for the epoch its hello presented (the runner stamps them so).
    if (this.inOrder(seq) === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      return;
    }
    for (const ev of events) {
      // Rule 1 after every await: a brain condemned or superseded mid-batch applies nothing more,
      // and the batch is not acked.
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
    // Redundant with `current()` (the session's epoch is the current one), kept as a cheap guard
    // against a runner that stamps an event with another epoch than its session's.
    if (ev.agent !== before.agent || ev.epoch !== sessionEpoch) return;
    // The event is recorded as seen only after its side effects succeeded: if one throws, the batch
    // isn't acked and the resend runs them again. Each is safe to repeat: the state change, the keyed
    // ingest, `postAsk` (keyed by call) and `syncActivity` (a "set to", compared with what was sent).
    if (this.sql.exec("SELECT 1 FROM events WHERE seq = ?", ev.seq).toArray().length) return;
    const completed = ev.type === "turn_completed" && !!ev.turn && ev.turn === before.current_turn;
    // An event stamped with a turn other than the current one belongs to a turn already over: the
    // runner reports a turn's `idle` after its `turn_completed`, by which time the next turn may be
    // running, and that `idle` must not stand for it. Unstamped events (between turns) count.
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
        default:
          break;
      }
    });
    // Reported on `<agt>/events` in the same step (queued; posted from the alarm). Never a brain decision.
    this.reportEvent(info, ev, completed, stale);
    if (ev.type === "rate_limited") {
      await this.workstream(info.workstream).ingest({
        workstream: info.workstream, ts_ms: ev.ts_ms, agent: info.agent, type: "quota_parked",
        ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
      }, `${info.agent}/${info.runner_instance ?? ""}/ev${ev.seq}`);
    } else if (ev.type === "inbox_delivered") {
      if (this.queue.confirm(ev.message)) this.pushCache();
    } else if (ev.type === "escalation") {
      // The runner already denied the call with "pending approval (request <call>)": record an
      // async ask; the answer becomes the agent's next turn.
      const input = JSON.stringify(ev.input ?? null);
      const question = `Allow ${ev.tool}? (request ${ev.call}) input: ${input.length > 500 ? `${input.slice(0, 500)}…` : input}`;
      await this.postAsk(info, ev.call, ev.epoch, question, "async", "escalation");
    }
    await this.syncActivity();
    if (completed) {
      this.pushCache();
      await this.pump();
    }
    this.sql.exec("INSERT OR IGNORE INTO events (seq, body) VALUES (?, ?)", ev.seq, JSON.stringify(ev));
    this.sql.exec("DELETE FROM events WHERE seq < ?", ev.seq - 500);
  }

  // ---------------------------------------------------------------------------------------------
  // Turns, inbox, interrupt, caches
  // ---------------------------------------------------------------------------------------------

  /** Queue a turn. A retried submission with the same `requestId` gets the same turn, queued once. */
  async enqueueTurn(input: TurnInput, requestId?: string, tainted = false, external = true): Promise<string> {
    // Never write a turn into an AgentDO that was never created (e.g. a subscriber id that names nobody).
    if (!this.exists()) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    const prior = requestId ? this.queue.turnFor(requestId) : undefined;
    if (prior) return prior;
    const turn = this.queue.enqueue(input, requestId);
    // Another agent's text (a workstream batch) reaches the model inline: the session is tainted.
    if (tainted) this.kvPut("read_tainted", true);
    if (external) this.inputArrived();
    await this.pump();
    await this.wake();
    return turn;
  }

  /** Send the next queued turn when the runner is connected and no turn is running. */
  private async pump(): Promise<void> {
    if (!this.socket() || this.load().current_turn) return;
    // Synchronous from the check above: no other pump can claim a turn in between.
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
    // What a sandbox move lost comes first (`moveNoteDue`).
    const due = !!info.hands && moveNoteDue({ epoch, told: info.told_sandbox_epoch, continued, movedMs: info.hands_moved_ms });
    const note = due ? await this.movedNote(info) : null;
    await this.hook("pump:beforeSend");
    // Re-checked after the awaits: a new runner process may have recovered this turn meanwhile, and
    // its recovery turn is current now. Sending this one too would run its work twice.
    if (this.load().current_turn !== turn) return;
    if (epoch !== null) {
      const e = epoch;
      // Only forward: a move notice sent during the awaits above told the brain of a newer epoch.
      this.update((i) => {
        i.told_sandbox_epoch = Math.max(i.told_sandbox_epoch ?? e, e);
      });
      // Best effort: without it, a recovery turn of this one falls back to the last move AgentDO heard of.
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
   * Mid-turn: pushed to the runner and mirrored in its hook cache; one it never confirms showing the
   * model comes back as a turn when the turn completes (`TurnQueue.complete`). Between turns: becomes
   * the next `inbox` turn. `interrupt` interrupts the running turn first. A retried post with the same
   * `requestId` gets the same message, delivered once.
   */
  async postInbox(from: string, text: string, interrupt = false, requestId?: string, tainted = false): Promise<string> {
    const prior = requestId ? this.queue.messageFor(requestId) : undefined;
    if (prior) return prior;
    const info = this.load();
    const message: InboxMessage = { id: newId("msg_"), from, text, interrupt, ts_ms: Date.now() };
    // Another agent's text reaches the model inline (stdin, the Stop hook, or a turn): when it may be
    // tainted, so is this session from now on (written with the message, in this step).
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
  // Channels (docs/channels/): deliveries in, `<agt>/events` out. Deliveries enter through the
  // turn queue and inbox exactly as any other input does (`enqueueTurn` / `postInbox`): nothing
  // here touches the brain record, the intent or the session's currency.
  // ---------------------------------------------------------------------------------------------

  private kvGet<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private kvPut(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  /** The session's taint as far as it is tracked (lib/channels.ts `sessionTaint`). */
  private tainted(info: AgentInfo): boolean {
    return sessionTaint({ hands: !!info.hands, builtin_tools: info.launch.builtin_tools, read_tainted: this.kvGet<boolean>("read_tainted") ?? false });
  }

  /** This agent as a channel caller: its identity and grants, from its own record, never from a tool's arguments. */
  private channelCaller(info: AgentInfo): Caller {
    return { principal: info.agent, owner: info.owner, sandbox: info.hands?.sandbox ?? null, grants: info.channel_grants, tainted: this.tainted(info) };
  }

  /** For another agent's built-in channel, that agent's owner (read from it, so a `{child}` grant or a spawner's read can be decided). */
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

  /**
   * Queue a runner event's report on `<agt>/events` (synchronous; idempotent per runner lineage and
   * event). A state change from a finished turn (`stale`) changed no state, so it isn't reported.
   */
  private reportEvent(info: AgentInfo, ev: AgentEvent, completed: boolean, stale: boolean): void {
    const idem = `${info.agent}/ev/${info.runner_instance ?? ""}/${ev.seq}`;
    const channel = `${info.agent}/events`;
    if (ev.type === "assistant_text") {
      this.kvPut("last_text", clip(ev.text, EVENT_TEXT_BYTES));
    } else if (ev.type === "turn_started") {
      // A turn without text of its own never reports the previous turn's.
      this.kvPut("last_text", "");
    } else if (ev.type === "state_changed" && !stale) {
      this.outbox.push(channel, { kind: "state_changed", text: `state: ${ev.state}`, data: { state: ev.state, epoch: ev.epoch }, idem_key: idem },
        { tainted: false, agent_owner: info.owner });
    } else if (ev.type === "turn_completed" && completed) {
      // The final text is the model's: it carries the session's taint.
      const text = this.kvGet<string>("last_text") ?? "";
      this.outbox.push(channel, {
        kind: "turn_completed", text: text || `turn ${ev.turn} completed (${ev.stop_reason})`,
        data: { turn: ev.turn, stop_reason: ev.stop_reason, ...(ev.usage ? { usage: ev.usage } : {}) }, idem_key: idem,
      }, { tainted: this.tainted(info), agent_owner: info.owner });
    } else if (ev.type === "escalation") {
      this.outbox.push(channel, { kind: "escalation", text: `asked to approve ${ev.tool} (request ${ev.call})`, idem_key: idem },
        { tainted: false, agent_owner: info.owner });
    } else if (ev.type === "rate_limited") {
      this.outbox.push(channel, { kind: "quota_parked", text: "parked by a rate limit", idem_key: idem }, { tainted: false, agent_owner: info.owner });
    }
  }

  /**
   * Queue a brain release on `<agt>/events` (synchronous). `exited` means the agent stopped: the
   * release restarts nothing (a stop, an auth failure, an unknown exit) and no start is wanted; it
   * carries the last text the brain produced. Any other release (an idle exit, a move, a host's
   * loss, a crash it restarts from) is platform housekeeping: `brain_released`, outside the
   * spawner's default filter, with no text.
   */
  private reportExit(info: AgentInfo, host: string, epoch: number, reason: AgentExitReason, ends: boolean): void {
    const terminal = ends && !info.intent;
    const idem_key = `${info.agent}/exit/${host}/${epoch}`;
    if (terminal) {
      const last = this.kvGet<string>("last_text") ?? "";
      this.outbox.push(`${info.agent}/events`, { kind: "exited", text: last || `stopped (${reason})`, data: { reason, epoch, host }, idem_key },
        { tainted: this.tainted(info), agent_owner: info.owner });
    } else {
      this.outbox.push(`${info.agent}/events`, { kind: "brain_released", text: `brain released (${reason})`, data: { reason, epoch, host }, idem_key },
        { tainted: false, agent_owner: info.owner });
    }
  }

  /** Whether `owner`'s spec has the `read` tool (its spec is fixed at spawn, so the answer is kept). */
  private async ownerReads(owner: string): Promise<boolean> {
    // A yes is kept (a spec's tools never shrink); a no only for `OWNER_READS_NO_MS`, so a later
    // grant of `read` (stage 2) is seen.
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
   * A ChannelDO delivers one subscription's batch (at least once; the same range on every retry).
   * Deduplicated by the subscription's high-water seq; then a platform notice (the wake envelope):
   * mid-turn, a notice from the agent's own inbox joins the inbox stream; anything else is queued as
   * the next turn, which starts a brain if none runs, exactly as any queued turn does. The loop guards answer `defer` (the channel keeps
   * the messages and retries, coalescing): at most 60 subscription-started turns an hour, and at most
   * 50 waiting. The high-water mark and the turn or inbox row are written in one synchronous step.
   */
  async deliverChannel(d: ChannelDelivery): Promise<DeliveryOutcome> {
    if (!this.exists()) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    const now = Date.now();
    const info = this.load();
    const reads = info.tools.includes("read");
    // A notice tells the model to `read`. An agent without the tool takes a batch only as far as
    // its user messages arrive inline (`inline_to`; the first always does), with an envelope of
    // those alone; the rest of the range comes as the next batch. Other posters' messages it can't
    // act on are taken without a notice, and counted (`skipped`, `skipped_to`) so stage 2, which
    // gives every agent `read` on its own built-ins, can point it at them.
    const upTo = reads ? d.batch.to_seq : Math.min(d.batch.inline_to ?? d.batch.to_seq, d.batch.to_seq);
    const ack: DeliveryOutcome = upTo < d.batch.to_seq ? { status: "ok", up_to: upTo } : { status: "ok" };
    // Deduplicated first (a retry of a batch already taken is acknowledged whatever the guards say).
    const hw = this.sql.exec<{ hw: number }>("SELECT hw FROM channel_subs WHERE channel = ? AND sub = ?", d.channel, d.subscription).toArray()[0]?.hw;
    if (hw !== undefined && hw >= upTo) return ack;
    const shown: ChannelDelivery = reads ? d : {
      ...d,
      batch: {
        ...d.batch, to_seq: upTo, count: d.batch.inline.length, first_seq: d.batch.inline[0]?.seq ?? upTo, last_seq: d.batch.inline.at(-1)?.seq ?? upTo,
        senders: d.batch.inline.length ? [{ from: "user", n: d.batch.inline.length }] : [], kinds: [], tainted: 0,
      },
    };
    const skipped = !reads && d.batch.count > d.batch.inline.length;
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
    // Each admits synchronously before its first await (the row is written in this step, with the
    // high-water mark). A merge or a queued turn wakes the agent, as any new input does (a stopped
    // or errored brain gets its fresh try, Q1/Q6).
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
   * In order with the runner's other reliable messages. The call's seq is marked processed only after
   * the call ran (or is waiting for an ask), so a call cut short by an eviction is redelivered and run
   * again. Every write a tool makes to another object carries the key `<agent>/<epoch>/<call>`, which
   * the target applies once, so a re-run repeats no side effect.
   */
  private async onToolCall(ws: WebSocket, att: Attachment, call: Extract<RunnerToAgent, { type: "tool_call" }>): Promise<void> {
    const verdict = this.admitCallMessage(ws, att, call.seq);
    if (!verdict) return;
    // Its own epoch's row and key (`CallLedger.call`), still fenced by this session's epoch.
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
      // Idempotency on (agent, epoch, call): a redelivered call gets the stored outcome.
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

  /**
   * The runner gave up on a call and told the model its outcome is unknown. A call that hasn't run
   * (or was cut short by an eviction) never runs; a call waiting in an `ask` sync window stops
   * waiting, and the answer, if one comes, arrives as a turn. Idempotent; no `tool_result` is sent.
   */
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

  /**
   * A call message's admission (`tool_call`, `cancel_call`): a stale session is told, one that isn't
   * current is ignored (null either way), a gap throws; otherwise whether it's new.
   */
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
   * `sandboxEpoch`: the sandbox epoch FleetDO's lease check verified for a host-relayed call (guest
   * CLI); without it, events about the sandbox read the epoch from SandboxDO.
   */
  private async dispatch(epoch: number, call: string, name: string, args: unknown, sandboxEpoch?: number, fence: number = epoch): Promise<DispatchResult> {
    // A host-relayed call (guest CLI, `sandboxEpoch` set) is fenced by FleetDO's lease check on the
    // sandbox; it isn't the brain's, so the agent epoch doesn't fence it (a brain start mid-call
    // must not fail it).
    const guest = sandboxEpoch !== undefined;
    const info = this.load();
    const def = toolDef(name);
    if (!def) throw new NestError(ErrorCodes.UNKNOWN_TOOL, `unknown tool ${name}`);
    if (!info.tools.includes(name)) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${name} is not granted to this agent`, 403);
    }
    const a = validateArgs(def.input_schema, args);
    const text = (t: string): ToolOutcome => ({ status: "ok", content: [{ type: "text", text: t }] });
    // Idempotency key for this call's writes to other objects (see onToolCall). A guest call is
    // keyed by the sandbox lease it was relayed under.
    const key = guest ? `${info.agent}/s${sandboxEpoch}/${call}` : `${info.agent}/${epoch}/${call}`;
    // A newer brain start, or a condemn, may land during any await: no write goes out for a brain
    // that isn't current.
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
          // Only within the workstream, the owner and the subscriber included: a prompt-injected
          // agent can't reach others.
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
        // Keyed by `key`: a re-run lands once (posts by idempotency key, a cursor read reads the same page).
        return await this.channelTool(info, name, a, key, live);
      default:
        throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${name} is not implemented yet`, 501);
    }
  }

  /**
   * The task ledger tools (docs/control-plane/durable-objects/tasks/). They act on the one ledger the
   * agent's spec names (its `ledger` param); a `ledger` argument must name that one. Privilege is the
   * tool: dispatch checked it against the spec, and each tool asks for exactly the operation `TOOL_OPS`
   * names (checked again before the write). Other agents' specs (an assignee, a watcher) are read
   * here, before the ledger is called, so the ledger never calls into an AgentDO mid-call.
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
    /** The caller, with its session's taint read now (after any await: a read that tainted it meanwhile counts). */
    const actor = (): Actor => ({ kind: "agent", agent: info.agent, ledger, tainted: this.tainted(this.load()) });
    const stub = ledgerStub(this.env, ledger);
    /** A result holding text a tainted session wrote taints this session (sticky; docs/agents/tools/#taint-and-sinks). */
    const seen = <T extends { tainted: boolean }>(r: T): T => {
      if (r.tainted) this.kvPut("read_tainted", true);
      return r;
    };
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    /** A nullable argument: a string, null, or absent (undefined). */
    const strOrNull = (k: string) => (a[k] === null ? null : str(k));
    const int = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
    const task = () => String(a.task);
    const out = (line: string, value: unknown): ToolOutcome => ({ status: "ok", content: [{ type: "text", text: line }, { type: "json", value }] });
    const line = (t: TaskView) => `${t.key} [${t.status}${t.priority === "none" ? "" : `, ${t.priority}`}] ${t.title}` +
      `${t.assignee ? ` (${t.assignee})` : ""} v${t.version}`;
    /** An agent's grant as its spec states it (null: nobody). */
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

  /**
   * Who `notify` to `captain` reaches: the owner when there is one, else whoever reads the agent's
   * escalation channel (the workstream channel's subscriber, or the user).
   */
  private async captainOf(info: AgentInfo): Promise<string | null> {
    if (info.owner) return info.owner;
    if (info.escalate_to === "user") return "user";
    return (await this.workstream(info.workstream).info()).subscriber;
  }

  /**
   * Record an ask and route the question to the user, or to the agent's escalation channel (`ask`
   * to `captain`, approvals): the workstream channel (`needs_input`) or the user, as its spec says.
   * `sync`: a tool call waits for it (until the sync-window deadline). `cli`: a guest `nest ask` waits
   * in memory. `async`: nothing waits; the answer becomes the next turn.
   */
  private async postAsk(
    info: AgentInfo, call: string, epoch: number, question: string, status: "sync" | "cli" | "async", to: "escalation" | "user",
    sandboxEpoch?: number, fence: number = epoch,
  ): Promise<string> {
    // Re-run for the same call (after an eviction, or an event resent because routing failed): the
    // same ask, routed again under the same key, which the workstream applies once.
    const prior = this.calls.askOf(call, epoch);
    if (prior?.status === "answered") return prior.ask;
    const ask = prior?.ask ?? newId("ask_");
    const deadline = prior?.deadline ?? Date.now() + num(this.env.ASK_SYNC_WINDOW_MS, 120_000);
    if (!prior) this.calls.recordAsk({ ask, call, epoch, question, status, deadline });
    if ((prior?.status ?? status) === "sync") await this.deadlines.set(`${ASK_DEADLINE}${ask}`, deadline);
    const q = prior?.question ?? question;
    // The brain's own asks are fenced by its epoch; a guest's (`sandboxEpoch`) by FleetDO's lease check.
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
   * A `nest` CLI command from a program in this agent's sandbox (relayed guest → nestd → FleetDO),
   * mapped onto the platform tools of the same name. `epoch` is the sandbox's: FleetDO relays the
   * command only from the host holding that lease (`holds()`), which is the fence; AgentDO holds no
   * copy to compare. Its writes are keyed by that sandbox lease, never fenced by the agent epoch: a
   * brain start landing mid-call doesn't fail it.
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

  /**
   * A background hands task exited, relayed by FleetDO only from the host holding the sandbox's lease
   * at `epoch` (`holds()` is the fence; AgentDO holds no copy of the sandbox epoch). Surfaced mid-turn.
   */
  async onTaskExited(sandbox: string, _epoch: number, task: TaskInfo): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) return;
    const how = task.status === "exited" ? `exited with code ${task.exit_code ?? "?"}` : task.status.replace("_", " ");
    const what = task.description ? `${task.task_id} (${task.description})` : task.task_id;
    // Only interesting while the agent is working; otherwise it reads TaskOutput when it next looks.
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
    if (route === "waiter") {
      waiter!(answer);
      return "sync";
    }
    if (row.status === "sync") {
      // The call stops waiting: its result if its brain still waits for it, else ended unsent (the
      // answer becomes a turn).
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
    // One handler per key: a key with none doesn't compile (`AgentDeadline`).
    const handlers: Record<AgentDeadline, () => Promise<void>> = {
      flush: () => this.flush(),
      starting: () => this.unresponsiveBrain("starting"),
      no_session: () => this.unresponsiveBrain("no_session"),
      activity: () => this.syncActivity(),
      wake: () => this.wake(),
      // A release's wake, counted by the crash-loop guard (a no-op once the inline wake started one).
      wake_after_exit: () => this.wake(true),
      condemned: () => this.escalate(),
      intent: async () => {
        try {
          await this.runIntent(true);
        } catch (e) {
          // Kept (or dropped) by `intentFailed`, which armed any retry.
          console.warn(`agent ${this.load().agent}: running the start intent failed`, e);
        }
      },
      [OUTBOX_DEADLINE]: () => this.outbox.flush(),
      prune: async () => {
        this.prune();
        await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS);
      },
    };
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key.startsWith(ASK_DEADLINE)) return this.askWindowLapsed(key.slice(ASK_DEADLINE.length));
      const run = handlers[key as AgentDeadline] as (() => Promise<void>) | undefined;
      if (run) await run();
      else console.error(`agent ${this.load().agent}: no handler for deadline ${key}; dropped`);
    }, 5_000, [OUTBOX_DEADLINE]);
  }

  /**
   * A brain that went unresponsive (`unresponsive`): no hello since `agent_start` within the start
   * deadline (the command was lost, or the host never ran it), or a live brain with no session and
   * no exit for `NO_SESSION_MS`. Condemned (its host kills it, or refuses it under the kill's
   * tombstone; its escalation proves it gone), and woken for waiting work once it is released.
   */
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

  /** A `sync` ask's window lapsed unanswered: the call answers `pending`, and the answer comes as a turn. */
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

  /** Bounded growth: finished calls, asks, turns and inbox messages older than a week go away. */
  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.calls.prune(cutoff);
    this.queue.prune(cutoff);
    // An ended (`once`) subscription's dedup row, after its retries are long over.
    this.sql.exec("DELETE FROM channel_subs WHERE ended = 1 AND created_ms < ?", cutoff);
  }
}

/**
 * Minimal JSON-schema check for platform tool arguments: object, required keys, no additional
 * properties, primitive types (one, or a list such as `["string", "null"]`), enums, numeric bounds
 * and array item types.
 */
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
