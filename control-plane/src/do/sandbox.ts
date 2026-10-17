// SandboxDO: authority for one sandbox (docs/control-plane/durable-objects/sandbox/). Epoch and lease
// grants, commit compare-and-set over the generation chain, layered egress policy with expiring grants,
// attached agents and the idle refcount, exposed ports.
//
// Concurrency: the input gate opens across awaits on other Durable Objects, so state is never saved
// from a copy loaded before an await. Mutations go through `update()`, which loads, applies and
// saves synchronously.
import { DurableObject } from "cloudflare:workers";
import { num, type Env } from "../env";
import { Deadlines } from "../lib/reliable";
import { b64url, NestError, newId } from "../lib/util";
import type { CommandBody, CommitOutcome, CommitRequestEvent } from "../protocol/control";
import {
  type AllowRule, type EgressLimits, type EgressPolicy, type ErrorBody, ErrorCodes, type GenerationRecord,
  type InjectionBinding, type Resources, type SandboxState,
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
  /** Which host held which epoch (salvage commits are checked against it). */
  history: { epoch: number; host: string }[];
  /** Host whose lease was lost, while the sandbox waits for a new placement. */
  lost_from: string | null;
  /** `sandbox_create` re-issues after retryable failures at the current epoch. */
  create_attempts: number;
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
const PLACING_STALE_MS = 60_000;
const PLACE_RETRY_MS = 30_000;
/**
 * Idle (no agent working) this long → suspend to the object store. The design pauses at 1 min and
 * suspends after 10 min paused; pausing isn't in the host contract yet, so this is both tiers.
 */
const DEFAULT_SUSPEND_IDLE_MS = 11 * 60_000;
const MAX_CREATE_ATTEMPTS = 3;
const HISTORY_MAX = 50;

export class SandboxDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly deadlines: Deadlines;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, record TEXT NOT NULL,
      orphaned INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS commits (request TEXT PRIMARY KEY, outcome TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, host TEXT NOT NULL, ports TEXT NOT NULL,
      expires_ms INTEGER NOT NULL)`);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
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
    const defaults = { placing: null, placing_ms: null, history: [], lost_from: null, create_attempts: 0 };
    return { ...defaults, ...s } as SandboxInfo;
  }

  /** Load, mutate and save synchronously (never across an await). */
  private update(fn: (info: SandboxInfo) => void): SandboxInfo {
    const info = this.info_();
    fn(info);
    this.put("info", info);
    return info;
  }

  private fleet(cell: string) {
    return this.env.FLEET.get(this.env.FLEET.idFromName(cell));
  }

  // --- lifecycle ----------------------------------------------------------------------------------

  /** Create (idempotent) and place the sandbox; the first placement grants epoch 1. */
  async create(req: CreateSandbox): Promise<SandboxInfo> {
    const existing = this.get<SandboxInfo>("info");
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
    };
    this.put("info", info);
    this.put("ws_layer", req.workstreamPolicy ?? EMPTY_LAYER);
    await this.placeCurrentEpoch();
    return this.info_();
  }

  async info(): Promise<SandboxInfo> {
    return this.info_();
  }

  /** An evicted placement leaves `placing` set: adopt the lease FleetDO granted, or clear it. */
  private async reconcilePlacing(): Promise<void> {
    const info = this.info_();
    if (info.placing === null || Date.now() - (info.placing_ms ?? 0) < PLACING_STALE_MS) return;
    const epoch = info.placing;
    const lease = await this.fleet(info.cell).leaseOf(info.sandbox);
    this.update((i) => {
      if (i.placing !== epoch) return;
      i.placing = null;
      i.placing_ms = null;
      if (lease && lease.epoch === epoch && !lease.expired) {
        i.host = lease.host;
        i.history = [...i.history, { epoch, host: lease.host }].slice(-HISTORY_MAX);
      }
    });
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
    });
    const from = before.head ? this.generation(before.head) : undefined;
    let host: string | null = null;
    let noCapacity = false;
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
    } finally {
      this.update((i) => {
        if (i.placing !== epoch) return;
        i.placing = null;
        i.placing_ms = null;
        // FleetDO answered that no host could take it, so no lease exists under this epoch: the
        // next attempt reuses it. (After an exception a lease may exist; the epoch stays spent.)
        if (noCapacity && i.epoch === epoch) i.epoch = before.epoch;
        if (host) {
          i.host = host;
          i.state = from ? "restoring" : "creating";
          i.lost_from = null;
          i.history = [...i.history, { epoch, host }].slice(-HISTORY_MAX);
        }
      });
    }
    if (host) {
      await this.deadlines.clear("place");
      await this.pushSecrets();
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

  /** Host-reported transition; ignored unless it comes from the current lease holder. */
  async reportState(host: string, epoch: number, state: SandboxState, _mode: string | null, _detail: string | null): Promise<void> {
    const info = this.get<SandboxInfo>("info");
    if (!info || epoch !== info.epoch || host !== info.host) return;
    this.update((i) => {
      i.state = state;
    });
    await this.armIdle();
  }

  /**
   * Lazy start: what an agent (or anything else) calls when it needs the sandbox now. A sandbox
   * suspended on its host resumes there; one with no host (evicted, or never placed) is placed from
   * its head, launching a host if the cell autoscales. Returns the host, or `null` while none can
   * take it yet (the caller retries).
   */
  async wake(): Promise<{ host: string | null; state: SandboxState }> {
    const info = this.info_();
    if (info.state === "destroyed" || info.state === "archived") {
      throw new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${info.state}`, 409);
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
    if (!cur || !ACTIVE_STATES.includes(cur.state)) return;
    if (cur.epoch === epoch && cur.host === host) {
      this.update((i) => {
        i.host = null;
        i.working = [];
        i.lost_from = host;
      });
    } else if (!(cur.host === null && cur.lost_from === host)) {
      return; // already handled (re-placed, or a newer epoch exists)
    }
    // A dead host is excluded; a host that came back and fenced is healthy and may get the new lease.
    const placed = await this.placeCurrentEpoch(hostIsDead ? host : undefined);
    if (!placed) await this.notifyAgentsMoved(null);
  }

  /** Bound agents follow their hands; one agent's failure doesn't stop the others. */
  private async notifyAgentsMoved(host: string | null): Promise<void> {
    const info = this.info_();
    for (const agent of info.attached) {
      try {
        await this.env.AGENT.get(this.env.AGENT.idFromName(agent)).onSandboxMoved(info.sandbox, info.epoch, host);
      } catch (e) {
        console.error(`sandbox ${info.sandbox}: notifying ${agent} of the move failed`, e);
      }
    }
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
    });
    await this.deadlines.clear("grants");
    await this.deadlines.clear("place");
    // Its generations stop being GC roots.
    await this.fleet(info.cell).sandboxDestroyed(info.sandbox);
  }

  private async command(bodies: CommandBody[]): Promise<void> {
    const info = this.info_();
    if (!info.host) throw new NestError(ErrorCodes.NOT_BOUND, "sandbox is not placed on a host", 409, true);
    await this.fleet(info.cell).issueCommands(info.host, bodies);
  }

  // --- generations ----------------------------------------------------------------------------------

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
    if (ev.reason === "salvage" && ev.epoch < info.epoch) {
      const held = info.history.find((h) => h.epoch === ev.epoch);
      if (!held || held.host !== host) {
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
    this.sql.exec("INSERT INTO commits (request, outcome) VALUES (?, ?)", ev.request, JSON.stringify(outcome));
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
        const info = this.info_();
        // A suspended sandbox with nobody working stays unplaced until something wakes it.
        const wanted = info.state !== "suspended" || info.working.length > 0;
        if (info.host === null && info.placing === null && ACTIVE_STATES.includes(info.state) && wanted) await this.placeCurrentEpoch();
      } else if (key === "idle") {
        const info = this.info_();
        if (info.host && info.state === "running" && info.working.length === 0) {
          await this.command([{ type: "sandbox_suspend", sandbox: info.sandbox, epoch: info.epoch, mode: "disk_only" }]);
        }
      }
    });
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

  // --- agents and idleness --------------------------------------------------------------------------

  async attachAgent(agent: string): Promise<SandboxInfo> {
    return this.update((i) => {
      if (!i.attached.includes(agent)) i.attached.push(agent);
    });
  }

  async detachAgent(agent: string): Promise<void> {
    this.update((i) => {
      i.attached = i.attached.filter((a) => a !== agent);
      i.working = i.working.filter((a) => a !== agent);
    });
    await this.armIdle();
  }

  /** Agent activity feeds the idle refcount: the sandbox may suspend only when nobody is working. */
  async agentActivity(agent: string, working: boolean): Promise<{ idle: boolean }> {
    const info = this.update((i) => {
      i.working = i.working.filter((a) => a !== agent);
      if (working && i.attached.includes(agent)) i.working.push(agent);
    });
    await this.armIdle();
    return { idle: info.working.length === 0 };
  }

  // --- ports ----------------------------------------------------------------------------------------

  async exposePort(port: number, share: boolean, hostHeader: "localhost" | "preserve" = "localhost"): Promise<{ url: string; share_url?: string }> {
    const info = this.info_();
    await this.command([{ type: "port_expose", sandbox: info.sandbox, epoch: info.epoch, port, host_header: { mode: hostHeader } }]);
    const url = `https://${port}-${info.sandbox}.${this.env.PREVIEW_DOMAIN}`;
    this.update((i) => {
      i.ports = [...i.ports.filter((p) => p.port !== port), { port, url }];
    });
    let shareUrl: string | undefined;
    if (share) {
      // Signed, expiring share token for one {sandbox, port}; verified by the preview Worker route.
      const exp = Date.now() + 24 * 3_600_000;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.HOST_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`share\n${info.sandbox}\n${port}\n${exp}`)));
      const shareDomain = this.env.PREVIEW_DOMAIN.replace(/^preview\./, "share.");
      shareUrl = `https://${port}-${info.sandbox}.${shareDomain}/?exp=${exp}&sig=${b64url(sig)}`;
    }
    return shareUrl ? { url, share_url: shareUrl } : { url };
  }

  async unexposePort(port: number): Promise<void> {
    const info = this.info_();
    await this.command([{ type: "port_unexpose", sandbox: info.sandbox, epoch: info.epoch, port }]);
    this.update((i) => {
      i.ports = i.ports.filter((p) => p.port !== port);
    });
  }
}
