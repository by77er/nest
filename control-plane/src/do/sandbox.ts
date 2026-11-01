// SandboxDO: authority for one sandbox (docs/control-plane/durable-objects/sandbox/). Epoch and lease
// grants, commit compare-and-set over the generation chain, layered egress policy with expiring grants,
// attached agents and the idle refcount, exposed ports.
//
// Concurrency: the input gate opens across awaits on other Durable Objects, so state is never saved
// from a copy loaded before an await. Mutations go through `update()`, which loads, applies and
// saves synchronously.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { healthRead, isHealthInstance } from "../lib/health";
import { num, type Env } from "../env";
import { ChannelOutbox, OUTBOX_DEADLINE } from "../lib/outbox";
import { Deadlines } from "../lib/reliable";
import { splitDomain } from "../lib/cloudflare";
import { signShare } from "../lib/tokens";
import { asNestError, hex, NestError, newId, sha256 } from "../lib/util";
import * as lease from "../lib/sandbox-lease";
import * as slots from "../lib/slots";
import { addColumn, storedEnum } from "../lib/stored";
import type { CommandBody, CommitOutcome, CommitRequestEvent, HostEvent } from "../protocol/control";
import { BINDING_LIFETIME_MS, type GuestInfo, type HandsTarget } from "../protocol/gateway";
import {
  type AllowRule, type EgressLimits, type EgressPolicy, type ErrorBody, ErrorCodes, type GenerationRecord,
  InjectionBinding, type InjectionSecret, RequestGuard, type Resources, SandboxState,
} from "../protocol/model";
import { canonicalRepos, Repos, unionRepos } from "../lib/repos";
import { GITHUB_BINDING, githubEgress } from "../lib/rules/github";
import { cellIdleTtlMs, dormant, EXPIRY_GAP_MS, expiryStep } from "../lib/lifetimes";
import {
  chainView, type ChainView, type GenRow, gcRootsOf, isRestoreSource, livePins, type Pin, retention, retentionMode, type RootRow,
} from "../lib/retention";

export const DEFAULT_IMAGE = "nest-base:latest";
export const DEFAULT_RESOURCES: Resources = { vcpus: 2, memory_mib: 4096, disk_gib: 32 };
export const DEFAULT_LIMITS: EgressLimits = { max_connections: 256, bandwidth_mbps: 200, max_inspected_body_bytes: 512 * 1024 * 1024 };
/** Base layer (docs/sandbox/networking/egress/policy/). */
export const BASE_ALLOW = [
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io",
  "github.com", "*.githubusercontent.com", "deb.debian.org",
];

/** The ports an allow rule (or a grant) covers when it names none. */
const WEB_PORTS = [80, 443];
export const Port = z.number().int().min(1).max(65535);
/**
 * The operator's egress policy layer for one sandbox (docs/sandbox/networking/egress/policy/), as the API
 * takes it (named for the workstreams it was once set per; it is per sandbox). `repos`: the push
 * allowlist (#repo-allowlists), which the GitHub rule constructor turns into guards; `guards`: request
 * guards written by hand, layered with the constructed ones.
 */
export const WorkstreamPolicyLayer = z.object({
  allow: z.array(z.object({ host: z.string().min(1), ports: z.array(Port).optional() })).default([]),
  passthrough: z.array(z.string().min(1)).default([]),
  inject: z.array(InjectionBinding).default([]),
  tcp: z.array(z.object({ host: z.string().min(1), port: Port })).default([]),
  repos: Repos.default([]),
  guards: z.array(RequestGuard).max(64).default([]),
});
export type WorkstreamPolicyLayer = z.output<typeof WorkstreamPolicyLayer>;
/** What a caller may pass: the fields with defaults may be left out. */
export type WorkstreamPolicyInput = z.input<typeof WorkstreamPolicyLayer>;
const EMPTY_LAYER: WorkstreamPolicyLayer = WorkstreamPolicyLayer.parse({});

/** A sandbox's record: its lease fields (lib/sandbox-lease.ts), its clients' slots (lib/slots.ts), and the rest. */
export interface SandboxInfo extends lease.Lease, slots.Slots {
  sandbox: string;
  workstream: string;
  cell: string;
  image: string;
  resources: Resources;
  policy_version: number;
  ports: { port: number; url: string }[];
  /** The last `HISTORY_MAX` epochs and their hosts (the `epochs` table keeps every one). */
  history: { epoch: number; host: string }[];
  /** The agent it was created for (`agent_spawn{sandbox: new}`), which may destroy it when it ends; absent: the operator's. */
  owner?: string;
  /** Destroyed after being dormant this long (docs/control-plane/durable-objects/sandbox/#lifetime); absent: the cell default. */
  idle_ttl_ms?: number;
  /** Since when it has been dormant (no agent attached, no VM up); kept by every mutation (`decide`). */
  dormant_since_ms?: number;
  /** When the notice that it will be destroyed went to `user`, for this dormancy. */
  expiry_notice_ms?: number;
  /** When the lifetime check last ran (a gap over `EXPIRY_GAP_MS` restarts the clock). */
  expiry_checked_ms?: number;
  /** The generation the claim at `epoch` restores, pinned by id in the claim's step (`livePins` says while it holds). */
  restore_pin?: Pin | null;
}

export interface CreateSandbox {
  sandbox: string;
  workstream: string;
  cell: string;
  image?: string;
  resources?: Resources;
  workstreamPolicy?: WorkstreamPolicyInput;
  /** The agent it is created for (it owns it). */
  owner?: string;
  idle_ttl_ms?: number;
}

const ACTIVE_STATES: SandboxState[] = ["creating", "restoring", "running", "suspending", "suspended"];
const PLACE_RETRY_MS = 30_000;
/** Idle this long → suspend. The design pauses at 1 min and suspends 10 min later; pausing isn't built. */
const DEFAULT_SUSPEND_IDLE_MS = 11 * 60_000;
/** At most one turn-end commit this often (docs/sandbox/state/#writeback-cadence). */
const TURN_CHECKPOINT_MIN_MS = 10_000;
/** How many epochs `info().history` shows; the `epochs` table keeps them all. */
const HISTORY_MAX = 50;
/** `commits` records: one rejected, or whose generation left the chain, goes this long after it was made. */
const COMMIT_RECORD_RETENTION_MS = 7 * 86_400_000;
/** Commit records are pruned from a deadline at most this often, never on the commit path. */
const COMMIT_PRUNE_INTERVAL_MS = 3_600_000;
/** Retention runs this long after a commit (one pass covers a burst of them). */
const RETENTION_AFTER_COMMIT_MS = 60_000;
/** And at least this often while the sandbox lives, so age limits apply without commits. */
const RETENTION_RECHECK_MS = 6 * 3_600_000;
/** At most this many generations are marked `deleting` per pass; the rest in the next, a second later. */
const RETENTION_MAX_MARKS = 500;
const RETENTION_CONTINUE_MS = 1_000;
/** A `deleting` row is kept this long after it was marked (an orphan's longer than any orphan head lives), then pruned. */
const DELETING_ROW_RETENTION_MS = 7 * 86_400_000;
const DELETING_ORPHAN_ROW_RETENTION_MS = 31 * 86_400_000;
/** A minted injection secret is pushed again this long before it expires (BrokerDO reuses one only with 20 minutes left). */
const INJECT_REFRESH_BEFORE_MS = 15 * 60_000;
/** A mint that failed for now (GitHub didn't answer) is tried again after this long. */
const INJECT_RETRY_MS = 2 * 60_000;
/** Nothing mintable (no App, not installed): tried again after this long, or at the next policy change. */
const INJECT_IDLE_RETRY_MS = 60 * 60_000;
/** Previews and share links without NEST_DOMAIN (the harness, tests): never routed, only named. */
const LOCAL_DOMAIN = "nest.localhost";

