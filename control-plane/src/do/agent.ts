// AgentDO: authority for one agent (docs/control-plane/durable-objects/agent/). The session WebSocket
// (docs/interfaces/control-host/session/): native session segments into R2 (acked by offset only once
// durable), canonical events and state, the turn queue, inbox and interrupts, caches for local hook
// answers, and the platform tool relay.
//
// Concurrency: the input gate opens across awaits on R2 and other Durable Objects, so state is never
// saved from a copy loaded before an await (`update()` loads, mutates and saves synchronously), and
// inbound session messages are processed one at a time, in order (`SerialQueue`).
import { DurableObject } from "cloudflare:workers";
import { num, type Env } from "../env";
import { toolDef, toolsFor } from "../lib/registry";
import { Deadlines, ReliableChannels, SerialQueue } from "../lib/reliable";
import { signBlobUrl } from "../lib/tokens";
import { asNestError, b64ToBytes, concatBytes, errorBody, NestError, newId } from "../lib/util";
import {
  type AgentCache, type AgentExitReason, type AgentStart, type AgentToRunner, handsResolved, type InboxMessage,
  type LaunchConfig, RunnerToAgent, type SegmentRef, type ToolOutcome, type ToolRule, type TurnInput,
} from "../protocol/control";
import {
  type AgentEvent, type AgentRole, type AgentState, type CliCommand, type CliResult, ErrorCodes, type GenerationRecord, PROTOCOL_VERSION,
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
const MAX_START_ATTEMPTS = 3;
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
/**
 * Which exits restart the brain at once when work is waiting. A `Record` over every member, so a
 * new exit reason doesn't compile until it has a decision here.
 */
const RESTART_ON_EXIT: Record<AgentExitReason, boolean> = {
  idle: true, crashed: true, fenced: true, host_lost: true, stopped: false, auth_failed: false, unknown: false,
};
/** Restarts after an exit without a turn completing in between, before giving up (`errored`). */
const MAX_EXIT_RESTARTS = 3;
const RETENTION_MS = 7 * 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
/** read_transcript: entries per call by default / at most, and a response size cap. */
const TRANSCRIPT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_MAX_LIMIT = 500;
const TRANSCRIPT_MAX_BYTES = 256 * 1024;
const EMIT_EVENTS = ["progress", "blocked", "pr_opened", "completed", "failed"] as const;
/** Separates a recovery turn's notes from the original turn's text. */
const RECOVERY_MARK = "\nThe turn was:\n";
const iso = (ms: number) => new Date(ms).toISOString();

export const DEFAULT_RULES: ToolRule[] = [{ pattern: "mcp__nest__*", decision: "allow" }];
/** Workers' launch enables subagents (Claude Code's `Agent` tool, `Task` before 2.1); they run without an approval. */
export const DEFAULT_WORKER_RULES: ToolRule[] = [...DEFAULT_RULES, { pattern: "Agent", decision: "allow" }, { pattern: "Task", decision: "allow" }];
export const DEFAULT_WORKER_LAUNCH: LaunchConfig = {
  builtin_tools: ["TodoWrite", "Task", "WebSearch"],
  system_prompt: {
    mode: "append",
    text: "You work in a remote sandbox through the mcp__nest__* tools; they behave like Claude Code's built-ins.",
  },
};
export const DEFAULT_CAPTAIN_LAUNCH: LaunchConfig = {
  builtin_tools: [],
  system_prompt: { mode: "replace", text: "You are a nest captain. You act only through mcp__nest__* platform tools." },
};

export interface AgentInfo {
  agent: string;
  role: AgentRole;
  workstream: string;
  cell: string;
  captain: string | null;
  /**
   * The bound sandbox, by id only. Its epoch is SandboxDO's (read there when needed, and fenced by
   * FleetDO's lease check for host-relayed calls); AgentDO keeps no copy.
   */
  hands: { sandbox: string } | null;
  /**
   * The agent epoch: bumped by every `agent_start` (never reused), unrelated to the sandbox's epoch.
   * The brain presents it in its session hello; platform tool calls and asks are keyed by it and
   * events filtered by it. Rows stored before it existed carry the sandbox epoch the brain was
   * started with, which is where `load()` starts the counter.
   */
  agent_epoch: number;
  /**
   * The one brain this agent has, if any: the only authority for where it runs (see the brain
   * lifecycle section). Cleared only by its release (its exit at its epoch or later, or its host's
   * loss), or replaced by a same-host re-issue.
   */
  brain: Brain | null;
  /** The start someone wants (an operator, a wake, a drain, a retry): the only stored start request. */
  intent: StartIntent | null;
  /** The host the last released brain ran on: preferred for the next start while healthy (a warm session). */
  prev_host?: string;
  launch: LaunchConfig;
  grants: string[] | null;
  rules: ToolRule[];
  /** Session of the committed base (what `--resume` restores). */
  session: string | null;
  state: AgentState;
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
  start_attempts: number;
  /** Restarts after an exit since the last completed turn (crash-loop guard). */
  exit_restarts?: number;
  /** Consecutive starts condemned for want of a hello (backs off the `starting` deadline). */
  start_timeouts?: number;
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

/**
 * A brain start AgentDO issued: its host and agent epoch. `starting` until its session's hello,
 * then `live`; `condemned` once AgentDO wants it gone (none of its sessions is current from then
 * on), with the kill command FleetDO stored for it and when (absent while the kill is owed).
 */
export type Brain =
  | { phase: "starting" | "live"; host: string; epoch: number; since_ms: number }
  | { phase: "condemned"; host: string; epoch: number; since_ms: number; kill?: { cmd: string; ms: number } };

/** Who wanted a start. */
export type IntentReason = "operator" | "restart" | "wake" | "drain" | "retry";

/** A start someone wants: on a chosen host, or anywhere but a host going away. */
export interface StartIntent {
  host_hint?: string;
  avoid?: string;
  reason: IntentReason;
}

/** What `info()` answers: the stored record plus the brain's host (derived, never stored). */
export type AgentView = AgentInfo & { host: string | null };

/** The field of records stored by the previous release that the brain record replaces (`load()`). */
interface PreviousReleaseFields {
  host?: string | null;
}

/** Points where a test can force an interleaving (`testHooks`). */
export type HookPoint =
  | "intent:beforeCommit" | "resolveHands:afterResolve" | "dispatch:beforeWrite" | "sandboxMoved:enter" | "kill:beforeIssue"
  | "hostLost:enter" | "exited:enter" | "start:afterCommit" | "release:afterCommit" | "event:afterApply" | "escalate:afterProgress";

export interface CreateAgent {
  agent: string;
  role: AgentRole;
  workstream: string;
  cell: string;
  captain?: string | null;
  sandbox?: string | null;
  launch?: LaunchConfig;
  grants?: string[] | null;
  rules?: ToolRule[];
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

export class AgentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rel: ReliableChannels;
  private readonly deadlines: Deadlines;
  private readonly inbound = new SerialQueue();
  /** The run of the intent in flight (single-flight, in memory only: the intent itself is stored). */
  private intentRun: Promise<StartResult | null> | null = null;
  /** Someone stored an intent while a run was in flight: run again (from the alarm) once it ends. */
  private intentDirty = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS turns (turn TEXT PRIMARY KEY, ord INTEGER NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, created_ms INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL, turn TEXT,
      status TEXT NOT NULL, created_ms INTEGER NOT NULL DEFAULT 0)`);
    // status: dispatching (not finished; re-dispatched if redelivered after an eviction), waiting (an
    // ask; answered later), done (outcome stored).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tool_calls (epoch INTEGER NOT NULL, call TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatching', outcome TEXT, created_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (epoch, call))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS asks (ask TEXT PRIMARY KEY, call TEXT NOT NULL, epoch INTEGER NOT NULL,
      question TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, answer TEXT, created_ms INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS segments (base INTEGER NOT NULL, offset INTEGER NOT NULL, len INTEGER NOT NULL,
      key TEXT NOT NULL, PRIMARY KEY (base, offset))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seg_buffer (base INTEGER NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY (base, offset))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
    // Idempotent admission: a retried submission with the same request id gets the same turn / message.
    this.addColumn("turns", "request_id", "TEXT");
    this.addColumn("turns", "started_ms", "INTEGER");
    // The bound sandbox's epoch (read from SandboxDO) when the turn started: a recovery turn compares
    // it with the current one to say whether the sandbox moved meanwhile.
    this.addColumn("turns", "hands_epoch", "INTEGER");
    this.addColumn("inbox", "request_id", "TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS turns_request ON turns (request_id) WHERE request_id IS NOT NULL");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbox_request ON inbox (request_id) WHERE request_id IS NOT NULL");
    this.rel = new ReliableChannels(this.sql);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
    if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private load(): AgentInfo {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0];
    if (!row) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    const info = JSON.parse(row.value) as Partial<AgentInfo> & AgentInfo & PreviousReleaseFields;
    // Stored before the agent epoch: `hands.epoch` was the session epoch of the running brain.
    const legacy = info.hands as { sandbox: string; epoch?: number } | null;
    const agentEpoch = info.agent_epoch ?? legacy?.epoch ?? 0;
    const { host, ...rest } = info;
    let brain = info.brain;
    let migrated = false;
    if (brain === undefined) {
      // Stored by the previous release: `host` was the brain's host, and it kept it after the brain
      // exited (detached or errored). Such a brain may or may not still run, so it is condemned:
      // its kill and escalation prove it gone. Any other is live (or starting). Migrated once, and
      // persisted with its alarm, below.
      brain = null;
      if (host) {
        const doubtful = info.state === "detached" || info.state === "errored";
        brain = doubtful
          ? { host, epoch: agentEpoch, phase: "condemned", since_ms: Date.now() }
          : { host, epoch: agentEpoch, phase: info.state === "starting" ? "starting" : "live", since_ms: Date.now() };
      }
      migrated = true;
    }
    const out: AgentInfo = {
      ...rest,
      brain,
      intent: info.intent ?? null,
      hands: legacy ? { sandbox: legacy.sandbox } : null,
      agent_epoch: agentEpoch,
      recv_base: info.recv_base ?? info.base_gen,
      recv_session: info.recv_session ?? info.session,
      recv_durable: info.recv_durable ?? info.durable_bytes,
      runner_instance: info.runner_instance ?? null,
      start_attempts: info.start_attempts ?? 0,
    };
    if (migrated) {
      this.save(out);
      // Each migrated record's alarm, armed with it (the rows are written now; the alarm set in
      // the background).
      const b = out.brain;
      if (b?.phase === "condemned") this.ctx.waitUntil(this.deadlines.set("condemned", Date.now(), true));
      else if (b?.phase === "starting") this.ctx.waitUntil(this.deadlines.set("starting", Date.now() + START_DEADLINE_MS, true));
      else if (b?.phase === "live") this.ctx.waitUntil(this.deadlines.set("no_session", Date.now() + NO_SESSION_MS, true));
    }
    return out;
  }

  private save(info: AgentInfo): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('info', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(info));
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
    let hands: AgentInfo["hands"] = null;
    if (req.role === "worker" && req.sandbox) {
      // A worker's cell and workstream are its sandbox's: its brain starts through that cell's FleetDO,
      // and its sandbox's secrets and events belong to that workstream. Checked before attaching.
      const stub = this.sandboxStub(req.sandbox);
      const cur = await stub.info();
      if (cur.cell !== req.cell || cur.workstream !== req.workstream) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE,
          `${req.sandbox} is in cell ${cur.cell}, workstream ${cur.workstream}; the worker must be too`, 409);
      }
      await stub.attach(req.agent);
      hands = { sandbox: req.sandbox };
    }
    if (this.exists()) return this.load();
    const info: AgentInfo = {
      agent: req.agent,
      role: req.role,
      workstream: req.workstream,
      cell: req.cell,
      captain: req.captain ?? null,
      hands,
      agent_epoch: 0,
      launch: req.launch ?? (req.role === "captain" ? DEFAULT_CAPTAIN_LAUNCH : DEFAULT_WORKER_LAUNCH),
      grants: req.grants ?? null,
      rules: req.rules ?? (req.role === "worker" ? DEFAULT_WORKER_RULES : DEFAULT_RULES),
      brain: null,
      intent: null,
      session: null,
      state: "detached",
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
    return { ...info, host: info.brain?.host ?? null };
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

  /**
   * Rule 1: a session at `epoch` is current iff there is a brain, it isn't condemned, and `epoch` is
   * its epoch. For one release a runner that predates the agent epoch presents `0` for an agent
   * without hands (that release's captains), and is accepted as before; current runners always
   * present the issued epoch (from 1).
   */
  private isCurrent(info: AgentInfo, epoch: number): boolean {
    const b = info.brain;
    return !!b && b.phase !== "condemned" && (epoch === b.epoch || (epoch === 0 && !info.hands));
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
    return !WAKE_STATES.includes(info.state) && (WORKING_STATES.includes(info.state) || info.current_turn !== null);
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
      if (!info.hands || info.role !== "worker") return;
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
  // runs on a lost host); or replaced by a same-host re-issue. Every transition arms the alarm that
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
    if (hostHint) {
      // An active, connected host of this cell, like `controllerHost` picks. Hands still go
      // through the sandbox's gateway.
      const st = await this.fleet(info.cell).hostStatus(hostHint);
      if (!st || st.status !== "active" || !st.connected) {
        throw new NestError(ErrorCodes.FORBIDDEN, `${hostHint} is not an active, connected host in ${info.cell}`, 409);
      }
    }
    await this.setIntent({ ...(hostHint ? { host_hint: hostHint } : {}), ...(avoid ? { avoid } : {}), reason: restart ? "restart" : "operator" });
    const r = await this.runIntent(true);
    return r ?? this.startStatus();
  }

  /** What a start that issued nothing answers: where the brain is, and what it waits for. */
  private startStatus(): StartResult {
    const info = this.load();
    const b = info.brain;
    if (b?.phase === "condemned") return { kind: "waiting", host: info.intent?.host_hint ?? null, cmd: null, waiting_for: b.host };
    return { kind: "none", host: b?.host ?? null, cmd: null };
  }

  /**
   * Merge a start request into the intent (the newer request's fields win; a host it avoids is
   * never also the hint), with a backstop alarm in the same step, so it runs even if nothing else
   * runs it (an eviction mid-start).
   */
  private async setIntent(patch: StartIntent): Promise<void> {
    this.update((i) => {
      const next: StartIntent = { ...(i.intent ?? {}), ...patch };
      if (patch.avoid && next.host_hint === patch.avoid) delete next.host_hint;
      if (patch.host_hint && next.avoid === patch.host_hint) delete next.avoid;
      i.intent = next;
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
   * - a brain on the target host (no hint elsewhere, not avoided): a same-host re-issue under a new
   *   epoch. Its host serializes the two: a live brain adopts the new epoch and keeps running (its
   *   launch config isn't re-applied; a stop, then a start, replaces it), and a stopping one is
   *   killed before the new one registers. A start without a hint never moves a live brain, least
   *   of all to follow its sandbox;
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
          // A brain that isn't condemned: never a second start for it (no same-host re-issue). It
          // moves (another hint, or its host avoided) or restarts (an operator's explicit restart)
          // by being condemned with the intent kept, which then starts once it is released (maybe
          // on the same host); any other start finds it running and answers `none`.
          const moves = (intent.host_hint !== undefined && intent.host_hint !== brain.host) || intent.avoid === brain.host || intent.reason === "restart";
          await this.hook("intent:beforeCommit");
          if (!this.unchanged(snap)) continue;
          if (moves) {
            await this.condemn(intent.reason === "restart" ? "restarting" : `starting on ${intent.host_hint ?? "another host"}`, brain.epoch);
            return this.startStatus();
          }
          this.update((i) => {
            i.intent = null;
          });
          await this.deadlines.clear("intent");
          return this.startStatus();
        }
        const host = await this.pickHost(snap, intent);
        const oauthRef = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).oauthTokenRef(snap.role);
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
    return JSON.stringify(now.brain) === JSON.stringify(snap.brain) && JSON.stringify(now.intent) === JSON.stringify(snap.intent);
  }

  /** Where a start with no brain goes (see `processIntent`). Throws when no host can take it now. */
  private async pickHost(info: AgentInfo, intent: StartIntent): Promise<string> {
    const fleet = this.fleet(info.cell);
    const healthy = async (h: string) => {
      const st = await fleet.hostStatus(h);
      return !!st && st.status === "active" && st.connected;
    };
    if (intent.host_hint) {
      if (!(await healthy(intent.host_hint))) {
        throw new NestError(ErrorCodes.FORBIDDEN, `${intent.host_hint} is not an active, connected host in ${info.cell}`, 409);
      }
      if (info.role === "worker" && info.hands) await this.sandboxStub(info.hands.sandbox).wake();
      return intent.host_hint;
    }
    let host: string | null;
    if (intent.avoid) {
      // Moving off a host that is going away: any other active, connected host (the sandbox, which
      // is leaving that host too, is not woken there).
      host = info.role === "worker" ? await fleet.otherHost(intent.avoid) : await fleet.controllerHost();
      if (host === intent.avoid) host = null;
    } else if (info.role === "worker") {
      if (!info.hands) throw new NestError(ErrorCodes.NOT_BOUND, "worker has no hands binding", 409);
      // Lazy start: a suspended sandbox resumes, an unplaced one is placed (maybe on a new host).
      // Without a host yet this fails retryably; the placement then wakes the agent.
      host = (await this.sandboxStub(info.hands.sandbox).wake()).host;
    } else {
      host = await fleet.controllerHost();
    }
    if (host && info.prev_host && info.prev_host !== host && info.prev_host !== intent.avoid && (await healthy(info.prev_host))) {
      host = info.prev_host;
    }
    // A host of the previous release (no brain epochs) only when no upgraded one can take it (N3).
    if (host && !(await fleet.hostStatus(host))?.current) {
      host = (await fleet.currentHost(info.role === "worker" ? null : "controller", intent.avoid)) ?? host;
    }
    if (!host) throw new NestError(ErrorCodes.CAPACITY_EXHAUSTED, "no host available for this agent", 503, true);
    return host;
  }

  /** The `starting` deadline: above the runner's budget before its hello, doubling per consecutive timeout. */
  private startDeadline(info: AgentInfo): number {
    return START_DEADLINE_MS * 2 ** Math.min(info.start_timeouts ?? 0, START_BACKOFF_STEPS);
  }

  /**
   * Commit a start on `host`: bump the agent epoch, record the brain `starting` (replacing a brain
   * there, for a same-host re-issue), consume the intent, and arm the `starting` deadline, all in
   * one synchronous step; then send `agent_start`. A send that fails may still have been queued, so
   * the brain is never just forgotten: it is condemned (its host refuses the start under the kill's
   * tombstone, or kills it) and the intent kept.
   */
  private async issueStart(host: string, oauthRef: string, resume: AgentStartBody["resume"], intent: StartIntent): Promise<StartResult> {
    const started = this.update((i) => {
      i.agent_epoch += 1;
      i.brain = { host, epoch: i.agent_epoch, phase: "starting", since_ms: Date.now() };
      i.intent = null;
      i.state = "starting";
    });
    const armed = Promise.all([
      this.deadlines.clear("intent"),
      this.deadlines.clear("no_session"),
      this.deadlines.set("starting", Date.now() + this.startDeadline(started)),
    ]);
    await this.hook("start:afterCommit");
    await armed;
    const epoch = started.agent_epoch;
    // Any other session (the replaced brain on this host, still flushing) is of an older epoch now:
    // `current()` refuses what it sends, and the new brain's hello supersedes it.
    const body: AgentStartBody = {
      agent: started.agent,
      role: started.role,
      workstream: started.workstream,
      epoch,
      ...(resume ? { resume } : {}),
      // `hands.epoch`: the same agent epoch again, for runners of the previous release (one release).
      ...(started.hands ? { hands: { sandbox: started.hands.sandbox, epoch } } : {}),
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
        // The start is still wanted: it runs again once this one is released.
        this.update((i) => {
          i.intent = i.intent ?? intent;
        });
        await this.condemn("its start could not be confirmed sent", epoch);
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
    const ne = asNestError(e);
    if (ne?.retryable ?? true) {
      await this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true);
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
      i.intent = null;
      if (!i.brain && (i.state === "starting" || i.state === "detached")) i.state = "errored";
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
  private async condemn(why: string, epoch: number): Promise<void> {
    let condemned: Brain | null = null;
    this.update((i) => {
      // Only the brain at `epoch` (N7): a record replaced meanwhile is not condemned by this call.
      if (i.brain && i.brain.phase !== "condemned" && i.brain.epoch === epoch) {
        i.brain = { host: i.brain.host, epoch: i.brain.epoch, phase: "condemned", since_ms: Date.now() };
        condemned = i.brain;
      }
    });
    if (!condemned) return;
    const armed = Promise.all([this.deadlines.set("condemned", Date.now(), true), this.deadlines.clear("starting"), this.deadlines.clear("no_session")]);
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
    const p = await this.fleet(info.cell).killProgress(b.kill.cmd, info.agent, b.host, b.epoch);
    await this.hook("escalate:afterProgress");
    // Decided only against the record it was asked for: one released or replaced meanwhile isn't wedged for.
    if (JSON.stringify(this.load().brain) !== JSON.stringify(b)) return;
    if (p.processed && !p.indexed) {
      await this.release(b.host, b.epoch, "stopped");
      return;
    }
    const age = Date.now() - b.kill.ms;
    const stuck = !p.processed && !p.host_processing && age >= EXIT_WAIT_MS;
    if ((stuck || age >= ESCALATION_CAP_MS) && !(await this.fleet(info.cell).hostStatus(b.host))?.current) {
      // A host of the previous release (no brain epochs) is never wedged for it (N3): its kill runs
      // in order and an epoch-less exit is matched conservatively, so a slow one isn't stuck. The
      // brain waits, and it is reported.
      console.error(`agent ${info.agent}: ${b.host}@${b.epoch} (a previous-release host) hasn't exited ${age} ms after its kill; waiting`);
    } else if (stuck || age >= ESCALATION_CAP_MS) {
      const why = stuck ? `${b.host} processed no command in the ${age} ms since the kill for ${info.agent}@${b.epoch}` : `${info.agent}@${b.epoch} outlived its kill by ${age} ms`;
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
    let released = false;
    const restarts = RESTART_ON_EXIT[reason] && reason !== "idle";
    const info = this.update((i) => {
      if (!i.brain || i.brain.host !== host || epoch < i.brain.epoch) return;
      // Counted once, where it happens (the crash-loop guard): here for a brain that ended on its
      // own; a condemned brain's exit is the condemn's outcome, counted by its cause if at all.
      if (restarts && i.brain.phase !== "condemned") i.exit_restarts = (i.exit_restarts ?? 0) + 1;
      i.prev_host = i.brain.host;
      i.brain = null;
      i.state = "detached";
      released = true;
    });
    if (!released) return false;
    const work = !!info.current_turn || this.sql.exec("SELECT 1 FROM turns WHERE status = 'queued' LIMIT 1").toArray().length > 0;
    const armed = Promise.all([
      this.deadlines.clear("condemned"),
      this.deadlines.clear("starting"),
      this.deadlines.clear("no_session"),
      info.intent ? this.deadlines.set("intent", Date.now(), true)
        : work && RESTART_ON_EXIT[reason] ? this.deadlines.set(reason === "idle" ? "wake" : "wake_after_exit", Date.now(), true) : Promise.resolve(),
    ]);
    await this.hook("release:afterCommit");
    await armed;
    console.log(`agent ${info.agent}: brain on ${host}@${epoch} released (${reason})`);
    this.fenceSessions(`brain released (${reason})`, host);
    await this.syncActivity();
    if (!info.intent && RESTART_ON_EXIT[reason]) await this.wake(restarts);
    return true;
  }

  /**
   * Stop the brain (an operator's request): it finishes its turn, and its exit releases it. A start
   * meanwhile re-issues it (same host) or condemns it; nothing about the stop is stored.
   */
  async stop(reason: string): Promise<void> {
    const info = this.load();
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
    const b = this.load().brain;
    if (!b || b.host !== host || b.phase === "condemned") return;
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
    const retry = !info.intent && error.retryable && info.start_attempts < MAX_START_ATTEMPTS;
    this.update((i) => {
      if (retry) {
        i.start_attempts += 1;
        i.intent = { reason: "retry" };
      } else if (!i.intent) {
        i.state = "errored";
      }
    });
    if (retry) await this.deadlines.set("intent", Date.now() + WAKE_RETRY_MS, true);
    await this.condemn(`its start failed (${error.code})`, epoch);
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
    if (epoch !== undefined) {
      await this.release(host, epoch, reason);
      return;
    }
    const b = this.load().brain;
    if (!b || b.host !== host || b.phase === "condemned") return;
    const counted = RESTART_ON_EXIT[reason] && reason !== "idle";
    if (counted) {
      this.update((i) => {
        i.exit_restarts = (i.exit_restarts ?? 0) + 1;
      });
    }
    await this.condemn(`an exit without an agent epoch (${reason})`, b.epoch);
    if (RESTART_ON_EXIT[reason]) await this.wake(counted);
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
   * Start a brain for waiting work (a queued turn, or the turn it was in the middle of) when it has
   * none, through the intent. A condemned brain's intent waits for its release. Never throws:
   * callers are queuing work, which stays queued (a failure retries from the alarm). `afterExit`
   * applies the crash-loop guard (exits are counted where they happen, once); new input always
   * gets a fresh try.
   */
  private async wake(afterExit = false): Promise<void> {
    const info = this.load();
    if (info.brain && info.brain.phase !== "condemned") return;
    const queued = this.sql.exec("SELECT 1 FROM turns WHERE status = 'queued' LIMIT 1").toArray().length > 0;
    if (!info.current_turn && !queued) return;
    if (afterExit && (info.exit_restarts ?? 0) > MAX_EXIT_RESTARTS) {
      this.update((i) => {
        i.state = "errored";
      });
      console.warn(`agent ${info.agent}: exited ${MAX_EXIT_RESTARTS} times without completing a turn; waiting for new input`);
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
      if (i.brain?.host === host && i.brain.phase !== "condemned" && i.state === "detached") i.state = state;
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
      this.update((i) => {
        i.told_sandbox_epoch = epoch;
      });
      await this.postInbox("system", note);
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
      this.send(ws, { type: "tools_list", request: msg.request, tools: toolsFor(info.role, info.grants ?? undefined) });
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
      if (i.state === "starting" || i.state === "detached" || i.state === "errored") i.state = "ready";
      if (i.brain && i.brain.phase === "starting") i.brain = { ...i.brain, phase: "live" };
      i.start_timeouts = 0;
    });
    const armed = Promise.all([this.deadlines.clear("starting"), this.deadlines.clear("no_session")]);
    this.sql.exec("DELETE FROM seg_buffer WHERE base < ?", info.recv_base);
    if (recovered) await this.requeueAsRecovery(recovered);

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
   * can't both continue it). It says what the model can't know from its transcript: where the durable
   * transcript ends (actions after that may have taken effect without appearing in it), and whether the
   * sandbox was restored from a saved generation meanwhile (changes after that are gone).
   */
  private async requeueAsRecovery(turn: string): Promise<void> {
    const row = this.sql.exec<{ input: string; started_ms: number | null; created_ms: number; hands_epoch: number | null }>(
      "SELECT input, started_ms, created_ms, hands_epoch FROM turns WHERE turn = ?", turn).toArray()[0];
    this.sql.exec("UPDATE turns SET status = 'interrupted' WHERE turn = ?", turn);
    if (!row) return;
    const orig = JSON.parse(row.input) as TurnInput;
    // A recovery turn that is itself interrupted keeps the original turn's text.
    const mark = orig.kind === "recovery" ? orig.text.indexOf(RECOVERY_MARK) : -1;
    const original = mark >= 0 ? orig.text.slice(mark + RECOVERY_MARK.length) : orig.text;
    const info = this.load();
    const notes = ["Your session restarted while you were working on a turn."];
    if (info.durable_ms) {
      notes.push(`Your saved transcript ends at ${iso(info.durable_ms)}. Anything you did after that may be missing from it but may still have taken effect: check the workspace (e.g. git status) before redoing work.`);
    }
    const started = row.started_ms ?? row.created_ms;
    // Moved during the turn: SandboxDO's epoch now differs from the one recorded when the turn started.
    // Without both (an older turn row, or SandboxDO unreachable) fall back to the last move AgentDO heard of.
    let current: number | null = null;
    if (info.hands && row.hands_epoch !== null) {
      try {
        current = (await this.sandboxStub(info.hands.sandbox).info()).epoch;
      } catch (e) {
        console.warn(`agent ${info.agent}: reading the sandbox epoch failed`, e);
      }
    }
    const moved = current !== null ? current !== row.hands_epoch : (info.hands_moved_ms ?? 0) >= started;
    if (info.hands && moved) notes.push(await this.movedNote(info));
    notes.push("If the turn isn't finished, continue it.");
    const ord = (this.sql.exec<{ m: number | null }>("SELECT MIN(ord) AS m FROM turns").toArray()[0]?.m ?? 0) - 1;
    this.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES (?, ?, ?, 'queued', ?)",
      newId("trn_"), ord, JSON.stringify({ kind: "recovery", text: `${notes.join(" ")}${RECOVERY_MARK}${original}` } satisfies TurnInput), Date.now());
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
      const delay = WORKING_STATES.includes(after.state) ? FLUSH_WORKING_MS : FLUSH_IDLE_MS;
      await this.deadlines.set("flush", Date.now() + delay, true);
    }
  }

  /**
   * Write the receive stream's buffered bytes to R2 as one segment object, then (and only then) ack
   * the new durable offset. A pending base becomes the committed base once it is durable and caught up.
   */
  async flush(): Promise<void> {
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
    const verdict = this.rel.classify(CHAN, seq);
    if (verdict === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      return;
    }
    if (verdict === "gap") {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `message ${seq} out of order; expected ${this.rel.lastIn(CHAN)! + 1}`, 400, true);
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
    const info = this.update((i) => {
      switch (ev.type) {
        case "turn_started":
          i.state = "working";
          break;
        case "state_changed":
          i.state = ev.state;
          break;
        case "rate_limited":
          i.state = "quota_parked";
          break;
        case "capabilities":
          i.capabilities = ev.capabilities;
          break;
        case "turn_completed":
          if (completed && i.current_turn === ev.turn) {
            this.sql.exec("UPDATE turns SET status = 'done' WHERE turn = ?", ev.turn);
            this.sql.exec("UPDATE inbox SET status = 'consumed' WHERE status = 'delivered'");
            i.current_turn = null;
            i.state = "idle";
            i.exit_restarts = 0;
          }
          break;
        default:
          break;
      }
    });
    if (ev.type === "rate_limited") {
      await this.workstream(info.workstream).ingest({
        workstream: info.workstream, ts_ms: ev.ts_ms, agent: info.agent, type: "quota_parked",
        ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
      }, `${info.agent}/${info.runner_instance ?? ""}/ev${ev.seq}`);
    } else if (ev.type === "inbox_delivered") {
      const n = this.sql.exec("UPDATE inbox SET status = 'consumed' WHERE id = ? AND status = 'delivered'", ev.message).rowsWritten;
      if (n > 0) this.pushCache();
    } else if (ev.type === "escalation") {
      // The runner already denied the call with "pending approval (request <call>)": record an
      // async ask; the answer becomes the agent's next turn.
      const input = JSON.stringify(ev.input ?? null);
      const question = `Allow ${ev.tool}? (request ${ev.call}) input: ${input.length > 500 ? `${input.slice(0, 500)}…` : input}`;
      await this.postAsk(info, ev.call, ev.epoch, question, "async", "captain");
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
  async enqueueTurn(input: TurnInput, requestId?: string): Promise<string> {
    // Never write a turn into an AgentDO that was never created (e.g. a captain id that names nobody).
    if (!this.exists()) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    if (requestId) {
      const prior = this.sql.exec<{ turn: string }>("SELECT turn FROM turns WHERE request_id = ?", requestId).toArray()[0];
      if (prior) return prior.turn;
    }
    const turn = newId("trn_");
    const ord = (this.sql.exec<{ m: number | null }>("SELECT MAX(ord) AS m FROM turns").toArray()[0]?.m ?? 0) + 1;
    this.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms, request_id) VALUES (?, ?, ?, 'queued', ?, ?)",
      turn, ord, JSON.stringify(input), Date.now(), requestId ?? null);
    await this.pump();
    await this.wake();
    return turn;
  }

  /** Send the next queued turn when the runner is connected and no turn is running. */
  private async pump(): Promise<void> {
    if (!this.socket() || this.load().current_turn) return;
    const next = this.sql
      .exec<{ turn: string; input: string }>("SELECT turn, input FROM turns WHERE status = 'queued' ORDER BY ord LIMIT 1")
      .toArray()[0];
    if (!next) return;
    // Synchronous from the check above: no other pump can claim a turn in between.
    this.sql.exec("UPDATE turns SET status = 'active', started_ms = ? WHERE turn = ?", Date.now(), next.turn);
    const info = this.update((i) => {
      i.current_turn = next.turn;
      i.state = "working";
    });
    const { turn } = next;
    const parsed = JSON.parse(next.input) as TurnInput;
    // What a sandbox move lost since the brain was last told comes first: derived from SandboxDO's
    // epoch now against the one the brain last heard of (durable, so no notice can be lost).
    let note: string | null = null;
    let sandboxEpoch: number | null = null;
    if (info.hands) {
      try {
        sandboxEpoch = (await this.sandboxStub(info.hands.sandbox).info()).epoch;
        if (info.told_sandbox_epoch !== undefined && info.told_sandbox_epoch !== sandboxEpoch) note = await this.movedNote(info);
        const e = sandboxEpoch;
        this.update((i) => {
          i.told_sandbox_epoch = e;
        });
      } catch (e) {
        console.warn(`agent ${info.agent}: reading the sandbox epoch at turn start failed`, e);
      }
    }
    const input: TurnInput = note ? { ...parsed, text: `${note}\n\n${parsed.text}` } : parsed;
    this.pushReliable((seq) => ({ type: "run_turn", seq, turn, input }));
    // Best effort: without it, a recovery turn falls back to the last move AgentDO heard of.
    if (sandboxEpoch !== null) this.sql.exec("UPDATE turns SET hands_epoch = ? WHERE turn = ?", sandboxEpoch, turn);
    await this.syncActivity();
  }

  async turns(): Promise<{ turn: string; status: string; input: TurnInput }[]> {
    return this.sql
      .exec<{ turn: string; status: string; input: string }>("SELECT turn, status, input FROM turns ORDER BY ord")
      .toArray()
      .map((r) => ({ turn: r.turn, status: r.status, input: JSON.parse(r.input) as TurnInput }));
  }

  /**
   * Mid-turn: delivered over stdin (and mirrored for the Stop hook). Between turns: becomes the next
   * `inbox` turn. `interrupt` interrupts the running turn first.
   */
  /** A retried post with the same `requestId` gets the same message, delivered once. */
  async postInbox(from: string, text: string, interrupt = false, requestId?: string): Promise<string> {
    if (requestId) {
      const prior = this.sql.exec<{ id: string }>("SELECT id FROM inbox WHERE request_id = ?", requestId).toArray()[0];
      if (prior) return prior.id;
    }
    const info = this.load();
    const message: InboxMessage = { id: newId("msg_"), from, text, interrupt, ts_ms: Date.now() };
    if (info.current_turn) {
      this.sql.exec("INSERT INTO inbox (id, message, turn, status, created_ms, request_id) VALUES (?, ?, ?, 'delivered', ?, ?)",
        message.id, JSON.stringify(message), info.current_turn, Date.now(), requestId ?? null);
      this.pushReliable((seq) => ({ type: "inbox", seq, message }));
      this.pushCache();
    } else {
      this.sql.exec("INSERT INTO inbox (id, message, turn, status, created_ms, request_id) VALUES (?, ?, NULL, 'consumed', ?, ?)",
        message.id, JSON.stringify(message), Date.now(), requestId ?? null);
      await this.enqueueTurn({ kind: "inbox", text: `Message from ${from}: ${text}` }, requestId && `inbox/${requestId}`);
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
    const inbox = this.sql
      .exec<{ message: string }>("SELECT message FROM inbox WHERE status = 'delivered' ORDER BY rowid")
      .toArray()
      .map((r) => JSON.parse(r.message) as InboxMessage);
    return { version: info.cache_version, rules: info.rules, inbox, max_stop_continuations: 5 };
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
  // Platform tool relay
  // ---------------------------------------------------------------------------------------------

  /**
   * In order with the runner's other reliable messages. The call's seq is marked processed only after
   * the call ran (or is waiting for an ask), so a call cut short by an eviction is redelivered and run
   * again. Every write a tool makes to another object carries the key `<agent>/<epoch>/<call>`, which
   * the target applies once, so a re-run repeats no side effect.
   */
  private async onToolCall(ws: WebSocket, att: Attachment, call: Extract<RunnerToAgent, { type: "tool_call" }>): Promise<void> {
    if (att.stale) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "stale epoch") });
      return;
    }
    if (!this.current(att)) return;
    const verdict = this.rel.classify(CHAN, call.seq);
    if (verdict === "gap") {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `message ${call.seq} out of order; expected ${this.rel.lastIn(CHAN)! + 1}`, 400, true);
    }
    // Keyed by the call's own id: a call first seen at an earlier epoch (redelivered after its brain
    // adopted a newer epoch) keeps that epoch's row and idempotency key, so its writes never run
    // twice; it is still fenced by this session's epoch.
    const prior = this.sql
      .exec<{ epoch: number; status: string; outcome: string | null }>("SELECT epoch, status, outcome FROM tool_calls WHERE call = ? ORDER BY epoch LIMIT 1", call.call)
      .toArray()[0];
    const epoch = prior?.epoch ?? att.epoch;
    if (verdict === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      if (prior?.outcome) this.pushReliable((seq) => ({ type: "tool_result", seq, call: call.call, outcome: JSON.parse(prior.outcome!) as ToolOutcome }));
      return;
    }
    if (prior?.outcome) {
      // Idempotency on (agent, epoch, call): a redelivered call gets the stored outcome.
      this.pushReliable((seq) => ({ type: "tool_result", seq, call: call.call, outcome: JSON.parse(prior.outcome!) as ToolOutcome }));
    } else if (prior?.status !== "waiting") {
      if (!prior) {
        this.sql.exec("INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (?, ?, ?, 'dispatching', NULL, ?)",
          epoch, call.call, call.name, Date.now());
      }
      let result: DispatchResult;
      try {
        result = await this.dispatch(epoch, call.call, call.name, call.arguments, undefined, att.epoch);
      } catch (e) {
        const ne = asNestError(e);
        if (!ne) console.error(`AgentDO: tool ${call.name} failed`, e);
        result = { status: "error", error: ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, `${call.name} failed`, true) };
      }
      if (result === "wait") this.sql.exec("UPDATE tool_calls SET status = 'waiting' WHERE epoch = ? AND call = ?", epoch, call.call);
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
    if (att.stale) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "stale epoch") });
      return;
    }
    if (!this.current(att)) return;
    const verdict = this.rel.classify(CHAN, m.seq);
    if (verdict === "gap") {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `message ${m.seq} out of order; expected ${this.rel.lastIn(CHAN)! + 1}`, 400, true);
    }
    if (verdict === "process") {
      const outcome: ToolOutcome = { status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, `cancelled by the runner: ${m.reason}`) };
      const prior = this.sql
        .exec<{ epoch: number; status: string }>("SELECT epoch, status FROM tool_calls WHERE call = ? ORDER BY epoch LIMIT 1", m.call)
        .toArray()[0];
      const epoch = prior?.epoch ?? att.epoch;
      if (!prior) {
        this.sql.exec("INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (?, ?, '', 'done', ?, ?)",
          epoch, m.call, JSON.stringify(outcome), Date.now());
      } else if (prior.status !== "done") {
        this.sql.exec("UPDATE tool_calls SET status = 'done', outcome = ? WHERE epoch = ? AND call = ?", JSON.stringify(outcome), epoch, m.call);
        // A pending ask keeps its question open, but any answer now arrives as a turn.
        this.sql.exec("UPDATE asks SET status = 'async' WHERE call = ? AND epoch = ? AND status = 'sync'", m.call, epoch);
      }
      this.rel.markProcessed(CHAN, m.seq);
    }
    this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
  }

  private finishCall(epoch: number, call: string, outcome: ToolOutcome): void {
    this.sql.exec("UPDATE tool_calls SET status = 'done', outcome = ? WHERE epoch = ? AND call = ?", JSON.stringify(outcome), epoch, call);
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
    if (!toolsFor(info.role, info.grants ?? undefined).some((t) => t.name === name)) {
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

    switch (name) {
      case "notify": {
        const to = String(a.to);
        const message = String(a.message);
        if (to === "user") {
          await live();
          await this.workstream(info.workstream).notifyUser(message, a.urgency === "high" ? "high" : "normal", key);
        } else {
          const wsCaptain = (await this.workstream(info.workstream).info()).captain;
          const target = to === "captain" ? info.captain ?? wsCaptain : to;
          if (!target?.startsWith("agt_")) throw new NestError(ErrorCodes.INVALID_MESSAGE, `no recipient for ${to}`);
          const stub = this.env.AGENT.get(this.env.AGENT.idFromName(target));
          // Only within the workstream, captains included: a prompt-injected agent can't reach others,
          // and a recorded captain (set at create, or by the workstream route) is no exception.
          const other = await stub.info();
          if (other.workstream !== info.workstream) throw new NestError(ErrorCodes.FORBIDDEN, `${target} is in another workstream`, 403);
          await live();
          await stub.postInbox(`${info.role}:${info.agent}`, message, false, key);
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
        await this.postAsk(info, call, epoch, full, "sync", a.to === "user" ? "user" : "captain", sandboxEpoch, fence);
        return "wait";
      }
      case "read_transcript": {
        const target = String(a.agent);
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
      default:
        throw new NestError(ErrorCodes.NOT_IMPLEMENTED, `${name} is not implemented yet`, 501);
    }
  }

  /**
   * Record an ask and route the question to the captain (workstream `needs_input`) or the user.
   * `sync`: a tool call waits for it (until the sync-window deadline). `cli`: a guest `nest ask` waits
   * in memory. `async`: nothing waits; the answer becomes the next turn.
   */
  private async postAsk(
    info: AgentInfo, call: string, epoch: number, question: string, status: "sync" | "cli" | "async", to: "captain" | "user",
    sandboxEpoch?: number, fence: number = epoch,
  ): Promise<string> {
    // Re-run for the same call (after an eviction, or an event resent because routing failed): the
    // same ask, routed again under the same key, which the workstream applies once.
    const prior = this.sql.exec<{ ask: string; question: string; status: string; deadline: number }>(
      "SELECT ask, question, status, deadline FROM asks WHERE call = ? AND epoch = ?", call, epoch).toArray()[0];
    if (prior?.status === "answered") return prior.ask;
    const ask = prior?.ask ?? newId("ask_");
    const deadline = prior?.deadline ?? Date.now() + num(this.env.ASK_SYNC_WINDOW_MS, 120_000);
    if (!prior) {
      this.sql.exec("INSERT INTO asks (ask, call, epoch, question, status, deadline, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ask, call, epoch, question, status, deadline, Date.now());
    }
    if ((prior?.status ?? status) === "sync") await this.deadlines.set(`ask:${ask}`, deadline);
    const q = prior?.question ?? question;
    // The brain's own asks are fenced by its epoch; a guest's (`sandboxEpoch`) by FleetDO's lease check.
    if (sandboxEpoch === undefined) this.assertEpoch(fence);
    if (to === "user") {
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
          const ask = await this.postAsk(info, call, key, full, "cli", "captain", epoch);
          const waitMs = Math.min(command.wait_s, 120) * 1000;
          const answer = await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => { this.cliWaiters.delete(ask); resolve(null); }, waitMs);
            this.cliWaiters.set(ask, (a) => { clearTimeout(timer); resolve(a); });
          });
          if (answer !== null) return { status: "answered", answer };
          this.sql.exec("UPDATE asks SET status = 'async' WHERE ask = ? AND status = 'cli'", ask);
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
    if (info.current_turn) await this.postInbox("system", `Background task ${what} ${how}.`);
  }

  /** Answer a pending `ask`: inside the sync window it completes the tool call; afterwards it becomes a turn. */
  async answerAsk(ask: string, answer: string): Promise<"sync" | "async" | "already_answered"> {
    const row = this.sql
      .exec<{ call: string; epoch: number; status: string }>("SELECT call, epoch, status FROM asks WHERE ask = ?", ask)
      .toArray()[0];
    if (!row) throw new NestError(ErrorCodes.INVALID_MESSAGE, "unknown ask", 404);
    if (row.status === "answered") return "already_answered";
    this.sql.exec("UPDATE asks SET status = 'answered', answer = ? WHERE ask = ?", answer, ask);
    if (row.status === "cli") {
      const waiter = this.cliWaiters.get(ask);
      this.cliWaiters.delete(ask);
      if (waiter) {
        waiter(answer);
        return "sync";
      }
      // The waiter was lost (eviction): deliver as a turn instead.
    }
    if (row.status === "sync") {
      await this.deadlines.clear(`ask:${ask}`);
      this.finishCall(row.epoch, row.call, { status: "ok", content: [{ type: "text", text: answer }] });
      return "sync";
    }
    await this.enqueueTurn({ kind: "ask_answer", text: `Answer to your question ${ask}: ${answer}` });
    return "async";
  }

  // ---------------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "flush") {
        await this.flush();
      } else if (key === "starting") {
        const info = this.load();
        if (info.brain?.phase === "starting" && !this.socket()) {
          // No hello since agent_start: condemn that start (its host kills it, or refuses it under
          // the kill's tombstone), back off the next deadline, and wake for waiting work once it is
          // released.
          console.warn(`agent ${info.agent}: no brain connected within ${this.startDeadline(info)} ms of agent_start@${info.brain.epoch}`);
          this.update((i) => {
            i.state = "errored";
            i.start_timeouts = (i.start_timeouts ?? 0) + 1;
            i.exit_restarts = (i.exit_restarts ?? 0) + 1;
          });
          await this.condemn("no hello before the start deadline", info.brain.epoch);
          await this.wake(true);
        }
      } else if (key === "no_session") {
        const info = this.load();
        if (info.brain?.phase === "live" && !this.socket()) {
          // A live brain with no session and no exit for this long: condemned, so its kill and
          // escalation prove it gone.
          console.warn(`agent ${info.agent}: brain ${info.brain.host}@${info.brain.epoch} had no session for ${NO_SESSION_MS} ms`);
          this.update((i) => {
            i.exit_restarts = (i.exit_restarts ?? 0) + 1;
          });
          await this.condemn("no session", info.brain.epoch);
          await this.wake(true);
        }
      } else if (key === "activity") {
        await this.syncActivity();
      } else if (key === "wake" || key === "restart") {
        // `restart`: the previous release's retry of a start, which a wake now covers.
        await this.wake();
      } else if (key === "wake_after_exit") {
        // A release's wake, counted by the crash-loop guard (a no-op once the inline wake started one).
        await this.wake(true);
      } else if (key === "condemned") {
        await this.escalate();
      } else if (key === "intent") {
        try {
          await this.runIntent(true);
        } catch (e) {
          // Kept (or dropped) by `intentFailed`, which armed any retry.
          console.warn(`agent ${this.load().agent}: running the start intent failed`, e);
        }
      } else if (key === "prune") {
        this.prune();
        await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS);
      } else if (key.startsWith("ask:")) {
        const ask = key.slice(4);
        const row = this.sql.exec<{ call: string; epoch: number; status: string }>("SELECT call, epoch, status FROM asks WHERE ask = ?", ask).toArray()[0];
        if (row?.status === "sync") {
          this.sql.exec("UPDATE asks SET status = 'async' WHERE ask = ?", ask);
          this.finishCall(row.epoch, row.call, {
            status: "pending",
            ask,
            message: "Question posted. End your turn; the answer arrives as your next input.",
          });
        }
      }
    });
  }

  /** Bounded growth: finished calls, asks, turns and inbox messages older than a week go away. */
  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.sql.exec("DELETE FROM tool_calls WHERE status = 'done' AND created_ms < ?", cutoff);
    this.sql.exec("DELETE FROM asks WHERE status = 'answered' AND created_ms < ?", cutoff);
    this.sql.exec("DELETE FROM turns WHERE status IN ('done', 'interrupted') AND created_ms < ?", cutoff);
    this.sql.exec("DELETE FROM inbox WHERE status = 'consumed' AND created_ms < ?", cutoff);
  }
}

/**
 * Minimal JSON-schema check for platform tool arguments: object, required keys, no additional
 * properties, primitive types, enums, numeric bounds and array item types.
 */
export function validateArgs(schema: unknown, args: unknown): Record<string, unknown> {
  type Prop = { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; items?: { type?: string } };
  const s = schema as { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: boolean };
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "arguments must be an object");
  }
  const a = args as Record<string, unknown>;
  for (const k of s.required ?? []) {
    if (!(k in a)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `missing argument ${k}`);
  }
  const typeOk = (t: string | undefined, v: unknown) =>
    t === undefined ||
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
    if (!typeOk(p.type, v)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `argument ${k} must be ${p.type}`);
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
