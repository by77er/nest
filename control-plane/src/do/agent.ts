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
  type AgentCache, type AgentStart, type AgentToRunner, type InboxMessage, type LaunchConfig, RunnerToAgent,
  type SegmentRef, type ToolOutcome, type ToolRule, type TurnInput,
} from "../protocol/control";
import {
  type AgentEvent, type AgentRole, type AgentState, type CliCommand, type CliResult, ErrorCodes, PROTOCOL_VERSION,
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
/** States with no brain running, which waiting work starts one from (see `wake()`). */
const WAKE_STATES: AgentState[] = ["detached", "errored"];
/** A wake that found no host (or failed transiently) retries this often. */
const WAKE_RETRY_MS = 30_000;
/** Exits that restart the brain at once when work is waiting (not `stopped`, not `auth_failed`). */
const RESTART_ON_EXIT = ["idle", "crashed", "fenced", "not running after host reconnect"];
/** Restarts after an exit without a turn completing in between, before giving up (`errored`). */
const MAX_EXIT_RESTARTS = 3;
const RETENTION_MS = 7 * 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
/** read_transcript: entries per call by default / at most, and a response size cap. */
const TRANSCRIPT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_MAX_LIMIT = 500;
const TRANSCRIPT_MAX_BYTES = 256 * 1024;
const EMIT_EVENTS = ["progress", "blocked", "pr_opened", "completed", "failed"] as const;

export const DEFAULT_RULES: ToolRule[] = [{ pattern: "mcp__nest__*", decision: "allow" }];
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
  hands: { sandbox: string; epoch: number } | null;
  launch: LaunchConfig;
  grants: string[] | null;
  rules: ToolRule[];
  host: string | null;
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
  /** Claude Code `system/init.capabilities`, from the latest `capabilities` event. */
  capabilities?: string[];
}

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

export interface TranscriptPage {
  lines: string[];
  /** Entry number (1-based JSONL line) of the last line returned, or `since_seq` if none. */
  next_seq: number;
  more: boolean;
}

