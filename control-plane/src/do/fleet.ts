// FleetDO: one per cell. Host enrollment, the fleet WebSocket (docs/interfaces/control-host/fleet/),
// leases and their expiry, STONITH, placement, and command delivery with exactly-one results.
import { DurableObject } from "cloudflare:workers";
import { num, type Env } from "../env";
import { isSecretRef } from "./broker";
import { createRootCertificate, generateDevRoot, kmsRoot, localRoot, signIntermediate, type RootCa } from "../lib/ca";
import { AwsKms } from "../lib/kms";
import { AwsEc2, CapacityError, isDead, type Ec2, type ImageInfo } from "../lib/ec2";
import { AwsSsm, type Ssm } from "../lib/ssm";
import {
  CloudflareError, CloudflareHttp, gatewayHostname, hostOfHostname, hostOfTunnelName, hostnameSuffix, splitDomain, tunnelConfig, tunnelName,
  tunnelPrefix, type CloudflareApi,
} from "../lib/cloudflare";
import { awsCell, DEFAULT_SANDBOX_RESERVE_MIB, type AwsCellConfig } from "../lib/cells";
import type { InstanceIdentity } from "../lib/aws-identity";
import { Deadlines, ReliableChannels, SerialQueue } from "../lib/reliable";
import { issueHostToken } from "../lib/tokens";
import { errorBody, NestError, newId, sha256, hex, asNestError } from "../lib/util";
import {
  type Capacity, type CommandBody, type CommitRequestEvent, DEFAULT_LEASE_TIMING, type EnrollRequest,
  type EnrollResponse, type FleetToHost, type HostEvent, type HostToFleet, HostToFleetFrame, parseHostEvents, type LeaseClaim, type CaCertificate, type SandboxReport,
  type TunnelState,
} from "../protocol/control";
import {
  type CliResult, ErrorCodes, type EgressPolicy, type GenerationRecord, type HostRole, PROTOCOL_VERSION, type Resources,
} from "../protocol/model";

type HostStatus = "active" | "draining" | "expired" | "stonith_pending" | "dead";

/**
 * Where a host's sandbox gateway is reached (`hostGatewayUrl`): through its tunnel (Cloudflare
 * Access in front, so targets carry the service token), not yet (the tunnel is connecting), or
 * directly at the URL its hello advertised (`tunnel` names the hostname a tunnel host is not
 * serving, for the log).
 */
export type HostGateway =
  | { kind: "tunnel"; url: string }
  | { kind: "connecting" }
  | { kind: "direct"; url: string; tunnel: string | null };

interface HostRow {
  host: string;
  cell: string;
  role: HostRole;
  instance_id: string | null;
  status: HostStatus;
  last_rx: number | null;
  token_exp: number;
  capacity: string | null;
  /** Where clients reach this host's sandbox gateway, from its hello (null: none advertised). */
  gateway_url: string | null;
  /** The host's Cloudflare Tunnel and DNS record (docs/sandbox/gateway/, Addressing); null without a zone. */
  tunnel_id: string | null;
  tunnel_hostname: string | null;
  dns_record_id: string | null;
  /** What the host last said about its tunnel (`TunnelState`); null before its first hello (= `none`). */
  tunnel_state: string | null;
  [key: string]: SqlStorageValue;
}

interface LeaseRow {
  sandbox: string;
  host: string;
  epoch: number;
  expired: number;
  /** Last state the holder reported (`suspended` leases don't keep a host busy). */
  state: string | null;
  /** What the sandbox asked for; reserved against the host's report until the host counts it. */
  vcpus: number | null;
  memory_mib: number | null;
  [key: string]: SqlStorageValue;
}

interface Attachment {
  host: string;
  helloed: boolean;
}

export interface PlaceRequest {
  sandbox: string;
  workstream: string;
  epoch: number;
  image: string;
  resources: Resources;
  policy: EgressPolicy;
  from?: GenerationRecord;
  excludeHost?: string;
  /** The cell this FleetDO serves; lets it launch a burst host when none can take the sandbox. */
  cell?: string;
}

/** An instance this control plane launched, with what it may enroll as. */
export interface LaunchedInstance {
  instance_id: string;
  role?: HostRole;
  account_id?: string;
  region?: string;
}

/** Command purposes FleetDO itself needs to react to when the result arrives. */
type Purpose = "stonith_fence" | null;

const TOKEN_ROTATE_BEFORE_MS = 10 * 60_000;
const COMMAND_RETENTION_MS = 24 * 3_600_000;
const ENROLL_TOKEN_RETENTION_MS = 7 * 86_400_000;
const ALARM_TICK = "tick";
/** The daily pass that deletes tunnels and records whose host is gone (docs/sandbox/gateway/). */
const ALARM_TUNNEL_SWEEP = "tunnel_sweep";
const TUNNEL_SWEEP_INTERVAL_MS = 24 * 3_600_000;
/** How long a tunnel this cell created may go without a hosts row (an enrollment still in flight). */
const TUNNEL_INTENT_GRACE_MS = 3_600_000;
/** GC: one run a day; a pass deletes only within 12 h of its mark; unmarked objects go after 24 h. */
const GC_INTERVAL_MS = 24 * 3_600_000;
const GC_WINDOW_MS = 12 * 3_600_000;
const GC_GRACE_MS = 24 * 3_600_000;
const GC_MAX_DELETES = 10_000;
/** Bump when the marking rules change: the next run is then a dry run again. */
const GC_MARK_VERSION = 1;

/** What a host needs to run one GC pass. */
export interface GcClaim {
  run: string;
  marked_ms: number;
  dry_run: boolean;
  /** Manifest hashes (`blake3:<hex>`) to mark from. */
  roots: string[];
  grace_ms: number;
  deadline_ms: number;
  max_deletes: number;
}