/**
 * A preview's or share link's hostname, by the naming rule (docs/setup/#hostnames): a first-level
 * label of the zone whose suffix is its kind, the sandbox id without `sbx_` (no `_` in a hostname).
 */
export function portHostname(kind: "preview" | "share", domain: string, port: number, sandbox: string): string {
  const { label, zone } = splitDomain(domain);
  return `${port}-${sandbox.replace(/^sbx_/, "")}-${kind}-${label}.${zone}`;
}

const days = (ms: number) => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} days` : `${Math.round(ms / 1000)} s`);

/** What a stored record written before these fields lacks, and a new one starts with. */
const newFields = () => ({
  placing: null, placing_ms: null, history: [], lost_from: null, create_attempts: 0, guest: null, attach_cwd: {},
  attach_pending: [], attach_inflight: {}, attach_attempts: {}, restore_pin: null,
});

type CommandOutcome = Extract<HostEvent, { type: "command_result" }>["outcome"];
/** A command addressed to this sandbox at its current epoch, before `command()` stamps both. */
type SandboxCommand = CommandBody extends infer C ? (C extends { sandbox: string; epoch: number } ? Omit<C, "sandbox" | "epoch"> : never) : never;

export class SandboxDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // `!`: set in the constructor, except on the health instance, which serves only `health()`.
  private readonly deadlines!: Deadlines;
  /** Posts to `<sbx>/events` (docs/channels/#built-in-channels), queued with the change they report. */
  private readonly outbox!: ChannelOutbox;

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.SANDBOX)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, record TEXT NOT NULL,
      orphaned INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL)`);
    // `state`: null is ready, 'deleting' is one-way (retention marked it; it is no longer a GC root).
    addColumn(this.sql, "generations", "state", "TEXT");
    addColumn(this.sql, "generations", "deleting_ms", "INTEGER");
    this.sql.exec("CREATE INDEX IF NOT EXISTS generations_deleting ON generations (deleting_ms) WHERE state = 'deleting'");
    this.sql.exec("CREATE TABLE IF NOT EXISTS commits (request TEXT PRIMARY KEY, outcome TEXT NOT NULL)");
    // When the request was answered, and the generation it committed (null: rejected), so
    // retention needs no JSON scan.
    addColumn(this.sql, "commits", "created_ms", "INTEGER");
    addColumn(this.sql, "commits", "generation_id", "TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS commits_generation ON commits (generation_id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS commits_rejected ON commits (created_ms) WHERE generation_id IS NULL");
    // Every epoch and the host that held it: salvage from any older epoch is authorized against it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS epochs (epoch INTEGER PRIMARY KEY, host TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, host TEXT NOT NULL, ports TEXT NOT NULL,
      expires_ms INTEGER NOT NULL)`);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
    this.outbox = new ChannelOutbox(this.sql, this.deadlines, env, (p) => ctx.waitUntil(p), () => this.info_().sandbox);
  }

  // --- state helpers ------------------------------------------------------------------------------

  private get<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private put(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private info_(): SandboxInfo {
    const s = this.get<Partial<SandboxInfo>>("info");
    if (!s) throw new NestError(ErrorCodes.UNKNOWN_SANDBOX, "unknown sandbox", 404);
    const info = { ...newFields(), ...s } as SandboxInfo;
    info.state = storedEnum(SandboxState, info.state, "info.state");
    // Derived on every read: rows written before the naming rule hold other hostnames.
    info.ports = info.ports.map((p) => ({ port: p.port, url: this.portUrl("preview", info.sandbox, p.port) }));
    info.history = this.recentEpochs();
    return info;
  }

  /** The info, or undefined for a sandbox never created (a host's report may name one). */
  private tryInfo(): SandboxInfo | undefined {
    return this.get<SandboxInfo>("info") ? this.info_() : undefined;
  }

  private recentEpochs(): { epoch: number; host: string }[] {
    return this.sql.exec<{ epoch: number; host: string }>(
      "SELECT epoch, host FROM epochs ORDER BY epoch DESC LIMIT ?", HISTORY_MAX).toArray().reverse();
  }

  /** `host` holds `epoch` (a placement, or an adopted lease). Kept for the sandbox's life. */
  private recordEpoch(epoch: number, host: string): void {
    this.sql.exec("INSERT INTO epochs (epoch, host) VALUES (?, ?) ON CONFLICT(epoch) DO UPDATE SET host = excluded.host", epoch, host);
  }

  /** The host that held `epoch`, if any did. */
  private epochHost(epoch: number): string | undefined {
    return this.sql.exec<{ host: string }>("SELECT host FROM epochs WHERE epoch = ?", epoch).toArray()[0]?.host;
  }

  private portUrl(kind: "preview" | "share", sandbox: string, port: number): string {
    return `https://${portHostname(kind, this.env.NEST_DOMAIN ?? LOCAL_DOMAIN, port, sandbox)}`;
  }

  /** Load, mutate and save synchronously (never across an await). `history` is the table's, never saved. */
  private update(fn: (info: SandboxInfo) => void): SandboxInfo {
    return this.decide(fn)[1];
  }

  /** `update`, returning what `fn` decided (a core's answer) with the saved info. */
  private decide<T>(fn: (info: SandboxInfo) => T): [T, SandboxInfo] {
    const info = this.info_();
    const r = fn(info);
    // Dormancy is kept in the step of every change: it starts at the first and ends at once (a wake, an attach).
    if (!dormant(info)) {
      delete info.dormant_since_ms;
      delete info.expiry_notice_ms;
    } else if (info.dormant_since_ms === undefined) {
      info.dormant_since_ms = Date.now();
    }
    info.history = this.recentEpochs();
    const { history: _derived, ...stored } = info;
    this.put("info", stored);
    return [r, info];
  }

  private fleet(cell: string) {
    return this.env.FLEET.get(this.env.FLEET.idFromName(cell));
  }

  /** Queue a platform post on `<sbx>/events` (synchronous; posted from the alarm). Never a decision. */
  private report(kind: string, text: string, data: Record<string, unknown>, idem?: string): void {
    const sandbox = this.info_().sandbox;
    this.outbox.push(`${sandbox}/events`, { kind, text, data, ...(idem ? { idem_key: idem } : {}) }, { tainted: false });
  }

  // --- lifecycle ----------------------------------------------------------------------------------

  /** Create (idempotent) and place the sandbox; the first placement grants epoch 1. */
  async create(req: CreateSandbox): Promise<SandboxInfo> {
    // The cell's registry is the authority for which sandboxes exist (its GC roots): registered
    // before anything can be written for the sandbox, and again on a retried create, but never
    // again once destroyed (its registry row may already be pruned).
    const existing = this.get<SandboxInfo>("info");
    if (existing?.state !== "destroyed") await this.fleet(req.cell).registerSandbox(req.sandbox);
    if (existing) return this.info_();
    const info: SandboxInfo = {
      ...newFields(),
      sandbox: req.sandbox,
      workstream: req.workstream,
      cell: req.cell,
      image: req.image ?? DEFAULT_IMAGE,
      resources: req.resources ?? DEFAULT_RESOURCES,
      epoch: 0,
      host: null,
      state: "creating",
      head: null,
      policy_version: 1,
      attached: [],
      working: [],
      ports: [],
      ...(req.owner ? { owner: req.owner } : {}),
      ...(req.idle_ttl_ms !== undefined ? { idle_ttl_ms: req.idle_ttl_ms } : {}),
    };
    this.put("info", info);
    await this.deadlines.set("expiry", Date.now() + 60_000, true);
    const layer = WorkstreamPolicyLayer.parse(req.workstreamPolicy ?? {});
    this.put("ws_layer", { ...layer, repos: canonicalRepos(layer.repos) });
    try {
      await this.placeCurrentEpoch();
    } catch (e) {
      // The sandbox exists either way. An unknown answer (the marker stays) is finished by the
      // `place` deadline: an error here would only make the client retry and mint a second sandbox.
      if (this.info_().placing === null) throw e;
      console.warn(`sandbox ${req.sandbox}: placement answer unknown; the place deadline reconciles it`, e);
    }
    return this.info_();
  }

  async info(): Promise<SandboxInfo> {
    return this.info_();
  }

  /** A placement that never finished leaves `placing` set: once stale, FleetDO's lease decides. */
  private async reconcilePlacing(): Promise<void> {
    const info = this.info_();
    const staleAt = lease.reconcileAt(info);
    if (staleAt === null) return;
    if (Date.now() < staleAt) {
      await this.deadlines.set("place", staleAt, true);
      return;
    }
    const epoch = info.placing!;
    const held = await this.fleet(info.cell).leaseOf(info.sandbox);
    const [r, after] = this.decide((i) => lease.reconciled(i, epoch, held));
    if (r === "adopted") this.recordEpoch(epoch, after.host!);
    if (r === "gone") {
      // Destroyed while FleetDO answered: a lease at this epoch was never this object's to adopt.
      if (held?.epoch === epoch) await this.discardPlacement(after, held.host, epoch);
    } else if (r === "adopted") {
      console.warn(`sandbox ${info.sandbox}: adopted the lease on ${after.host} (epoch ${epoch}) from an unfinished placement`);
      await this.afterPlaced();
    } else if (r === "cleared") {
      console.warn(`sandbox ${info.sandbox}: cleared an unfinished placement at epoch ${epoch} (no lease)`);
    }
  }

  /** Place an unplaced sandbox on a host under a new epoch (`lease.claim` says which it may). */
  async placeCurrentEpoch(excludeHost?: string): Promise<string | null> {
    await this.reconcilePlacing();
    const now = Date.now();
    // The source is chosen and pinned by id in the claim's step: retention, in this same single
    // writer, can't mark it `deleting` while the placement restores it.
    const from = this.restoreSource(this.info_(), now);
    const [claimed, before] = this.decide((i) => {
      const c = lease.claim(i, now);
      if (c.ok) i.restore_pin = from ? { generation: from.id, epoch: c.epoch } : null;
      return c;
    });
    if (!claimed.ok) throw claimed.error;
    const epoch = claimed.epoch;
    // If this call never finishes (a reset, a lost answer), the marker is reconciled when it goes stale.
    await this.deadlines.set("place", now + lease.PLACING_STALE_MS, true);
    let answer: lease.PlaceAnswer;
    let failure: unknown = null;
    try {
      const host = await this.fleet(before.cell).place({
        sandbox: before.sandbox,
        workstream: before.workstream,
        epoch,
        image: before.image,
        resources: before.resources,
        policy: this.effectivePolicy(),
        ...(from ? { from } : {}),
        ...(excludeHost ? { excludeHost } : {}),
      });
      answer = host ? { kind: "host", host } : { kind: "none" };
    } catch (e) {
      failure = e;
      answer = { kind: asNestError(e)?.code === ErrorCodes.FORBIDDEN ? "refused" : "unknown" };
    }
    const [r, after] = this.decide((i) => lease.placeAnswered(i, epoch, answer, from !== undefined));
    if (r === "placed") this.recordEpoch(epoch, after.host!);
    switch (r) {
      case "stale":
        // Overtaken while FleetDO answered: destroyed (whatever it granted goes too), or the marker
        // went stale and was reconciled. No follow-ups: they would act on a newer claim's state.
        if (!lease.gone(after.state)) return after.host;
        if (answer.kind === "host" || answer.kind === "unknown") await this.discardPlacement(after, answer.kind === "host" ? answer.host : null, epoch);
        return null;
      case "unknown":
        // A lease may exist: the marker stays for the `place` deadline to reconcile.
        throw failure;
      case "unplaced":
        // A refusal is not retried on its own (the leases disagree: an operator looks); no room is.
        if (answer.kind === "refused") {
          await this.deadlines.clear("place");
          throw failure;
        }
        await this.deadlines.set("place", Date.now() + PLACE_RETRY_MS, true);
        return null;
      case "placed":
        await this.deadlines.clear("place");
        await this.afterPlaced();
        return after.host;
    }
  }

  /** What every new placement (answered or adopted) is followed by. */
  private async afterPlaced(): Promise<void> {
    await this.pushSecrets();
    await this.issueAttachesOrRetry();
    await this.notifyAgentsMoved();
    await this.armIdle();
  }

  /**
   * Operator retry (`POST /place`): an unplaced sandbox is placed; a failed one is fenced on its old
   * host, its lease released, and placed again under a new epoch.
   */
  async retryPlacement(): Promise<string | null> {
    const info = this.info_();
    const old = lease.failedHolder(info);
    if (old) {
      await this.fleet(info.cell).issueCommands(old.host, [{ type: "fence", sandboxes: [info.sandbox], reason: "create failed; re-placing" }]);
      await this.fleet(info.cell).releaseLease(info.sandbox, old.epoch);
      this.update((i) => lease.retried(i, old.host, old.epoch));
    }
    return this.placeCurrentEpoch();
  }

  /**
   * Host-reported transition; ignored unless it comes from the current lease holder. A `running`
   * report carries the guest's version, which `resolve` hands to clients.
   */
  async reportState(
    host: string, epoch: number, state: SandboxState, detail: string | null, guest: GuestInfo | null = null,
  ): Promise<void> {
    const info = this.tryInfo();
    if (!info || !lease.holds(info, host, epoch)) return;
    // The host's reason, to Workers Logs only (it names host paths): the one place it was kept.
    if (state === "failed" && detail) console.warn(`sandbox ${info.sandbox}: failed on ${host}: ${detail}`);
    const [r] = this.decide((i) => lease.reported(i, host, epoch, state, guest));
    if (!r.applied) return;
    if (r.changed) this.report("state_changed", `state: ${state}`, { state, epoch, host });
    // A guest that just came up (boot, resume) takes the slots its sandbox was suspended without.
    if (r.becameRunning) await this.reissuePendingAttaches(true);
    await this.armIdle();
  }

  /**
   * Lazy start: a sandbox suspended on its host resumes there; one with no host is placed from its
   * head. The host, or `null` while none can take it yet (the caller retries).
   */
  async wake(): Promise<{ host: string | null; state: SandboxState }> {
    let info = this.info_();
    if (lease.gone(info.state)) throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${info.state}`, 409);
    if (!info.host && info.placing !== null) {
      await this.reconcilePlacing();
      info = this.info_();
    }
    if (info.host) {
      if (info.state === "suspended") await this.command({ type: "sandbox_resume" });
      return { host: info.host, state: info.state };
    }
    if (info.placing !== null) return { host: null, state: info.state };
    const host = await this.placeCurrentEpoch();
    return { host, state: this.info_().state };
  }

  /** FleetDO took this suspended sandbox off a host going away (`lease.evicted`). */
  async evicted(host: string, epoch: number): Promise<void> {
    if (!this.tryInfo()) return;
    const [r] = this.decide((i) => lease.evicted(i, host, epoch));
    if (r === "ignore") return;
    await this.deadlines.clear("idle");
    if (r === "replace") await this.placeCurrentEpoch(host);
    else await this.notifyAgentsMoved();
  }

  /** Start (or clear) the idle countdown: running, placed, and no agent working. */
  private async armIdle(): Promise<void> {
    const info = this.info_();
    if (info.host && info.state === "running" && info.working.length === 0) {
      if (!this.deadlines.has("idle")) {
        await this.deadlines.set("idle", Date.now() + num(this.env.SANDBOX_SUSPEND_IDLE_MS, DEFAULT_SUSPEND_IDLE_MS));
      }
    } else {
      await this.deadlines.clear("idle");
    }
  }

  /** A command failed on the lease holder: only `sandbox_create` failures matter here. */
  async commandFailed(host: string, type: string, epoch: number, error: ErrorBody): Promise<void> {
    if (type !== "sandbox_create" || !this.tryInfo()) return;
    const [r, info] = this.decide((i) => lease.createFailed(i, host, epoch, error.retryable));
    if (r === "reissue") {
      await this.fleet(info.cell).issueCommands(host, [this.createBody(info)]);
      await this.pushSecrets();
    } else if (r === "failed") {
      console.warn(`sandbox ${info.sandbox}: create failed: ${error.code} ${error.message}`);
    }
  }

  /** FleetDO dropped the lease (STONITH, or a fence): placed again from head. FleetDO retries until it succeeds. */
  async leaseLost(host: string, epoch: number, hostIsDead: boolean): Promise<void> {
    if (!this.tryInfo()) return;
    const [r] = this.decide((i) => lease.leaseLost(i, host, epoch));
    if (r === "ignore") return; // gone, or already handled (re-placed, or a newer epoch exists)
    // A dead host is excluded; a host that came back and fenced is healthy and may get the new lease.
    const placed = await this.placeCurrentEpoch(hostIsDead ? host : undefined);
    if (!placed) await this.notifyAgentsMoved();
  }

  /**
   * Tell bound agents their sandbox moved, from this object's own alarm: a placement made inside an
   * agent's own call (its start wakes the sandbox) would deadlock calling back into it.
   */
  private async notifyAgentsMoved(): Promise<void> {
    const info = this.info_();
    this.report("moved", info.host ? `placed on ${info.host} at epoch ${info.epoch}` : "no host: restored from its head when next woken",
      { epoch: info.epoch, host: info.host }, `${info.sandbox}/moved/${info.epoch}/${info.host ?? "none"}`);
    await this.deadlines.set("notify_moved", Date.now(), true);
  }

  /** The `notify_moved` alarm: one agent's failure doesn't stop the others, and is retried. */
  private async sendMoveNotices(): Promise<void> {
    const info = this.info_();
    let failed = false;
    for (const agent of info.attached) {
      try {
        await this.env.AGENT.get(this.env.AGENT.idFromName(agent)).onSandboxMoved(info.sandbox, info.epoch, info.host);
      } catch (e) {
        failed = true;
        console.error(`sandbox ${info.sandbox}: notifying ${agent} of the move failed; retrying`, e);
      }
    }
    if (failed) await this.deadlines.set("notify_moved", Date.now() + slots.ATTACH_RETRY_MS, true);
  }

  /** The manifests GC must keep (`gcRootsOf`): none once destroyed; never a `deleting` generation's. */
  async gcRoots(): Promise<string[]> {
    const info = this.tryInfo();
    if (!info || info.state === "destroyed") return [];
    const now = Date.now();
    return gcRootsOf(this.readyRows(), this.chain(info, now), retentionMode(this.env));
  }

  /**
   * Destroyed is decided at once, before any await: a placement answer that lands meanwhile finds
   * the sandbox gone, and discards what it got. FleetDO is told before the lease is released, so it
   * grants nothing afterwards (and its generations stop being GC roots). A retry repeats the cleanup.
   */
  async destroy(reason = "requested"): Promise<void> {
    const before = this.info_();
    this.update(lease.destroyed);
    await this.afterDestroyed(before, reason);
  }

  /** What follows the decision that it is destroyed (`before`: the record just before it). A retry repeats it. */
  private async afterDestroyed(before: SandboxInfo, reason: string): Promise<void> {
    this.report("destroyed", `destroyed (${reason})`, { epoch: before.epoch, reason }, `${before.sandbox}/destroyed`);
    const fleet = this.fleet(before.cell);
    await fleet.sandboxDestroyed(before.sandbox);
    if (before.host) await fleet.issueCommands(before.host, [{ type: "sandbox_destroy", sandbox: before.sandbox, epoch: before.epoch }]);
    await fleet.releaseLease(before.sandbox);
    await this.deadlines.clear("grants");
    await this.deadlines.clear("place");
    await this.deadlines.clear("inject_refresh");
    await this.deadlines.clear("expiry");
    await this.deadlines.clear("retention");
    await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).forgetInjections(before.sandbox);
  }

  /** `sandbox_create` for the current epoch, from the head if there is one. */
  private createBody(info: SandboxInfo): CommandBody {
    const from = this.restoreSource(info, Date.now());
    return {
      type: "sandbox_create", sandbox: info.sandbox, workstream: info.workstream, epoch: info.epoch, image: info.image,
      resources: info.resources, policy: this.effectivePolicy(), ...(from ? { from } : {}),
    };
  }

  /** A lease granted to a destroyed sandbox: released, and its VM destroyed (unknown host: its heartbeat fences it). */
  private async discardPlacement(info: SandboxInfo, host: string | null, epoch: number): Promise<void> {
    await this.fleet(info.cell).releaseLease(info.sandbox, epoch);
    if (host) await this.fleet(info.cell).issueCommands(host, [{ type: "sandbox_destroy", sandbox: info.sandbox, epoch }]);
  }

  /** Send one command to the current holder, stamped with the sandbox and the epoch read with the host. */
  private async command(body: SandboxCommand): Promise<void> {
    const info = this.info_();
    if (!info.host) throw new NestError(ErrorCodes.NOT_BOUND, "sandbox is not placed on a host", 409, true);
    await this.fleet(info.cell).issueCommands(info.host, [{ ...body, sandbox: info.sandbox, epoch: info.epoch } as CommandBody]);
  }

  // --- generations ----------------------------------------------------------------------------------

  /** The head generation, if any (an agent's recovery context compares it with its transcript). */
  async headGeneration(): Promise<GenerationRecord | null> {
    const head = this.get<SandboxInfo>("info")?.head;
    return (head && this.generation(head)) || null;
  }

  private generation(id: string): GenerationRecord | undefined {
    const row = this.sql.exec<{ record: string }>("SELECT record FROM generations WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.record) as GenerationRecord) : undefined;
  }

  /**
   * Every recorded generation, oldest first, with its state and, for a ready one, why retention keeps
   * it (`null`: the next pass drops it, or would in `report` mode).
   */
  async generations(): Promise<{ record: GenerationRecord; orphaned: boolean; state: "ready" | "deleting"; retained: string | null }[]> {
    const info = this.tryInfo();
    const rows = this.sql
      .exec<{ record: string; orphaned: number; state: string | null }>("SELECT record, orphaned, state FROM generations ORDER BY created_ms, id")
      .toArray();
    const kept = info ? retention(this.readyRows(), this.chain(info, Date.now())).kept : new Map<string, string>();
    return rows.map((r) => {
      const record = JSON.parse(r.record) as GenerationRecord;
      const deleting = r.state === "deleting";
      return { record, orphaned: r.orphaned === 1, state: deleting ? "deleting" : "ready", retained: deleting ? null : kept.get(record.id) ?? null };
    });
  }

  /** The ready generations, as retention reads them. */
  private readyRows(): RootRow[] {
    return this.sql
      .exec<{ record: string; orphaned: number; created_ms: number }>("SELECT record, orphaned, created_ms FROM generations WHERE state IS NULL")
      .toArray()
      .map((r) => {
        const g = JSON.parse(r.record) as GenerationRecord;
        return {
          id: g.id, parent: g.parent ?? null, orphaned: r.orphaned === 1, reason: g.reason, created_ms: r.created_ms, deleting: false,
          disk_manifest: g.disk_manifest, ...(g.mem_manifest ? { mem_manifest: g.mem_manifest } : {}),
        };
      });
  }

  /** What `isRestoreSource` reads: the head, the live pins, and every orphan's parent (`deleting` orphans' too). */
  private chain(info: SandboxInfo, now: number): ChainView {
    const parents = this.sql.exec<{ record: string }>("SELECT record FROM generations WHERE orphaned = 1").toArray()
      .map((r) => (JSON.parse(r.record) as GenerationRecord).parent)
      .filter((p): p is string => p !== undefined);
    return chainView(info.head, livePins(info), parents, now);
  }

  /**
   * What a placement restores: the head, which must be a restore source. It always is (only a commit
   * moves the head, to a new generation, and retention never marks a restore source), so a head that
   * isn't is a broken invariant: refused, never restored and never replaced by an older generation.
   */
  private restoreSource(info: SandboxInfo, now: number): GenerationRecord | undefined {
    if (!info.head) return undefined;
    const row = this.sql.exec<{ record: string; orphaned: number; created_ms: number; state: string | null }>(
      "SELECT record, orphaned, created_ms, state FROM generations WHERE id = ?", info.head).toArray()[0];
    if (!row) throw new NestError(ErrorCodes.INTERNAL, `sandbox ${info.sandbox}: its head ${info.head} is not recorded`, 500);
    const g = JSON.parse(row.record) as GenerationRecord;
    const gen: GenRow = { id: g.id, parent: g.parent ?? null, orphaned: row.orphaned === 1, reason: g.reason, created_ms: row.created_ms, deleting: row.state === "deleting" };
    if (!isRestoreSource(gen, chainView(info.head, livePins(info), [], now))) {
      console.error(`sandbox ${info.sandbox}: its head ${g.id} is not a restore source (${row.state ?? "ready"}); not restoring it`);
      throw new NestError(ErrorCodes.INTERNAL, `sandbox ${info.sandbox}: its head is not a restore source`, 500);
    }
    return g;
  }

  /**
   * The `retention` deadline (`retention()`): in `on` mode, marks what it drops `deleting`, at most
   * `RETENTION_MAX_MARKS` a pass, all in one synchronous step with the read, so a claim's pin and a
   * commit's new head are seen; `report` mode records what it would drop. Then prunes old `deleting`
   * rows. Re-armed while the sandbox lives.
   */
  private async runRetention(): Promise<void> {
    const mode = retentionMode(this.env);
    const info = this.tryInfo();
    if (mode === "off" || !info || info.state === "destroyed") return;
    const now = Date.now();
    const rows = this.readyRows();
    const view = this.chain(info, now);
    const d = retention(rows, view);
    let marked = 0;
    if (mode === "on") {
      for (const id of d.drop.slice(0, RETENTION_MAX_MARKS)) {
        // `rowsWritten` counts index rows too: one or more means this row changed.
        if (this.sql.exec("UPDATE generations SET state = 'deleting', deleting_ms = ? WHERE id = ? AND state IS NULL", now, id).rowsWritten > 0) marked += 1;
      }
    }
    const old = this.sql.exec<{ id: string }>(`SELECT id FROM generations WHERE state = 'deleting' AND deleting_ms < ?
      AND (orphaned = 0 OR deleting_ms < ?) LIMIT ?`, now - DELETING_ROW_RETENTION_MS, now - DELETING_ORPHAN_ROW_RETENTION_MS, RETENTION_MAX_MARKS).toArray();
    for (const { id } of old) this.sql.exec("DELETE FROM generations WHERE id = ? AND state = 'deleting'", id);
    const pruned = old.length;
    const memory = rows.filter((g) => g.mem_manifest && !isRestoreSource(g, view)).length;
    this.put("retention_report", { at: now, mode, ready: rows.length, drop: d.drop.length, marked, pruned, memory_not_source: memory });
    if (d.drop.length || pruned) {
      console.log(`sandbox ${info.sandbox}: retention (${mode}): ${rows.length} ready, ${d.drop.length} to drop` +
        `${mode === "on" ? ` (${marked} marked deleting)` : " (report only)"}, ${memory} checkpoints' memory not a restore source, ${pruned} old rows pruned`);
    }
    await this.deadlines.set("retention", now + (mode === "on" && d.drop.length > marked ? RETENTION_CONTINUE_MS : RETENTION_RECHECK_MS));
  }

  /** Compare-and-set the head (`lease.decideCommit`), idempotent per `request`. */
  async commit(host: string, ev: CommitRequestEvent): Promise<CommitOutcome> {
    const stored = this.sql.exec<{ outcome: string }>("SELECT outcome FROM commits WHERE request = ?", ev.request).toArray()[0];
    if (stored) {
      const outcome = JSON.parse(stored.outcome) as CommitOutcome;
      // The first answer's notice may not have been posted (it failed after the record was stored).
      if (outcome.status === "orphaned") await this.noticeOrphan(ev, outcome.generation);
      return outcome;
    }
    const info = this.info_();
    const record = (): GenerationRecord => ({
      id: newId("gen_"),
      sandbox: info.sandbox,
      ...(ev.parent ? { parent: ev.parent } : {}),
      epoch: ev.epoch,
      kind: ev.kind,
      disk_manifest: ev.disk_manifest,
      ...(ev.mem_manifest ? { mem_manifest: ev.mem_manifest } : {}),
      reason: ev.reason,
      created_ms: Date.now(),
    });
    const d = lease.decideCommit(info, (e) => this.epochHost(e), host, ev);
    let outcome: CommitOutcome;
    if (d.kind === "rejected") {
      outcome = { status: "rejected", reason: d.reason, ...(info.head ? { head: info.head } : {}) };
    } else {
      const generation = record();
      this.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, ?, ?)",
        generation.id, JSON.stringify(generation), d.kind === "orphan" ? 1 : 0, generation.created_ms);
      if (d.kind === "head") {
        this.update((i) => {
          i.head = generation.id;
        });
      }
      outcome = { status: d.kind === "orphan" ? "orphaned" : "committed", generation };
    }
    this.sql.exec("INSERT INTO commits (request, outcome, created_ms, generation_id) VALUES (?, ?, ?, ?)",
      ev.request, JSON.stringify(outcome), Date.now(), outcome.status === "rejected" ? null : outcome.generation.id);
    await this.deadlines.set("commit_prune", Date.now() + COMMIT_PRUNE_INTERVAL_MS, true);
    if (outcome.status !== "rejected") await this.deadlines.set("retention", Date.now() + RETENTION_AFTER_COMMIT_MS, true);
    if (outcome.status === "orphaned") await this.noticeOrphan(ev, outcome.generation);
    return outcome;
  }

  /** `orphaned_work` to the workstream, at least once per request (WorkstreamDO drops a repeated key). */
  private async noticeOrphan(ev: CommitRequestEvent, orphan: GenerationRecord): Promise<void> {
    const info = this.info_();
    await this.env.WORKSTREAM.get(this.env.WORKSTREAM.idFromName(info.workstream)).ingest({
      workstream: info.workstream,
      ts_ms: Date.now(),
      sandbox: info.sandbox,
      epoch: info.epoch,
      type: "orphaned_work",
      generation: orphan.id,
      stale_epoch: ev.epoch,
    }, `orphan/${ev.request}`);
  }

  /**
   * Retention of the idempotency records (docs/data/#retention). nestd may ask again days later: a
   * committed request finds its record while the generation is kept; any other meets the CAS anew.
   */
  private async pruneCommitRecords(): Promise<void> {
    const cutoff = Date.now() - COMMIT_RECORD_RETENTION_MS;
    // Rejected requests (the partial index), then records whose generation left the chain.
    this.sql.exec("DELETE FROM commits WHERE generation_id IS NULL AND created_ms < ?", cutoff);
    this.sql.exec(`DELETE FROM commits WHERE generation_id IS NOT NULL AND created_ms < ?
      AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.id = commits.generation_id)`, cutoff);
    // Again when the oldest rejected record left ages out (a commit arms it sooner, hourly).
    const oldest = this.sql.exec<{ at: number | null }>("SELECT MIN(created_ms) AS at FROM commits WHERE generation_id IS NULL").toArray()[0]?.at;
    if (oldest !== null && oldest !== undefined) {
      await this.deadlines.set("commit_prune", Math.max(oldest + COMMIT_RECORD_RETENTION_MS, Date.now() + COMMIT_PRUNE_INTERVAL_MS), true);
    }
  }

  // --- egress policy --------------------------------------------------------------------------------

  /**
   * Effective policy merged from the base, workstream and sandbox (temporary grant) layers, plus what the
   * rule constructors build from the push allowlist (lib/rules/github.ts): its guards always, layered
   * with the operator's own. An operator binding named `github` wins over the constructed one.
   */
  private effectivePolicy(now = Date.now()): EgressPolicy {
    const info = this.info_();
    const ws = this.wsLayer();
    const gh = githubEgress(this.pushRepos());
    const inject = [...ws.inject, ...gh.inject.filter((b) => !ws.inject.some((w) => w.name === b.name))];
    const allow: AllowRule[] = [
      ...BASE_ALLOW.map((host) => ({ host, ports: WEB_PORTS, layer: "base" as const })),
      ...[...ws.allow, ...gh.allow].map((a) => ({ host: a.host, ports: a.ports ?? WEB_PORTS, layer: "workstream" as const })),
      ...this.sql
        .exec<{ host: string; ports: string; expires_ms: number }>("SELECT host, ports, expires_ms FROM grants WHERE expires_ms > ? ORDER BY expires_ms", now)
        .toArray()
        .map((g) => ({ host: g.host, ports: JSON.parse(g.ports) as number[], layer: "sandbox" as const, expires_ms: g.expires_ms })),
    ];
    return {
      version: info.policy_version,
      allow,
      passthrough: ws.passthrough,
      inject,
      tcp: ws.tcp,
      limits: DEFAULT_LIMITS,
      guards: [...gh.guards, ...(ws.guards ?? [])],
    };
  }

  /** The operator's layer; one stored before `repos` and `guards` reads as having none. */
  private wsLayer(): WorkstreamPolicyLayer {
    const l = this.get<Partial<WorkstreamPolicyLayer>>("ws_layer");
    return { ...EMPTY_LAYER, ...l, repos: l?.repos ?? [], guards: l?.guards ?? [] };
  }

  async policy(): Promise<EgressPolicy> {
    return this.effectivePolicy();
  }

  async setWorkstreamPolicy(input: WorkstreamPolicyInput): Promise<EgressPolicy> {
    this.info_();
    const layer = WorkstreamPolicyLayer.parse(input);
    this.put("ws_layer", { ...layer, repos: canonicalRepos(layer.repos) });
    return this.policyChanged(true);
  }

  /** Temporary sandbox-layer grant (e.g. approved through `ask`). Expires on its own. */
  async grant(host: string, ttlMs: number, ports: number[] = WEB_PORTS): Promise<EgressPolicy> {
    this.info_(); // an unknown sandbox gets no row and no alarm
    const expires = Date.now() + ttlMs;
    this.sql.exec("INSERT INTO grants (id, host, ports, expires_ms) VALUES (?, ?, ?, ?)", newId("grt_"), host, JSON.stringify(ports), expires);
    await this.deadlines.set("grants", expires, true);
    return this.policyChanged(false);
  }

  /**
   * Temporary grants an agent's `egress_policy` asked for (docs/sandbox/networking/egress/policy/#rules),
   * one policy version for all of them. Each grant's id is derived from `request` (the call key), so a
   * re-run of the same call adds nothing.
   */
  async widenEgress(request: string, rules: { host: string; ports?: number[] }[], ttlMs: number): Promise<EgressPolicy> {
    const ids = await Promise.all(rules.map(async (r) => `grt_${hex(await sha256(`${request}|${r.host}`)).slice(0, 24)}`));
    this.info_(); // an unknown sandbox gets no row and no alarm
    const expires = Date.now() + ttlMs;
    let added = 0;
    rules.forEach((r, i) => {
      added += this.sql.exec("INSERT OR IGNORE INTO grants (id, host, ports, expires_ms) VALUES (?, ?, ?, ?)",
        ids[i]!, r.host, JSON.stringify(r.ports ?? WEB_PORTS), expires).rowsWritten;
    });
    if (!added) return this.effectivePolicy();
    await this.deadlines.set("grants", expires, true);
    return this.policyChanged(false);
  }

  /** Drop every temporary grant for these hosts (narrowing is never gated). */
  async narrowEgress(hosts: string[]): Promise<EgressPolicy> {
    this.info_();
    let removed = 0;
    for (const h of hosts) removed += this.sql.exec("DELETE FROM grants WHERE host = ?", h).rowsWritten;
    return removed ? this.policyChanged(false) : this.effectivePolicy();
  }

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "grants") {
        const now = Date.now();
        const expired = this.sql.exec("SELECT id FROM grants WHERE expires_ms <= ?", now).toArray().length;
        this.sql.exec("DELETE FROM grants WHERE expires_ms <= ?", now);
        const next = this.sql.exec<{ at: number | null }>("SELECT MIN(expires_ms) AS at FROM grants").toArray()[0]?.at;
        if (next) await this.deadlines.set("grants", next);
        if (expired) await this.policyChanged(false);
      } else if (key === "place") {
        // An unfinished placement is reconciled first (or the deadline re-armed until it goes stale).
        await this.reconcilePlacing();
        if (lease.placeWanted(this.info_())) await this.placeCurrentEpoch();
      } else if (key === "inject_refresh") {
        const info = this.info_();
        if (info.host && ACTIVE_STATES.includes(info.state)) await this.pushSecrets(true);
      } else if (key === "turn_checkpoint") {
        await this.turnEndCheckpoint();
      } else if (key === "idle") {
        const info = this.info_();
        if (info.host && info.state === "running" && info.working.length === 0) {
          await this.command({ type: "sandbox_suspend", mode: "disk_only" });
        }
      } else if (key === "attach_retry") {
        await this.reissuePendingAttaches(false);
      } else if (key === "commit_prune") {
        await this.pruneCommitRecords();
      } else if (key === "retention") {
        await this.runRetention();
      } else if (key === "notify_moved") {
        await this.sendMoveNotices();
      } else if (key === "expiry") {
        await this.checkExpiry();
      } else if (key === OUTBOX_DEADLINE) {
        await this.outbox.flush();
      }
    }, 5_000, [OUTBOX_DEADLINE]);
  }

  private async policyChanged(injectionChanged: boolean): Promise<EgressPolicy> {
    const info = this.update((i) => {
      i.policy_version += 1;
    });
    const policy = this.effectivePolicy();
    if (info.host && ACTIVE_STATES.includes(info.state)) {
      await this.command({ type: "policy_update", policy });
      if (injectionChanged) await this.pushSecrets(true);
    }
    return policy;
  }

  /**
   * Injection secrets for the policy's bindings, as BrokerDO references (FleetDO resolves them when it
   * sends): the operator's static ones (`inject:<binding>[:<sandbox>]`), and for a push allowlist a
   * GitHub installation token BrokerDO mints for exactly those repos. `secrets_update` replaces the
   * proxy's set, so `force` sends it even when empty (an allowlist emptied takes the token away).
   *
   * Checked twice: whatever arrives while BrokerDO minted (a fence, a move, an allowlist change) makes
   * this push stale, and it is dropped; the change that did it pushes again.
   */
  private async pushSecrets(force = false): Promise<void> {
    const before = this.info_();
    const ws = this.wsLayer();
    const repos = this.pushRepos();
    const mint = repos.length > 0 && !ws.inject.some((b) => b.name === GITHUB_BINDING);
    if (!before.host || (!ws.inject.length && !mint && !force)) return;
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName("broker"));
    const secrets: InjectionSecret[] = ws.inject.length
      ? await broker.injectionSecretRefs(ws.inject.map((b) => b.name), { sandbox: before.sandbox, workstream: before.workstream })
      : [];
    let next: number | null = null;
    if (!mint && force) await broker.forgetInjections(before.sandbox);
    if (mint) {
      try {
        const t = await broker.injectionSecret({ sandbox: before.sandbox, epoch: before.epoch },
          { kind: "github_app", binding: GITHUB_BINDING, repos }, "SandboxDO");
        if (t) {
          secrets.push({ binding: t.binding, value: t.value, ...(t.expires_ms !== undefined ? { expires_ms: t.expires_ms } : {}) });
          next = (t.expires_ms ?? Date.now() + INJECT_IDLE_RETRY_MS) - INJECT_REFRESH_BEFORE_MS;
        } else {
          next = Date.now() + INJECT_IDLE_RETRY_MS;
        }
      } catch (e) {
        console.warn(`sandbox ${before.sandbox}: minting its GitHub token failed; retrying`, e);
        next = Date.now() + INJECT_RETRY_MS;
      }
    }
    const after = this.info_();
    if (after.epoch !== before.epoch || after.host !== before.host || this.pushRepos().join() !== repos.join()) return;
    if (secrets.length || force || mint) await this.command({ type: "secrets_update", secrets });
    if (next !== null) await this.deadlines.set("inject_refresh", next);
    else await this.deadlines.clear("inject_refresh");
  }

  // --- agents, bindings and idleness (docs/control-plane/durable-objects/sandbox/#attach-and-bindings) --

  /**
   * Attach an agent's hands: its slot is configured with `agent_attach`, and no binding is minted before its
   * `ok`. `repos`: its spec's push allowlist, which joins the sandbox's while it is attached (everything in
   * one sandbox shares a trust domain).
   */
  async attach(agent: string, cwd?: string, repos?: string[]): Promise<SandboxInfo> {
    const cur = this.info_();
    if (lease.gone(cur.state)) throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${cur.state}`, 409);
    const widened = this.setAgentRepos(agent, repos ?? []);
    const [send, info] = this.decide((i) => slots.attach(i, agent, cwd ?? null, i.host !== null));
    if (send) await this.issueAttachCommands([agent]);
    if (widened) await this.policyChanged(true);
    return info;
  }

  /** Remove the agent's slot (killing its processes); its bindings are refused from then on. */
  async detach(agent: string): Promise<void> {
    await this.release(agent, false);
  }

  /**
   * An agent ended for good: its slot goes (`detach`), and with `destroy` the sandbox too, in the same
   * step, if it was created for that agent and no other agent is attached. Idempotent: a retry after
   * the destroy repeats its cleanup.
   */
  async release(agent: string, destroy: boolean): Promise<{ destroyed: boolean }> {
    const before = this.tryInfo();
    if (!before) return { destroyed: false };
    const mine = destroy && before.owner === agent;
    if (before.state === "destroyed") {
      if (mine) await this.afterDestroyed(before, `its agent ${agent} ended`);
      return { destroyed: mine };
    }
    const [destroyed, info] = this.decide((i) => {
      slots.detach(i, agent);
      const d = mine && i.attached.length === 0;
      if (d) lease.destroyed(i);
      return d;
    });
    const narrowed = this.setAgentRepos(agent, []);
    if (destroyed) {
      await this.afterDestroyed(before, `its agent ${agent} ended`);
      return { destroyed: true };
    }
    if (info.host) {
      await this.command({ type: "agent_detach", agent, kill_processes: true });
    }
    if (narrowed) await this.policyChanged(true);
    await this.armIdle();
    return { destroyed: false };
  }

  // --- lifetime (docs/control-plane/durable-objects/sandbox/#lifetime) --------------------------------

  /**
   * The `expiry` deadline: a sandbox dormant for its idle TTL is destroyed (`expiryStep`); one with a
   * TTL over a day gets a notice on `user` a day first. Re-armed on every check while it lives.
   */
  private async checkExpiry(): Promise<void> {
    const now = Date.now();
    const before = this.tryInfo();
    if (!before || before.state === "destroyed") return;
    // Recorded with the check; after missed checks the dormancy clock (and any notice) starts again.
    const gap = before.expiry_checked_ms !== undefined && now - before.expiry_checked_ms > EXPIRY_GAP_MS;
    const s = this.update((i) => {
      i.expiry_checked_ms = now;
      if (gap && i.dormant_since_ms !== undefined) {
        i.dormant_since_ms = now;
        delete i.expiry_notice_ms;
      }
    });
    const ttl = s.idle_ttl_ms ?? cellIdleTtlMs(this.env, s.cell);
    const step = expiryStep({
      dormant: dormant(s), ttl, now, ...(s.dormant_since_ms !== undefined ? { since: s.dormant_since_ms } : {}),
      ...(s.expiry_notice_ms !== undefined ? { noticed: s.expiry_notice_ms } : {}),
    });
    if (step.kind === "destroy") {
      console.log(`sandbox ${s.sandbox}: dormant since ${new Date(step.since).toISOString()}, past its idle TTL (${ttl} ms); destroying`);
      await this.destroy(`dormant past its idle TTL of ${days(ttl)}`);
      return;
    }
    if (step.kind === "notice") {
      this.update((i) => {
        i.expiry_notice_ms = now;
      });
      const at = new Date(step.destroy_at).toISOString();
      this.outbox.push("user", {
        kind: "sandbox_expiring",
        text: `Sandbox ${s.sandbox} (cell ${s.cell}) has had no agent attached and no VM up since ${new Date(step.since).toISOString()}; it will be ` +
          `destroyed at ${at} (idle TTL ${days(ttl)}). To keep it, wake it (POST /v1/sandboxes/${s.sandbox}/place), attach an agent, or give it ` +
          `a longer TTL (PUT /v1/sandboxes/${s.sandbox}/lifetime).`,
        data: { sandbox: s.sandbox, cell: s.cell, dormant_since_ms: step.since, destroy_at_ms: step.destroy_at, idle_ttl_ms: ttl },
        idem_key: `${s.sandbox}/expiry/${step.since}`,
      }, { tainted: false });
    }
    // Sandboxes from before retention (and any whose deadline a rolled-back release dropped) get it here.
    if (!this.deadlines.has("retention")) await this.deadlines.set("retention", now);
    await this.deadlines.set("expiry", step.at);
  }

  /** FleetDO's backfill for sandboxes created before lifetimes: arm the check if it isn't. */
  async ensureLifetime(): Promise<boolean> {
    const s = this.tryInfo();
    if (!s || s.state === "destroyed") return false;
    if (!this.deadlines.has("expiry")) await this.deadlines.set("expiry", Date.now());
    return true;
  }

  /** The operator's: this sandbox's own idle TTL (null: back to the cell default). Checked again at once. */
  async setLifetime(idleTtlMs: number | null): Promise<SandboxInfo> {
    const info = this.update((i) => {
      if (idleTtlMs === null) delete i.idle_ttl_ms;
      else i.idle_ttl_ms = idleTtlMs;
      // A new TTL warns again before it ends.
      delete i.expiry_notice_ms;
    });
    if (!lease.gone(info.state)) await this.deadlines.set("expiry", Date.now());
    return info;
  }

  /**
   * Add repos to an attached agent's part of the allowlist (a fork it made, approved by the operator:
   * AgentDO's `github.fork`). Ignored for an agent that isn't attached.
   */
  async allowAgentRepos(agent: string, repos: string[]): Promise<string[]> {
    if (!this.info_().attached.includes(agent)) return this.pushRepos();
    const have = this.get<Record<string, string[]>>("agent_repos")?.[agent] ?? [];
    if (this.setAgentRepos(agent, [...have, ...repos])) await this.policyChanged(true);
    return this.pushRepos();
  }

  /** Record an attached agent's push allowlist; whether the sandbox's allowlist changed. */
  private setAgentRepos(agent: string, repos: string[]): boolean {
    const before = this.pushRepos();
    const all = { ...(this.get<Record<string, string[]>>("agent_repos") ?? {}) };
    if (repos.length) all[agent] = canonicalRepos(repos);
    else delete all[agent];
    this.put("agent_repos", all);
    return this.pushRepos().join() !== before.join();
  }

  /** The push allowlist: the operator's layer and every attached agent's spec (docs/sandbox/networking/egress/policy/#repo-allowlists). */
  pushRepos(): string[] {
    return unionRepos(this.wsLayer().repos, ...Object.values(this.get<Record<string, string[]>>("agent_repos") ?? {}));
  }

  /** Send `agent_attach` for these agents, each as the agent's one in flight. */
  private async issueAttachCommands(agents: string[]): Promise<void> {
    const info = this.info_();
    if (!info.host || !agents.length) return;
    const bodies = agents.map((agent): CommandBody => {
      const cwd = info.attach_cwd[agent];
      return { type: "agent_attach", sandbox: info.sandbox, epoch: info.epoch, agent, ...(cwd ? { cwd } : {}) };
    });
    const cmds = await this.fleet(info.cell).issueCommands(info.host, bodies);
    this.update((i) => {
      if (i.host === info.host && i.epoch === info.epoch) slots.sent(i, agents, cmds);
    });
  }

  /** A new placement configures every slot again; a failed send is retried from the alarm, so the other follow-ups run. */
  private async issueAttachesOrRetry(): Promise<void> {
    const [agents, info] = this.decide(slots.newPlacement);
    if (!info.host || !agents.length) return;
    try {
      await this.issueAttachCommands(agents);
    } catch (e) {
      console.error(`sandbox ${info.sandbox}: issuing agent_attach failed; retrying`, e);
      await this.deadlines.set("attach_retry", Date.now() + slots.ATTACH_RETRY_MS, true);
    }
  }

  /** Re-send `agent_attach` for pending agents with none in flight. */
  private async reissuePendingAttaches(fresh: boolean): Promise<void> {
    const [agents, info] = this.decide((i) => slots.due(i, fresh));
    if (info.host) await this.issueAttachCommands(agents);
  }

  /** An `agent_attach` result, from the holder at the current epoch only. */
  async attachResult(host: string, epoch: number, agent: string, cmd: string, outcome: CommandOutcome): Promise<void> {
    const info = this.tryInfo();
    if (!info || !lease.holds(info, host, epoch)) return;
    const [r] = this.decide((i) => slots.attachResult(i, agent, cmd, outcome.status === "ok", outcome.status !== "ok" && outcome.error.retryable));
    if (r.kind === "retry") {
      await this.deadlines.set("attach_retry", Date.now() + r.delayMs, true);
    } else if (r.kind === "failed" && outcome.status !== "ok") {
      // The agent stays pending (no binding the gateway would refuse); the next `running` report
      // re-issues it, and `resolve` keeps answering not-ready meanwhile.
      console.warn(`sandbox ${info.sandbox}: attaching ${agent} failed: ${outcome.error.code} ${outcome.error.message}`);
    }
  }

  /**
   * A fresh binding and the current gateway for an attached agent: not ready (retryable) until
   * `slots.unbindable` allows it and the gateway is reachable. The token is BrokerDO's, never stored.
   */
  async resolve(agent: string): Promise<HandsTarget> {
    let info = this.info_();
    const notReady = (why: string) => new NestError(ErrorCodes.SANDBOX_NOT_READY, why, 503, true);
    if (info.attached.includes(agent) && info.host && info.state === "suspended") {
      await this.wake();
      info = this.info_();
    }
    const refused = slots.unbindable(info, agent);
    if (refused) throw refused;
    const host = info.host!;
    const gateway = await this.fleet(info.cell).hostGatewayUrl(host);
    if (!gateway) throw notReady(`host ${host} advertises no gateway yet`);
    // A target now would only fail at the edge.
    if (gateway.kind === "connecting") throw notReady(`host ${host}'s tunnel is connecting`);
    if (gateway.kind === "down") {
      console.error(`SandboxDO: host ${host} has the tunnel ${gateway.tunnel} but serves none; ${info.sandbox} is unreachable until it does`);
      throw notReady(`host ${host} serves no tunnel`);
    }
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName("broker"));
    const binding = await broker.signBinding(info.cell, {
      sandbox: info.sandbox, epoch: info.epoch, client: agent, scope: "hands", exp_ms: Date.now() + BINDING_LIFETIME_MS,
    });
    // Only a tunnel has the Access edge in front: the service token never travels to a direct gateway.
    // Without it a tunnel target is refused on every call: not retryable (docs/setup/).
    const edge = gateway.kind === "tunnel" ? await broker.accessServiceToken() : null;
    if (gateway.kind === "tunnel" && !edge) {
      throw new NestError(ErrorCodes.INTERNAL, "access:gateway is not stored; a tunnel target cannot be used without it", 500, false);
    }
    // Across the awaits it may have moved or suspended, or the agent detached: never a token the gateway refuses.
    const fresh = this.info_();
    const now = slots.unbindable(fresh, agent);
    if (now) throw now;
    if (fresh.epoch !== info.epoch || fresh.host !== host) throw notReady("sandbox moved while resolving");
    // `sandbox` and `epoch`: unsigned copies of the claims, for clients of the previous release only.
    return { url: gateway.url, sandbox: info.sandbox, epoch: info.epoch, binding, guest: fresh.guest!, ...(edge ? { edge } : {}) };
  }

  /** Agent activity feeds the idle refcount: the sandbox may suspend only when nobody is working. */
  async agentActivity(agent: string, working: boolean): Promise<{ idle: boolean }> {
    const [{ turnEnded }, info] = this.decide((i) => slots.setWorking(i, agent, working));
    await this.armIdle();
    if (turnEnded) await this.turnEndCheckpoint();
    return { idle: info.working.length === 0 };
  }

  /**
   * An agent finished a turn: commit the disk (`turn_end`), at most once per TURN_CHECKPOINT_MIN_MS; a
   * turn ending sooner gets its commit when the interval is up, so the last turn's is never skipped.
   */
  private async turnEndCheckpoint(): Promise<void> {
    const last = this.get<number>("turn_checkpoint_ms") ?? 0;
    const due = last + TURN_CHECKPOINT_MIN_MS;
    if (Date.now() < due) {
      await this.deadlines.set("turn_checkpoint", due);
      return;
    }
    const info = this.info_();
    if (!info.host || info.state !== "running") return;
    this.put("turn_checkpoint_ms", Date.now());
    await this.command({ type: "sandbox_checkpoint", reason: "turn_end" });
  }

  // --- ports ----------------------------------------------------------------------------------------

  async exposePort(port: number, share: boolean, hostHeader: "localhost" | "preserve" = "localhost"): Promise<{ url: string; share_url?: string }> {
    const info = this.info_();
    await this.command({ type: "port_expose", port, host_header: { mode: hostHeader } });
    const url = this.portUrl("preview", info.sandbox, port);
    this.update((i) => {
      i.ports = [...i.ports.filter((p) => p.port !== port), { port, url }];
    });
    this.report("port_exposed", `port ${port} exposed at ${url}`, { port, url });
    let shareUrl: string | undefined;
    if (share) {
      // Signed and expiring, for one {sandbox, port}. Minted only: no Worker route serves it yet.
      const query = await signShare(this.env.HOST_TOKEN_SECRET, info.sandbox, port, Date.now() + 24 * 3_600_000);
      shareUrl = `${this.portUrl("share", info.sandbox, port)}/?${query}`;
    }
    return shareUrl ? { url, share_url: shareUrl } : { url };
  }

  async unexposePort(port: number): Promise<void> {
    await this.command({ type: "port_unexpose", port });
    this.update((i) => {
      i.ports = i.ports.filter((p) => p.port !== port);
    });
    this.report("port_unexposed", `port ${port} no longer exposed`, { port });
  }
}