export class AgentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rel: ReliableChannels;
  private readonly deadlines: Deadlines;
  private readonly inbound = new SerialQueue();
  /** A `wake()` is starting a brain (its awaits open the input gate). */
  private waking = false;

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
    this.rel = new ReliableChannels(this.sql);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  private load(): AgentInfo {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0];
    if (!row) throw new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
    const info = JSON.parse(row.value) as Partial<AgentInfo> & AgentInfo;
    return {
      ...info,
      recv_base: info.recv_base ?? info.base_gen,
      recv_session: info.recv_session ?? info.session,
      recv_durable: info.recv_durable ?? info.durable_bytes,
      runner_instance: info.runner_instance ?? null,
      start_attempts: info.start_attempts ?? 0,
    };
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
      const sbx = await this.sandboxStub(req.sandbox).attachAgent(req.agent);
      hands = { sandbox: req.sandbox, epoch: sbx.epoch };
    }
    if (this.exists()) return this.load();
    const info: AgentInfo = {
      agent: req.agent,
      role: req.role,
      workstream: req.workstream,
      cell: req.cell,
      captain: req.captain ?? null,
      hands,
      launch: req.launch ?? (req.role === "captain" ? DEFAULT_CAPTAIN_LAUNCH : DEFAULT_WORKER_LAUNCH),
      grants: req.grants ?? null,
      rules: req.rules ?? DEFAULT_RULES,
      host: null,
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

  async info(): Promise<AgentInfo> {
    return this.load();
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

  /** Epoch a runner must present: the bound sandbox's lease for workers, 0 for captains. */
  private expectedEpoch(info: AgentInfo): number {
    return info.hands?.epoch ?? 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Brain lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Send `agent_start` to the host that should run this brain (co-located with its sandbox). The
   * setup token travels as a BrokerDO reference, resolved by FleetDO when it sends.
   */
  async start(hostHint?: string): Promise<{ host: string; cmd: string }> {
    const info = this.load();
    let host: string | null;
    if (info.role === "worker") {
      if (!info.hands) throw new NestError(ErrorCodes.NOT_BOUND, "worker has no hands binding", 409);
      // Lazy start: a suspended sandbox resumes, an unplaced one is placed (maybe on a new host).
      // Without a host yet this fails retryably; the placement then moves the agent onto it.
      host = hostHint ?? (await this.sandboxStub(info.hands.sandbox).wake()).host;
    } else {
      host = await this.fleet(info.cell).controllerHost();
    }
    if (!host) throw new NestError(ErrorCodes.CAPACITY_EXHAUSTED, "no host available for this agent", 503, true);
    const oauthRef = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).oauthTokenRef(info.role);
    // `--resume` reads R2 only: make what's still buffered durable first, or the new brain would
    // resume from up to a flush interval ago.
    await this.flush();
    const fresh = this.load();
    const resume = fresh.session ? await this.sessionResume(fresh) : undefined;
    const body: Omit<AgentStart, "type"> = {
      agent: fresh.agent,
      role: fresh.role,
      workstream: fresh.workstream,
      ...(resume ? { resume } : {}),
      ...(fresh.hands ? { hands: fresh.hands } : {}),
      launch: fresh.launch,
      oauth_token: oauthRef,
      session_ws_url: `${this.env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/agents/${fresh.agent}/session`,
    };
    this.update((i) => {
      i.host = host;
      i.state = "starting";
    });
    const [cmd] = await this.fleet(info.cell).issueCommands(host, [{ type: "agent_start", ...body }]);
    return { host, cmd: cmd! };
  }

  async stop(reason: string): Promise<void> {
    const info = this.load();
    if (info.host) await this.fleet(info.cell).issueCommands(info.host, [{ type: "agent_stop", agent: info.agent, reason }]);
  }

  /** `agent_start` failed on `host`: retry a few times when retryable, otherwise give up. */
  async startFailed(host: string, error: { code: string; message: string; retryable?: boolean }): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    if (info.host !== host) return;
    if (error.retryable && info.start_attempts < MAX_START_ATTEMPTS) {
      this.update((i) => {
        i.start_attempts += 1;
        i.state = "starting";
      });
      await this.deadlines.set("restart", Date.now() + START_RETRY_MS, true);
      return;
    }
    this.update((i) => {
      i.state = "errored";
    });
    console.warn(`agent ${info.agent}: start failed: ${error.code} ${error.message}`);
  }

  /** The brain on `host` exited. Reports from any other host are ignored (e.g. after a move). */
  async onExited(host: string, reason: string): Promise<void> {
    if (!this.exists()) return;
    if (this.load().host !== host) return;
    const info = this.update((i) => {
      i.state = "detached";
    });
    if (info.hands && info.role === "worker") await this.sandboxStub(info.hands.sandbox).agentActivity(info.agent, false);
    console.log(`agent ${info.agent}: brain exited (${reason})`);
    // Work that arrived while it was exiting, or the turn it died in, brings it straight back.
    if (RESTART_ON_EXIT.includes(reason)) await this.wake(reason !== "idle");
  }

  /**
   * The host running this brain went silent past its lease. Only controller hosts get here: captains
   * have no sandbox to follow. Their brains fenced themselves when the host's lease lapsed, so another
   * one can start elsewhere.
   */
  async onHostLost(host: string): Promise<void> {
    if (!this.exists() || this.load().host !== host) return;
    this.update((i) => {
      i.host = null;
      i.state = "detached";
    });
    for (const ws of this.ctx.getWebSockets("session")) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.host !== host) continue;
      ws.serializeAttachment({ ...a, helloed: false, stale: true });
      ws.close(4409, "host lost");
    }
    await this.wake(true);
  }

  /**
   * Start a brain for waiting work (a queued turn, or the turn it was in the middle of) when it has
   * none: it went idle, exited or lost its host (`detached`), or gave up (`errored`). Never throws:
   * callers are queuing work, which stays queued. A retryable failure (no host yet) retries from the
   * alarm. `afterExit` counts towards the crash-loop guard; new input always gets a fresh try.
   */
  private async wake(afterExit = false): Promise<void> {
    if (this.waking) return;
    const info = this.load();
    if (!WAKE_STATES.includes(info.state) || this.socket()) return;
    const queued = this.sql.exec("SELECT 1 FROM turns WHERE status = 'queued' LIMIT 1").toArray().length > 0;
    if (!info.current_turn && !queued) return;
    if (afterExit && (info.exit_restarts ?? 0) >= MAX_EXIT_RESTARTS) {
      this.update((i) => {
        i.state = "errored";
      });
      console.warn(`agent ${info.agent}: exited ${MAX_EXIT_RESTARTS} times without completing a turn; waiting for new input`);
      return;
    }
    this.waking = true;
    try {
      this.update((i) => {
        i.start_attempts = 0;
        if (afterExit) i.exit_restarts = (i.exit_restarts ?? 0) + 1;
      });
      await this.start();
    } catch (e) {
      console.warn(`agent ${info.agent}: wake failed`, e);
      // A failure after start() claimed the agent must not leave it `starting` with nothing running.
      this.update((i) => {
        if (i.state === "starting") i.state = "detached";
      });
      // Anything but a NestError is infrastructure (e.g. a Durable Object call): try again later.
      if (asNestError(e)?.retryable ?? true) await this.deadlines.set("wake", Date.now() + WAKE_RETRY_MS, true);
    } finally {
      this.waking = false;
    }
  }

  /** The host reported this brain in its hello (e.g. after a nestd restart). */
  async hostReport(host: string, state: AgentState): Promise<void> {
    if (!this.exists()) return;
    this.update((i) => {
      if (i.host === host && i.state === "detached") i.state = state;
    });
  }

  /** The bound sandbox got a new lease (and maybe host): follow it; the brain is co-located. */
  async onSandboxMoved(sandbox: string, epoch: number, host: string | null): Promise<void> {
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) return;
    this.update((i) => {
      i.hands = { sandbox, epoch };
      i.host = null;
      i.start_attempts = 0;
    });
    for (const ws of this.ctx.getWebSockets("session")) {
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), helloed: false, stale: true });
      ws.close(4409, "sandbox moved; reconnect with the new epoch");
    }
    if (!host) return;
    try {
      await this.start(host);
    } catch (e) {
      this.update((i) => {
        i.state = "errored";
      });
      // Waiting work retries from the alarm instead of stranding the agent.
      await this.deadlines.set("wake", Date.now() + WAKE_RETRY_MS, true);
      throw e;
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
    // Only the host this agent was started on, in the agent's cell, while that host is live.
    if (!info.host || info.host !== host) return new Response("agent is not assigned to this host", { status: 403 });
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
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  private send(ws: WebSocket, msg: AgentToRunner): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket gone: reliable messages are resent after the next hello.
    }
  }

  /** The live, non-stale session socket of the current runner process, if any. */
  private socket(): WebSocket | undefined {
    const instance = this.load().runner_instance;
    return this.ctx.getWebSockets("session").find((ws) => {
      const a = ws.deserializeAttachment() as Attachment;
      return a.helloed && !a.stale && a.instance === instance;
    });
  }

  /** Persist a reliable message and send it if the runner is connected. */
  private pushReliable(make: (seq: number) => AgentToRunner & { seq: number }): void {
    const msg = this.rel.push(CHAN, make);
    const ws = this.socket();
    if (ws) this.send(ws, msg);
  }

  /** A message from a socket that isn't the current runner process is ignored. */
  private current(att: Attachment): boolean {
    return !att.stale && att.instance === this.load().runner_instance;
  }

  private async onHello(ws: WebSocket, att: Attachment, hello: Extract<RunnerToAgent, { type: "hello" }>): Promise<void> {
    if (hello.protocol_version !== PROTOCOL_VERSION) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.UNSUPPORTED_PROTOCOL_VERSION, `server speaks ${PROTOCOL_VERSION}`) });
      ws.close(4426, "unsupported protocol version");
      return;
    }
    const before = this.load();
    if (hello.agent !== before.agent || hello.host !== att.host || before.host !== att.host) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.UNAUTHORIZED, "hello does not match agent/host") });
      ws.close(4401, "unauthorized");
      return;
    }
    // A stale epoch is still accepted, but its segments go to the orphan branch and nothing else flows.
    const stale = hello.epoch !== this.expectedEpoch(before);
    ws.serializeAttachment({ host: att.host, epoch: hello.epoch, helloed: true, stale, instance: hello.instance_id } satisfies Attachment);
    if (stale) {
      this.send(ws, {
        type: "hello_ack", protocol_version: PROTOCOL_VERSION, durable_bytes: hello.local_bytes ?? 0,
      });
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.STALE_EPOCH, `expected epoch ${this.expectedEpoch(before)}`) });
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
    });
    this.sql.exec("DELETE FROM seg_buffer WHERE base < ?", info.recv_base);
    if (recovered) this.requeueAsRecovery(recovered);

    this.send(ws, {
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      durable_bytes: info.recv_durable,
      ...(this.rel.lastIn(CHAN) !== undefined ? { last_seq: this.rel.lastIn(CHAN) } : {}),
    });
    if (!newLineage && hello.last_seq !== undefined) this.rel.ack(CHAN, hello.last_seq);
    for (const m of this.rel.pendingAfter(CHAN, newLineage ? undefined : hello.last_seq)) this.send(ws, m as AgentToRunner);
    this.pushCache();
    await this.pump();
  }

  /** A turn whose brain restarted mid-turn comes back first, as a recovery turn. */
  private requeueAsRecovery(turn: string): void {
    const row = this.sql.exec<{ input: string }>("SELECT input FROM turns WHERE turn = ?", turn).toArray()[0];
    this.sql.exec("UPDATE turns SET status = 'interrupted' WHERE turn = ?", turn);
    if (!row) return;
    const orig = JSON.parse(row.input) as TurnInput;
    const ord = (this.sql.exec<{ m: number | null }>("SELECT MIN(ord) AS m FROM turns").toArray()[0]?.m ?? 0) - 1;
    this.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES (?, ?, ?, 'queued', ?)",
      newId("trn_"), ord, JSON.stringify({
        kind: "recovery",
        text: `Your session restarted while you were working on a turn. If it isn't finished, continue it. The turn was:\n${orig.text}`,
      } satisfies TurnInput), Date.now());
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
  async readTranscript(since = 0, limit = TRANSCRIPT_DEFAULT_LIMIT): Promise<TranscriptPage> {
    const info = this.load();
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
      for (const p of parts) if (take(p)) return { lines, next_seq: n, more: true };
    }
    take(carry + decoder.decode());
    return { lines, next_seq: lines.length ? n : since, more: false };
  }

  // --- events ---------------------------------------------------------------------------------------

  private async onEvents(ws: WebSocket, att: Attachment, seq: number, events: AgentEvent[]): Promise<void> {
    if (!this.current(att)) return;
    const verdict = this.rel.classify(CHAN, seq);
    if (verdict === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(CHAN)! });
      return;
    }
    if (verdict === "gap") {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `message ${seq} out of order; expected ${this.rel.lastIn(CHAN)! + 1}`, 400, true);
    }
    for (const ev of events) await this.applyEvent(ev);
    this.rel.markProcessed(CHAN, seq);
    this.send(ws, { type: "ack", up_to: seq });
  }

  private async applyEvent(ev: AgentEvent): Promise<void> {
    const before = this.load();
    if (ev.agent !== before.agent || ev.epoch !== this.expectedEpoch(before)) return;
    if (this.sql.exec("SELECT 1 FROM events WHERE seq = ?", ev.seq).toArray().length) return;
    this.sql.exec("INSERT INTO events (seq, body) VALUES (?, ?)", ev.seq, JSON.stringify(ev));
    this.sql.exec("DELETE FROM events WHERE seq < ?", ev.seq - 500);
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
      });
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
    const wasWorking = WORKING_STATES.includes(before.state);
    const isWorking = WORKING_STATES.includes(info.state);
    if (info.hands && wasWorking !== isWorking) await this.sandboxStub(info.hands.sandbox).agentActivity(info.agent, isWorking);
    if (completed) {
      this.pushCache();
      await this.pump();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Turns, inbox, interrupt, caches
  // ---------------------------------------------------------------------------------------------

  async enqueueTurn(input: TurnInput): Promise<string> {
    const turn = newId("trn_");
    const ord = (this.sql.exec<{ m: number | null }>("SELECT MAX(ord) AS m FROM turns").toArray()[0]?.m ?? 0) + 1;
    this.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES (?, ?, ?, 'queued', ?)", turn, ord, JSON.stringify(input), Date.now());
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
    this.sql.exec("UPDATE turns SET status = 'active' WHERE turn = ?", next.turn);
    const info = this.update((i) => {
      i.current_turn = next.turn;
      i.state = "working";
    });
    const { turn, input } = next;
    this.pushReliable((seq) => ({ type: "run_turn", seq, turn, input: JSON.parse(input) as TurnInput }));
    if (info.hands) await this.sandboxStub(info.hands.sandbox).agentActivity(info.agent, true);
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
  async postInbox(from: string, text: string, interrupt = false): Promise<string> {
    const info = this.load();
    const message: InboxMessage = { id: newId("msg_"), from, text, interrupt, ts_ms: Date.now() };
    if (info.current_turn) {
      this.sql.exec("INSERT INTO inbox (id, message, turn, status, created_ms) VALUES (?, ?, ?, 'delivered', ?)",
        message.id, JSON.stringify(message), info.current_turn, Date.now());
      this.pushReliable((seq) => ({ type: "inbox", seq, message }));
      this.pushCache();
    } else {
      this.sql.exec("INSERT INTO inbox (id, message, turn, status, created_ms) VALUES (?, ?, NULL, 'consumed', ?)",
        message.id, JSON.stringify(message), Date.now());
      await this.enqueueTurn({ kind: "inbox", text: `Message from ${from}: ${text}` });
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
   * again: platform tools are at-least-once across evictions, exactly-once otherwise.
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
    const epoch = att.epoch;
    const prior = this.sql
      .exec<{ status: string; outcome: string | null }>("SELECT status, outcome FROM tool_calls WHERE epoch = ? AND call = ?", epoch, call.call)
      .toArray()[0];
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
        result = await this.dispatch(epoch, call.call, call.name, call.arguments);
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
      const epoch = att.epoch;
      const outcome: ToolOutcome = { status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, `cancelled by the runner: ${m.reason}`) };
      const prior = this.sql
        .exec<{ status: string }>("SELECT status FROM tool_calls WHERE epoch = ? AND call = ?", epoch, m.call)
        .toArray()[0];
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

  private async dispatch(epoch: number, call: string, name: string, args: unknown): Promise<DispatchResult> {
    const info = this.load();
    const def = toolDef(name);
    if (!def) throw new NestError(ErrorCodes.UNKNOWN_TOOL, `unknown tool ${name}`);
    if (!toolsFor(info.role, info.grants ?? undefined).some((t) => t.name === name)) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${name} is not granted to this agent`, 403);
    }
    const a = validateArgs(def.input_schema, args);
    const text = (t: string): ToolOutcome => ({ status: "ok", content: [{ type: "text", text: t }] });

    switch (name) {
      case "notify": {
        const to = String(a.to);
        const message = String(a.message);
        if (to === "user") {
          await this.workstream(info.workstream).notifyUser(message, a.urgency === "high" ? "high" : "normal");
        } else {
          const wsCaptain = (await this.workstream(info.workstream).info()).captain;
          const target = to === "captain" ? info.captain ?? wsCaptain : to;
          if (!target?.startsWith("agt_")) throw new NestError(ErrorCodes.INVALID_MESSAGE, `no recipient for ${to}`);
          const stub = this.env.AGENT.get(this.env.AGENT.idFromName(target));
          // Only within the workstream (or to its captain): a prompt-injected agent can't reach others.
          if (target !== info.captain && target !== wsCaptain) {
            const other = await stub.info();
            if (other.workstream !== info.workstream) throw new NestError(ErrorCodes.FORBIDDEN, `${target} is in another workstream`, 403);
          }
          await stub.postInbox(`${info.role}:${info.agent}`, message);
        }
        return text(`Delivered to ${to}.`);
      }
      case "emit": {
        const base = {
          workstream: info.workstream, ts_ms: Date.now(), agent: info.agent,
          ...(info.hands ? { sandbox: info.hands.sandbox, epoch: info.hands.epoch } : {}),
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
        await this.workstream(info.workstream).ingest(event);
        return text(`Recorded ${event.type}.`);
      }
      case "ask": {
        const question = String(a.question);
        const options = Array.isArray(a.options) ? (a.options as unknown[]).map(String) : [];
        const full = options.length ? `${question} (options: ${options.join(" | ")})` : question;
        await this.postAsk(info, call, epoch, full, "sync", a.to === "user" ? "user" : "captain");
        return "wait";
      }
      case "read_transcript": {
        const target = String(a.agent);
        const since = typeof a.since_seq === "number" ? Math.max(0, a.since_seq) : 0;
        const limit = typeof a.limit === "number" ? a.limit : TRANSCRIPT_DEFAULT_LIMIT;
        let page: TranscriptPage;
        if (target === info.agent) {
          page = await this.readTranscript(since, limit);
        } else {
          const stub = this.env.AGENT.get(this.env.AGENT.idFromName(target));
          const other = await stub.info();
          if (other.workstream !== info.workstream) throw new NestError(ErrorCodes.FORBIDDEN, "transcript is in another workstream", 403);
          page = await stub.readTranscript(since, limit);
        }
        return {
          status: "ok",
          content: [
            { type: "text", text: page.lines.join("\n") },
            { type: "json", value: { entries: page.lines.length, next_seq: page.next_seq, more: page.more } },
          ],
        };
      }
      case "expose_port": {
        if (!info.hands) throw new NestError(ErrorCodes.NOT_BOUND, "agent has no sandbox", 409);
        if (a.share === true) {
          // A public link bypasses Cloudflare Access: agents can't mint one; an operator can.
          throw new NestError(ErrorCodes.FORBIDDEN, "public share links need operator approval; ask the user to share the port", 403);
        }
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
  ): Promise<string> {
    const ask = newId("ask_");
    const deadline = Date.now() + num(this.env.ASK_SYNC_WINDOW_MS, 120_000);
    this.sql.exec("INSERT INTO asks (ask, call, epoch, question, status, deadline, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ask, call, epoch, question, status, deadline, Date.now());
    if (status === "sync") await this.deadlines.set(`ask:${ask}`, deadline);
    if (to === "user") {
      await this.workstream(info.workstream).notifyUser(`[${ask}] ${info.agent} asks: ${question}`, "high");
    } else {
      await this.workstream(info.workstream).ingest({
        workstream: info.workstream, ts_ms: Date.now(), agent: info.agent, type: "needs_input", ask, question,
        ...(info.hands ? { sandbox: info.hands.sandbox, epoch: info.hands.epoch } : {}),
      });
    }
    return ask;
  }

  /** In-memory waiters for guest `nest ask` (lost on eviction: the ask then falls back to async). */
  private readonly cliWaiters = new Map<string, (answer: string) => void>();

  /**
   * A `nest` CLI command from a program in this agent's sandbox (relayed guest → nestd → FleetDO),
   * mapped onto the platform tools of the same name.
   */
  async guestCli(sandbox: string, epoch: number, command: CliCommand): Promise<CliResult> {
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox) {
      return { status: "error", error: errorBody(ErrorCodes.NOT_BOUND, `${info.agent} is not bound to ${sandbox}`) };
    }
    if (info.hands.epoch !== epoch) return { status: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "stale epoch") };
    const call = newId("cal_cli-");
    const run = async (name: string, args: Record<string, unknown>): Promise<CliResult> => {
      const r = await this.dispatch(epoch, call, name, args);
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
          const ask = await this.postAsk(info, call, epoch, full, "cli", "captain");
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

  /** A background hands task exited (relayed by the lease holder). Surfaced mid-turn. */
  async onTaskExited(sandbox: string, epoch: number, task: TaskInfo): Promise<void> {
    if (!this.exists()) return;
    const info = this.load();
    if (!info.hands || info.hands.sandbox !== sandbox || info.hands.epoch !== epoch) return;
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
      } else if (key === "restart") {
        const info = this.load();
        if (info.state === "starting" && info.host && !this.socket()) await this.start();
      } else if (key === "wake") {
        await this.wake();
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