export class FleetDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rel: ReliableChannels;
  private readonly deadlines: Deadlines;
  /** Per-host serialization of inbound reliable messages (hello and event batches). */
  private readonly inbound = new Map<string, SerialQueue>();
  /** Override for tests; `undefined` derives a client from the AWS_* secrets. */
  ec2Override: Ec2 | null | undefined = undefined;
  /** Override for tests; `undefined` reads the cell's entry in `AWS_CELLS`. */
  cellConfigOverride: AwsCellConfig | null | undefined = undefined;
  /** Override for tests: SSM for the host AMI parameter; `null` = none. */
  ssmOverride: Ssm | null | undefined = undefined;
  /** Override for tests: a fake Cloudflare API and the domain; `null` = no tunnels; `undefined` reads the env. */
  cloudflareOverride: { api: CloudflareApi; domain: string } | null | undefined = undefined;
  /** A launch is in flight (RunInstances awaits); placements meanwhile don't launch another. */
  private launching = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, cell TEXT NOT NULL, role TEXT NOT NULL,
      instance_id TEXT, status TEXT NOT NULL, last_rx INTEGER, token_exp INTEGER NOT NULL, enrolled_ms INTEGER NOT NULL,
      capacity TEXT, nestd_instance TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS enroll_tokens (hash TEXT PRIMARY KEY, role TEXT NOT NULL,
      created_ms INTEGER NOT NULL, used_ms INTEGER, host TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS launched (instance_id TEXT PRIMARY KEY, launched_ms INTEGER NOT NULL,
      host TEXT, role TEXT, account_id TEXT, region TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS leases (sandbox TEXT PRIMARY KEY, host TEXT NOT NULL,
      epoch INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0)`);
    // Command bodies hold BrokerDO secret references, never secret values (resolved only when sent).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS commands (cmd TEXT PRIMARY KEY, host TEXT NOT NULL, type TEXT NOT NULL,
      sandbox TEXT, agent TEXT, epoch INTEGER, purpose TEXT, body TEXT NOT NULL, issued_ms INTEGER NOT NULL,
      result TEXT, result_ms INTEGER)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS commands_host_result ON commands (host, result)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS host_agents (agent TEXT PRIMARY KEY, host TEXT NOT NULL, cmd TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reassign_queue (sandbox TEXT PRIMARY KEY, host TEXT NOT NULL,
      epoch INTEGER NOT NULL, host_dead INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Every host this cell created a tunnel for, written before the first Cloudflare call: what the
    // sweep may delete. Rows are never removed (one per sandbox host ever enrolled).
    this.sql.exec("CREATE TABLE IF NOT EXISTS tunnels_created (host TEXT PRIMARY KEY, created_ms INTEGER NOT NULL)");
    // Autoscaling: when a launched instance stopped counting (`reason`) and when EC2 confirmed it gone.
    this.addColumn("launched", "cell", "TEXT");
    this.addColumn("launched", "reason", "TEXT");
    this.addColumn("launched", "ended_ms", "INTEGER");
    this.addColumn("hosts", "idle_since", "INTEGER");
    // The seam: where clients reach a host's sandbox gateway (docs/sandbox/gateway/).
    this.addColumn("hosts", "gateway_url", "TEXT");
    this.addColumn("hosts", "tunnel_id", "TEXT");
    this.addColumn("hosts", "tunnel_hostname", "TEXT");
    this.addColumn("hosts", "dns_record_id", "TEXT");
    this.addColumn("hosts", "tunnel_state", "TEXT");
    this.addColumn("leases", "state", "TEXT");
    // Packing: what each lease reserves until the host's capacity report counts the sandbox.
    this.addColumn("leases", "vcpus", "INTEGER");
    this.addColumn("leases", "memory_mib", "INTEGER");
    // Object-store GC: the cell's sandboxes (their generations are the roots) and the runs.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sandboxes (sandbox TEXT PRIMARY KEY, registered_ms INTEGER NOT NULL,
      destroyed_ms INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gc_runs (run TEXT PRIMARY KEY, host TEXT NOT NULL, marked_ms INTEGER NOT NULL,
      dry_run INTEGER NOT NULL, mark_version INTEGER NOT NULL, roots INTEGER NOT NULL, finished_ms INTEGER, report TEXT)`);
    // Sandboxes that held a lease before the registry existed.
    this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) SELECT sandbox, ? FROM leases", Date.now());
    // Suspended sandboxes leaving a host that is going away; SandboxDO is told, with retries.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS evictions (sandbox TEXT NOT NULL, host TEXT NOT NULL, epoch INTEGER NOT NULL,
      PRIMARY KEY (sandbox, host, epoch))`);
    this.rel = new ReliableChannels(this.sql);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
    if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private queue(host: string): SerialQueue {
    let q = this.inbound.get(host);
    if (!q) this.inbound.set(host, (q = new SerialQueue()));
    return q;
  }

  // ---------------------------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------------------------

  async mintEnrollmentToken(role: HostRole): Promise<string> {
    const token = `net_${newId("")}${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    this.sql.exec("INSERT INTO enroll_tokens (hash, role, created_ms) VALUES (?, ?, ?)", hex(await sha256(token)), role, Date.now());
    return token;
  }

  /**
   * Records an instance this control plane launched (RunInstances); only those may enroll via AWS
   * identity, as the recorded role, from the recorded account and region (when given).
   */
  async registerLaunched(l: LaunchedInstance): Promise<void> {
    this.sql.exec(
      `INSERT INTO launched (instance_id, launched_ms, role, account_id, region) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET role = excluded.role, account_id = excluded.account_id, region = excluded.region
       WHERE launched.host IS NULL`,
      l.instance_id, Date.now(), l.role ?? null, l.account_id ?? null, l.region ?? null,
    );
  }

  /**
   * `identity` is set when the Worker verified an AWS identity document; otherwise the proof must be
   * an enrollment token. The CSR is validated (signed) before the one-time proof is consumed.
   */
  async enroll(req: EnrollRequest, cell: string, identity: InstanceIdentity | null): Promise<EnrollResponse> {
    this.rememberCell(cell);
    const proxyCa = await this.signProxyCa(req.proxy_ca_csr_pem);
    const hash = req.proof.type === "enrollment_token" ? hex(await sha256(req.proof.token)) : "";
    const host = newId("hst_");
    // The proof is checked twice: once here, so an unauthenticated caller costs no Cloudflare call,
    // and once more when it is consumed atomically with the row. A failure in between fails the
    // enrollment (the host retries with the same proof) and the tunnel just created is deleted.
    this.checkProof(req, identity, hash);
    const tunnel = req.role === "burst" ? await this.createTunnel(host) : null;
    try {
      return await this.enrollRecord(req, cell, identity, hash, host, proxyCa, tunnel);
    } catch (e) {
      if (tunnel) this.ctx.waitUntil(this.deleteTunnelAssets(host, tunnel.id, tunnel.record, "enrollment refused"));
      throw e;
    }
  }

  /** Synchronous: throws unless the proof is valid and unused; `consume` marks it used by `host`. */
  private checkProof(req: EnrollRequest, identity: InstanceIdentity | null, hash: string, consume?: { host: string; now: number }): string | null {
    if (req.proof.type === "enrollment_token") {
      const row = this.sql
        .exec<{ role: string; used_ms: number | null; host: string | null }>("SELECT role, used_ms, host FROM enroll_tokens WHERE hash = ?", hash)
        .toArray()[0];
      if (!row) throw new NestError(ErrorCodes.UNAUTHORIZED, "unknown enrollment token", 401);
      if (row.used_ms !== null && !this.neverConnected(row.host)) throw new NestError(ErrorCodes.FORBIDDEN, "enrollment token already used", 409);
      if (row.role !== req.role) throw new NestError(ErrorCodes.UNAUTHORIZED, "enrollment token minted for another role", 401);
      if (consume) {
        if (row.host) this.retireNeverConnected(row.host, consume.host);
        this.sql.exec("UPDATE enroll_tokens SET used_ms = ?, host = ? WHERE hash = ?", consume.now, consume.host, hash);
      }
      return null;
    }
    if (!identity) throw new NestError(ErrorCodes.UNAUTHORIZED, "unverified identity document", 401);
    const row = this.sql
      .exec<{ host: string | null; role: string | null; account_id: string | null; region: string | null }>(
        "SELECT host, role, account_id, region FROM launched WHERE instance_id = ?", identity.instanceId)
      .toArray()[0];
    if (!row) throw new NestError(ErrorCodes.UNAUTHORIZED, "instance was not launched by this control plane (in this cell)", 401);
    if (row.host && !this.neverConnected(row.host)) throw new NestError(ErrorCodes.FORBIDDEN, "instance already enrolled", 409);
    if (row.role && row.role !== req.role) throw new NestError(ErrorCodes.UNAUTHORIZED, `instance was launched as ${row.role}`, 401);
    if (row.account_id && row.account_id !== identity.accountId) throw new NestError(ErrorCodes.UNAUTHORIZED, "instance is in another AWS account", 401);
    if (row.region && row.region !== identity.region) throw new NestError(ErrorCodes.UNAUTHORIZED, "instance is in another AWS region", 401);
    if (consume) {
      if (row.host) this.retireNeverConnected(row.host, consume.host);
      this.sql.exec("UPDATE launched SET host = ? WHERE instance_id = ?", consume.host, identity.instanceId);
    }
    return identity.instanceId;
  }

  /**
   * A proof already used by a host that never said hello may be used again: the enrollment answer
   * was lost (nestd timed out while the tunnel was being made, or was killed before it saved its
   * credentials), so nobody holds that host's token and nestd is retrying with the same proof. A
   * host that connected keeps its proof: a second enrollment from a connected instance is a replay.
   */
  private neverConnected(host: string | null): boolean {
    const h = host ? this.host(host) : undefined;
    return !!h && h.status === "active" && h.last_rx === null;
  }

  /** The prior, never-connected holder of a proof gives way to `successor`: dead, tunnel released. */
  private retireNeverConnected(host: string, successor: string): void {
    if (!this.neverConnected(host)) return;
    this.sql.exec("UPDATE hosts SET status = 'dead' WHERE host = ?", host);
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4410, "re-enrolled before connecting");
    this.releaseTunnel(host, "re-enrolled before connecting");
    const leases = this.leasesOf(host).map((l) => l.sandbox);
    if (leases.length) this.ctx.waitUntil(this.queueReassign(host, leases, true));
    console.warn(`FleetDO: ${host} never connected; its proof enrolls again as ${successor}`);
  }

  private async enrollRecord(
    req: EnrollRequest, cell: string, identity: InstanceIdentity | null, hash: string, host: string, proxyCa: EnrollResponse["proxy_ca"],
    tunnel: { id: string; token: string; hostname: string; record: string } | null,
  ): Promise<EnrollResponse> {
    // Everything up to the INSERT is synchronous: the proof is checked and consumed atomically.
    const now = Date.now();
    const instanceId = this.checkProof(req, identity, hash, { host, now });
    const tokenExp = now + num(this.env.HOST_TOKEN_TTL_MS, 3_600_000);
    this.sql.exec(
      `INSERT INTO hosts (host, cell, role, instance_id, status, last_rx, token_exp, enrolled_ms, tunnel_id, tunnel_hostname, dns_record_id)
       VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)`,
      host, cell, req.role, instanceId, tokenExp, now, tunnel?.id ?? null, tunnel?.hostname ?? null, tunnel?.record ?? null,
    );
    const hostToken = await issueHostToken(this.env.HOST_TOKEN_SECRET, { host, cell, role: req.role, exp: tokenExp });
    return {
      host,
      host_token: hostToken,
      host_token_expires_ms: tokenExp,
      fleet_ws_url: `${this.env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/fleet`,
      proxy_ca: proxyCa,
      ...(tunnel ? { tunnel_token: tunnel.token, gateway_url: `wss://${tunnel.hostname}` } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Tunnels (docs/sandbox/gateway/, Addressing): one tunnel and one proxied record per sandbox host.
  // The account is shared (other cells, other deployments, hand-made tunnels), so this cell deletes
  // only what `tunnels_created` says it made, and only once the host is dead or never enrolled.

  private cloudflare(): { api: CloudflareApi; label: string; zone: string } | null {
    if (this.cloudflareOverride === null) return null;
    if (this.cloudflareOverride) return { api: this.cloudflareOverride.api, ...splitDomain(this.cloudflareOverride.domain) };
    const cfg = tunnelConfig(this.env);
    return cfg ? { api: new CloudflareHttp(cfg), ...splitDomain(cfg.domain) } : null;
  }

  /** The zone's id, looked up once and kept in kv. */
  private async zoneId(cf: { api: CloudflareApi; zone: string }): Promise<string> {
    const key = `zone_id:${cf.zone}`;
    const cached = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value;
    if (cached) return cached;
    const id = await cf.api.zoneId(cf.zone);
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, id);
    return id;
  }

  /** Create the host's tunnel, its ingress to the gateway, and its record; undo on a later failure. */
  private async createTunnel(host: string): Promise<{ id: string; token: string; hostname: string; record: string } | null> {
    const cf = this.cloudflare();
    if (!cf) return null;
    // Before the first call: the sweep is armed and the host is on record as one this cell made a
    // tunnel for, so whatever a failure or a reset leaves behind is accounted for and swept.
    await this.deadlines.set(ALARM_TUNNEL_SWEEP, Date.now() + TUNNEL_SWEEP_INTERVAL_MS, true);
    this.sql.exec("INSERT OR REPLACE INTO tunnels_created (host, created_ms) VALUES (?, ?)", host, Date.now());
    const hostname = gatewayHostname(cf.label, cf.zone, host);
    let zone: string;
    let t: { id: string; token: string };
    try {
      zone = await this.zoneId(cf);
      t = await cf.api.createTunnel(tunnelName(cf.label, host));
    } catch (e) {
      // A revoked token (or one short of a permission) would fail every enrollment until an
      // operator acts, and a host that cannot enroll restarts nestd until the enroll timeout
      // terminates and relaunches it: an instance-burning loop. The host enrolls without a tunnel
      // instead (reachable directly, as the harness is) and the fleet view shows no hostname.
      if (e instanceof CloudflareError && e.unauthorized) {
        console.error(`FleetDO: Cloudflare refuses the tunnel API token (HTTP ${e.httpStatus}); ${host} enrolls without a tunnel: ${e.message}`);
        return null;
      }
      throw e;
    }
    try {
      await cf.api.configureIngress(t.id, hostname);
      const r = await cf.api.createRecord(zone, hostname, t.id, `nest ${host}`);
      return { id: t.id, token: t.token, hostname, record: r.id };
    } catch (e) {
      await cf.api.deleteTunnel(t.id).catch((err: unknown) => console.error(`FleetDO: tunnel ${t.id} for ${host} leaked after a failed enrollment; the sweep deletes it`, err));
      throw e;
    }
  }

  /** Delete a host's record and tunnel. Never awaited on a fence or STONITH path; failures go to the sweep. */
  private async deleteTunnelAssets(host: string, tunnelId: string | null, recordId: string | null, why: string): Promise<boolean> {
    const cf = this.cloudflare();
    if (!cf) return true;
    let ok = true;
    if (recordId) {
      try {
        await cf.api.deleteRecord(await this.zoneId(cf), recordId);
        this.sql.exec("UPDATE hosts SET dns_record_id = NULL WHERE host = ?", host);
      } catch (e) {
        ok = false;
        console.error(`FleetDO: deleting the record of ${host} (${why}) failed; the sweep retries`, e);
      }
    }
    if (tunnelId) {
      try {
        await cf.api.deleteTunnel(tunnelId);
        this.sql.exec("UPDATE hosts SET tunnel_id = NULL, tunnel_hostname = NULL WHERE host = ?", host);
      } catch (e) {
        ok = false;
        console.error(`FleetDO: deleting the tunnel of ${host} (${why}) failed; the sweep retries`, e);
      }
    }
    return ok;
  }

  /** A host is gone: release its tunnel and record without holding up the caller. */
  private releaseTunnel(host: string, why: string): void {
    const h = this.host(host);
    if (!h || (!h.tunnel_id && !h.dns_record_id)) return;
    this.ctx.waitUntil(this.deleteTunnelAssets(host, h.tunnel_id, h.dns_record_id, why));
  }

  /**
   * The daily pass. Retries the deletes a dead host's row still owes; then, among the tunnels with
   * nest's name prefix and the records with nest's hostname suffix that Cloudflare lists, deletes
   * those this cell created (`tunnels_created`) for a host that is dead, or that never got a row
   * within the grace (an enrollment that failed after the tunnel existed). A nest-shaped name this
   * cell cannot account for (another cell or deployment on the same account, a hand-made tunnel)
   * is counted and logged, never deleted. An operator runs it with `POST /v1/admin/tunnels/sweep`.
   */
  async tunnelSweep(): Promise<{ tunnels: number; records: number; retried: number; failed: number; unknown: number }> {
    const cf = this.cloudflare();
    const counts = { tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 0 };
    if (!cf) return counts;
    const now = Date.now();
    for (const h of this.sql.exec<HostRow>("SELECT * FROM hosts WHERE status = 'dead' AND (tunnel_id IS NOT NULL OR dns_record_id IS NOT NULL)").toArray()) {
      counts.retried++;
      if (!(await this.deleteTunnelAssets(h.host, h.tunnel_id, h.dns_record_id, "sweep retry"))) counts.failed++;
    }
    const unknown: string[] = [];
    const disposable = (host: string | null, name: string): boolean => {
      const created = host ? this.sql.exec<{ created_ms: number }>("SELECT created_ms FROM tunnels_created WHERE host = ?", host).toArray()[0] : undefined;
      if (!host || !created) {
        unknown.push(name);
        return false;
      }
      const h = this.host(host);
      return h ? h.status === "dead" : now - created.created_ms > TUNNEL_INTENT_GRACE_MS;
    };
    // Each pass fails on its own: a refused list call must not cost the other pass a day.
    try {
      const zone = await this.zoneId(cf);
      for (const r of await cf.api.listRecords(zone, hostnameSuffix(cf.label, cf.zone))) {
        if (!disposable(hostOfHostname(cf.label, cf.zone, r.name), r.name)) continue;
        try {
          await cf.api.deleteRecord(zone, r.id);
          counts.records++;
        } catch (e) {
          counts.failed++;
          console.error(`FleetDO: sweep could not delete record ${r.name}`, e);
        }
      }
    } catch (e) {
      counts.failed++;
      console.error("FleetDO: sweep could not list the zone's records", e);
    }
    try {
      for (const t of await cf.api.listTunnels(tunnelPrefix(cf.label))) {
        if (!disposable(hostOfTunnelName(cf.label, t.name), t.name)) continue;
        try {
          await cf.api.deleteTunnel(t.id);
          counts.tunnels++;
        } catch (e) {
          counts.failed++;
          console.error(`FleetDO: sweep could not delete tunnel ${t.name}`, e);
        }
      }
    } catch (e) {
      counts.failed++;
      console.error("FleetDO: sweep could not list the account's tunnels", e);
    }
    counts.unknown = unknown.length;
    if (unknown.length) console.warn(`FleetDO: sweep left ${unknown.length} nest-named tunnels/records this cell did not create: ${unknown.slice(0, 20).join(", ")}`);
    console.log(`FleetDO: tunnel sweep: ${counts.tunnels} tunnels, ${counts.records} records, ${counts.retried} retried, ${counts.failed} failed, ${counts.unknown} unknown`);
    return counts;
  }

  private kms(): AwsKms {
    const e = this.env;
    if (!e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY) throw new NestError(ErrorCodes.INTERNAL, "AWS credentials not configured", 500);
    return new AwsKms(e.AWS_ACCESS_KEY_ID, e.AWS_SECRET_ACCESS_KEY, e.AWS_REGION ?? "us-east-1");
  }

  /** The root CA: its key in KMS (`ROOT_CA_KMS_KEY_ID`), else a PEM key (development, and before KMS). */
  private async rootCa(): Promise<RootCa> {
    if (this.env.ROOT_CA_CERT_PEM && this.env.ROOT_CA_KMS_KEY_ID) {
      return kmsRoot(this.env.ROOT_CA_CERT_PEM, this.kms(), this.env.ROOT_CA_KMS_KEY_ID);
    }
    if (this.env.ROOT_CA_CERT_PEM && this.env.ROOT_CA_KEY_PEM) return localRoot(this.env.ROOT_CA_CERT_PEM, this.env.ROOT_CA_KEY_PEM);
    if (this.env.ALLOW_DEV_CA !== "1") {
      throw new NestError(ErrorCodes.INTERNAL, "root CA not configured (ROOT_CA_CERT_PEM / ROOT_CA_KEY_PEM)", 500);
    }
    type Dev = { certPem: string; keyPem: string };
    const stored = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'dev_root_ca'").toArray()[0];
    if (stored) {
      const d = JSON.parse(stored.value) as Dev;
      return localRoot(d.certPem, d.keyPem);
    }
    const root = await generateDevRoot();
    const raced = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'dev_root_ca'").toArray()[0];
    const d = raced ? (JSON.parse(raced.value) as Dev) : root;
    if (!raced) {
      console.warn("FleetDO: generated a development root CA (ALLOW_DEV_CA=1)");
      this.sql.exec("INSERT INTO kv (key, value) VALUES ('dev_root_ca', ?)", JSON.stringify(root));
    }
    return localRoot(d.certPem, d.keyPem);
  }

  /**
   * Operator, once per root: a self-signed root certificate for the KMS key, signed through KMS. The
   * operator stores it as `ROOT_CA_CERT_PEM` (with `ROOT_CA_KMS_KEY_ID`) and bakes it into images.
   */
  async createKmsRootCertificate(keyId: string, name: string, ttlMs: number): Promise<string> {
    const kms = this.kms();
    return createRootCertificate(await kms.publicKey(keyId), kmsRoot("", kms, keyId).sign, name, ttlMs);
  }

  /** Root certificate to bake into sandbox images. */
  async rootCertificatePem(): Promise<string> {
    return (await this.rootCa()).certPem;
  }

  private async signProxyCa(csrPem: string): Promise<CaCertificate> {
    return signIntermediate(await this.rootCa(), csrPem, num(this.env.PROXY_CA_TTL_MS, 7 * 86_400_000));
  }

  // ---------------------------------------------------------------------------------------------
  // Fleet WebSocket
  // ---------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const host = request.headers.get("x-nest-host");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !host) {
      return new Response("expected websocket upgrade", { status: 400 });
    }
    const row = this.host(host);
    if (!row || row.status === "dead") return new Response("unknown or dead host", { status: 401 });
    // Older connections are superseded only once this one presents a valid hello.
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [host]);
    server.serializeAttachment({ host, helloed: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    let parsed: HostToFleetFrame;
    try {
      const r = HostToFleetFrame.safeParse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
      if (!r.success) throw new Error(r.error.message);
      parsed = r.data;
    } catch (e) {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, String(e instanceof Error ? e.message : e)) });
      return;
    }
    if (!att.helloed && parsed.type !== "hello") {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, "first frame must be hello") });
      ws.close(4400, "expected hello");
      return;
    }
    switch (parsed.type) {
      case "hello":
        return this.queue(att.host).run(() => this.onHello(ws, att, parsed));
      case "heartbeat":
        return this.onHeartbeat(ws, att.host, parsed.sent_ms, parsed.leases);
      case "events": {
        // One bad event is quarantined (logged, skipped, acked with its batch), never the whole
        // batch: a rejected batch is resent forever and stalls every sandbox on the host.
        const { events, quarantined } = parseHostEvents(parsed.events);
        for (const q of quarantined) {
          console.warn(`FleetDO: quarantined event ${q.index} (${q.type}) of batch ${parsed.seq} from ${att.host}: ${q.error}`);
        }
        return this.queue(att.host).run(() => this.onEvents(ws, att.host, parsed.seq, events));
      }
      case "ack":
        this.rel.ack(att.host, parsed.up_to);
        return;
      case "ca_renew": {
        try {
          this.send(ws, { type: "proxy_ca", ...(await this.signProxyCa(parsed.csr_pem)) });
        } catch (e) {
          this.send(ws, { type: "error", error: (asNestError(e) ?? new NestError(ErrorCodes.INTERNAL, "CA signing failed")).body() });
        }
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  private send(ws: WebSocket, msg: FleetToHost): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket died; reliable messages are resent after the next hello.
    }
  }

  /** Send messages after replacing BrokerDO secret references with current values. */
  private async sendResolved(ws: WebSocket, msgs: unknown[]): Promise<void> {
    const refs = new Set<string>();
    const collect = (v: unknown): void => {
      if (isSecretRef(v)) refs.add(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    msgs.forEach(collect);
    let values: Record<string, string | null> = {};
    if (refs.size) {
      try {
        values = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).resolveRefs([...refs]);
      } catch (e) {
        console.error("FleetDO: resolving secret references failed; not sending", e);
        return; // stays queued; resent after the next hello
      }
    }
    const replace = (v: unknown): unknown => {
      if (isSecretRef(v)) {
        const value = values[v];
        if (value === null || value === undefined) console.warn(`FleetDO: secret ${v.slice(v.indexOf(":") + 1)} is missing or expired`);
        return value ?? "";
      }
      if (Array.isArray(v)) return v.map(replace);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)]));
      return v;
    };
    for (const m of msgs) this.send(ws, replace(m) as FleetToHost);
  }

  private socketFor(host: string): WebSocket | undefined {
    return this.ctx.getWebSockets(host).find((ws) => (ws.deserializeAttachment() as Attachment).helloed);
  }

  private async onHello(ws: WebSocket, att: Attachment, hello: Extract<HostToFleet, { type: "hello" }>): Promise<void> {
    if (hello.protocol_version !== PROTOCOL_VERSION) {
      this.send(ws, {
        type: "error",
        error: errorBody(ErrorCodes.UNSUPPORTED_VERSION, `server speaks ${PROTOCOL_VERSION}`),
      });
      ws.close(4426, "unsupported protocol version");
      return;
    }
    const prior = this.host(att.host);
    if (hello.host !== att.host || !prior || prior.status === "dead") {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.UNAUTHORIZED, "hello.host does not match token, or host is dead") });
      ws.close(4401, "unauthorized");
      return;
    }
    for (const old of this.ctx.getWebSockets(att.host)) {
      if (old === ws) continue;
      // Never pick a superseded socket for sending, even while its close is in flight.
      old.serializeAttachment({ host: att.host, helloed: false } satisfies Attachment);
      old.close(4000, "superseded by a new connection");
    }
    const now = Date.now();
    // A new nestd process (new instance_id): both seq lineages restart. Its unacked commands fail
    // (retryably) or are reconciled from the report below.
    const lastInstance = prior.nestd_instance as string | null;
    const newProcess = lastInstance !== null && lastInstance !== hello.instance_id;
    if (newProcess) this.rel.reset(att.host);
    this.sql.exec("UPDATE hosts SET last_rx = ?, capacity = ?, nestd_instance = ?, gateway_url = ? WHERE host = ?",
      now, JSON.stringify(hello.capacity), hello.instance_id, hello.gateway_url ?? null, att.host);
    this.setTunnelState(att.host, hello.tunnel ?? "none", prior as HostRow);
    ws.serializeAttachment({ host: att.host, helloed: true } satisfies Attachment);

    this.send(ws, {
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      server_ms: now,
      ...(this.rel.lastIn(att.host) !== undefined ? { last_event_seq: this.rel.lastIn(att.host) } : {}),
      lease: DEFAULT_LEASE_TIMING,
      host_token_expires_ms: prior.token_exp,
    });
    if (prior.token_exp - now < TOKEN_ROTATE_BEFORE_MS) await this.rotateToken(ws, att.host);
    this.keysSent.delete(att.host);
    await this.sendBindingKeys(ws, prior.cell, att.host);

    // Resend unacked commands the host hasn't processed.
    if (hello.last_command_seq !== undefined) this.rel.ack(att.host, hello.last_command_seq);
    await this.sendResolved(ws, this.rel.pendingAfter(att.host, hello.last_command_seq));

    if (prior.status === "expired" || prior.status === "stonith_pending") {
      this.sql.exec("UPDATE hosts SET status = 'active' WHERE host = ?", att.host);
    }
    await this.reconcileSandboxes(att.host, hello.sandboxes);
    const reported = new Map(hello.sandboxes.map((s) => [s.sandbox, s]));
    if (newProcess) {
      // What the old process never answered, captured before re-placement issues anything new.
      const pending = new Set(this.sql.exec<{ cmd: string }>("SELECT cmd FROM commands WHERE host = ? AND result IS NULL", att.host).toArray().map((r) => r.cmd));
      await this.dropUnreported(att.host, reported);
      await this.failPendingCommands(att.host, "host process restarted before running this command", reported, pending);
    }
    await this.reconcileAgents(att.host, hello.agents);
    // A host whose leases we expired came back: it must fence them before we reassign (STONITH by fence).
    await this.ensureStonithFence(att.host);
    await this.deadlines.set(ALARM_TICK, now + DEFAULT_LEASE_TIMING.heartbeat_ms, true);
  }

  /**
   * A new nestd process on this host (a restart) reported its sandboxes; one we leased to the host
   * that it doesn't report is gone with the old process, so it can't run twice. A suspended one is
   * evicted (it wakes lazily); any other is placed again from its head.
   */
  private async dropUnreported(host: string, reported: Map<string, SandboxReport>): Promise<void> {
    const gone = this.leasesOf(host).filter((l) => !l.expired && !reported.has(l.sandbox));
    if (!gone.length) return;
    // Their unanswered commands died with the old process; close them without the retries a
    // failure would trigger (the sandbox is placed again below, under a new epoch).
    const closed = JSON.stringify({ status: "error", error: errorBody(ErrorCodes.INTERNAL, "sandbox lost with the old host process", false) });
    for (const l of gone) {
      this.sql.exec("UPDATE commands SET result = ?, result_ms = ? WHERE host = ? AND sandbox = ? AND result IS NULL", closed, Date.now(), host, l.sandbox);
    }
    console.warn(`FleetDO: ${host} restarted without ${gone.map((l) => l.sandbox).join(", ")}`);
    await this.evict(host, gone.filter((l) => l.state === "suspended").map((l) => l.sandbox));
    await this.queueReassign(host, gone.filter((l) => l.state !== "suspended").map((l) => l.sandbox), false);
  }

  /** Fence what we don't honor; take the reported state of what we do (e.g. after a nestd restart). */
  private async reconcileSandboxes(host: string, sandboxes: SandboxReport[]): Promise<void> {
    const fence: string[] = [];
    for (const s of sandboxes) {
      const lease = this.lease(s.sandbox);
      const honored = lease && lease.host === host && lease.epoch === s.epoch && !lease.expired;
      if (!honored) {
        if (s.state !== "fenced" && s.state !== "destroyed") fence.push(s.sandbox);
        continue;
      }
      this.sql.exec("UPDATE leases SET state = ? WHERE sandbox = ? AND host = ? AND epoch = ?", s.state, s.sandbox, host, s.epoch);
      try {
        await this.sandbox(s.sandbox).reportState(host, s.epoch, s.state, null, "reported in hello", s.guest ?? null);
      } catch (e) {
        console.error(`FleetDO: reconciling ${s.sandbox} failed`, e);
      }
    }
    if (fence.length) await this.issueCommands(host, [{ type: "fence", sandboxes: fence, reason: "reconcile" }]);
  }

  /** Brains the host doesn't report (after its agent_start completed) are gone. */
  private async reconcileAgents(host: string, agents: Extract<HostToFleet, { type: "hello" }>["agents"]): Promise<void> {
    const reported = new Set(agents.map((a) => a.agent));
    for (const a of agents) {
      try {
        await this.agentStub(a.agent).hostReport(host, a.state);
      } catch (e) {
        console.error(`FleetDO: reconciling ${a.agent} failed`, e);
      }
    }
    const known = this.sql
      .exec<{ agent: string; c_cmd: string | null; result: string | null }>(
        `SELECT h.agent, c.cmd AS c_cmd, c.result FROM host_agents h LEFT JOIN commands c ON c.cmd = h.cmd WHERE h.host = ?`, host)
      .toArray();
    for (const k of known) {
      if (reported.has(k.agent)) continue;
      // Only once its agent_start completed (or the command aged out); a pending start isn't running yet.
      if (k.c_cmd !== null && k.result === null) continue;
      this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ?", k.agent, host);
      try {
        await this.agentStub(k.agent).onExited(host, "host_lost");
      } catch (e) {
        console.error(`FleetDO: marking ${k.agent} exited failed`, e);
      }
    }
  }

  private async onHeartbeat(ws: WebSocket, host: string, sentMs: number, claims: LeaseClaim[]): Promise<void> {
    const now = Date.now();
    this.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ? AND status IN ('active', 'draining')", now, host);
    const revoked = claims.filter((c) => {
      const lease = this.lease(c.sandbox);
      return !lease || lease.host !== host || lease.epoch !== c.epoch || lease.expired === 1;
    });
    this.send(ws, { type: "heartbeat_ack", sent_ms: sentMs, server_ms: now, revoked });
    // A host that missed its keys (BrokerDO was unavailable at hello, or this object restarted)
    // refuses every binding as unknown_key until it has them: resend on the next heartbeat.
    if (!this.keysSent.has(host)) {
      const row = this.sql.exec<{ cell: string }>("SELECT cell FROM hosts WHERE host = ?", host).toArray()[0];
      if (row) await this.sendBindingKeys(ws, row.cell, host);
    }
    if (!this.deadlines.has(ALARM_TICK)) await this.deadlines.set(ALARM_TICK, now + DEFAULT_LEASE_TIMING.heartbeat_ms);
  }

  /**
   * Strictly in order: the next batch is processed and acked; a duplicate is re-acked; a gap or a
   * failure closes the connection so the host reconnects and resends from `last_event_seq`.
   */
  private async onEvents(ws: WebSocket, host: string, seq: number, events: HostEvent[]): Promise<void> {
    const verdict = this.rel.classify(host, seq);
    if (verdict === "duplicate") {
      this.send(ws, { type: "ack", up_to: this.rel.lastIn(host)! });
      return;
    }
    if (verdict === "gap") {
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, `event batch ${seq} out of order; expected ${this.rel.lastIn(host)! + 1}`, true) });
      ws.close(4409, "out-of-order event batch; reconnect and resend");
      return;
    }
    try {
      for (const ev of events) await this.handleEvent(host, ev);
    } catch (e) {
      console.error("FleetDO: event batch failed", e);
      this.send(ws, { type: "error", error: errorBody(ErrorCodes.INTERNAL, "event processing failed; reconnect and resend", true) });
      ws.close(4500, "event processing failed; reconnect and resend");
      return;
    }
    this.rel.markProcessed(host, seq);
    this.send(ws, { type: "ack", up_to: seq });
  }

  /** True when `host` holds the live lease for `sandbox` (at `epoch`, when given). */
  private holds(host: string, sandbox: string | undefined, epoch?: number): boolean {
    if (!sandbox) return false;
    const lease = this.lease(sandbox);
    return !!lease && lease.host === host && !lease.expired && (epoch === undefined || lease.epoch === epoch);
  }

  private async handleEvent(host: string, ev: HostEvent): Promise<void> {
    switch (ev.type) {
      case "command_result":
        return this.onCommandResult(host, ev.cmd, ev.outcome);
      case "sandbox_state":
        if (this.holds(host, ev.sandbox, ev.epoch)) {
          this.sql.exec("UPDATE leases SET state = ? WHERE sandbox = ? AND host = ?", ev.state, ev.sandbox, host);
        }
        await this.sandbox(ev.sandbox).reportState(host, ev.epoch, ev.state, ev.suspend_mode ?? null, ev.detail ?? null, ev.guest ?? null);
        // A draining host's sandboxes leave as soon as they're safely suspended.
        if (ev.state === "suspended" && this.host(host)?.status === "draining") await this.evict(host, [ev.sandbox]);
        return;
      case "commit_request":
        return this.onCommitRequest(host, ev);
      case "workstream": {
        // Host-originated workstream events must be about a sandbox this host holds.
        if (!this.holds(host, ev.event.sandbox, ev.event.epoch)) {
          console.warn(`FleetDO: dropping ${ev.event.type} from ${host}: not the lease holder of ${ev.event.sandbox ?? "(no sandbox)"}`);
          return;
        }
        await this.env.WORKSTREAM.get(this.env.WORKSTREAM.idFromName(ev.event.workstream)).ingest(ev.event);
        return;
      }
      case "egress_audit": {
        const body = ev.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        await this.env.BUCKET.put(`audit/${host}/${ev.ts_ms}-${newId("")}.jsonl`, body);
        return;
      }
      case "capacity":
        this.sql.exec("UPDATE hosts SET capacity = ? WHERE host = ?", JSON.stringify(ev.capacity), host);
        return;
      case "tunnel_state":
        this.setTunnelState(host, ev.state, this.host(host));
        return;
      case "spot_notice":
        return this.drain(host, ev.deadline_ms);
      case "agent_exited":
        this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ?", ev.agent, host);
        await this.agentStub(ev.agent).onExited(host, ev.reason);
        return;
      case "guest_cli":
        if (!this.holds(host, ev.sandbox, ev.epoch)) {
          await this.issueCommands(host, [{
            type: "guest_cli_result", request: ev.request,
            result: { status: "error", error: errorBody(ErrorCodes.STALE_EPOCH, "this host does not hold the sandbox's lease") },
          }]);
          return;
        }
        // `ask` may wait up to 120 s: don't hold the event batch (and its ack) for it.
        this.ctx.waitUntil(this.relayGuestCli(host, ev));
        return;
      case "task_exited":
        if (!this.holds(host, ev.sandbox, ev.epoch)) return;
        await this.agentStub(ev.agent).onTaskExited(ev.sandbox, ev.epoch, ev.task);
        return;
    }
  }

  /** Run a guest `nest` CLI command on the attributed agent and answer with `guest_cli_result`. */
  private async relayGuestCli(host: string, ev: Extract<HostEvent, { type: "guest_cli" }>): Promise<void> {
    let result: CliResult;
    try {
      if (!ev.agent) {
        result = { status: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, "nest CLI call has no NEST_AGENT_ID") };
      } else {
        result = await this.agentStub(ev.agent).guestCli(ev.sandbox, ev.epoch, ev.command);
      }
    } catch (e) {
      const ne = asNestError(e);
      result = { status: "error", error: ne ? ne.body() : errorBody(ErrorCodes.INTERNAL, "nest CLI relay failed", true) };
    }
    await this.issueCommands(host, [{ type: "guest_cli_result", request: ev.request, result }]);
  }

  /**
   * Fail every command still awaiting a result on `host` (retryable). A `sandbox_create` the new
   * process reports running anyway is completed instead.
   */
  private async failPendingCommands(host: string, message: string, reported = new Map<string, SandboxReport>(), only?: Set<string>): Promise<void> {
    const pending = this.sql
      .exec<{ cmd: string; type: string; sandbox: string | null; epoch: number | null }>(
        "SELECT cmd, type, sandbox, epoch FROM commands WHERE host = ? AND result IS NULL ORDER BY issued_ms", host)
      .toArray()
      .filter((c) => !only || only.has(c.cmd));
    for (const c of pending) {
      const r = c.sandbox ? reported.get(c.sandbox) : undefined;
      const done = c.type === "sandbox_create" && r && r.epoch === c.epoch;
      await this.onCommandResult(host, c.cmd, done ? { status: "ok" } : { status: "error", error: errorBody(ErrorCodes.INTERNAL, message, true) });
    }
  }

  private async onCommandResult(host: string, cmd: string, outcome: Extract<HostEvent, { type: "command_result" }>["outcome"]) {
    const row = this.sql
      .exec<{ type: string; sandbox: string | null; agent: string | null; epoch: number | null; purpose: string | null; body: string; result: string | null; host: string }>(
        "SELECT type, sandbox, agent, epoch, purpose, body, result, host FROM commands WHERE cmd = ?", cmd)
      .toArray()[0];
    if (!row || row.host !== host || row.result !== null) return; // unknown, foreign, or a redelivered result
    this.sql.exec("UPDATE commands SET result = ?, result_ms = ? WHERE cmd = ?", JSON.stringify(outcome), Date.now(), cmd);

    if (row.purpose === "stonith_fence") {
      const body = JSON.parse(row.body) as Extract<CommandBody, { type: "fence" }>;
      if (outcome.status === "ok") await this.queueReassign(host, body.sandboxes, false);
      else await this.ensureStonithFence(host); // re-issue: leases stay expired until a fence succeeds
      return;
    }
    if (row.type === "agent_stop" && outcome.status === "ok" && row.agent) {
      this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ?", row.agent, host);
    }
    // The sandbox side of `attach`: SandboxDO hands out no binding for an agent until its slot exists.
    if (row.type === "agent_attach" && row.sandbox && row.epoch !== null && row.agent) {
      await this.sandbox(row.sandbox).attachResult(host, row.epoch, row.agent, cmd, outcome);
    }
    if (outcome.status === "error") {
      if (row.sandbox && row.epoch !== null) await this.sandbox(row.sandbox).commandFailed(host, row.type, row.epoch, outcome.error);
      if (row.agent && row.type === "agent_start") {
        this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND cmd = ?", row.agent, cmd);
        await this.agentStub(row.agent).startFailed(host, outcome.error);
      }
    }
  }

  private async onCommitRequest(host: string, ev: CommitRequestEvent): Promise<void> {
    const outcome = await this.sandbox(ev.sandbox).commit(host, ev);
    await this.issueCommands(host, [{ type: "commit_result", request: ev.request, sandbox: ev.sandbox, outcome }]);
  }

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  /**
   * Queue commands for a host: persisted, delivered reliably in order, each with exactly one result.
   * Secret values must arrive as BrokerDO references; they are resolved only when sent.
   */
  async issueCommands(host: string, bodies: CommandBody[], purpose: Purpose = null): Promise<string[]> {
    const now = Date.now();
    const commands = bodies.map((body) => ({ cmd: newId("cmd_"), issued_ms: now, ...body }));
    for (const c of commands) {
      const sandbox = "sandbox" in c ? c.sandbox : c.type === "sandbox_fork" ? c.child : null;
      const epoch = "epoch" in c ? c.epoch : c.type === "sandbox_fork" ? c.child_epoch : null;
      const agent = "agent" in c ? c.agent : null;
      this.sql.exec(
        `INSERT INTO commands (cmd, host, type, sandbox, agent, epoch, purpose, body, issued_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.cmd, host, c.type, sandbox, agent, epoch, purpose, JSON.stringify(c), now,
      );
      if (c.type === "agent_start") {
        this.sql.exec("INSERT INTO host_agents (agent, host, cmd) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET host = excluded.host, cmd = excluded.cmd",
          c.agent, host, c.cmd);
      }
    }
    const msg = this.rel.push(host, (seq) => ({ type: "commands" as const, seq, commands }));
    const ws = this.socketFor(host);
    if (ws) await this.sendResolved(ws, [msg]);
    return commands.map((c) => c.cmd);
  }

  /** Result of a command, once the host reported it. */
  async commandResult(cmd: string): Promise<unknown> {
    const row = this.sql.exec<{ result: string | null }>("SELECT result FROM commands WHERE cmd = ?", cmd).toArray()[0];
    return row?.result ? (JSON.parse(row.result) as unknown) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Placement and leases
  // ---------------------------------------------------------------------------------------------

  /**
   * Choose a host, record the lease and send `sandbox_create`. `null` when no capacity. Refuses a
   * sandbox that already holds a lease: a lease is only ever granted to one host at a time.
   */
  async place(req: PlaceRequest): Promise<string | null> {
    const existing = this.lease(req.sandbox);
    if (existing) {
      throw new NestError(ErrorCodes.FORBIDDEN, `sandbox ${req.sandbox} already holds a lease (epoch ${existing.epoch} on ${existing.host})`, 409);
    }
    if (req.cell) this.rememberCell(req.cell);
    this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) VALUES (?, ?)", req.sandbox, Date.now());
    // Packing (docs/compute/autoscaling/): fill hosts before opening new ones, so idle hosts empty
    // out. A host's room is its last capacity report less what leases placed since reserve (a
    // lease the host has not reported a state for). On regular pages (no hugepage pool, the
    // default) a sandbox costs what it touches: it reserves the cell's `sandbox_reserve_mib`
    // against `memory_mib_free`, its declared size being a ceiling the jailer enforces, and an
    // optional `max_sandboxes_per_host` caps the count. On a hugepage host the pool is a hard
    // reservation: the declared size counts against `hugepages_mib_free`, declared vCPUs against
    // `vcpus_free`. An empty host always takes one.
    const need = req.resources;
    const cfg = this.cellConfig();
    const reserveMib = cfg?.sandbox_reserve_mib ?? DEFAULT_SANDBOX_RESERVE_MIB;
    const maxPerHost = cfg?.max_sandboxes_per_host ?? 0;
    const room = (h: HostRow): { room: number; leases: number; fits: boolean } => {
      const leases = this.leasesOf(h.host);
      if (!h.capacity) return { room: leases.length ? 0 : Infinity, leases: leases.length, fits: leases.length === 0 };
      const cap = JSON.parse(h.capacity) as Capacity;
      const pending = leases.filter((l) => l.state === null);
      const hugepageHost = (cap.hugepages_mib_total ?? 0) > 0 || (cap.hugepages_mib_total === undefined && cap.hugepages_mib_free > 0);
      if (hugepageHost) {
        const huge = cap.hugepages_mib_free - pending.reduce((sum, l) => sum + (l.memory_mib ?? need.memory_mib), 0);
        const vcpus = cap.vcpus_free - pending.reduce((sum, l) => sum + (l.vcpus ?? need.vcpus), 0);
        return { room: huge - need.memory_mib, leases: leases.length, fits: leases.length === 0 || (huge >= need.memory_mib && vcpus >= need.vcpus) };
      }
      const mem = cap.memory_mib_free - pending.length * reserveMib;
      const underCap = maxPerHost === 0 || leases.length < maxPerHost;
      return { room: mem - reserveMib, leases: leases.length, fits: leases.length === 0 || (underCap && mem >= reserveMib) };
    };
    const candidates = this.sql
      .exec<HostRow>("SELECT * FROM hosts WHERE role = 'burst' AND status = 'active'")
      .toArray()
      .filter((h) => h.host !== req.excludeHost && this.socketFor(h.host))
      .map((h) => ({ h, r: room(h) }))
      .filter((c) => c.r.fits);
    if (!candidates.length) {
      // SandboxDO retries placement on its own alarm; by then the new host may have enrolled.
      await this.scaleUp();
      return null;
    }
    const warm = (h: HostRow) => {
      if (!req.from || !h.capacity) return false;
      return (JSON.parse(h.capacity) as Capacity).warm.includes(req.from.id);
    };
    // Warm snapshot first; then the fullest host that still fits (least room left after this
    // sandbox, then most leases).
    candidates.sort((a, b) => Number(warm(b.h)) - Number(warm(a.h)) || a.r.room - b.r.room || b.r.leases - a.r.leases);
    const host = candidates[0]!.h.host;
    this.sql.exec("INSERT INTO leases (sandbox, host, epoch, expired, vcpus, memory_mib) VALUES (?, ?, ?, 0, ?, ?)",
      req.sandbox, host, req.epoch, need.vcpus, need.memory_mib);
    await this.issueCommands(host, [{
      type: "sandbox_create",
      sandbox: req.sandbox,
      workstream: req.workstream,
      epoch: req.epoch,
      image: req.image,
      resources: req.resources,
      policy: req.policy,
      ...(req.from ? { from: req.from } : {}),
    }]);
    return host;
  }

  /** Drop a sandbox's lease (destroyed, or about to be re-placed after a failed create). */
  async releaseLease(sandbox: string, epoch?: number): Promise<void> {
    if (epoch === undefined) this.sql.exec("DELETE FROM leases WHERE sandbox = ?", sandbox);
    else this.sql.exec("DELETE FROM leases WHERE sandbox = ? AND epoch = ?", sandbox, epoch);
  }

  async leaseOf(sandbox: string): Promise<{ host: string; epoch: number; expired: boolean } | null> {
    const l = this.lease(sandbox);
    return l ? { host: l.host, epoch: l.epoch, expired: l.expired === 1 } : null;
  }

  /** A connected, active controller host for captains. */
  async controllerHost(): Promise<string | null> {
    const hosts = this.sql.exec<HostRow>("SELECT * FROM hosts WHERE role = 'controller' AND status = 'active'").toArray();
    return hosts.find((h) => this.socketFor(h.host))?.host ?? null;
  }

  async hostStatus(host: string): Promise<{ status: HostStatus; connected: boolean; last_rx: number | null } | null> {
    const h = this.host(host);
    return h ? { status: h.status, connected: !!this.socketFor(host), last_rx: h.last_rx } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Lease expiry, STONITH, token rotation
  // ---------------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === ALARM_TICK) await this.tick();
      if (key === ALARM_TUNNEL_SWEEP) {
        try {
          await this.tunnelSweep();
        } finally {
          await this.deadlines.set(ALARM_TUNNEL_SWEEP, Date.now() + TUNNEL_SWEEP_INTERVAL_MS);
        }
      }
    });
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const expiry = DEFAULT_LEASE_TIMING.cp_expiry_ms;
    for (const h of this.sql.exec<HostRow>("SELECT * FROM hosts WHERE status IN ('active', 'draining')").toArray()) {
      if (h.last_rx === null || now - h.last_rx < expiry) continue;
      if (this.leasesOf(h.host).some((l) => !l.expired)) await this.expireHost(h.host);
      else if (h.role === "controller") await this.expireController(h.host);
    }
    for (const h of this.sql.exec<HostRow>("SELECT * FROM hosts WHERE status = 'stonith_pending'").toArray()) {
      await this.pollStonith(h);
    }
    for (const h of this.sql.exec<HostRow>("SELECT * FROM hosts WHERE status IN ('active', 'draining')").toArray()) {
      const ws = this.socketFor(h.host);
      if (ws) await this.ensureStonithFence(h.host);
      if (ws && h.token_exp - now < TOKEN_ROTATE_BEFORE_MS) await this.rotateToken(ws, h.host);
    }
    await this.processReassign();
    await this.scaleDown(now);
    this.sql.exec("DELETE FROM commands WHERE result IS NOT NULL AND result_ms < ?", now - COMMAND_RETENTION_MS);
    this.sql.exec("DELETE FROM enroll_tokens WHERE used_ms IS NOT NULL AND used_ms < ?", now - ENROLL_TOKEN_RETENTION_MS);
    const busy = this.sql.exec("SELECT 1 FROM hosts WHERE status IN ('active', 'draining', 'stonith_pending')").toArray().length
      || this.sql.exec("SELECT 1 FROM reassign_queue").toArray().length
      || this.sql.exec("SELECT 1 FROM launched WHERE ended_ms IS NULL AND (host IS NULL OR reason IS NOT NULL)").toArray().length
      || this.sql.exec("SELECT 1 FROM evictions").toArray().length;
    if (busy) await this.deadlines.set(ALARM_TICK, now + DEFAULT_LEASE_TIMING.heartbeat_ms);
  }

  /**
   * The cell's binding verification keys, for the host's sandbox gateway (docs/sandbox/gateway/).
   * Sent after every hello: the gateway verifies bindings with them and holds nothing else.
   */
  /** Hosts that have the cell's binding keys since their last hello; in memory only, so a restart resends once. */
  private readonly keysSent = new Set<string>();

  private async sendBindingKeys(ws: WebSocket, cell: string, host: string): Promise<void> {
    try {
      const keys = await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).bindingPublicKeys(cell);
      this.send(ws, { type: "binding_key", keys });
      this.keysSent.add(host);
    } catch (e) {
      console.error("FleetDO: binding keys unavailable; the host's gateway refuses bindings until the next heartbeat", e);
    }
  }

  /** What the host last reported about its tunnel; `none` until it says otherwise. */
  private setTunnelState(host: string, state: TunnelState, prior: Pick<HostRow, "tunnel_state" | "tunnel_hostname"> | undefined): void {
    const was = (prior?.tunnel_state ?? "none") as TunnelState;
    this.sql.exec("UPDATE hosts SET tunnel_state = ? WHERE host = ?", state, host);
    if (was === state) return;
    if (state === "none" && prior?.tunnel_hostname) {
      console.warn(`FleetDO: ${host} has the tunnel ${prior.tunnel_hostname} but runs none (an old nestd, or no cloudflared on the host): its gateway is reached directly`);
    } else {
      console.log(`FleetDO: ${host} tunnel ${was} → ${state}`);
    }
  }

  /**
   * Where clients reach `host`'s sandbox gateway. The control plane is the authority for the name,
   * but only the host knows whether its tunnel is served: `tunnel` (Cloudflare Access in front)
   * needs the hostname FleetDO recorded at enrollment and the host's `connected`; `connecting` is
   * a tunnel host whose cloudflared has no ready connection yet (the caller waits); `direct` is the
   * URL the host's hello advertised, which is also where a tunnel host that reports `none` is
   * reached (an old nestd, or no binary), since every brain still starts on its sandbox's host.
   */
  async hostGatewayUrl(host: string): Promise<HostGateway | null> {
    const h = this.host(host);
    // A dead host serves nothing; its sandboxes are being reassigned.
    if (!h || h.status === "dead") return null;
    if (h.tunnel_hostname) {
      if (h.tunnel_state === "connected") return { kind: "tunnel", url: `wss://${h.tunnel_hostname}` };
      if (h.tunnel_state === "connecting") return { kind: "connecting" };
    }
    return h.gateway_url ? { kind: "direct", url: h.gateway_url, tunnel: h.tunnel_hostname } : null;
  }

  private async rotateToken(ws: WebSocket, host: string): Promise<void> {
    const h = this.host(host);
    if (!h) return;
    const exp = Date.now() + num(this.env.HOST_TOKEN_TTL_MS, 3_600_000);
    const token = await issueHostToken(this.env.HOST_TOKEN_SECRET, { host, cell: h.cell, role: h.role, exp });
    this.sql.exec("UPDATE hosts SET token_exp = ? WHERE host = ?", exp, host);
    this.send(ws, { type: "host_token", token, expires_ms: exp });
  }

  private ec2(): Ec2 | null {
    if (this.ec2Override !== undefined) return this.ec2Override;
    const { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret } = this.env;
    const region = this.cellConfig()?.region ?? this.env.AWS_REGION;
    return id && secret && region ? new AwsEc2(id, secret, region) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Autoscaling (docs/compute/autoscaling/): launch on demand, retire idle hosts, scale to zero
  // ---------------------------------------------------------------------------------------------

  private rememberCell(cell: string): void {
    this.sql.exec("INSERT OR IGNORE INTO kv (key, value) VALUES ('cell', ?)", cell);
  }

  private cellConfig(): AwsCellConfig | null {
    if (this.cellConfigOverride !== undefined) return this.cellConfigOverride;
    const cell = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'cell'").toArray()[0]?.value;
    return cell ? awsCell(this.env.AWS_CELLS, cell) : null;
  }

  /**
   * No connected burst host could take a sandbox: launch one, unless a launch is already on its way
   * or the cell is at its host cap. Tries each instance type on spot (rotating zones), then the first
   * type on demand. The instance may enroll only as a burst host of this cell, from this region.
   */
  private async scaleUp(): Promise<void> {
    const cfg = this.cellConfig();
    const ec2 = this.ec2();
    if (!cfg || !ec2 || this.launching) return;
    const pending = this.sql.exec("SELECT 1 FROM launched WHERE host IS NULL AND reason IS NULL").toArray().length;
    if (pending) return;
    const live = this.sql
      .exec("SELECT 1 FROM hosts WHERE role = 'burst' AND status IN ('active', 'stonith_pending')")
      .toArray().length;
    if (live >= cfg.max_hosts) return;
    const cell = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'cell'").toArray()[0]?.value ?? null;
    const now = Date.now();
    const zone = (i: number) => cfg.subnet_ids[(Math.floor(now / 1000) + i) % cfg.subnet_ids.length]!;
    const attempts = [
      ...(cfg.spot ? cfg.instance_types.map((t, i) => ({ type: t, subnet: zone(i), spot: true })) : []),
      { type: cfg.instance_types[0]!, subnet: zone(0), spot: false },
    ];
    this.launching = true;
    try {
      for (const [i, a] of attempts.entries()) {
        try {
          const id = await ec2.launch({
            launchTemplateId: cfg.launch_template_id, instanceType: a.type, subnetId: a.subnet, spot: a.spot,
            clientToken: `${cell ?? "cell"}-${now}-${i}`,
          });
          this.sql.exec(
            "INSERT INTO launched (instance_id, launched_ms, role, region, cell) VALUES (?, ?, 'burst', ?, ?)",
            id, Date.now(), cfg.region, cell,
          );
          console.log(`FleetDO: launched ${id} (${a.type}, ${a.spot ? "spot" : "on-demand"}, ${a.subnet})`);
          if (!this.deadlines.has(ALARM_TICK)) await this.deadlines.set(ALARM_TICK, Date.now() + DEFAULT_LEASE_TIMING.heartbeat_ms);
          return;
        } catch (e) {
          if (!(e instanceof CapacityError)) {
            console.error("FleetDO: launch failed", e);
            return;
          }
          console.warn(`FleetDO: no capacity for ${a.type} (${a.spot ? "spot" : "on-demand"}): ${e.message}`);
        }
      }
    } finally {
      this.launching = false;
    }
  }

  /**
   * Retire what the cell no longer needs: a launched instance that never enrolled, and a burst host
   * we launched that has held no sandbox and no agent for the idle grace. Retiring marks the host
   * dead first, so nothing is placed on it while TerminateInstances is in flight.
   */
  private async scaleDown(now: number): Promise<void> {
    const cfg = this.cellConfig();
    if (!cfg) return;
    for (const r of this.sql.exec<{ instance_id: string }>(
      "SELECT instance_id FROM launched WHERE host IS NULL AND reason IS NULL AND launched_ms < ?",
      now - cfg.enroll_timeout_ms).toArray()) {
      this.sql.exec("UPDATE launched SET reason = 'enroll_timeout' WHERE instance_id = ?", r.instance_id);
      console.warn(`FleetDO: ${r.instance_id} never enrolled; terminating`);
    }
    for (const h of this.sql.exec<HostRow & { idle_since: number | null }>(
      "SELECT * FROM hosts WHERE role = 'burst' AND status = 'active' AND instance_id IS NOT NULL").toArray()) {
      // Suspended sandboxes are safe in the object store: they don't keep a host up.
      const busy = this.leasesOf(h.host).some((l) => l.state !== "suspended")
        || this.sql.exec("SELECT 1 FROM host_agents WHERE host = ?", h.host).toArray().length > 0;
      if (busy) {
        if (h.idle_since !== null) this.sql.exec("UPDATE hosts SET idle_since = NULL WHERE host = ?", h.host);
      } else if (h.idle_since === null) {
        this.sql.exec("UPDATE hosts SET idle_since = ? WHERE host = ?", now, h.host);
      } else if (now - h.idle_since >= cfg.idle_grace_ms) {
        this.sql.exec("UPDATE hosts SET status = 'dead' WHERE host = ?", h.host);
        this.endInstance(h.instance_id!, "idle");
        this.releaseTunnel(h.host, "idle");
        for (const ws of this.ctx.getWebSockets(h.host)) ws.close(4410, "idle: retired");
        console.log(`FleetDO: retiring idle host ${h.host} (${h.instance_id})`);
        await this.evict(h.host, this.leasesOf(h.host).map((l) => l.sandbox));
      }
    }
    // A draining host whose sandboxes have all left goes now rather than at its deadline.
    for (const h of this.sql.exec<HostRow>(
      "SELECT * FROM hosts WHERE role = 'burst' AND status = 'draining' AND instance_id IS NOT NULL").toArray()) {
      if (this.leasesOf(h.host).length) continue;
      this.sql.exec("UPDATE hosts SET status = 'dead' WHERE host = ?", h.host);
      this.endInstance(h.instance_id!, "drained");
      this.releaseTunnel(h.host, "drained");
      for (const ws of this.ctx.getWebSockets(h.host)) ws.close(4410, "drained");
      console.log(`FleetDO: drained ${h.host} (${h.instance_id})`);
    }
    await this.processEvictions();
    const ec2 = this.ec2();
    if (!ec2) return;
    for (const r of this.sql.exec<{ instance_id: string }>(
      "SELECT instance_id FROM launched WHERE reason IS NOT NULL AND ended_ms IS NULL").toArray()) {
      try {
        const state = await ec2.state(r.instance_id);
        if (isDead(state)) this.sql.exec("UPDATE launched SET ended_ms = ? WHERE instance_id = ?", Date.now(), r.instance_id);
        else await ec2.terminate(r.instance_id);
      } catch (e) {
        console.error(`FleetDO: terminating ${r.instance_id} failed; will retry`, e);
      }
    }
  }

  /**
   * Forced drain (spot notice): no new placements; suspended sandboxes leave now, the rest are
   * suspended to the object store and leave as they report `suspended`. SandboxDO re-places a
   * sandbox whose agents are mid-turn at once; the others wait until something needs them.
   */
  private async drain(host: string, deadlineMs: number): Promise<void> {
    this.sql.exec("UPDATE hosts SET status = 'draining' WHERE host = ? AND status = 'active'", host);
    console.warn(`FleetDO: ${host} draining (spot interruption at ${new Date(deadlineMs).toISOString()})`);
    const leases = this.leasesOf(host).filter((l) => !l.expired);
    await this.evict(host, leases.filter((l) => l.state === "suspended").map((l) => l.sandbox));
    const running = leases.filter((l) => l.state !== "suspended");
    if (running.length) {
      await this.issueCommands(host, running.map((l) => ({ type: "sandbox_suspend" as const, sandbox: l.sandbox, epoch: l.epoch, mode: "disk_only" as const })));
    }
    if (!this.deadlines.has(ALARM_TICK)) await this.deadlines.set(ALARM_TICK, Date.now() + DEFAULT_LEASE_TIMING.heartbeat_ms);
  }

  /**
   * Take suspended sandboxes off a host that is going away: their head is in the object store, so
   * the lease is dropped and SandboxDO forgets the host (retried from the alarm until it answers).
   * The host fences what it still has when its next heartbeat's leases are revoked.
   */
  private async evict(host: string, sandboxes: string[]): Promise<void> {
    for (const sandbox of sandboxes) {
      const lease = this.lease(sandbox);
      if (!lease || lease.host !== host) continue;
      this.sql.exec("DELETE FROM leases WHERE sandbox = ? AND host = ?", sandbox, host);
      this.sql.exec("INSERT OR IGNORE INTO evictions (sandbox, host, epoch) VALUES (?, ?, ?)", sandbox, host, lease.epoch);
    }
    await this.processEvictions();
  }

  /** Mark an instance for termination (retried from the alarm until EC2 reports it gone). */
  private endInstance(instanceId: string, reason: string): void {
    this.sql.exec(
      `INSERT INTO launched (instance_id, launched_ms, role, reason) VALUES (?, ?, 'burst', ?)
       ON CONFLICT(instance_id) DO UPDATE SET reason = COALESCE(launched.reason, excluded.reason)`,
      instanceId, Date.now(), reason,
    );
  }

  private async processEvictions(): Promise<void> {
    for (const e of this.sql.exec<{ sandbox: string; host: string; epoch: number }>("SELECT * FROM evictions").toArray()) {
      try {
        await this.sandbox(e.sandbox).evicted(e.host, e.epoch);
        this.sql.exec("DELETE FROM evictions WHERE sandbox = ? AND host = ? AND epoch = ?", e.sandbox, e.host, e.epoch);
      } catch (err) {
        console.error(`FleetDO: evicting ${e.sandbox} from ${e.host} failed; will retry`, err);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Object-store GC (docs/sandbox/state/object-store/#garbage-collection). Hosts hold the S3
  // credentials, so a burst host runs it; FleetDO decides when, and supplies the roots.
  // -------------------------------------------------------------------------------------------

  /** A sandbox was destroyed: its generations stop being roots. */
  async sandboxDestroyed(sandbox: string): Promise<void> {
    this.sql.exec("INSERT INTO sandboxes (sandbox, registered_ms, destroyed_ms) VALUES (?, ?, ?) ON CONFLICT(sandbox) DO UPDATE SET destroyed_ms = excluded.destroyed_ms",
      sandbox, Date.now(), Date.now());
  }

  /** Operator: register sandboxes created before the registry existed, so GC keeps their data. */
  async registerSandboxes(sandboxes: string[]): Promise<number> {
    for (const s of sandboxes) this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) VALUES (?, ?)", s, Date.now());
    return this.sql.exec("SELECT 1 FROM sandboxes WHERE destroyed_ms IS NULL").toArray().length;
  }

  /** Operator: make the next claim start a run now (it still follows the dry-run rule). */
  async gcRequest(): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('gc_requested', '1')");
  }

  /**
   * A burst host offers to run GC. Due once a day (or when requested), one run at a time; a run
   * that hasn't reported within its 12 h window is abandoned. The roots are snapshotted now: the
   * host must finish deleting within 12 h of this mark. The first run, and the first after the
   * marking rules change, is a dry run.
   */
  async gcClaim(host: string): Promise<GcClaim | null> {
    const h = this.host(host);
    if (!h || h.role !== "burst" || h.status !== "active") return null;
    const now = Date.now();
    this.sql.exec("UPDATE gc_runs SET finished_ms = ?, report = '{\"abandoned\":true}' WHERE finished_ms IS NULL AND marked_ms < ?", now, now - GC_WINDOW_MS);
    if (this.sql.exec("SELECT 1 FROM gc_runs WHERE finished_ms IS NULL").toArray().length) return null;
    const last = this.sql.exec<{ marked_ms: number }>("SELECT MAX(marked_ms) AS marked_ms FROM gc_runs").toArray()[0]?.marked_ms ?? 0;
    const requested = this.sql.exec("SELECT 1 FROM kv WHERE key = 'gc_requested'").toArray().length > 0;
    if (!requested && now - last < GC_INTERVAL_MS) return null;
    // Dry unless a completed (not abandoned) run of this marking version has already reported.
    const proven = this.sql.exec(
      "SELECT 1 FROM gc_runs WHERE mark_version = ? AND finished_ms IS NOT NULL AND report NOT LIKE '%\"abandoned\"%' AND report NOT LIKE '%\"error\"%'",
      GC_MARK_VERSION).toArray().length > 0;
    // Take the run before collecting roots: the calls below let another claim in.
    const run = newId("gc_");
    this.sql.exec("DELETE FROM kv WHERE key = 'gc_requested'");
    this.sql.exec("INSERT INTO gc_runs (run, host, marked_ms, dry_run, mark_version, roots) VALUES (?, ?, ?, ?, ?, 0)",
      run, host, now, proven ? 0 : 1, GC_MARK_VERSION);
    const live = this.sql.exec<{ sandbox: string }>("SELECT sandbox FROM sandboxes WHERE destroyed_ms IS NULL").toArray();
    const roots = new Set<string>();
    try {
      for (const { sandbox } of live) for (const m of await this.sandbox(sandbox).gcRoots()) roots.add(m);
    } catch (e) {
      // A root we can't read means we can't mark: no run.
      this.sql.exec("UPDATE gc_runs SET finished_ms = ?, report = ? WHERE run = ?", Date.now(),
        JSON.stringify({ error: `collecting roots: ${String(e)}` }), run);
      return null;
    }
    this.sql.exec("UPDATE gc_runs SET roots = ? WHERE run = ?", roots.size, run);
    return {
      run, marked_ms: now, dry_run: !proven, roots: [...roots], grace_ms: GC_GRACE_MS, deadline_ms: now + GC_WINDOW_MS,
      max_deletes: GC_MAX_DELETES,
    };
  }

  async gcReport(host: string, run: string, report: Record<string, unknown>): Promise<void> {
    this.sql.exec("UPDATE gc_runs SET finished_ms = ?, report = ? WHERE run = ? AND host = ? AND finished_ms IS NULL",
      Date.now(), JSON.stringify(report), run, host);
  }

  async gcStatus(): Promise<{ sandboxes: number; runs: Record<string, unknown>[] }> {
    return {
      sandboxes: this.sql.exec("SELECT 1 FROM sandboxes WHERE destroyed_ms IS NULL").toArray().length,
      runs: this.sql.exec<{ report: string | null } & Record<string, SqlStorageValue>>(
        "SELECT * FROM gc_runs ORDER BY marked_ms DESC LIMIT 10").toArray()
        .map((r) => ({ ...r, report: r.report ? JSON.parse(r.report) as unknown : null })),
    };
  }

  /**
   * Operator view: hosts with their lease counts, capacity, resident sandboxes and brains; launched
   * instances with their outcome; and every live sandbox of the cell (registered, not destroyed)
   * with its lease, so an unplaced one shows too.
   */
  async fleetView(): Promise<{ hosts: Record<string, unknown>[]; launches: Record<string, unknown>[]; sandboxes: Record<string, unknown>[] }> {
    const hosts = this.sql.exec(`SELECT h.host, h.role, h.instance_id, h.status, h.idle_since, h.enrolled_ms, h.last_rx,
        h.tunnel_hostname, h.tunnel_state, h.capacity,
        (SELECT COUNT(*) FROM leases l WHERE l.host = h.host) AS leases FROM hosts h ORDER BY h.enrolled_ms`).toArray()
      .map((h) => ({
        ...h,
        capacity: typeof h.capacity === "string" ? (JSON.parse(h.capacity) as Capacity) : null,
        connected: !!this.socketFor(h.host as string),
        sandboxes: this.sql.exec("SELECT sandbox, epoch, state, vcpus, memory_mib FROM leases WHERE host = ? ORDER BY sandbox", h.host as string).toArray(),
        agents: this.sql.exec<{ agent: string }>("SELECT agent FROM host_agents WHERE host = ? ORDER BY agent", h.host as string).toArray().map((a) => a.agent),
      }));
    return {
      hosts,
      launches: this.sql.exec("SELECT instance_id, launched_ms, host, reason, ended_ms FROM launched ORDER BY launched_ms").toArray(),
      sandboxes: this.sql.exec(`SELECT s.sandbox, s.registered_ms, l.host, l.epoch, l.state FROM sandboxes s
        LEFT JOIN leases l ON l.sandbox = s.sandbox WHERE s.destroyed_ms IS NULL ORDER BY s.registered_ms`).toArray(),
    };
  }

  /** Operator view: the cell's host AMIs and the one the launch template resolves to. */
  async images(): Promise<{ current: string | null; current_since_ms: number | null; images: ImageInfo[] }> {
    const ec2 = this.ec2();
    const cell = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'cell'").toArray()[0]?.value;
    const ssm = this.ssm();
    const current = ssm && cell ? await ssm.parameter(`/imagebuilder/nest-${cell}/host-ami`) : null;
    return { current: current?.value ?? null, current_since_ms: current?.modified_ms ?? null, images: ec2 ? await ec2.images() : [] };
  }

  private ssm(): Ssm | null {
    if (this.ssmOverride !== undefined) return this.ssmOverride;
    const { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret } = this.env;
    const region = this.cellConfig()?.region ?? this.env.AWS_REGION;
    return id && secret && region ? new AwsSsm(id, secret, region) : null;
  }

  /** CP-side lease expiry: no sandbox on this host may run anywhere else until STONITH is confirmed. */
  private async expireHost(host: string): Promise<void> {
    this.sql.exec("UPDATE leases SET expired = 1 WHERE host = ?", host);
    this.sql.exec("UPDATE hosts SET status = 'stonith_pending' WHERE host = ?", host);
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4408, "lease expired");
    const row = this.host(host)!;
    const ec2 = this.ec2();
    if (row.instance_id && ec2) {
      try {
        await ec2.terminate(row.instance_id);
      } catch (e) {
        console.error("FleetDO: TerminateInstances failed; will retry", e);
      }
      await this.pollStonith(row);
    }
    // Without an instance id or EC2 access, STONITH waits for the host to reconnect and fence, or for
    // an operator to confirm (`confirmHostDead`). Never double-run.
  }

  /**
   * A silent controller host: it holds no sandboxes, so nothing can run twice and no STONITH is needed.
   * Its runner killed its brains when the host lease lapsed (20 s, before this 30 s expiry), and only
   * an agent's assigned host may attach its session, so its captains start again on another controller
   * host (or on this one once it reconnects; `hello` makes it active again).
   */
  private async expireController(host: string): Promise<void> {
    this.sql.exec("UPDATE hosts SET status = 'expired' WHERE host = ?", host);
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4408, "lease expired");
    const agents = this.sql.exec<{ agent: string }>("SELECT agent FROM host_agents WHERE host = ?", host).toArray();
    this.sql.exec("DELETE FROM host_agents WHERE host = ?", host);
    for (const { agent } of agents) {
      try {
        await this.agentStub(agent).onHostLost(host);
      } catch (e) {
        console.error(`FleetDO: moving ${agent} off ${host} failed`, e);
      }
    }
  }

  private async pollStonith(h: HostRow): Promise<void> {
    const ec2 = this.ec2();
    if (!h.instance_id || !ec2) return;
    try {
      const state = await ec2.state(h.instance_id);
      if (isDead(state)) await this.confirmHostDead(h.host);
      else if (state === "running" || state === "pending" || state === "stopping" || state === "stopped") {
        await ec2.terminate(h.instance_id);
      }
    } catch (e) {
      console.error("FleetDO: STONITH poll failed; will retry", e);
    }
  }

  /**
   * A reachable host with expired leases must fence them before they are reassigned. Re-issued on
   * every hello, every tick and after a failed fence until one succeeds.
   */
  private async ensureStonithFence(host: string): Promise<void> {
    const queued = new Set(this.sql.exec<{ sandbox: string }>("SELECT sandbox FROM reassign_queue").toArray().map((r) => r.sandbox));
    const expired = this.leasesOf(host).filter((l) => l.expired && !queued.has(l.sandbox)).map((l) => l.sandbox);
    if (!expired.length) return;
    const covered = new Set<string>();
    for (const r of this.sql.exec<{ body: string }>(
      "SELECT body FROM commands WHERE host = ? AND purpose = 'stonith_fence' AND result IS NULL", host).toArray()) {
      for (const s of (JSON.parse(r.body) as { sandboxes: string[] }).sandboxes) covered.add(s);
    }
    const missing = expired.filter((s) => !covered.has(s));
    if (missing.length) await this.issueCommands(host, [{ type: "fence", sandboxes: missing, reason: "lease expired" }], "stonith_fence");
  }

  /** STONITH confirmed (EC2 says terminated, or an operator confirmed): reassign every lease. */
  async confirmHostDead(host: string): Promise<void> {
    const h = this.host(host);
    if (!h) return;
    if (h.status !== "dead") {
      this.sql.exec("UPDATE hosts SET status = 'dead' WHERE host = ?", host);
      for (const ws of this.ctx.getWebSockets(host)) ws.close(4410, "host declared dead");
      this.releaseTunnel(host, "dead");
    }
    await this.queueReassign(host, this.leasesOf(host).map((l) => l.sandbox), true);
  }

  /** Queue leases for reassignment and work the queue; failures are retried from the alarm. */
  private async queueReassign(host: string, sandboxes: string[], hostDead: boolean): Promise<void> {
    for (const sandbox of sandboxes) {
      const lease = this.lease(sandbox);
      if (!lease || lease.host !== host) continue;
      this.sql.exec("INSERT OR IGNORE INTO reassign_queue (sandbox, host, epoch, host_dead) VALUES (?, ?, ?, ?)",
        sandbox, host, lease.epoch, hostDead ? 1 : 0);
    }
    await this.processReassign();
  }

  /** Idempotent per sandbox: drop the old lease, then have SandboxDO grant a new one elsewhere. */
  private async processReassign(): Promise<void> {
    const rows = this.sql
      .exec<{ sandbox: string; host: string; epoch: number; host_dead: number }>("SELECT sandbox, host, epoch, host_dead FROM reassign_queue")
      .toArray();
    for (const r of rows) {
      try {
        const lease = this.lease(r.sandbox);
        if (lease && lease.host === r.host && lease.epoch === r.epoch) this.sql.exec("DELETE FROM leases WHERE sandbox = ?", r.sandbox);
        await this.sandbox(r.sandbox).leaseLost(r.host, r.epoch, r.host_dead === 1);
        this.sql.exec("DELETE FROM reassign_queue WHERE sandbox = ? AND host = ? AND epoch = ?", r.sandbox, r.host, r.epoch);
      } catch (e) {
        this.sql.exec("UPDATE reassign_queue SET attempts = attempts + 1 WHERE sandbox = ?", r.sandbox);
        console.error(`FleetDO: reassigning ${r.sandbox} failed; will retry`, e);
      }
    }
    if (this.sql.exec("SELECT 1 FROM reassign_queue").toArray().length && !this.deadlines.has(ALARM_TICK)) {
      await this.deadlines.set(ALARM_TICK, Date.now() + DEFAULT_LEASE_TIMING.heartbeat_ms);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private host(host: string): (HostRow & { cell: string; nestd_instance: string | null }) | undefined {
    return this.sql.exec<HostRow & { cell: string; nestd_instance: string | null }>("SELECT * FROM hosts WHERE host = ?", host).toArray()[0];
  }

  private lease(sandbox: string): LeaseRow | undefined {
    return this.sql.exec<LeaseRow>("SELECT * FROM leases WHERE sandbox = ?", sandbox).toArray()[0];
  }

  private leasesOf(host: string): LeaseRow[] {
    return this.sql.exec<LeaseRow>("SELECT * FROM leases WHERE host = ?", host).toArray();
  }

  private sandbox(id: string) {
    return this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id));
  }

  private agentStub(id: string) {
    return this.env.AGENT.get(this.env.AGENT.idFromName(id));
  }
}
