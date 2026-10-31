// SandboxDO: authority for one sandbox (docs/control-plane/durable-objects/sandbox/). Epoch and lease
// grants, commit compare-and-set over the generation chain, layered egress policy with expiring grants,
// attached agents and the idle refcount, exposed ports.
//
// Concurrency: the input gate opens across awaits on other Durable Objects, so state is never saved
// from a copy loaded before an await. Mutations go through `update()`, which loads, applies and
// saves synchronously.
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import { num, type Env } from "../env";
import { ChannelOutbox, OUTBOX_DEADLINE } from "../lib/outbox";
import { Deadlines } from "../lib/reliable";
import { splitDomain } from "../lib/cloudflare";
import { asNestError, b64url, NestError, newId } from "../lib/util";
import { storedEnum } from "../lib/stored";
import type { CommandBody, CommitOutcome, CommitRequestEvent, HostEvent } from "../protocol/control";
import { BINDING_LIFETIME_MS, type GuestInfo, type HandsTarget } from "../protocol/gateway";
import {
  type AllowRule, type EgressLimits, type EgressPolicy, type ErrorBody, ErrorCodes, type GenerationRecord,
  type InjectionBinding, type Resources, SandboxState,
} from "../protocol/model";

export const DEFAULT_IMAGE = "nest-base:latest";
export const DEFAULT_RESOURCES: Resources = { vcpus: 2, memory_mib: 4096, disk_gib: 32 };
export const DEFAULT_LIMITS: EgressLimits = { max_connections: 256, bandwidth_mbps: 200, max_inspected_body_bytes: 512 * 1024 * 1024 };
/** Base layer (docs/sandbox/networking/egress/policy/). */
export const BASE_ALLOW = [
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io",
  "github.com", "*.githubusercontent.com", "deb.debian.org",
];

export interface WorkstreamPolicyLayer {
  allow: { host: string; ports?: number[] }[];
  passthrough: string[];
  inject: InjectionBinding[];
  tcp: { host: string; port: number }[];
}

const EMPTY_LAYER: WorkstreamPolicyLayer = { allow: [], passthrough: [], inject: [], tcp: [] };

export interface SandboxInfo {
  sandbox: string;
  workstream: string;
  cell: string;
  image: string;
  resources: Resources;
  epoch: number;
  host: string | null;
  state: SandboxState;
  head: string | null;
  policy_version: number;
  attached: string[];
  working: string[];
  ports: { port: number; url: string }[];
  /** Epoch currently being placed (FleetDO.place in flight), and since when. */
  placing: number | null;
  placing_ms: number | null;
  /**
   * The last `HISTORY_MAX` epochs and the host that held each, read from the `epochs` table (which
   * keeps every one: salvage commits are checked against it); also saved in the blob for one release.
   */
  history: { epoch: number; host: string }[];
  /** Host whose lease was lost, while the sandbox waits for a new placement. */
  lost_from: string | null;
  /** `sandbox_create` re-issues after retryable failures at the current epoch. */
  create_attempts: number;
  /** The guest's version and capabilities, from the host's last `running` report (null until then). */
  guest: GuestInfo | null;
  /** Each attached agent's slot cwd (null: the default), re-sent to every new placement. */
  attach_cwd: Record<string, string | null>;
  /** Agents whose `agent_attach` at the current placement has no `ok` yet: no binding for them. */
  attach_pending: string[];
  /** The `agent_attach` command in flight per agent; a result for any other command is stale. */
  attach_inflight: Record<string, string>;
  /** Failed attempts at the current placement, per agent (drives the retry backoff). */
  attach_attempts: Record<string, number>;
}

export interface CreateSandbox {
  sandbox: string;
  workstream: string;
  cell: string;
  image?: string;
  resources?: Resources;
  workstreamPolicy?: WorkstreamPolicyLayer;
}

const ACTIVE_STATES: SandboxState[] = ["creating", "restoring", "running", "suspending", "suspended"];
/** Destroyed and archived are final: no transition leaves them. */
const gone = (s: SandboxState) => s === "destroyed" || s === "archived";
/** A `placing` marker this old belongs to a placement that never finished: reconciled against FleetDO's lease. */
const PLACING_STALE_MS = 60_000;
const PLACE_RETRY_MS = 30_000;
/**
 * Idle (no agent working) this long → suspend to the object store. The design pauses at 1 min and
 * suspends after 10 min paused; pausing isn't in the host contract yet, so this is both tiers.
 */
const DEFAULT_SUSPEND_IDLE_MS = 11 * 60_000;
/** At most one turn-end commit this often (docs/sandbox/state/#writeback-cadence). */
const TURN_CHECKPOINT_MIN_MS = 10_000;
const MAX_CREATE_ATTEMPTS = 3;
/** How many epochs `info().history` shows; the `epochs` table keeps them all. */
const HISTORY_MAX = 50;
/**
 * `commits` (the idempotency record of commit requests): a rejected request's record, or one whose
 * generation is no longer in the chain, is dropped this long after it was made. A record whose
 * generation is still kept stays as long as the generation (docs/data/#retention).
 */
const COMMIT_RECORD_RETENTION_MS = 7 * 86_400_000;
/** Commit records are pruned from a deadline at most this often, never on the commit path. */
const COMMIT_PRUNE_INTERVAL_MS = 3_600_000;
/** A failed `agent_attach` is retried with this backoff (doubling), capped, for as long as the sandbox is placed. */
const ATTACH_RETRY_MS = 2_000;
const ATTACH_RETRY_MAX_MS = 30_000;
/** Previews and share links without NEST_DOMAIN (the harness, tests): never routed, only named. */
const LOCAL_DOMAIN = "nest.localhost";

/**
 * Preview and share hostnames follow the naming rule (docs/setup/#hostnames): a first-level label of
 * the zone whose suffix is its kind. The sandbox id loses its `sbx_` prefix (no `_` in a hostname).
 */
export function previewHostname(domain: string, port: number, sandbox: string): string {
  const { label, zone } = splitDomain(domain);
  return `${port}-${sandbox.replace(/^sbx_/, "")}-preview-${label}.${zone}`;
}
/** A share link's hostname, `<token>-share-<label>.<zone>`: the token names one `{sandbox, port}`. */
export function shareHostname(domain: string, port: number, sandbox: string): string {
  const { label, zone } = splitDomain(domain);
  return `${port}-${sandbox.replace(/^sbx_/, "")}-share-${label}.${zone}`;
}

type CommandOutcome = Extract<HostEvent, { type: "command_result" }>["outcome"];

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
    this.sql.exec("CREATE TABLE IF NOT EXISTS commits (request TEXT PRIMARY KEY, outcome TEXT NOT NULL)");
    // When the request was answered (null only until the start below stamps it), and
    // the generation it committed (null: rejected), so retention needs no JSON scan.
    const commitCols = this.sql.exec<{ name: string }>("PRAGMA table_info(commits)").toArray().map((c) => c.name);
    if (!commitCols.includes("created_ms")) this.sql.exec("ALTER TABLE commits ADD COLUMN created_ms INTEGER");
    if (!commitCols.includes("generation_id")) this.sql.exec("ALTER TABLE commits ADD COLUMN generation_id TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS commits_generation ON commits (generation_id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS commits_rejected ON commits (created_ms) WHERE generation_id IS NULL");
    // On every start: a record written by a release without these columns (before them, or during a
    // rollback to one) gets its generation from its outcome, and counts its age from now, so a
    // committed record is never mistaken for a rejected one and nothing is pruned at once.
    this.sql.exec("UPDATE commits SET generation_id = json_extract(outcome, '$.generation.id'), created_ms = ? WHERE generation_id IS NULL AND created_ms IS NULL",
      Date.now());
    // Every epoch and the host that held it: salvage from any older epoch is authorized against it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS epochs (epoch INTEGER PRIMARY KEY, host TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, host TEXT NOT NULL, ports TEXT NOT NULL,
      expires_ms INTEGER NOT NULL)`);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
    this.outbox = new ChannelOutbox(this.sql, this.deadlines, env, (p) => ctx.waitUntil(p), () => this.info_().sandbox);
    // The blob's capped `history` is merged in on every start: it holds what a release before the
    // table (or a rollback to one) recorded. The table never loses an epoch it already has.
    for (const h of this.get<{ history?: { epoch: number; host: string }[] }>("info")?.history ?? []) {
      this.sql.exec("INSERT OR IGNORE INTO epochs (epoch, host) VALUES (?, ?)", h.epoch, h.host);
    }
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
    const defaults = {
      placing: null, placing_ms: null, history: [], lost_from: null, create_attempts: 0, guest: null, attach_cwd: {},
      attach_pending: [], attach_inflight: {}, attach_attempts: {},
    };
    const info = { ...defaults, ...s } as SandboxInfo;
    info.state = storedEnum(SandboxState, info.state, "info.state");
    // Derived on every read: rows written before the naming rule hold other hostnames.
    info.ports = info.ports.map((p) => ({ port: p.port, url: this.previewUrl(info.sandbox, p.port) }));
    info.history = this.recentEpochs();
    return info;
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

  private previewUrl(sandbox: string, port: number): string {
    return `https://${previewHostname(this.env.NEST_DOMAIN ?? LOCAL_DOMAIN, port, sandbox)}`;
  }

  /**
   * Load, mutate and save synchronously (never across an await). The saved `history` is the
   * table's last `HISTORY_MAX` epochs, re-read after `fn`: written for one release, so the release
   * before the table (after a rollback) still authorizes salvage from recent epochs.
   */
  private update(fn: (info: SandboxInfo) => void): SandboxInfo {
    const info = this.info_();
    fn(info);
    info.history = this.recentEpochs();
    this.put("info", info);
    return info;
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
      placing: null,
      placing_ms: null,
      history: [],
      lost_from: null,
      create_attempts: 0,
      guest: null,
      attach_cwd: {},
      attach_pending: [],
      attach_inflight: {},
      attach_attempts: {},
    };
    this.put("info", info);
    this.put("ws_layer", req.workstreamPolicy ?? EMPTY_LAYER);
    await this.placeCurrentEpoch();
    return this.info_();
  }

  async info(): Promise<SandboxInfo> {
    return this.info_();
  }

  /**
   * A placement that never finished (this object was reset mid-call, or FleetDO's answer was lost)
   * leaves `placing` set. Once stale, FleetDO's lease decides: a live lease at that epoch is adopted
   * with the state (and guest) its holder last reported; no such lease clears the marker. Before
   * then the `place` deadline is (re)armed for when it goes stale.
   */
  private async reconcilePlacing(): Promise<void> {
    const info = this.info_();
    if (info.placing === null) return;
    const staleAt = (info.placing_ms ?? 0) + PLACING_STALE_MS;
    if (Date.now() < staleAt) {
      await this.deadlines.set("place", staleAt, true);
      return;
    }
    const epoch = info.placing;
    const lease = await this.fleet(info.cell).leaseOf(info.sandbox);
    let adopted: string | null = null;
    const after = this.update((i) => {
      if (i.placing !== epoch) return;
      i.placing = null;
      i.placing_ms = null;
      if (gone(i.state)) return;
      if (lease && lease.epoch === epoch && !lease.expired) {
        i.host = lease.host;
        i.state = lease.state ?? (i.head ? "restoring" : "creating");
        i.guest = lease.guest;
        i.lost_from = null;
        this.recordEpoch(epoch, lease.host);
        adopted = lease.host;
      }
    });
    if (gone(after.state)) {
      // Destroyed while FleetDO answered: a live lease at this epoch was never this object's to adopt.
      if (lease && lease.epoch === epoch) await this.discardPlacement(after, lease.host, epoch);
      return;
    }
    if (adopted) {
      console.warn(`sandbox ${info.sandbox}: adopted the lease on ${adopted} (epoch ${epoch}) from an unfinished placement`);
      await this.pushSecrets();
      await this.issueAttachesOrRetry();
      await this.notifyAgentsMoved(adopted);
      await this.armIdle();
    } else {
      console.warn(`sandbox ${info.sandbox}: cleared an unfinished placement at epoch ${epoch} (no lease)`);
    }
  }

  /**
   * Place an unplaced sandbox on a host under a new epoch. Refuses a sandbox that is placed, being
   * placed, or gone: one lease, one host, ever.
   */
  async placeCurrentEpoch(excludeHost?: string): Promise<string | null> {
    await this.reconcilePlacing();
    const before = this.info_();
    if (before.state === "destroyed" || before.state === "archived") {
      throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${before.state}`, 409);
    }
    if (before.host) throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is already placed on ${before.host} (epoch ${before.epoch})`, 409);
    if (before.placing !== null) throw new NestError(ErrorCodes.FORBIDDEN, "placement already in progress", 409, true);
    const epoch = before.epoch + 1;
    const now = Date.now();
    this.update((i) => {
      i.epoch = epoch;
      i.placing = epoch;
      i.placing_ms = now;
      i.create_attempts = 0;
      // A new placement is a new VM: the old guest version and slots mean nothing to it.
      i.guest = null;
      i.attach_pending = [...i.attached];
      i.attach_inflight = {};
      i.attach_attempts = {};
    });
    // If this call never finishes (a reset, a lost answer), the marker is reconciled when it goes stale.
    await this.deadlines.set("place", now + PLACING_STALE_MS, true);
    const from = before.head ? this.generation(before.head) : undefined;
    let host: string | null = null;
    let noCapacity = false;
    let failure: unknown = null;
    try {
      host = await this.fleet(before.cell).place({
        sandbox: before.sandbox,
        workstream: before.workstream,
        cell: before.cell,
        epoch,
        image: before.image,
        resources: before.resources,
        policy: this.effectivePolicy(),
        ...(from ? { from } : {}),
        ...(excludeHost ? { excludeHost } : {}),
      });
      noCapacity = host === null;
    } catch (e) {
      failure = e;
    }
    // FleetDO refused outright (a lease at another epoch): no lease exists under this epoch.
    const refused = failure !== null && asNestError(failure)?.code === ErrorCodes.FORBIDDEN;
    let applied = false;
    const after = this.update((i) => {
      if (i.placing !== epoch || gone(i.state)) return;
      applied = true;
      // Any other failure leaves the answer unknown (a lease may exist): the marker stays for the
      // `place` deadline to reconcile against FleetDO's lease.
      if (failure !== null && !refused) return;
      i.placing = null;
      i.placing_ms = null;
      // No host could take it, so no lease exists under this epoch: the next attempt reuses it.
      if ((noCapacity || refused) && i.epoch === epoch) i.epoch = before.epoch;
      if (host) {
        i.host = host;
        i.state = from ? "restoring" : "creating";
        i.lost_from = null;
        this.recordEpoch(epoch, host);
      }
    });
    if (!applied) {
      // Overtaken while FleetDO answered: destroyed (the lease it granted, and the VM it sent, go
      // too), or the marker went stale and was reconciled. Either way this answer is no longer the
      // placement's, so none of its follow-ups run: they would act on a newer claim's state.
      if (gone(after.state)) {
        if (host) await this.discardPlacement(after, host, epoch);
        return null;
      }
      return after.host;
    }
    if (failure !== null) {
      // A refusal is not retried on its own (the leases disagree: an operator looks); anything else is.
      if (refused) await this.deadlines.clear("place");
      throw failure;
    }
    if (host) {
      await this.deadlines.clear("place");
      await this.pushSecrets();
      await this.issueAttachesOrRetry();
      await this.notifyAgentsMoved(host);
      await this.armIdle();
    } else {
      await this.deadlines.set("place", Date.now() + PLACE_RETRY_MS, true);
    }
    return host;
  }

  /**
   * Operator retry (`POST /place`): an unplaced sandbox is placed; a failed one is fenced on its old
   * host, its lease released, and placed again under a new epoch.
   */
  async retryPlacement(): Promise<string | null> {
    const info = this.info_();
    if (info.state === "failed" && info.host) {
      const old = info.host;
      await this.fleet(info.cell).issueCommands(old, [{ type: "fence", sandboxes: [info.sandbox], reason: "create failed; re-placing" }]);
      await this.fleet(info.cell).releaseLease(info.sandbox, info.epoch);
      this.update((i) => {
        if (i.host === old && i.epoch === info.epoch) {
          i.host = null;
          i.state = "creating";
        }
      });
    }
    return this.placeCurrentEpoch();
  }

  /**
   * Host-reported transition; ignored unless it comes from the current lease holder. A `running`
   * report carries the guest's version, which `resolve` hands to clients.
   */
  async reportState(
    host: string, epoch: number, state: SandboxState, _mode: string | null, detail: string | null, guest: GuestInfo | null = null,
  ): Promise<void> {
    const info = this.get<SandboxInfo>("info");
    if (!info || epoch !== info.epoch || host !== info.host) return;
    // The host's reason, to Workers Logs only (it names host paths): the one place it was kept.
    if (state === "failed" && detail) console.warn(`sandbox ${info.sandbox}: failed on ${host}: ${detail}`);
    const becameRunning = state === "running" && info.state !== "running";
    this.update((i) => {
      i.state = state;
      if (guest && state === "running") i.guest = guest;
    });
    if (state !== info.state) this.report("state_changed", `state: ${state}`, { state, epoch, host });
    // A guest that just came up (boot, resume) takes the slots its sandbox was suspended without.
    if (becameRunning) await this.reissuePendingAttaches(true);
    await this.armIdle();
  }

  /**
   * Lazy start: what an agent (or anything else) calls when it needs the sandbox now. A sandbox
   * suspended on its host resumes there; one with no host (evicted, or never placed) is placed from
   * its head, launching a host if the cell autoscales. Returns the host, or `null` while none can
   * take it yet (the caller retries).
   */
  async wake(): Promise<{ host: string | null; state: SandboxState }> {
    let info = this.info_();
    if (info.state === "destroyed" || info.state === "archived") {
      throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${info.state}`, 409);
    }
    if (!info.host && info.placing !== null) {
      await this.reconcilePlacing();
      info = this.info_();
    }
    if (info.host) {
      if (info.state === "suspended") {
        await this.command([{ type: "sandbox_resume", sandbox: info.sandbox, epoch: info.epoch }]);
      }
      return { host: info.host, state: info.state };
    }
    if (info.placing !== null) return { host: null, state: info.state };
    const host = await this.placeCurrentEpoch();
    return { host, state: this.info_().state };
  }

  /**
   * FleetDO took this suspended sandbox off a host that is going away; its head is in the object
   * store. It stays suspended with no host until something wakes it, unless an agent is mid-turn on
   * it (a spot drain), in which case it's placed elsewhere now.
   */
  async evicted(host: string, epoch: number): Promise<void> {
    const cur = this.get<SandboxInfo>("info") ? this.info_() : undefined;
    if (!cur || cur.host !== host || cur.epoch !== epoch) return;
    const info = this.update((i) => {
      i.host = null;
      i.state = "suspended";
    });
    await this.deadlines.clear("idle");
    if (info.working.length) await this.placeCurrentEpoch(host);
    else await this.notifyAgentsMoved(null);
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

  /**
   * A command failed on the lease holder. A retryable `sandbox_create` failure (e.g. nestd restarted
   * before running it) is re-issued a few times; otherwise the sandbox is marked failed.
   */
  async commandFailed(host: string, type: string, epoch: number, error: ErrorBody): Promise<void> {
    const info = this.get<SandboxInfo>("info") ? this.info_() : undefined;
    if (!info || epoch !== info.epoch || host !== info.host || type !== "sandbox_create") return;
    if (error.retryable && info.create_attempts < MAX_CREATE_ATTEMPTS) {
      this.update((i) => {
        i.create_attempts += 1;
      });
      const from = info.head ? this.generation(info.head) : undefined;
      await this.fleet(info.cell).issueCommands(host, [{
        type: "sandbox_create", sandbox: info.sandbox, workstream: info.workstream, epoch, image: info.image,
        resources: info.resources, policy: this.effectivePolicy(), ...(from ? { from } : {}),
      }]);
      await this.pushSecrets();
      return;
    }
    this.update((i) => {
      if (i.epoch === epoch && i.host === host) i.state = "failed";
    });
    console.warn(`sandbox ${info.sandbox}: create failed: ${error.code} ${error.message}`);
  }

  /**
   * STONITH is confirmed for `host` (FleetDO already dropped the lease): grant a new lease elsewhere and
   * restore from head. Idempotent: FleetDO retries it until it succeeds.
   */
  async leaseLost(host: string, epoch: number, hostIsDead: boolean): Promise<void> {
    const cur = this.get<SandboxInfo>("info") ? this.info_() : undefined;
    // Keyed on the lease (host, epoch), never on the state a host reported (`fenced`, `failed`):
    // host evidence doesn't block the control plane's own transitions. A lease this object never
    // adopted (its placement was cut off, and the marker since cleared) counts as its own.
    if (!cur || cur.state === "destroyed" || cur.state === "archived") return;
    if (cur.epoch === epoch && (cur.host === host || (cur.host === null && cur.placing === null))) {
      this.update((i) => {
        // `working` stays: the brains run elsewhere, untouched by this host's loss, and AgentDO
        // re-sends activity only when it changes.
        i.host = null;
        i.lost_from = host;
      });
    } else if (!(cur.host === null && cur.lost_from === host)) {
      return; // already handled (re-placed, or a newer epoch exists)
    }
    // A dead host is excluded; a host that came back and fenced is healthy and may get the new lease.
    const placed = await this.placeCurrentEpoch(hostIsDead ? host : undefined);
    if (!placed) await this.notifyAgentsMoved(null);
  }

  /**
   * Tell bound agents their sandbox moved: from this object's own alarm, never inline. A placement
   * can be made on an agent's behalf (its start wakes the sandbox), and calling back into that
   * agent from inside its own call would deadlock. A brain needs nothing from it (its next hands
   * call resolves the new placement); the agent records the move, tells a working brain what was
   * lost, and wakes a stopped one with work waiting. The latest placement is what is sent.
   */
  private async notifyAgentsMoved(_host: string | null): Promise<void> {
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
    if (failed) await this.deadlines.set("notify_moved", Date.now() + ATTACH_RETRY_MS, true);
  }

  /**
   * The manifests this sandbox needs kept: every generation it records (retention isn't built, so
   * all of them). GC marks from these.
   */
  async gcRoots(): Promise<string[]> {
    if (!this.get<SandboxInfo>("info") || this.info_().state === "destroyed") return [];
    const roots = new Set<string>();
    for (const { record } of this.sql.exec<{ record: string }>("SELECT record FROM generations").toArray()) {
      const g = JSON.parse(record) as GenerationRecord;
      roots.add(g.disk_manifest);
      if (g.mem_manifest) roots.add(g.mem_manifest);
    }
    return [...roots];
  }

  async destroy(): Promise<void> {
    const info = this.info_();
    if (info.host) await this.command([{ type: "sandbox_destroy", sandbox: info.sandbox, epoch: info.epoch }]);
    await this.fleet(info.cell).releaseLease(info.sandbox);
    this.update((i) => {
      i.state = "destroyed";
      i.host = null;
      // A placement still in flight finds no marker, so it adopts nothing (it discards what it got).
      i.placing = null;
      i.placing_ms = null;
    });
    this.report("destroyed", "destroyed", { epoch: info.epoch }, `${info.sandbox}/destroyed`);
    await this.deadlines.clear("grants");
    await this.deadlines.clear("place");
    // Its generations stop being GC roots.
    await this.fleet(info.cell).sandboxDestroyed(info.sandbox);
  }

  /** A lease granted to a destroyed sandbox: released, and the VM FleetDO sent with it destroyed. */
  private async discardPlacement(info: SandboxInfo, host: string, epoch: number): Promise<void> {
    await this.fleet(info.cell).releaseLease(info.sandbox, epoch);
    await this.fleet(info.cell).issueCommands(host, [{ type: "sandbox_destroy", sandbox: info.sandbox, epoch }]);
  }

  private async command(bodies: CommandBody[]): Promise<void> {
    const info = this.info_();
    if (!info.host) throw new NestError(ErrorCodes.NOT_BOUND, "sandbox is not placed on a host", 409, true);
    await this.fleet(info.cell).issueCommands(info.host, bodies);
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

  async generations(): Promise<{ record: GenerationRecord; orphaned: boolean }[]> {
    return this.sql
      .exec<{ record: string; orphaned: number }>("SELECT record, orphaned FROM generations ORDER BY created_ms, id")
      .toArray()
      .map((r) => ({ record: JSON.parse(r.record) as GenerationRecord, orphaned: r.orphaned === 1 }));
  }

  /**
   * Compare-and-set the head. Idempotent per `request`. A `salvage` commit from a stale epoch becomes an
   * orphaned sibling generation (head unchanged) and raises `orphaned_work`, but only from the host
   * that held that epoch.
   */
  async commit(host: string, ev: CommitRequestEvent): Promise<CommitOutcome> {
    const stored = this.sql.exec<{ outcome: string }>("SELECT outcome FROM commits WHERE request = ?", ev.request).toArray()[0];
    if (stored) return JSON.parse(stored.outcome) as CommitOutcome;
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
    const rejected = (reason: string): CommitOutcome => ({ status: "rejected", reason, ...(info.head ? { head: info.head } : {}) });

    let outcome: CommitOutcome;
    let orphan: GenerationRecord | null = null;
    if ((ev.kind === "checkpoint") !== (ev.mem_manifest !== undefined)) {
      // `kind` must agree with the memory manifest: the chain is immutable, and a checkpoint
      // without one would restore without memory.
      outcome = rejected(ErrorCodes.INVALID_MESSAGE);
    } else if (ev.reason === "salvage" && ev.epoch < info.epoch) {
      if (this.epochHost(ev.epoch) !== host) {
        outcome = rejected(ErrorCodes.STALE_EPOCH);
      } else {
        orphan = record();
        this.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, 1, ?)",
          orphan.id, JSON.stringify(orphan), orphan.created_ms);
        outcome = { status: "orphaned", generation: orphan };
      }
    } else if (ev.epoch !== info.epoch || host !== info.host) {
      outcome = rejected(ErrorCodes.STALE_EPOCH);
    } else if ((ev.parent ?? null) !== info.head) {
      outcome = rejected(ErrorCodes.PARENT_MISMATCH);
    } else {
      const generation = record();
      this.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, 0, ?)",
        generation.id, JSON.stringify(generation), generation.created_ms);
      this.update((i) => {
        i.head = generation.id;
      });
      outcome = { status: "committed", generation };
    }
    this.sql.exec("INSERT INTO commits (request, outcome, created_ms, generation_id) VALUES (?, ?, ?, ?)",
      ev.request, JSON.stringify(outcome), Date.now(), outcome.status === "rejected" ? null : outcome.generation.id);
    await this.deadlines.set("commit_prune", Date.now() + COMMIT_PRUNE_INTERVAL_MS, true);
    if (orphan) {
      await this.env.WORKSTREAM.get(this.env.WORKSTREAM.idFromName(info.workstream)).ingest({
        workstream: info.workstream,
        ts_ms: Date.now(),
        sandbox: info.sandbox,
        epoch: info.epoch,
        type: "orphaned_work",
        generation: orphan.id,
        stale_epoch: ev.epoch,
      });
    }
    return outcome;
  }

  /**
   * Retention of the idempotency records (docs/data/#retention): a record past
   * `COMMIT_RECORD_RETENTION_MS` goes unless its generation is still in the chain. nestd asks again
   * with an unanswered request's id before its next commit, which may be days later: a committed
   * request finds its record while the generation is kept, and any other meets the compare-and-set
   * again, against the current epoch and head, as a new request would.
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

  /** Effective policy merged from the base, workstream and sandbox (temporary grant) layers. */
  private effectivePolicy(now = Date.now()): EgressPolicy {
    const info = this.info_();
    const ws = this.get<WorkstreamPolicyLayer>("ws_layer") ?? EMPTY_LAYER;
    const allow: AllowRule[] = [
      ...BASE_ALLOW.map((host) => ({ host, ports: [80, 443], layer: "base" as const })),
      ...ws.allow.map((a) => ({ host: a.host, ports: a.ports ?? [80, 443], layer: "workstream" as const })),
      ...this.sql
        .exec<{ host: string; ports: string; expires_ms: number }>("SELECT host, ports, expires_ms FROM grants WHERE expires_ms > ? ORDER BY expires_ms", now)
        .toArray()
        .map((g) => ({ host: g.host, ports: JSON.parse(g.ports) as number[], layer: "sandbox" as const, expires_ms: g.expires_ms })),
    ];
    return {
      version: info.policy_version,
      allow,
      passthrough: ws.passthrough,
      inject: ws.inject,
      tcp: ws.tcp,
      limits: DEFAULT_LIMITS,
    };
  }

  async policy(): Promise<EgressPolicy> {
    return this.effectivePolicy();
  }

  async workstreamPolicy(): Promise<WorkstreamPolicyLayer> {
    return this.get<WorkstreamPolicyLayer>("ws_layer") ?? EMPTY_LAYER;
  }

  async setWorkstreamPolicy(layer: WorkstreamPolicyLayer): Promise<EgressPolicy> {
    this.info_();
    this.put("ws_layer", layer);
    return this.policyChanged(true);
  }

  /** Temporary sandbox-layer grant (e.g. approved through `ask`). Expires on its own. */
  async grant(host: string, ttlMs: number, ports: number[] = [80, 443]): Promise<EgressPolicy> {
    this.info_(); // an unknown sandbox gets no row and no alarm
    const expires = Date.now() + ttlMs;
    this.sql.exec("INSERT INTO grants (id, host, ports, expires_ms) VALUES (?, ?, ?, ?)", newId("grt_"), host, JSON.stringify(ports), expires);
    await this.deadlines.set("grants", expires, true);
    return this.policyChanged(false);
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
        const info = this.info_();
        // A suspended sandbox with nobody working stays unplaced until something wakes it. Any other
        // live one is placed again, whatever its last report (`fenced`, `failed`) said.
        const wanted = info.state !== "suspended" || info.working.length > 0;
        if (info.host === null && info.placing === null && !gone(info.state) && wanted) await this.placeCurrentEpoch();
      } else if (key === "turn_checkpoint") {
        await this.turnEndCheckpoint();
      } else if (key === "idle") {
        const info = this.info_();
        if (info.host && info.state === "running" && info.working.length === 0) {
          await this.command([{ type: "sandbox_suspend", sandbox: info.sandbox, epoch: info.epoch, mode: "disk_only" }]);
        }
      } else if (key === "attach_retry") {
        await this.reissuePendingAttaches(false);
      } else if (key === "commit_prune") {
        await this.pruneCommitRecords();
      } else if (key === "notify_moved") {
        await this.sendMoveNotices();
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
      await this.command([{ type: "policy_update", sandbox: info.sandbox, epoch: info.epoch, policy }]);
      if (injectionChanged) await this.pushSecrets();
    }
    return policy;
  }

  /**
   * Deliver injection secrets for the policy's bindings (proxy memory only). They travel as BrokerDO
   * references; FleetDO resolves them when it sends, so no copy is stored outside BrokerDO.
   */
  private async pushSecrets(): Promise<void> {
    const info = this.info_();
    const ws = this.get<WorkstreamPolicyLayer>("ws_layer") ?? EMPTY_LAYER;
    if (!info.host || !ws.inject.length) return;
    const secrets = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).injectionSecretRefs(
      ws.inject.map((b) => b.name), info.workstream);
    if (secrets.length) await this.command([{ type: "secrets_update", sandbox: info.sandbox, epoch: info.epoch, secrets }]);
  }

  // --- agents, bindings and idleness (docs/control-plane/durable-objects/sandbox/#attach-and-bindings) --

  /**
   * Attach an agent's hands: the agent is recorded, and when the sandbox is placed its slot (cwd,
   * proxy port, cgroup) is configured in the guest with `agent_attach`. No binding is handed out
   * until that command's `ok`, so a first hands call never beats the slot. Idempotent.
   */
  async attach(agent: string, cwd?: string): Promise<SandboxInfo> {
    const before = this.info_();
    const wanted = cwd ?? null;
    // Already attached and confirmed with this cwd: nothing to re-send, and no pending mark to re-set.
    if (before.attached.includes(agent) && !before.attach_pending.includes(agent) && before.attach_cwd[agent] === wanted) return before;
    const info = this.update((i) => {
      if (!i.attached.includes(agent)) i.attached.push(agent);
      i.attach_cwd[agent] = wanted;
      i.attach_attempts[agent] = 0;
      if (i.host && !i.attach_pending.includes(agent)) i.attach_pending.push(agent);
    });
    if (info.host) await this.issueAttachCommands([agent]);
    return info;
  }

  /** Remove the agent's slot (killing its processes); its bindings are refused from then on. */
  async detach(agent: string): Promise<void> {
    const info = this.update((i) => {
      i.attached = i.attached.filter((a) => a !== agent);
      i.working = i.working.filter((a) => a !== agent);
      i.attach_pending = i.attach_pending.filter((a) => a !== agent);
      delete i.attach_cwd[agent];
      delete i.attach_inflight[agent];
      delete i.attach_attempts[agent];
    });
    if (info.host) {
      await this.command([{ type: "agent_detach", sandbox: info.sandbox, epoch: info.epoch, agent, kill_processes: true }]);
    }
    await this.armIdle();
  }

  private attachBody(info: SandboxInfo, agent: string): CommandBody {
    const cwd = info.attach_cwd[agent];
    return { type: "agent_attach", sandbox: info.sandbox, epoch: info.epoch, agent, ...(cwd ? { cwd } : {}) };
  }

  /** Send `agent_attach` for these agents and remember each command as the agent's one in flight. */
  private async issueAttachCommands(agents: string[]): Promise<void> {
    const info = this.info_();
    if (!info.host || !agents.length) return;
    const cmds = await this.fleet(info.cell).issueCommands(info.host, agents.map((a) => this.attachBody(info, a)));
    this.update((i) => {
      if (i.host !== info.host || i.epoch !== info.epoch) return;
      agents.forEach((a, n) => {
        if (i.attached.includes(a)) i.attach_inflight[a] = cmds[n]!;
      });
    });
  }

  /**
   * A new placement: every attached agent's slot is configured again, and pending until confirmed.
   * A failure to send is logged and retried from the alarm, so the placement's other follow-ups run.
   */
  private async issueAttachesOrRetry(): Promise<void> {
    const info = this.update((i) => {
      i.attach_pending = [...i.attached];
      i.attach_inflight = {};
      for (const a of i.attached) i.attach_attempts[a] = 0;
    });
    if (!info.host || !info.attached.length) return;
    try {
      await this.issueAttachCommands(info.attached);
    } catch (e) {
      console.error(`sandbox ${info.sandbox}: issuing agent_attach failed; retrying`, e);
      await this.deadlines.set("attach_retry", Date.now() + ATTACH_RETRY_MS, true);
    }
  }

  /** Re-send `agent_attach` for pending agents with no command in flight (after a failure, or a guest coming up). */
  private async reissuePendingAttaches(resetAttempts: boolean): Promise<void> {
    const info = this.update((i) => {
      if (resetAttempts) for (const a of i.attach_pending) i.attach_attempts[a] = 0;
    });
    if (!info.host) return;
    const due = info.attach_pending.filter((a) => !(a in info.attach_inflight));
    if (due.length) await this.issueAttachCommands(due);
  }

  /**
   * FleetDO routes each `agent_attach` result here. Only the command in flight for the agent counts:
   * `ok` confirms the slot; an error schedules a retry with a doubling backoff (2 s … 30 s) for as
   * long as the sandbox is placed, or, for a non-retryable error, waits for the next `running`.
   */
  async attachResult(host: string, epoch: number, agent: string, cmd: string, outcome: CommandOutcome): Promise<void> {
    const info = this.get<SandboxInfo>("info") ? this.info_() : undefined;
    if (!info || epoch !== info.epoch || host !== info.host || !info.attached.includes(agent)) return;
    if (info.attach_inflight[agent] !== cmd) return; // a superseded attempt's result
    if (outcome.status === "ok") {
      this.update((i) => {
        i.attach_pending = i.attach_pending.filter((a) => a !== agent);
        delete i.attach_inflight[agent];
        i.attach_attempts[agent] = 0;
      });
      return;
    }
    const attempts = (info.attach_attempts[agent] ?? 0) + 1;
    this.update((i) => {
      delete i.attach_inflight[agent];
      i.attach_attempts[agent] = attempts;
    });
    if (outcome.error.retryable) {
      const delay = Math.min(ATTACH_RETRY_MS * 2 ** (attempts - 1), ATTACH_RETRY_MAX_MS);
      await this.deadlines.set("attach_retry", Date.now() + delay, true);
      return;
    }
    // The agent stays pending (no binding the gateway would refuse); the next `running` report
    // re-issues it, and `resolve` keeps answering not-ready meanwhile.
    console.warn(`sandbox ${info.sandbox}: attaching ${agent} failed: ${outcome.error.code} ${outcome.error.message}`);
  }

  /**
   * A fresh binding and the sandbox's current gateway for an attached agent. Not-ready (retryable)
   * while the sandbox has no host, is being placed, or the agent's slot isn't confirmed; a suspended
   * sandbox on a host is resumed first. The token is minted by BrokerDO and never stored here.
   */
  async resolve(agent: string): Promise<HandsTarget> {
    let info = this.info_();
    const notReady = (why: string) => new NestError(ErrorCodes.SANDBOX_NOT_READY, why, 503, true);
    if (!info.attached.includes(agent)) throw new NestError(ErrorCodes.NOT_BOUND, `${agent} is not attached to this sandbox`, 409);
    if (info.state === "destroyed" || info.state === "archived") throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${info.state}`, 409);
    if (info.host && info.state === "suspended") {
      await this.wake();
      info = this.info_();
    }
    if (!info.host || info.placing !== null) throw notReady("sandbox is not placed yet");
    // nestd forgets a suspended sandbox's gateway entry and re-adds it before it reports `running`,
    // so a target minted during a resume would only ever be refused as `moved`.
    if (info.state !== "running") throw notReady(`sandbox is ${info.state}`);
    if (info.attach_pending.includes(agent)) throw notReady(`${agent}'s slot is not configured yet`);
    const gateway = await this.fleet(info.cell).hostGatewayUrl(info.host);
    // The host may advertise one on its next hello (a restart, an upgrade): not an error, not yet.
    if (!gateway) throw notReady(`host ${info.host} advertises no gateway yet`);
    // Its cloudflared has no ready connection yet (the host just started, or the tunnel is
    // reconnecting): a target now would only fail at the edge. The runner retries.
    if (gateway.kind === "connecting") throw notReady(`host ${info.host}'s tunnel is connecting`);
    // A tunnel host serving no tunnel (an old nestd, no cloudflared) is unreachable: its hello URL is
    // its own loopback, and a runner never shares its sandbox's host.
    if (gateway.kind === "down") {
      console.error(`SandboxDO: host ${info.host} has the tunnel ${gateway.tunnel} but serves none; ${info.sandbox} is unreachable until it does`);
      throw notReady(`host ${info.host} serves no tunnel`);
    }
    // The guest's version comes from the host's report; it is never guessed.
    if (!info.guest) throw notReady("the guest has not reported its version yet");
    const url = gateway.url;
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName("broker"));
    const binding = await broker.signBinding(info.cell, {
      sandbox: info.sandbox, epoch: info.epoch, client: agent, scope: "hands", exp_ms: Date.now() + BINDING_LIFETIME_MS,
    });
    // Only a tunnel has the Access edge in front of it; a gateway reached directly (the harness, a
    // host's own address) would receive the service token and front nothing, so it never travels.
    // And a tunnel target without it would be refused at the edge on every call: not retryable,
    // an operator stores the token (docs/setup/).
    const edge = gateway.kind === "tunnel" ? await broker.accessServiceToken() : null;
    if (gateway.kind === "tunnel" && !edge) {
      throw new NestError(ErrorCodes.INTERNAL, "access:gateway is not stored; a tunnel target cannot be used without it", 500, false);
    }
    // Across the awaits the sandbox may have moved, or the agent been detached: never hand out a
    // token the gateway would refuse, or one for an agent that is no longer attached.
    const fresh = this.info_();
    if (!fresh.attached.includes(agent)) throw new NestError(ErrorCodes.NOT_BOUND, `${agent} was detached while resolving`, 409);
    if (fresh.epoch !== info.epoch || fresh.host !== info.host || fresh.attach_pending.includes(agent)) {
      throw notReady("sandbox moved while resolving");
    }
    if (!fresh.guest) throw notReady("sandbox moved while resolving");
    // `sandbox` and `epoch`: unsigned copies of the claims, for clients of the previous release only.
    return { url, sandbox: info.sandbox, epoch: info.epoch, binding, guest: fresh.guest, ...(edge ? { edge } : {}) };
  }

  /** Agent activity feeds the idle refcount: the sandbox may suspend only when nobody is working. */
  async agentActivity(agent: string, working: boolean): Promise<{ idle: boolean }> {
    const turnEnded = !working && this.info_().working.includes(agent);
    const info = this.update((i) => {
      i.working = i.working.filter((a) => a !== agent);
      if (working && i.attached.includes(agent)) i.working.push(agent);
    });
    await this.armIdle();
    if (turnEnded) await this.turnEndCheckpoint();
    return { idle: info.working.length === 0 };
  }

  /**
   * An agent finished a turn: commit the disk (`turn_end`), the rewind point and the bound on what a
   * lost host loses. At most one per TURN_CHECKPOINT_MIN_MS; a turn ending sooner gets its commit
   * when that interval is up, so the last turn's changes are never left uncommitted.
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
    await this.command([{ type: "sandbox_checkpoint", sandbox: info.sandbox, epoch: info.epoch, reason: "turn_end" }]);
  }

  // --- ports ----------------------------------------------------------------------------------------

  async exposePort(port: number, share: boolean, hostHeader: "localhost" | "preserve" = "localhost"): Promise<{ url: string; share_url?: string }> {
    const info = this.info_();
    await this.command([{ type: "port_expose", sandbox: info.sandbox, epoch: info.epoch, port, host_header: { mode: hostHeader } }]);
    const url = this.previewUrl(info.sandbox, port);
    this.update((i) => {
      i.ports = [...i.ports.filter((p) => p.port !== port), { port, url }];
    });
    this.report("port_exposed", `port ${port} exposed at ${url}`, { port, url });
    let shareUrl: string | undefined;
    if (share) {
      // Signed, expiring share token for one {sandbox, port}; verified by the preview Worker route.
      const exp = Date.now() + 24 * 3_600_000;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.HOST_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`share\n${info.sandbox}\n${port}\n${exp}`)));
      shareUrl = `https://${shareHostname(this.env.NEST_DOMAIN ?? LOCAL_DOMAIN, port, info.sandbox)}/?exp=${exp}&sig=${b64url(sig)}`;
    }
    return shareUrl ? { url, share_url: shareUrl } : { url };
  }

  async unexposePort(port: number): Promise<void> {
    const info = this.info_();
    await this.command([{ type: "port_unexpose", sandbox: info.sandbox, epoch: info.epoch, port }]);
    this.update((i) => {
      i.ports = i.ports.filter((p) => p.port !== port);
    });
    this.report("port_unexposed", `port ${port} no longer exposed`, { port });
  }
}
