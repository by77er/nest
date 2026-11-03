// FleetDO: one per cell. Host enrollment, the fleet WebSocket (docs/interfaces/control-host/fleet/),
// leases and their expiry, STONITH, placement, and command delivery with exactly-one results.
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import { rekeyHostAgents } from "./fleet-rekey";
import { z } from "zod";
import { num, type Env } from "../env";
import { commandRefSlots, REF_PURPOSES, type RefPurpose } from "./broker";

/** A `secrets_update` entry whose reference resolved to nothing: removed before the batch goes out. */
const DROPPED_SECRET = "\u0000nest:dropped";
import { canonicalSpki, certificateSpki, createRootCertificate, generateDevRoot, kmsRoot, localRoot, signIntermediate, type RootCa } from "../lib/ca";
import { AwsKms, type Kms } from "../lib/kms";
import { AwsEc2, CapacityError, isDead, type Ec2 } from "../lib/ec2";
import { AwsSsm, type Ssm } from "../lib/ssm";
import { DEFAULT_IMAGE } from "./sandbox";
import {
  CloudflareError, CloudflareHttp, gatewayHostname, hostOfHostname, hostOfTunnelName, hostnameSuffix, splitDomain, tunnelConfig, tunnelName,
  tunnelPrefix, type CloudflareApi,
} from "../lib/cloudflare";
import { awsCell, cellAws, DEFAULT_SANDBOX_RESERVE_MIB, type AwsCellConfig, type CellAws } from "../lib/cells";
import { brainHostNeeded, idleStep, maxBrains, pickBrainHost, pickSandboxHost, scaleUpPlan, type BrainHostFacts, type ScaleSettings } from "../lib/placement";
import { deathPlan, expiryVerdict, hostStep, type DeathCause, type HostTransition } from "../lib/host-lifecycle";
import type { InstanceIdentity } from "../lib/aws-identity";
import { Deadlines, ReliableChannels, SerialQueue } from "../lib/reliable";
import { issueHostToken } from "../lib/tokens";
import { bytesToB64, errorBody, NestError, newId, sha256, hex, asNestError } from "../lib/util";
import { addColumn, sqlIn, storedEnum, storedEnumOrNull, typeEnum } from "../lib/stored";
import { retentionMode } from "../lib/retention";
import {
  Capacity, type CommandBody, CommandBodyVariants, type CommitRequestEvent, DEFAULT_LEASE_TIMING, type EnrollRequest,
  type EnrollResponse, type FleetToHost, type HostEvent, type HostToFleet, HostToFleetFrame, parseHostEvents, type LeaseClaim, type CaCertificate, type SandboxReport,
  TunnelState,
} from "../protocol/control";
import type { GuestInfo } from "../protocol/gateway";
import {
  type CliResult, ErrorCodes, type EgressPolicy, type GenerationRecord, type HostKind, HostRole, hostKind, PROTOCOL_VERSION, type Resources,
  roleName, SandboxState,
} from "../protocol/model";
import {
  type CapacityView, type FleetView, HOST_STATUSES, type HostStatus, type HostView, type ImagesView, LAUNCH_END_REASONS, type LaunchEndReason,
  type LaunchView, type SandboxView, type TemplateView,
  type HostRole as AdminHostRole, type SandboxState as AdminSandboxState, type TunnelState as AdminTunnelState,
  type AwsView, AGENT_LIFETIME_KINDS, type AgentLifetimeKind, type LifetimeAgentView, type LifetimeSandboxView, type LifetimesView,
  SANDBOX_LIFETIME_KINDS, type SandboxLifetimeKind,
} from "../../../protocol/admin/view";
import { AGENTS_CURSOR, agentCursorOf, type AgentRead, classifyAgent, classifySandbox, cursorOf, DEFAULT_QUIET_MS, mapBounded, parseCursor } from "../lib/abandoned";
import { cellIdleTtlMs } from "../lib/lifetimes";
import { labelWhere, type Labels } from "../lib/clients";

/** What an agent or sandbox registers beside its id: its API client and labels (fixed at creation). */
export interface RegistryMeta {
  client: string | null;
  labels: Labels | null;
}
export interface RegistryQuery {
  labels?: [string, string][];
  client?: string;
  state?: "live" | "ended" | "all";
  limit?: number;
  cursor?: string;
}
/** A row of a cell's agent or sandbox registry, as listed. */
export interface RegistryRow {
  id: string;
  client: string | null;
  labels: Labels;
  created_ms: number;
  /** When its end was done, or it was destroyed; null while it lives. */
  ended_ms: number | null;
}

// Closed unions for every status/kind column (docs/data/#enums): written through these types, read
// back through `storedEnum` (a value outside the union is logged as an error).
const HostStatus = z.enum(HOST_STATUSES);
const LaunchEndReason = z.enum(LAUNCH_END_REASONS);
/** Command purposes FleetDO itself needs to react to when the result arrives (`commands.purpose`). */
const PURPOSES = ["stonith_fence"] as const;
const PurposeEnum = z.enum(PURPOSES);
type Purpose = (typeof PURPOSES)[number] | null;
/** `commands.answered_by`: FleetDO answered the command itself (null: the host did). */
const AnsweredByEnum = z.enum(["fleet"]);
type AnsweredBy = z.output<typeof AnsweredByEnum>;
/** `commands.type`: the type of the command body it stores. */
type CommandType = CommandBody["type"];
const CommandTypeEnum = typeEnum<CommandType>(CommandBodyVariants);
/** The host kind that holds sandbox leases, and the one that runs brains: never both (docs/compute/). */
const SANDBOX_ROLE: HostKind = "sandbox";
const BRAIN_ROLE: HostKind = "brain";
/** Statuses in which a host is (or may be) running: it is ticked, polled and counted. */
const LIVE_STATUSES = ["active", "draining", "stonith_pending"] as const satisfies readonly HostStatus[];

// The admin view (protocol/admin/view.ts, the contract with the dashboard) repeats the protocol's enums
// without zod; they must be the same sets.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const ADMIN_ENUMS_AGREE: [
  Same<AdminSandboxState, SandboxState>, Same<AdminHostRole, HostKind>, Same<AdminTunnelState, TunnelState>,
] = [true, true, true];

/**
 * Where a host's sandbox gateway is reached (`hostGatewayUrl`): through its tunnel (Cloudflare
 * Access in front, so targets carry the service token), not yet (the tunnel is connecting), not at
 * all (`down`: a tunnel host that serves no tunnel; never its hello URL, which is its own loopback),
 * or directly at the URL its hello advertised (a host without a tunnel: the harness).
 */
export type HostGateway =
  | { kind: "tunnel"; url: string }
  | { kind: "connecting" }
  | { kind: "down"; tunnel: string }
  | { kind: "direct"; url: string };

interface HostRow {
  host: string;
  cell: string;
  /** Stored as the role's name this release writes (`roleName`), read back as its kind. */
  role: HostKind;
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
  /** What the host last said about its tunnel; `none` until its first hello says otherwise. */
  tunnel_state: TunnelState;
  /** The `mark` at which `capacity` was last reported (null: before marks existed). */
  capacity_seq: number | null;
  idle_since: number | null;
  /** When the host became `dead` (null otherwise): its row is pruned `DEAD_HOST_RETENTION_MS` later. */
  dead_ms: number | null;
  nestd_instance: string | null;
  /** Its brains are proven gone (A6): lease expired, or death confirmed (1), else 0. */
  lost: number;
  /** When AgentDO reported it wedged (null: not wedged). */
  wedged_ms: number | null;
  /** Its nestd keys brains by agent epoch (1), or is of the previous release (0). */
  brain_epochs: number;
  /** When a drain was asked for (null: none). The status says whether it is serving; this survives an expiry and a return. */
  drain_ms: number | null;
  [key: string]: SqlStorageValue;
}

interface LeaseRow {
  sandbox: string;
  host: string;
  epoch: number;
  expired: number;
  /** Last state the holder reported (`suspended` leases don't keep a host busy); null before its first report. */
  state: SandboxState | null;
  /** What the sandbox asked for; reserved against the host's report until the host counts it. */
  vcpus: number | null;
  memory_mib: number | null;
  /** The `mark` at which the holder first reported a state (null: none yet, or before marks existed). */
  state_seq: number | null;
  /** The guest the holder last reported with `running` (JSON `GuestInfo`), for a SandboxDO adopting the lease. */
  guest: string | null;
  [key: string]: SqlStorageValue;
}

interface Attachment {
  host: string;
  helloed: boolean;
  /**
   * The highest command seq this socket has been sent: its hello's `last_command_seq` to start
   * with, advanced by each outbound run. Absent (a socket from before it): everything unacked.
   */
  sent?: number;
}

/**
 * `kv` key of a host's lineage-reset capture (`Orphans`): what its old nestd process never
 * answered, kept until it has been dealt with.
 */
const orphansKey = (host: string) => `orphaned_commands:${host}`;

/** A RunInstances attempt FleetDO hasn't seen the end of (`scaleUp`), kept in `kv` under `launchKey`. */
interface LaunchIntent { token: string; type: string; subnet: string; spot: boolean; at: number }
const launchKey = (role: HostKind) => `launch:${role}`;
/**
 * The old process's unanswered commands, and (until `dropUnreported` has run) the leases it held
 * that the new process doesn't report. An older shape is the bare array of commands.
 */
interface Orphans {
  cmds: string[];
  gone?: { sandbox: string; epoch: number }[];
}
function parseOrphans(value: string): Orphans {
  const v = JSON.parse(value) as Orphans | string[];
  return Array.isArray(v) ? { cmds: v } : v;
}

export interface PlaceRequest {
  sandbox: string;
  /** Compat: the `ws_` value `sandbox_create` carries to hosts of the previous release (SandboxDO's). */
  workstream: string;
  epoch: number;
  image: string;
  resources: Resources;
  policy: EgressPolicy;
  from?: GenerationRecord;
  excludeHost?: string;
}

/** An instance this control plane launched, with what it may enroll as. */
export interface LaunchedInstance {
  instance_id: string;
  role?: HostRole;
  account_id?: string;
  region?: string;
}

const TOKEN_ROTATE_BEFORE_MS = 10 * 60_000;

// Retention, one constant per table that would otherwise only grow (docs/data/#retention).
/** `commands`: an answered command (a host's death answers what it never did). */
const COMMAND_RETENTION_MS = 24 * 3_600_000;
/** `stale_incarnations`: a destroyed incarnation's row, once its `sandbox_destroy` was issued. */
const STALE_INCARNATION_RETENTION_MS = 24 * 3_600_000;
/**
 * `hosts` (with its `commands`, reliable-channel and `tunnels_created` rows): a dead host with nothing
 * left to clean up, and no brain still indexed there (`host_agents` rows go only once AgentDO took
 * the loss or the exit).
 */
const DEAD_HOST_RETENTION_MS = 7 * 86_400_000;
/** `launched`: an instance EC2 confirmed gone. */
const LAUNCH_RETENTION_MS = 7 * 86_400_000;
/** `gc_runs`: a finished run; the latest run and the latest proven one are always kept. */
const GC_RUN_RETENTION_MS = 30 * 86_400_000;
/** `sandboxes`: a destroyed sandbox's registry row (its generations stopped being roots when it was destroyed). */
const DESTROYED_SANDBOX_RETENTION_MS = 30 * 86_400_000;
/** The pruning pass runs at most this often, from any alarm (the tick, the daily tunnel sweep, its own). */
const PRUNE_INTERVAL_MS = 3_600_000;
/** Its own deadline, so a quiet cell (no tick, no tunnels) still prunes: armed on every start. */
const ALARM_PRUNE = "prune";
const PRUNE_DAILY_MS = 24 * 3_600_000;
/** Sandboxes whose lifetime check `armLifetimes` arms per daily run, and how often each is asked again. */
const LIFETIME_BACKFILL_PER_RUN = 200;
const LIFETIME_RECHECK_MS = 7 * 86_400_000;
/** The lifetimes view's page of sandboxes (default and most), agents read per page, and reads at a time. */
const LIFETIMES_PAGE = 50;
const LIFETIMES_MAX_PAGE = 100;
const LIFETIMES_MAX_AGENTS = 200;
const LIFETIMES_CONCURRENCY = 8;
/** A brain waiter not seen again for this long has stopped waiting (it retries at least every 5 min). */
const BRAIN_WAIT_TTL_MS = 12 * 60_000;
/** Lost hosts (expired or dead) whose brains' agents haven't all acknowledged the loss yet. */
const LOST_WITH_BRAINS = "SELECT host FROM hosts WHERE lost = 1 AND host IN (SELECT host FROM host_agents)";
/**
 * How long a stale incarnation's salvage may take before FleetDO destroys it anyway: nestd gives a
 * salvage commit 600 s (`SALVAGE_TIMEOUT`), plus a margin.
 */
const SALVAGE_WINDOW_MS = 11 * 60_000;
const ENROLL_TOKEN_RETENTION_MS = 7 * 86_400_000;
/** How long a cell root certificate self-signed through KMS lasts. */
const ROOT_CA_TTL_MS = 3650 * 86_400_000;
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
/**
 * Bump when the marking rules change: the next run is then a dry run again. Switching generation
 * retention on (kv `retention_on_ms`) also makes the next run dry: only a run marked after it proves.
 */
const GC_MARK_VERSION = 1;
/** A finished run of the marking version bound to `?` that completed: the next run of that version may delete. */
const GC_PROVEN = `mark_version = ? AND finished_ms IS NOT NULL AND report NOT LIKE '%"abandoned"%' AND report NOT LIKE '%"error"%'`;

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

export type { AwsView } from "../../../protocol/admin/view";

export class FleetDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // `!`: set in the constructor, except on the health instance, which serves only `health()`.
  private readonly rel!: ReliableChannels;
  private readonly deadlines!: Deadlines;
  /** Per-host serialization of inbound reliable messages (hello and event batches). */
  private readonly inbound = new Map<string, SerialQueue>();
  /** Per-host serialization of outbound command sends (`flush`). */
  private readonly outbound = new Map<string, SerialQueue>();
  /** Override for tests; `undefined` derives a client from the AWS_* secrets. */
  ec2Override: Ec2 | null | undefined = undefined;
  /** Override for tests; `undefined` reads the cell's entry in `AWS_CELLS`. */
  cellConfigOverride: AwsCellConfig | null | undefined = undefined;
  /** Override for tests: SSM for the host AMI parameter; `null` = none. */
  ssmOverride: Ssm | null | undefined = undefined;
  /** Override for tests: the cell's KMS; `null` = no credentials; `undefined` derives it from the cell's AWS access. */
  kmsOverride: Kms | null | undefined = undefined;
  /** The cell's KMS root, kept for this instance's life (loading it costs a KMS `GetPublicKey`). */
  private kmsRoot: { keyId: string; root: RootCa } | null = null;
  /** Override for tests: a fake Cloudflare API and the domain; `null` = no tunnels; `undefined` reads the env. */
  cloudflareOverride: { api: CloudflareApi; domain: string } | null | undefined = undefined;
  /** Host kinds with a RunInstances call in flight in this instance; placements meanwhile don't launch another. */
  private readonly launching = new Set<HostKind>();

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.FLEET)) return;
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
    // `epoch` is the body's own: the sandbox epoch for sandbox commands, the agent epoch for
    // `agent_start` / `agent_stop` (read by type, never across types).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS commands (cmd TEXT PRIMARY KEY, host TEXT NOT NULL, type TEXT NOT NULL,
      sandbox TEXT, agent TEXT, epoch INTEGER, purpose TEXT, body TEXT NOT NULL, issued_ms INTEGER NOT NULL,
      result TEXT, result_ms INTEGER)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS commands_host_result ON commands (host, result)");
    this.createHostAgents();
    // One row per lost lease: a newer loss is queued while an older one still retries (sandbox-lease L2).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reassignments (sandbox TEXT NOT NULL, host TEXT NOT NULL,
      epoch INTEGER NOT NULL, host_dead INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sandbox, host, epoch))`);
    // Its predecessor, keyed by sandbox: moved over, and kept for a rolled-back Worker.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reassign_queue (sandbox TEXT PRIMARY KEY, host TEXT NOT NULL,
      epoch INTEGER NOT NULL, host_dead INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO reassignments (sandbox, host, epoch, host_dead, attempts)
      SELECT sandbox, host, epoch, host_dead, attempts FROM reassign_queue`);
    this.sql.exec("DELETE FROM reassign_queue");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Every host this cell made a tunnel for, written before the first Cloudflare call: what the
    // sweep may delete.
    this.sql.exec("CREATE TABLE IF NOT EXISTS tunnels_created (host TEXT PRIMARY KEY, created_ms INTEGER NOT NULL)");
    // Autoscaling: when a launched instance stopped counting (`reason`) and when EC2 confirmed it gone.
    addColumn(this.sql, "launched", "cell", "TEXT");
    addColumn(this.sql, "launched", "reason", "TEXT");
    addColumn(this.sql, "launched", "ended_ms", "INTEGER");
    addColumn(this.sql, "hosts", "idle_since", "INTEGER");
    // The seam: where clients reach a host's sandbox gateway (docs/sandbox/gateway/).
    addColumn(this.sql, "hosts", "gateway_url", "TEXT");
    addColumn(this.sql, "hosts", "tunnel_id", "TEXT");
    addColumn(this.sql, "hosts", "tunnel_hostname", "TEXT");
    addColumn(this.sql, "hosts", "dns_record_id", "TEXT");
    addColumn(this.sql, "hosts", "tunnel_state", "TEXT");
    // When AgentDO reported a brain on this host that didn't exit after a kill (`hostWedged`): its
    // heartbeats and hellos go unanswered until it is expired, so its own lease fences it.
    addColumn(this.sql, "hosts", "wedged_ms", "INTEGER");
    // A6: the host's brains are proven gone (lease expired, or death confirmed); an idle or drained
    // retirement isn't proof until EC2 confirms it.
    addColumn(this.sql, "hosts", "lost", "INTEGER NOT NULL DEFAULT 0");
    // The host's nestd keys brains by agent epoch (its hello says so; nestd of the previous release
    // doesn't): preferred for new brains, and the only kind escalation ever wedges.
    addColumn(this.sql, "hosts", "brain_epochs", "INTEGER NOT NULL DEFAULT 0");
    // A drain is an intent, not a liveness: a host that expires and comes back returns to `draining`.
    addColumn(this.sql, "hosts", "drain_ms", "INTEGER");
    addColumn(this.sql, "leases", "state", "TEXT");
    // Packing: what each lease reserves until the host's capacity report counts the sandbox.
    addColumn(this.sql, "leases", "vcpus", "INTEGER");
    addColumn(this.sql, "leases", "memory_mib", "INTEGER");
    // ... and until a capacity report the host made after the lease's first state (`mark` order).
    addColumn(this.sql, "leases", "state_seq", "INTEGER");
    addColumn(this.sql, "hosts", "capacity_seq", "INTEGER");
    addColumn(this.sql, "leases", "guest", "TEXT");
    // `fleet` when FleetDO answered a command itself; null for the host's own result. Only a host's
    // answer means the host ran it (`killProgress`).
    addColumn(this.sql, "commands", "answered_by", "TEXT");
    // Retention: when a host died.
    addColumn(this.sql, "hosts", "dead_ms", "INTEGER");
    // Incarnations a host still has at an epoch FleetDO no longer leases to it: destroyed there once
    // their salvage is done (the host reports them clean) or its window has passed.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stale_incarnations (sandbox TEXT NOT NULL, host TEXT NOT NULL, epoch INTEGER NOT NULL,
      first_seen_ms INTEGER NOT NULL, clean INTEGER NOT NULL DEFAULT 0, cmd TEXT, PRIMARY KEY (sandbox, host, epoch))`);
    // Object-store GC: the registry is the authority for which sandboxes exist (their generations are
    // the roots); SandboxDO registers in `create`, before anything is written for the sandbox.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sandboxes (sandbox TEXT PRIMARY KEY, registered_ms INTEGER NOT NULL,
      destroyed_ms INTEGER)`);
    // When its SandboxDO confirmed its lifetime check is armed (null: not yet; `armLifetimes` backfills it).
    addColumn(this.sql, "sandboxes", "lifetime_ms", "INTEGER");
    // The cell's agents (the lifetimes view's agent pages): each AgentDO registers itself (`registry`
    // deadline, re-checked at its alarms, so agents from before this table backfill within the hour)
    // and its end once done; its reap removes it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_registry (agent TEXT PRIMARY KEY, registered_ms INTEGER NOT NULL, ended_ms INTEGER)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS agent_registry_page ON agent_registry (registered_ms, agent)");
    // The listing's filters (`GET /v1/agents`, `GET /v1/sandboxes`): each one's API client and labels,
    // copied from its record at registration (both are fixed at creation). Null: none, or registered before.
    addColumn(this.sql, "agent_registry", "client", "TEXT");
    addColumn(this.sql, "agent_registry", "labels", "TEXT");
    addColumn(this.sql, "sandboxes", "client", "TEXT");
    addColumn(this.sql, "sandboxes", "labels", "TEXT");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gc_runs (run TEXT PRIMARY KEY, host TEXT NOT NULL, marked_ms INTEGER NOT NULL,
      dry_run INTEGER NOT NULL, mark_version INTEGER NOT NULL, roots INTEGER NOT NULL, finished_ms INTEGER, report TEXT)`);
    // Agents whose last start found no brain host with room: poked when room appears, and the tick
    // launches a brain host while any wait. A row goes once poked, placed, or after `BRAIN_WAIT_TTL_MS`.
    this.sql.exec("CREATE TABLE IF NOT EXISTS brain_waiters (agent TEXT PRIMARY KEY, since_ms INTEGER NOT NULL)");
    // Suspended sandboxes leaving a host that is going away; SandboxDO is told, with retries.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS evictions (sandbox TEXT NOT NULL, host TEXT NOT NULL, epoch INTEGER NOT NULL,
      PRIMARY KEY (sandbox, host, epoch))`);
    this.rel = new ReliableChannels(this.sql);
    this.deadlines = new Deadlines(this.sql, ctx.storage);
    // Retention runs at least daily, whether or not the cell is busy or has tunnels.
    ctx.blockConcurrencyWhile(async () => {
      if (!this.deadlines.has(ALARM_PRUNE)) await this.deadlines.set(ALARM_PRUNE, Date.now() + PRUNE_DAILY_MS);
    });
  }

  private queue(host: string, map = this.inbound): SerialQueue {
    let q = map.get(host);
    if (!q) map.set(host, (q = new SerialQueue()));
    return q;
  }

  // ---------------------------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------------------------

  async mintEnrollmentToken(role: HostRole): Promise<string> {
    const token = `net_${newId("")}${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    this.sql.exec("INSERT INTO enroll_tokens (hash, role, created_ms) VALUES (?, ?, ?)", hex(await sha256(token)), roleName(hostKind(role)), Date.now());
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
      l.instance_id, Date.now(), l.role ? roleName(hostKind(l.role)) : null, l.account_id ?? null, l.region ?? null,
    );
  }

  /**
   * `identity` is set when the Worker verified an AWS identity document; otherwise the proof must be
   * an enrollment token. The proof is checked before anything costs a call (KMS, Cloudflare), and
   * consumed only after the CSR is signed and the tunnel made.
   */
  async enroll(req: EnrollRequest, cell: string, identity: InstanceIdentity | null): Promise<EnrollResponse> {
    // Only a sandbox host runs nest-proxy, so only it must ask for the intermediate CA (a brain host of
    // the previous release still does, and gets one).
    if (hostKind(req.role) === SANDBOX_ROLE && !req.proxy_ca_csr_pem) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, "a sandbox host must send proxy_ca_csr_pem", 400);
    }
    const hash = req.proof.type === "enrollment_token" ? hex(await sha256(req.proof.token)) : "";
    const host = newId("hst_");
    // Checked first, so an unauthenticated caller costs no KMS or Cloudflare call, and again when
    // consumed with the row, so a failure in between never uses it up (the host retries with it).
    this.checkProof(req, identity, hash);
    const proxyCa = req.proxy_ca_csr_pem ? await this.signProxyCa(req.proxy_ca_csr_pem) : undefined;
    const tunnel = hostKind(req.role) === SANDBOX_ROLE ? await this.createTunnel(host) : null;
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
      if (hostKind(storedEnum(HostRole, row.role, "enroll_tokens.role")) !== hostKind(req.role)) {
        throw new NestError(ErrorCodes.UNAUTHORIZED, "enrollment token minted for another role", 401);
      }
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
    const stored = storedEnumOrNull(HostRole, row.role, "launched.role");
    const launchedAs = stored ? hostKind(stored) : null;
    if (launchedAs && launchedAs !== hostKind(req.role)) throw new NestError(ErrorCodes.UNAUTHORIZED, `instance was launched as ${launchedAs}`, 401);
    if (row.account_id && row.account_id !== identity.accountId) throw new NestError(ErrorCodes.UNAUTHORIZED, "instance is in another AWS account", 401);
    if (row.region && row.region !== identity.region) throw new NestError(ErrorCodes.UNAUTHORIZED, "instance is in another AWS region", 401);
    if (consume) {
      if (row.host) this.retireNeverConnected(row.host, consume.host);
      this.sql.exec("UPDATE launched SET host = ? WHERE instance_id = ?", consume.host, identity.instanceId);
    }
    return identity.instanceId;
  }

  /**
   * A proof used by a host that never said hello may be used again: its answer was lost, so nobody
   * holds that host's token. One that connected keeps its proof: a second enrollment is a replay.
   */
  private neverConnected(host: string | null): boolean {
    const h = host ? this.host(host) : undefined;
    return !!h && h.status === "active" && h.last_rx === null;
  }

  /** The prior, never-connected holder of a proof gives way to `successor`: dead, tunnel released. */
  private retireNeverConnected(host: string, successor: string): void {
    if (!this.neverConnected(host)) return;
    // Never connected: nothing was ever delivered to it, so nothing runs there (A6).
    this.ctx.waitUntil(this.die(host, "never_connected"));
    console.warn(`FleetDO: ${host} never connected; its proof enrolls again as ${successor}`);
  }

  private async enrollRecord(
    req: EnrollRequest, cell: string, identity: InstanceIdentity | null, hash: string, host: string, proxyCa: CaCertificate | undefined,
    tunnel: { id: string; token: string; hostname: string; record: string } | null,
  ): Promise<EnrollResponse> {
    // Everything up to the INSERT is synchronous: the proof is checked and consumed atomically.
    const now = Date.now();
    const instanceId = this.checkProof(req, identity, hash, { host, now });
    const tokenExp = now + num(this.env.HOST_TOKEN_TTL_MS, 3_600_000);
    this.sql.exec(
      `INSERT INTO hosts (host, cell, role, instance_id, status, last_rx, token_exp, enrolled_ms, tunnel_id, tunnel_hostname, dns_record_id, tunnel_state)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      host, cell, roleName(hostKind(req.role)), instanceId, "active" satisfies HostStatus, tokenExp, now, tunnel?.id ?? null, tunnel?.hostname ?? null, tunnel?.record ?? null,
      "none" satisfies TunnelState,
    );
    const hostToken = await issueHostToken(this.env.HOST_TOKEN_SECRET, { host, cell, role: roleName(hostKind(req.role)), exp: tokenExp });
    return {
      host,
      host_token: hostToken,
      host_token_expires_ms: tokenExp,
      fleet_ws_url: `${this.env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/fleet`,
      ...(proxyCa ? { proxy_ca: proxyCa } : {}),
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
      // A revoked token would fail every enrollment, and the enroll timeout would burn instance
      // after instance: the host enrolls without a tunnel instead (reachable directly).
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
   * The daily pass (also `POST /v1/admin/tunnels/sweep`). Retries the deletes dead hosts owe; then
   * deletes the nest-named tunnels and records this cell created (`tunnels_created`) for a host that
   * is dead or never got a row within the grace. A nest-shaped name it can't account for (another
   * cell or deployment, a hand-made tunnel) is counted, never deleted.
   */
  async tunnelSweep(): Promise<{ tunnels: number; records: number; retried: number; failed: number; unknown: number; forgotten: number }> {
    const cf = this.cloudflare();
    const counts = { tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 0, forgotten: 0 };
    if (!cf) return counts;
    const now = Date.now();
    for (const h of this.hostsBy({ status: "dead", where: "(tunnel_id IS NOT NULL OR dns_record_id IS NOT NULL)" })) {
      counts.retried++;
      if (!(await this.deleteTunnelAssets(h.host, h.tunnel_id, h.dns_record_id, "sweep retry"))) counts.failed++;
    }
    const unknown: string[] = [];
    /** Hosts whose tunnel or record either listing showed (deleted in this pass or not). */
    const seen = new Set<string>();
    /** Listings that succeeded and were complete. */
    let listed = 0;
    const disposable = (host: string | null, name: string): boolean => {
      if (host) seen.add(host);
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
      const records = await cf.api.listRecords(zone, hostnameSuffix(cf.label, cf.zone));
      if (records.complete) listed++;
      for (const r of records.items) {
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
      const tunnels = await cf.api.listTunnels(tunnelPrefix(cf.label));
      if (tunnels.complete) listed++;
      for (const t of tunnels.items) {
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
    // Rows with a hosts row go with it (prune); one without, that neither listing shows when both
    // succeeded and neither stopped at its page limit, has nothing left on Cloudflare.
    if (listed === 2) {
      for (const r of this.sql.exec<{ host: string; created_ms: number }>(
        "SELECT host, created_ms FROM tunnels_created WHERE host NOT IN (SELECT host FROM hosts) AND created_ms < ?", now - TUNNEL_INTENT_GRACE_MS).toArray()) {
        if (seen.has(r.host)) continue;
        this.sql.exec("DELETE FROM tunnels_created WHERE host = ?", r.host);
        counts.forgotten++;
      }
    }
    counts.unknown = unknown.length;
    if (unknown.length) console.warn(`FleetDO: sweep left ${unknown.length} nest-named tunnels/records this cell did not create: ${unknown.slice(0, 20).join(", ")}`);
    console.log(`FleetDO: tunnel sweep: ${counts.tunnels} tunnels, ${counts.records} records, ${counts.retried} retried, ${counts.failed} failed, ${counts.unknown} unknown, ${counts.forgotten} forgotten`);
    return counts;
  }

  /** The cell's AWS access (`lib/cells.ts`): its own region, credentials and KMS key. */
  private aws(): CellAws {
    return cellAws(this.env, this.cellName(), this.cellConfig());
  }

  /** The cell's KMS, in the cell's region with the cell's credentials. */
  private kms(): Kms {
    if (this.kmsOverride !== undefined) {
      if (!this.kmsOverride) throw new NestError(ErrorCodes.INTERNAL, "AWS credentials not configured", 500);
      return this.kmsOverride;
    }
    const { credentials, region } = this.aws();
    if (!credentials || !region) {
      throw new NestError(ErrorCodes.INTERNAL, `AWS credentials or region not configured for cell ${this.cellName() ?? "(unnamed)"}`, 500);
    }
    return new AwsKms(credentials.access_key_id, credentials.secret_access_key, region);
  }

  /** The root CA: the cell's KMS key, else a PEM key (development, and before KMS). */
  private async rootCa(): Promise<RootCa> {
    const keyId = this.aws().kmsKey;
    if (keyId) return this.kmsRootCa(keyId);
    if (this.env.ROOT_CA_CERT_PEM && this.env.ROOT_CA_KEY_PEM) return localRoot(this.env.ROOT_CA_CERT_PEM, this.env.ROOT_CA_KEY_PEM);
    if (this.env.ALLOW_DEV_CA !== "1") {
      throw new NestError(ErrorCodes.INTERNAL, "root CA not configured (no KMS key for the cell, no ROOT_CA_CERT_PEM / ROOT_CA_KEY_PEM)", 500);
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
   * The cell's root in KMS, its certificate kept in `kv.root_ca`: self-signed through KMS the first
   * time. A kept certificate for any other key is refused, so nothing issues intermediates baked
   * images don't trust.
   */
  private async kmsRootCa(keyId: string): Promise<RootCa> {
    if (this.kmsRoot?.keyId === keyId) return this.kmsRoot.root;
    const kms = this.kms();
    const keySpki = await canonicalSpki(await kms.publicKey(keyId));
    const cell = this.cellName();
    const forKey = async (pem: string) => bytesToB64(await certificateSpki(pem)) === bytesToB64(keySpki);
    const refuse = (what: string) => new NestError(ErrorCodes.INTERNAL,
      `cell ${cell ?? "(unnamed)"}: ${what} is not a certificate for the cell's KMS key ${keyId}; rotating the root is an operator action`, 500);
    const load = () => this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'root_ca'").toArray()[0]?.value ?? null;
    let certPem = load();
    if (certPem === null) {
      const candidate = await createRootCertificate(keySpki, kmsRoot("", kms, keyId).sign, `CN=nest ${cell ? `${cell} ` : ""}proxy root CA`, ROOT_CA_TTL_MS);
      // The awaits above yield, so another call may have kept one meanwhile; no await from here to the insert.
      certPem = load() ?? candidate;
      if (certPem === candidate) {
        this.sql.exec("INSERT INTO kv (key, value) VALUES ('root_ca', ?)", certPem);
        console.log(`FleetDO: cell ${cell}: root CA certificate self-signed through KMS`);
      }
    }
    if (!(await forKey(certPem))) throw refuse("the root certificate the cell keeps");
    const root = kmsRoot(certPem, kms, keyId);
    this.kmsRoot = { keyId, root };
    return root;
  }

  /** The cell's root certificate, to bake into its sandbox images. */
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

  /**
   * Put the host's unsent command batches (above `Attachment.sent`) on its current socket, in seq
   * order. Runs go one at a time per host (the outbound chain), so no batch overtakes a lower one
   * while that one awaits BrokerDO. A run that throws closes its socket, so the hello resends.
   */
  private flush(host: string): Promise<void> {
    let ws: WebSocket | undefined;
    return this.queue(host, this.outbound).run(async () => {
      ws = this.socketFor(host);
      if (!ws) return;
      const msgs = this.rel.pendingAfter(host, (ws.deserializeAttachment() as Attachment).sent) as { seq: number }[];
      if (msgs.length) await this.sendResolved(ws, host, msgs);
    }).catch((e) => {
      console.error(`FleetDO: sending commands to ${host} failed; closing, so its hello resends them`, e);
      if (ws) this.closeRetryable(ws, "sending commands failed; reconnect and resend");
    });
  }

  /** Close a host's socket so it reconnects at once, its hello resending what is unacked. */
  private closeRetryable(ws: WebSocket, why: string): void {
    this.send(ws, { type: "error", error: errorBody(ErrorCodes.INTERNAL, why, true) });
    try {
      ws.close(4503, why);
    } catch {
      // already closed
    }
  }

  /**
   * Send one outbound run on `ws`, a batch at a time: each goes out once its secret references
   * resolve, its seq then recorded as sent. The first failure stops the run and closes the socket.
   * Only `commandRefSlots`' typed slots are resolved, each to the names its purpose allows
   * (`REF_PURPOSES`), so no other field can pull an arbitrary secret (a binding key) out of BrokerDO.
   */
  private async sendResolved(ws: WebSocket, host: string, msgs: { seq: number }[]): Promise<void> {
    for (const msg of msgs) {
      const m = structuredClone(msg) as { seq: number; type?: unknown; commands?: unknown };
      const commands = m.type === "commands" && Array.isArray(m.commands) ? (m.commands as Record<string, unknown>[]) : [];
      // An `agent_start` already answered (failed when its host was expired: A3) is never resent.
      if (commands.length) {
        m.commands = commands.filter((c) => c.type !== "agent_start"
          || this.sql.exec("SELECT 1 FROM commands WHERE cmd = ? AND result IS NOT NULL", c.cmd as string).toArray().length === 0);
      }
      const slots = (m.commands as Record<string, unknown>[] | undefined ?? []).flatMap((c) => commandRefSlots(c));
      const values = new Map<RefPurpose, Record<string, string | null>>();
      for (const purpose of new Set(slots.map((s) => s.purpose))) {
        const refs = [...new Set(slots.filter((s) => s.purpose === purpose).map((s) => s.ref))];
        try {
          values.set(purpose, await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).resolveRefs(refs, REF_PURPOSES[purpose]));
        } catch (e) {
          console.error(`FleetDO: resolving secret references for batch ${m.seq} failed; holding it and the rest, closing`, e);
          this.closeRetryable(ws, "resolving secret references failed; reconnect and resend");
          return;
        }
      }
      // Superseded or closing (meanwhile, or by an earlier failure): its successor's hello resends.
      if (this.socketFor(host) !== ws) return;
      for (const s of slots) {
        const value = values.get(s.purpose)?.[s.ref];
        if (value === null || value === undefined) console.warn(`FleetDO: secret ${s.ref.slice(s.ref.indexOf(":") + 1)} is missing, expired or not allowed here`);
        // A missing injection secret goes out as no secret at all, never an empty one: nest-proxy then
        // refuses its binding's placeholder (`injection_unavailable`) instead of substituting "".
        s.set(value ?? (s.purpose === "secrets_update" ? DROPPED_SECRET : ""));
      }
      for (const c of (m.commands as Record<string, unknown>[] | undefined) ?? []) {
        if (c.type === "secrets_update" && Array.isArray(c.secrets)) c.secrets = (c.secrets as { value?: unknown }[]).filter((x) => x.value !== DROPPED_SECRET);
      }
      this.send(ws, m as FleetToHost);
      ws.serializeAttachment({ host, helloed: true, sent: m.seq } satisfies Attachment);
    }
  }

  /** The host's current socket: helloed and open (one being closed stays listed until its peer answers). */
  private socketFor(host: string): WebSocket | undefined {
    return this.ctx.getWebSockets(host).find((ws) => ws.readyState === WebSocket.OPEN && (ws.deserializeAttachment() as Attachment).helloed);
  }

  private async onHello(ws: WebSocket, att: Attachment, hello: Extract<HostToFleet, { type: "hello" }>): Promise<void> {
    // A hello that waited in the host's queue while its socket closed is stale: the host has
    // reconnected or will. Acting on it would supersede the live socket before its own hello runs.
    if (ws.readyState !== WebSocket.OPEN) return;
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
    // A wedged host gets no lease renewal (a hello_ack renews it) until it has been expired.
    if (prior.wedged_ms !== null) {
      ws.close(4408, "wedged: a brain did not exit when killed");
      return;
    }
    for (const old of this.ctx.getWebSockets(att.host)) {
      if (old === ws) continue;
      // Never pick a superseded socket for sending, even while its close is in flight.
      old.serializeAttachment({ host: att.host, helloed: false } satisfies Attachment);
      old.close(4000, "superseded by a new connection");
    }
    const now = Date.now();
    const reported = new Map(hello.sandboxes.map((s) => [s.sandbox, s]));
    // A new nestd process: both seq lineages restart. Its predecessor's unanswered commands and
    // unreported leases are captured in the reset's step, before any await, and kept in `kv` until
    // handled, so a FleetDO restart midway leaves them to the next hello.
    const lastInstance = prior.nestd_instance as string | null;
    const newProcess = lastInstance !== null && lastInstance !== hello.instance_id;
    if (newProcess) {
      this.rel.reset(att.host);
      const capture: Orphans = {
        cmds: this.sql.exec<{ cmd: string }>("SELECT cmd FROM commands WHERE host = ? AND result IS NULL", att.host).toArray().map((r) => r.cmd),
        gone: this.leasesOf(att.host).filter((l) => !l.expired && !reported.has(l.sandbox)).map((l) => ({ sandbox: l.sandbox, epoch: l.epoch })),
      };
      this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", orphansKey(att.host), JSON.stringify(capture));
    }
    const stored = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", orphansKey(att.host)).toArray()[0]?.value;
    const orphans = stored === undefined ? undefined : parseOrphans(stored);
    // The host has processed every command up to `last_command_seq`; the socket starts there.
    if (hello.last_command_seq !== undefined) this.rel.ack(att.host, hello.last_command_seq);
    this.sql.exec("UPDATE hosts SET last_rx = ?, capacity = ?, nestd_instance = ?, gateway_url = ?, brain_epochs = ? WHERE host = ?",
      now, JSON.stringify(hello.capacity), hello.instance_id, hello.gateway_url ?? null, hello.brain_epochs ? 1 : 0, att.host);
    this.setTunnelState(att.host, hello.tunnel ?? "none", prior);
    if (hello.cgroup_delegation_error) {
      console.error(`FleetDO: ${att.host} runs its VMMs outside its unit cgroup (delegation failed: ${hello.cgroup_delegation_error})`);
    }
    ws.serializeAttachment({ host: att.host, helloed: true, sent: hello.last_command_seq ?? 0 } satisfies Attachment);
    // An expired host is back, in the step that acks its hello (which renews its lease); it comes
    // back with no brains, and `lost` clears. A `stonith_pending` host stays so until STONITH ends.
    this.move(att.host, "hello_back");

    this.send(ws, {
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      server_ms: now,
      ...(this.rel.lastIn(att.host) !== undefined ? { last_event_seq: this.rel.lastIn(att.host) } : {}),
      lease: DEFAULT_LEASE_TIMING,
      host_token_expires_ms: prior.token_exp,
      // Read in the same step as the reset and `helloed`: the resend below starts here, and anything
      // issued later is pushed above it.
      next_command_seq: this.rel.firstToSend(att.host, hello.last_command_seq),
    });
    // The resend of what the host hasn't processed, queued on the outbound chain in this same step:
    // a command issued from here on goes out behind it, never ahead of a lower one.
    void this.flush(att.host);
    // A new token on every connection: the frame isn't reliable, and losing it means a reconnect.
    await this.rotateToken(ws, att.host);
    this.keysSent.delete(att.host);
    await this.sendBindingKeys(ws, prior.cell, att.host);
    await this.reconcileSandboxes(att.host, hello.sandboxes);
    // The hello's capacity counts the sandboxes it reports: marked after their first states.
    this.sql.exec("UPDATE hosts SET capacity_seq = ? WHERE host = ?", this.mark(), att.host);
    if (orphans?.gone) {
      await this.dropUnreported(att.host, orphans.gone, new Set(orphans.cmds));
      this.sql.exec("UPDATE kv SET value = ? WHERE key = ?", JSON.stringify({ cmds: orphans.cmds } satisfies Orphans), orphansKey(att.host));
    }
    if (orphans) {
      await this.failPendingCommands(att.host, "host process restarted before running this command", reported, orphans.cmds);
    }
    // A previous-release host (no brain epochs) is drained of brains on sight, before its agents are
    // reconciled, and retired once empty; it never receives a brain (`issueCommands` refuses one).
    if (!hello.brain_epochs) await this.drainBrains(att.host, "a previous-release nestd");
    await this.reconcileAgents(att.host, hello.agents);
    // A brain host of this release is (back) up: agents waiting for room try it now.
    if (prior.role === BRAIN_ROLE && hello.brain_epochs) this.pokeBrainWaitersLater();
    // A host whose leases we expired came back: it must fence them before we reassign (STONITH by fence).
    await this.ensureStonithFence(att.host);
    await this.armTick();
  }

  /**
   * A restarted nestd's leases it doesn't report died with the old process: suspended ones are
   * evicted, others placed again from head. A lease since moved or expired is left alone. Idempotent.
   */
  private async dropUnreported(host: string, unreported: Orphans["gone"] & {}, cmds: Set<string>): Promise<void> {
    const gone = this.leasesOf(host).filter((l) => !l.expired && unreported.some((u) => u.sandbox === l.sandbox && u.epoch === l.epoch));
    if (!gone.length) return;
    // Their unanswered commands died with it: closed without retries (placed again under a new epoch).
    const lost = new Set(gone.map((l) => l.sandbox));
    const unanswered = this.sql.exec<{ cmd: string; sandbox: string | null }>("SELECT cmd, sandbox FROM commands WHERE host = ? AND result IS NULL", host).toArray();
    for (const c of unanswered) {
      if (!cmds.has(c.cmd) || c.sandbox === null || !lost.has(c.sandbox)) continue;
      this.answerByFleet("cmd = ?", [c.cmd], "sandbox lost with the old host process", false);
    }
    console.warn(`FleetDO: ${host} restarted without ${gone.map((l) => l.sandbox).join(", ")}`);
    await this.evict(host, gone.filter((l) => l.state === "suspended").map((l) => l.sandbox));
    await this.queueReassign(host, gone.filter((l) => l.state !== "suspended").map((l) => l.sandbox), false);
  }

  /**
   * Fence what we don't honor, and destroy it there once it is stale and salvaged; take the reported
   * state of what we do (e.g. after a nestd restart).
   */
  private async reconcileSandboxes(host: string, sandboxes: SandboxReport[]): Promise<void> {
    const fence: string[] = [];
    const fenced: SandboxReport[] = [];
    for (const s of sandboxes) {
      const lease = this.lease(s.sandbox);
      const honored = lease && lease.host === host && lease.epoch === s.epoch && !lease.expired;
      if (!honored) {
        if (s.state !== "fenced" && s.state !== "destroyed") fence.push(s.sandbox);
        if (s.state !== "destroyed") this.recordStale(s.sandbox, host, s.epoch, !s.dirty);
        continue;
      }
      this.recordState(host, s.sandbox, s.epoch, s.state, s.guest);
      try {
        await this.sandbox(s.sandbox).reportState(host, s.epoch, s.state, "reported in hello", s.guest ?? null);
      } catch (e) {
        console.error(`FleetDO: reconciling ${s.sandbox} failed`, e);
      }
      if (s.state === "fenced") fenced.push(s);
    }
    if (fence.length) this.issueCommands(host, [{ type: "fence", sandboxes: fence, reason: "reconcile" }]);
    for (const s of fenced) await this.holderFenced(host, s.sandbox, s.epoch, !s.dirty);
    this.reapStale();
  }

  /**
   * A lease holder's report: the lease's state (and guest, with `running`), and the mark of its
   * first one (placement reserves until a capacity report after it).
   */
  private recordState(host: string, sandbox: string, epoch: number, state: string, guest?: GuestInfo): void {
    this.sql.exec("UPDATE leases SET state = ?, state_seq = COALESCE(state_seq, ?), guest = COALESCE(?, guest) WHERE sandbox = ? AND host = ? AND epoch = ?",
      state, this.mark(), state === "running" && guest ? JSON.stringify(guest) : null, sandbox, host, epoch);
  }

  /**
   * The holder fenced the sandbox itself (nestd self-fences when its host lease lapses): the VM is
   * paused for good, so the sandbox is placed again (on any host, this one included) from its head,
   * and the fenced incarnation is destroyed once its salvage is done.
   */
  private async holderFenced(host: string, sandbox: string, epoch: number, clean: boolean): Promise<void> {
    console.warn(`FleetDO: ${host} reports ${sandbox}@${epoch} fenced; placing it again`);
    this.recordStale(sandbox, host, epoch, clean);
    await this.queueReassign(host, [sandbox], false);
  }

  /** A strictly increasing number: orders capacity reports against leases' first states. */
  private mark(): number {
    const row = this.sql.exec<{ value: string }>(
      "INSERT INTO kv (key, value) VALUES ('mark', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value").toArray()[0];
    return Number(row!.value);
  }

  /**
   * Remember an incarnation `host` has (or had) at `epoch` that its lease may no longer cover;
   * `clean` once the host reports nothing uncommitted (salvage done, or never dirty).
   */
  private recordStale(sandbox: string, host: string, epoch: number, clean: boolean): void {
    this.sql.exec(
      `INSERT INTO stale_incarnations (sandbox, host, epoch, first_seen_ms, clean) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sandbox, host, epoch) DO UPDATE SET clean = MAX(clean, excluded.clean)`,
      sandbox, host, epoch, Date.now(), clean ? 1 : 0);
  }

  /**
   * Destroy each stale incarnation once clean or past its salvage window: one `sandbox_destroy` at its
   * old epoch, never repeated. One superseded by a newer epoch on the same host is dropped (nestd
   * salvages and replaces it when it creates the new one).
   */
  private reapStale(): void {
    const now = Date.now();
    const rows = this.sql.exec<{ sandbox: string; host: string; epoch: number; first_seen_ms: number; clean: number }>(
      "SELECT sandbox, host, epoch, first_seen_ms, clean FROM stale_incarnations WHERE cmd IS NULL").toArray();
    for (const r of rows) {
      const lease = this.lease(r.sandbox);
      const h = this.host(r.host);
      const drop = () => this.sql.exec("DELETE FROM stale_incarnations WHERE sandbox = ? AND host = ? AND epoch = ?", r.sandbox, r.host, r.epoch);
      if (lease && lease.host === r.host && lease.epoch === r.epoch) continue; // still its own (or STONITH pending)
      if (!h || h.status === "dead" || (lease && (lease.epoch < r.epoch || lease.host === r.host))) {
        drop();
        continue;
      }
      if (!r.clean && now - r.first_seen_ms < SALVAGE_WINDOW_MS) continue;
      const [cmd] = this.issueCommands(r.host, [{ type: "sandbox_destroy", sandbox: r.sandbox, epoch: r.epoch }]);
      this.sql.exec("UPDATE stale_incarnations SET cmd = ? WHERE sandbox = ? AND host = ? AND epoch = ?", cmd!, r.sandbox, r.host, r.epoch);
      console.log(`FleetDO: destroying the stale ${r.sandbox}@${r.epoch} on ${r.host}`);
    }
  }

  /**
   * The brain index: one row per (agent, host) an `agent_start` went to, with its agent epoch, until
   * that brain's exit at or above it is reported there or the host is given up on (fleet design doc).
   */
  private createHostAgents(): void {
    const create = "CREATE TABLE IF NOT EXISTS host_agents (agent TEXT NOT NULL, host TEXT NOT NULL, cmd TEXT NOT NULL, epoch INTEGER, PRIMARY KEY (agent, host))";
    const cols = this.sql.exec<{ name: string; pk: number }>("PRAGMA table_info(host_agents)").toArray();
    if (cols.length === 0 || cols.find((c) => c.name === "host")?.pk !== 0) {
      this.sql.exec(create);
      addColumn(this.sql, "host_agents", "epoch", "INTEGER");
      this.addHostAgentsColumns();
      return;
    }
    // Keyed by `agent` (written before 2026-10-26): rekeyed once (the recorded exception to expand-only).
    rekeyHostAgents(this.sql, this.ctx.storage, create);
    this.addHostAgentsColumns();
  }

  /**
   * `gone`: the host's hello no longer reports the agent; its exit is owed to AgentDO (retried by the
   * tick until acknowledged, then the row goes).
   */
  private addHostAgentsColumns(): void {
    addColumn(this.sql, "host_agents", "gone", "INTEGER NOT NULL DEFAULT 0");
    // Whether its agent took the host's drain (`onHostDraining`); retried by the tick until it did.
    addColumn(this.sql, "host_agents", "drain_told", "INTEGER NOT NULL DEFAULT 0");
  }

  /** An epoch-less exit (previous-release nestd) stands for the row's: one start per host is outstanding. */
  private exitEpoch(agent: string, host: string): number | undefined {
    const r = this.sql.exec<{ epoch: number | null }>("SELECT epoch FROM host_agents WHERE agent = ? AND host = ?", agent, host).toArray()[0];
    return r?.epoch ?? undefined;
  }

  /** A brain on `host` exited at agent epoch `epoch` (unknown: the row is the previous release's): its row goes unless a newer start replaced it. */
  private brainGone(agent: string, host: string, epoch: number | undefined): void {
    if (epoch === undefined) {
      this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ? AND epoch IS NULL", agent, host);
    } else {
      this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ? AND (epoch IS NULL OR epoch <= ?)", agent, host, epoch);
    }
    // A slot may have freed: an agent waiting for room tries now rather than at its backoff.
    this.pokeBrainWaitersLater();
  }

  /** Owed exits of brains a host's hello no longer reports: told to AgentDO, the row going only once it took it. */
  private async goneExits(host: string): Promise<void> {
    for (const k of this.sql.exec<{ agent: string; epoch: number | null; cmd: string }>("SELECT agent, epoch, cmd FROM host_agents WHERE host = ? AND gone = 1", host).toArray()) {
      try {
        await this.agentStub(k.agent).onExited(host, "host_lost", k.epoch ?? undefined);
        // Only the row that notice was for (A5).
        this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ? AND gone = 1 AND cmd = ?", k.agent, host, k.cmd);
        this.pokeBrainWaitersLater();
      } catch (e) {
        console.error(`FleetDO: marking ${k.agent} exited on ${host} failed; will retry`, e);
      }
    }
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
      .exec<{ agent: string; c_cmd: string | null; result: string | null; epoch: number | null }>(
        `SELECT h.agent, c.cmd AS c_cmd, c.result, h.epoch FROM host_agents h LEFT JOIN commands c ON c.cmd = h.cmd WHERE h.host = ?`, host)
      .toArray();
    for (const k of known) {
      if (reported.has(k.agent)) continue;
      // Only once its agent_start completed (or the command aged out); a pending start isn't running yet.
      if (k.c_cmd !== null && k.result === null) continue;
      this.sql.exec("UPDATE host_agents SET gone = 1 WHERE agent = ? AND host = ?", k.agent, host);
    }
    // Told until acknowledged (the tick retries), and only then forgotten.
    await this.goneExits(host);
  }

  private async onHeartbeat(ws: WebSocket, host: string, sentMs: number, claims: LeaseClaim[]): Promise<void> {
    const now = Date.now();
    // Wedged: no renewal and no liveness, so the host's lease lapses (it kills its brains at 20 s)
    // and this object expires it at 30 s like a silent host.
    if (this.sql.exec("SELECT 1 FROM hosts WHERE host = ? AND wedged_ms IS NOT NULL", host).toArray().length) return;
    // Only a live host's lease is renewed: one this object holds expired or dead gets no ack.
    if (this.sql.exec(`UPDATE hosts SET last_rx = ? WHERE host = ? AND status IN (${sqlIn(LIVE_STATUSES)})`, now, host).rowsWritten === 0) return;
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
    await this.armTick();
  }

  /**
   * Strictly in order: the next batch is processed and acked; a duplicate is re-acked; a gap or a
   * failure closes the connection so the host reconnects and resends from `last_event_seq`.
   */
  private async onEvents(ws: WebSocket, host: string, seq: number, events: HostEvent[]): Promise<void> {
    // Checked here, not at arrival: a hello queued ahead may have superseded this socket and reset
    // the lineage, and this batch would become the new lineage's baseline. Dropped unacked.
    if (this.socketFor(host) !== ws) return;
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
      case "incarnation_retired":
        // Its disk is deleted: clean, so its destroy needn't wait out the salvage window.
        this.recordStale(ev.sandbox, host, ev.epoch, true);
        this.reapStale();
        return;
      case "sandbox_state":
        // Only the lease holder's reports reach SandboxDO; a stale incarnation's `fenced` is noted
        // for cleanup on that host.
        if (!this.holds(host, ev.sandbox, ev.epoch)) {
          if (ev.state === "fenced") {
            this.recordStale(ev.sandbox, host, ev.epoch, false);
            this.reapStale();
          }
          return;
        }
        this.recordState(host, ev.sandbox, ev.epoch, ev.state, ev.guest);
        await this.sandbox(ev.sandbox).reportState(host, ev.epoch, ev.state, ev.detail ?? null, ev.guest ?? null);
        if (ev.state === "fenced") await this.holderFenced(host, ev.sandbox, ev.epoch, false);
        // A draining host's sandboxes leave as soon as they're safely suspended.
        else if (ev.state === "suspended" && this.host(host)?.status === "draining") await this.evict(host, [ev.sandbox]);
        return;
      case "commit_request":
        return this.onCommitRequest(host, ev);
      case "workstream": {
        // A sandbox event (the tag is historical): about a sandbox this host holds, and logged. Owners
        // hear of them once agent events reach them as webhooks (docs/README.md#principles).
        const e = ev.event;
        if (!this.holds(host, e.sandbox, e.epoch)) {
          console.warn(`FleetDO: dropping ${e.type} from ${host}: not the lease holder of ${e.sandbox ?? "(no sandbox)"}`);
          return;
        }
        const what = e.type === "port_opened" ? `port ${e.port}` : e.type === "egress_denied" ? `${e.host}:${e.port}` : `${e.host} (${e.reason}${e.binding ? `, ${e.binding}` : ""})`;
        (e.type === "egress_alert" ? console.warn : console.log)(`FleetDO: ${e.sandbox}@${e.epoch} ${e.type} ${what}${e.agent ? ` by ${e.agent}` : ""}`);
        return;
      }
      case "egress_audit": {
        const body = ev.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        await this.env.BUCKET.put(`audit/${host}/${ev.ts_ms}-${newId("")}.jsonl`, body);
        return;
      }
      case "capacity":
        this.sql.exec("UPDATE hosts SET capacity = ?, capacity_seq = ? WHERE host = ?", JSON.stringify(ev.capacity), this.mark(), host);
        return;
      case "tunnel_state":
        this.setTunnelState(host, ev.state, this.host(host));
        return;
      case "spot_notice":
        return this.drain(host, ev.deadline_ms);
      case "agent_exited": {
        // AgentDO is told first and the row moves on only after: a failed call fails the batch, and
        // its redelivery computes the same epoch.
        const epoch = ev.epoch ?? this.exitEpoch(ev.agent, host);
        // Without an epoch and without a row here, it names no start this index knows: ignored (N4).
        if (epoch === undefined && !this.sql.exec("SELECT 1 FROM host_agents WHERE agent = ? AND host = ?", ev.agent, host).toArray().length) return;
        await this.agentStub(ev.agent).onExited(host, ev.reason, epoch);
        this.brainGone(ev.agent, host, epoch);
        return;
      }
      case "guest_cli":
        if (!this.holds(host, ev.sandbox, ev.epoch)) {
          this.issueCommands(host, [{
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
    this.issueCommands(host, [{ type: "guest_cli_result", request: ev.request, result }]);
  }

  /**
   * Fail (retryably) the commands an old nestd process never answered (`cmds`, captured at its reset);
   * a `sandbox_create` the new process reports running anyway is completed instead.
   */
  private async failPendingCommands(host: string, message: string, reported: Map<string, SandboxReport>, cmds: string[]): Promise<void> {
    const only = new Set(cmds);
    const pending = this.sql
      .exec<{ cmd: string; type: string; sandbox: string | null; epoch: number | null }>(
        "SELECT cmd, type, sandbox, epoch FROM commands WHERE host = ? AND result IS NULL ORDER BY issued_ms", host)
      .toArray()
      .filter((c) => only.has(c.cmd));
    for (const c of pending) {
      const r = c.sandbox ? reported.get(c.sandbox) : undefined;
      const done = storedEnum(CommandTypeEnum, c.type, "commands.type") === "sandbox_create" && r && r.epoch === c.epoch;
      await this.onCommandResult(host, c.cmd, done ? { status: "ok" } : { status: "error", error: errorBody(ErrorCodes.INTERNAL, message, true) }, "fleet");
    }
    this.sql.exec("DELETE FROM kv WHERE key = ?", orphansKey(host));
  }

  /** Record a command's one result (`answeredBy`: null for the host's own, else who wrote it) and act on it. */
  private async onCommandResult(host: string, cmd: string, outcome: Extract<HostEvent, { type: "command_result" }>["outcome"], answeredBy: AnsweredBy | null = null) {
    const stored = this.sql
      .exec<{ type: string; sandbox: string | null; agent: string | null; epoch: number | null; purpose: string | null; body: string; result: string | null; host: string }>(
        "SELECT type, sandbox, agent, epoch, purpose, body, result, host FROM commands WHERE cmd = ?", cmd)
      .toArray()[0];
    if (!stored || stored.host !== host || stored.result !== null) return; // unknown, foreign, or a redelivered result
    const row = {
      ...stored,
      type: storedEnum(CommandTypeEnum, stored.type, "commands.type"),
      purpose: storedEnumOrNull(PurposeEnum, stored.purpose, "commands.purpose"),
    };
    this.sql.exec("UPDATE commands SET result = ?, result_ms = ?, answered_by = ? WHERE cmd = ?", JSON.stringify(outcome), Date.now(), answeredBy, cmd);

    if (row.purpose === "stonith_fence") {
      const body = JSON.parse(row.body) as Extract<CommandBody, { type: "fence" }>;
      if (outcome.status !== "ok") {
        await this.ensureStonithFence(host); // re-issue: leases stay expired until a fence succeeds
        return;
      }
      // The fenced incarnations stay on the host until their salvage is done; then they are destroyed.
      for (const s of body.sandboxes) {
        const lease = this.lease(s);
        if (lease && lease.host === host) this.recordStale(s, host, lease.epoch, false);
      }
      // Active again first, so the re-placement below may pick this (healthy) host.
      this.stonithDoneIfClear(host, new Set(body.sandboxes));
      await this.queueReassign(host, body.sandboxes, false);
      return;
    }
    // An `agent_stop`'s `ok` drops no index row: only the brain's exit, or its host's loss, does.
    if (row.type === "agent_attach" && row.sandbox && row.epoch !== null && row.agent) {
      await this.sandbox(row.sandbox).attachResult(host, row.epoch, row.agent, cmd, outcome);
    }
    // A checkpoint's result, ok or not, lands it in SandboxDO (keyed by this command), even one that
    // produced no new commit. A SandboxDO still on the previous code lacks the method for a few
    // minutes after a deploy: logged, and its in-flight record then times out on its own.
    if (row.type === "sandbox_checkpoint" && row.sandbox && row.epoch !== null) {
      try {
        await this.sandbox(row.sandbox).checkpointResult(host, row.epoch, cmd);
      } catch (e) {
        console.warn(`FleetDO: checkpoint result ${cmd} for ${row.sandbox} not delivered: ${e}`);
      }
    }
    if (outcome.status === "error") {
      if (row.sandbox && row.epoch !== null && row.type !== "sandbox_checkpoint") {
        await this.sandbox(row.sandbox).commandFailed(host, row.type, row.epoch, outcome.error);
      }
      if (row.agent && row.type === "agent_start") {
        // Its index row stays: the start's own exit (owed by nestd until older brains there have
        // gone) or the host's loss removes it. AgentDO condemns the brain, never releases it here.
        await this.agentStub(row.agent).startFailed(host, outcome.error, row.epoch ?? undefined);
      }
    }
  }

  private async onCommitRequest(host: string, ev: CommitRequestEvent): Promise<void> {
    const outcome = await this.sandbox(ev.sandbox).commit(host, ev);
    this.issueCommands(host, [{ type: "commit_result", request: ev.request, sandbox: ev.sandbox, outcome }]);
  }

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  /**
   * Queue commands for a host: persisted, delivered in order, each with exactly one result. Secrets
   * arrive as BrokerDO references, resolved only when sent. Synchronous: stored (with any index row)
   * in the caller's step; the send happens behind it, on the host's outbound chain.
   */
  issueCommands(host: string, bodies: CommandBody[], purpose: Purpose = null): string[] {
    const now = Date.now();
    // A start never goes to a host whose loss is (being) announced: expired, dead or unknown (A3),
    // nor to a host of the previous release (N23: closes the gap between AgentDO's pick and this send).
    const target = this.host(host);
    if (bodies.some((b) => b.type === "agent_start")) {
      const prev = target?.brain_epochs === 0;
      if (!target || target.status === "expired" || target.status === "dead" || prev) {
        throw new NestError(ErrorCodes.FORBIDDEN, `host ${host} is ${prev ? "of the previous release" : target?.status ?? "unknown"}: no agent_start goes there`, 409, true);
      }
      // A sandbox host never runs a brain (docs/compute/brain-hosts/).
      if (target.role !== BRAIN_ROLE) {
        throw new NestError(ErrorCodes.FORBIDDEN, `host ${host} is a ${target.role} host: brains run only on brain hosts`, 409, true);
      }
      // The cap is enforced where the index row is written, so concurrent picks of one host can't
      // overfill it. Nothing is stored for a refused start; AgentDO condemns it and keeps the intent.
      const max = this.maxBrainsOf(target, this.cellConfig()?.brain?.max_brains_per_host);
      for (const b of bodies) {
        if (b.type !== "agent_start") continue;
        const others = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM host_agents WHERE host = ? AND agent <> ?", host, b.agent).one().n;
        if (others >= max) {
          throw new NestError(ErrorCodes.CAPACITY_EXHAUSTED, `brain host ${host} is full (${others} of ${max} brains)`, 503, true);
        }
      }
    }
    const commands = bodies.map((body) => ({ cmd: newId("cmd_"), issued_ms: now, ...body }));
    // A command for a dead or unknown host is stored (an `issueKill` retry finds it) and answered at
    // once, without failure handling; never queued.
    const undeliverable = !target || target.status === "dead";
    for (const c of commands) {
      const sandbox = "sandbox" in c ? c.sandbox : c.type === "sandbox_fork" ? c.child : null;
      const epoch = "epoch" in c ? c.epoch : c.type === "sandbox_fork" ? c.child_epoch : null;
      const agent = "agent" in c ? c.agent : null;
      this.sql.exec(
        "INSERT INTO commands (cmd, host, type, sandbox, agent, epoch, purpose, body, issued_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        c.cmd, host, c.type, sandbox, agent, epoch, purpose, JSON.stringify(c), now,
      );
      if (undeliverable) {
        this.answerByFleet("cmd = ?", [c.cmd], `host ${host} is ${target ? "dead" : "unknown"}`, false);
        continue;
      }
      if (c.type === "agent_start") {
        this.sql.exec(`INSERT INTO host_agents (agent, host, cmd, epoch, gone, drain_told) VALUES (?, ?, ?, ?, 0, 0)
          ON CONFLICT(agent, host) DO UPDATE SET cmd = excluded.cmd, epoch = excluded.epoch, gone = 0, drain_told = 0`,
          c.agent, host, c.cmd, c.epoch ?? null);
      }
    }
    if (undeliverable) {
      console.warn(`FleetDO: ${commands.map((c) => c.type).join(", ")} for ${target ? "dead" : "unknown"} host ${host} answered with an error`);
      return commands.map((c) => c.cmd);
    }
    this.rel.push(host, (seq) => ({ type: "commands" as const, seq, commands }));
    // Durable now: the caller isn't held behind unrelated BrokerDO resolution.
    void this.flush(host);
    return commands.map((c) => c.cmd);
  }

  /** FleetDO's own error answer to every unanswered command matching `where`: never evidence the host ran it. */
  private answerByFleet(where: string, args: SqlStorageValue[], message: string, retryable: boolean): void {
    const answer = JSON.stringify({ status: "error", error: errorBody(ErrorCodes.INTERNAL, message, retryable) });
    this.sql.exec(`UPDATE commands SET result = ?, result_ms = ?, answered_by = ? WHERE (${where}) AND result IS NULL`,
      answer, Date.now(), "fleet" satisfies AnsweredBy, ...args);
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
   * Choose a host, record the lease and send `sandbox_create`; `null` when no capacity. Idempotent per
   * (sandbox, epoch). Refuses a sandbox leased at another epoch, and a destroyed one.
   */
  async place(req: PlaceRequest): Promise<string | null> {
    const existing = this.lease(req.sandbox);
    if (existing && existing.epoch === req.epoch && !existing.expired) return existing.host;
    if (existing) {
      throw new NestError(ErrorCodes.FORBIDDEN, `sandbox ${req.sandbox} already holds a lease (epoch ${existing.epoch} on ${existing.host})`, 409);
    }
    // SandboxDO's `destroy` marks it here before releasing the lease, so no lease outlives a destroy
    // (sandbox-lease B2). One missing from the registry would lose its data to GC: registered, loudly.
    const registered = this.sql.exec<{ destroyed_ms: number | null }>("SELECT destroyed_ms FROM sandboxes WHERE sandbox = ?", req.sandbox).toArray()[0];
    if (registered && registered.destroyed_ms !== null) throw new NestError(ErrorCodes.FORBIDDEN, `sandbox ${req.sandbox} is destroyed`, 409);
    if (!registered) {
      console.error(`FleetDO: placing ${req.sandbox}, which its SandboxDO never registered; registering it now`);
      this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) VALUES (?, ?)", req.sandbox, Date.now());
    }
    // Packing: `pickSandboxHost`, over the connected, active, unwedged sandbox hosts.
    const need = req.resources;
    const cfg = this.cellConfig();
    const hosts = this.hostsBy({ role: SANDBOX_ROLE, status: "active", where: "wedged_ms IS NULL" })
      .filter((h) => h.host !== req.excludeHost && this.socketFor(h.host))
      .map((h) => {
        const capacity = h.capacity ? (JSON.parse(h.capacity) as Capacity) : null;
        return { host: h.host, capacity, capacity_seq: h.capacity_seq, leases: this.leasesOf(h.host), warm: !!req.from && !!capacity?.warm.includes(req.from.id) };
      });
    const host = pickSandboxHost(hosts, need, {
      reserve_mib: cfg?.sandbox_reserve_mib ?? DEFAULT_SANDBOX_RESERVE_MIB, max_per_host: cfg?.max_sandboxes_per_host ?? 0,
    });
    if (!host) {
      // SandboxDO retries placement on its own alarm; by then the new host may have enrolled.
      await this.scaleUp();
      return null;
    }
    this.sql.exec("INSERT INTO leases (sandbox, host, epoch, expired, vcpus, memory_mib) VALUES (?, ?, ?, 0, ?, ?)",
      req.sandbox, host, req.epoch, need.vcpus, need.memory_mib);
    this.issueCommands(host, [{
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

  async leaseOf(sandbox: string): Promise<{ host: string; epoch: number; expired: boolean; state: SandboxState | null; guest: GuestInfo | null } | null> {
    const l = this.lease(sandbox);
    return l ? {
      host: l.host, epoch: l.epoch, expired: l.expired === 1, state: l.state,
      guest: l.guest ? (JSON.parse(l.guest) as GuestInfo) : null,
    } : null;
  }

  /**
   * The kill for `agent`'s brain at agent epoch `epoch` on `host`, issued once: a retry (AgentDO
   * issues it from an alarm until it has the id) gets the stored command back and sends nothing.
   */
  async issueKill(host: string, agent: string, epoch: number, reason: string): Promise<string> {
    const prior = this.sql.exec<{ cmd: string }>(
      `SELECT cmd FROM commands WHERE type = 'agent_stop' AND host = ? AND agent = ? AND epoch = ?
         AND json_extract(body, '$.mode') = 'kill' ORDER BY issued_ms LIMIT 1`, host, agent, epoch).toArray()[0];
    if (prior) return prior.cmd;
    const [cmd] = this.issueCommands(host, [{ type: "agent_stop", agent, reason, mode: "kill", epoch }]);
    return cmd!;
  }

  /**
   * Where a condemned brain's kill stands, for AgentDO's escalation: whether `host` processed it,
   * whether a start at or below `epoch` is still indexed there, and whether the host processes
   * commands at all (a result since the kill, or an older command still pending ahead of it).
   */
  async killProgress(cmd: string, agent: string, host: string, epoch: number): Promise<{ processed: boolean; indexed: boolean; host_processing: boolean }> {
    const row = this.sql.exec<{ result: string | null; issued_ms: number; answered_by: string | null }>(
      "SELECT result, issued_ms, answered_by FROM commands WHERE cmd = ?", cmd).toArray()[0];
    const since = row?.issued_ms ?? 0;
    // Only the host's own answers count: one FleetDO wrote (its host died, or was dead when the kill
    // was issued) says nothing about what ran there; such a brain waits for its host's `lost` (A6).
    const byHost = (by: string | null) => storedEnumOrNull(AnsweredByEnum, by, "commands.answered_by") !== "fleet";
    const host_processing = this.sql.exec(
      `SELECT 1 FROM commands WHERE host = ? AND cmd <> ? AND ((result IS NOT NULL AND result_ms >= ? AND answered_by IS NULL)
         OR (result IS NULL AND issued_ms < ?)) LIMIT 1`,
      host, cmd, since, since).toArray().length > 0;
    // A row without an epoch (the previous release's) proves nothing either way: not counted; the
    // host's next hello resolves it (a brain not reported is gone).
    const indexed = this.sql.exec("SELECT 1 FROM host_agents WHERE agent = ? AND host = ? AND epoch IS NOT NULL AND epoch <= ?", agent, host, epoch)
      .toArray().length > 0;
    return { processed: !row || (row.result !== null && byHost(row.answered_by)), indexed, host_processing };
  }

  /**
   * AgentDO's escalation gave up on a kill: the host is wedged. Its heartbeats and hellos go
   * unanswered, so 30 s later the tick sends it to STONITH (D5); its brains are handed back only once
   * its death is confirmed, never on its own watchdog's word. Every brain and sandbox on it moves.
   */
  async hostWedged(host: string, reason: string): Promise<void> {
    const h = this.host(host);
    if (!h || (h.status !== "active" && h.status !== "draining") || h.wedged_ms !== null) return;
    this.sql.exec("UPDATE hosts SET wedged_ms = ? WHERE host = ?", Date.now(), host);
    // Cut off at once: no socket (its hellos are refused), and no placement of anything on it.
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4408, "wedged");
    console.error(`FleetDO: ${host} is wedged (${reason}); no lease renewal until it is expired`);
    await this.armTick();
  }

  /** `lost`: its brains are proven gone (A6); `current`: its nestd keys brains by agent epoch. */
  async hostStatus(host: string): Promise<{
    status: HostStatus; connected: boolean; last_rx: number | null; lost: boolean; current: boolean; wedged: boolean; role: HostKind;
  } | null> {
    const h = this.host(host);
    if (!h) return null;
    return {
      status: h.status, connected: !!this.socketFor(host), last_rx: h.last_rx, lost: h.lost === 1, current: h.brain_epochs === 1,
      wedged: h.wedged_ms !== null, role: h.role,
    };
  }

  /**
   * Where a new brain goes (`pickBrainHost`). `null` when none can take it now: a brain host is
   * launched and AgentDO retries. A query, not a reservation (`issueCommands` enforces the cap).
   */
  async placeBrain(req: { prev?: string | null; avoid?: string | null; agent?: string }): Promise<string | null> {
    const facts = this.brainFacts();
    const pick = pickBrainHost(facts, req.prev, req.avoid);
    if (pick.host) {
      // Not idle any more: the idle sweep can't retire it while AgentDO is between this pick and
      // its send (the clock starts again, from zero, if the start never lands).
      this.sql.exec("UPDATE hosts SET idle_since = NULL WHERE host = ?", pick.host);
      if (req.agent) this.sql.exec("DELETE FROM brain_waiters WHERE agent = ?", req.agent);
      return pick.host;
    }
    if (req.agent) {
      // Waiting for room: poked when it appears, and the tick keeps launching while anyone waits.
      this.sql.exec("INSERT OR REPLACE INTO brain_waiters (agent, since_ms) VALUES (?, ?)", req.agent, Date.now());
      await this.armTick();
    }
    if (brainHostNeeded(facts, req.avoid)) await this.scaleUp(BRAIN_ROLE);
    return null;
  }

  /** `agent` no longer waits for a brain host (an operator stopped it). */
  async brainWaitEnded(agent: string): Promise<void> {
    this.sql.exec("DELETE FROM brain_waiters WHERE agent = ?", agent);
  }

  /** Every active brain host as brain placement sees it (`pickBrainHost`, `brainHostNeeded`). */
  private brainFacts(): BrainHostFacts[] {
    const configured = this.cellConfig()?.brain?.max_brains_per_host;
    return this.hostsBy({ role: BRAIN_ROLE, status: "active" }).map((h): BrainHostFacts => {
      const unwedged = h.wedged_ms === null;
      const connected = !!this.socketFor(h.host);
      return {
        host: h.host,
        healthy: connected && h.brain_epochs === 1 && unwedged,
        reconnecting: !connected && unwedged && (h.brain_epochs === 1 || h.last_rx === null),
        brains: this.brainsOn(h.host),
        max_brains: this.maxBrainsOf(h, configured),
      };
    });
  }

  /** Poke the waiting agents in the background (a slot freed, a brain host said hello). */
  private pokeBrainWaitersLater(): void {
    if (this.sql.exec("SELECT 1 FROM brain_waiters LIMIT 1").toArray().length) this.ctx.waitUntil(this.pokeBrainWaiters());
  }

  /** Run each waiting agent's kept intent now; a row goes once taken, unless the agent waited again since. */
  private async pokeBrainWaiters(): Promise<void> {
    const waiters = this.sql.exec<{ agent: string; since_ms: number }>("SELECT agent, since_ms FROM brain_waiters").toArray();
    await Promise.all(waiters.map(async (w) => {
      try {
        await this.agentStub(w.agent).pokeIntent();
        this.sql.exec("DELETE FROM brain_waiters WHERE agent = ? AND since_ms <= ?", w.agent, w.since_ms);
      } catch (e) {
        console.error(`FleetDO: poking ${w.agent} (waiting for a brain host) failed`, e);
      }
    }));
  }

  /** Brains indexed on `host` (started there, not yet proven exited). */
  private brainsOn(host: string): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM host_agents WHERE host = ?", host).one().n;
  }

  /** What a brain host may hold: the cell's setting, else from the vCPUs its last capacity report counted. */
  private maxBrainsOf(h: HostRow, configured: number | undefined): number {
    return maxBrains(configured, h.capacity ? (JSON.parse(h.capacity) as Capacity).vcpus_free : null);
  }

  /** A6: proven gone (see the `lost` column); a row never seen at all counts as gone. */
  private hostLost(host: string): boolean {
    const h = this.host(host);
    return !h || h.lost === 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Lease expiry, STONITH, token rotation
  // ---------------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    this.prune(Date.now());
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === ALARM_TICK) await this.tick();
      if (key === ALARM_PRUNE) {
        await this.deadlines.set(ALARM_PRUNE, Date.now() + PRUNE_DAILY_MS);
        await this.armLifetimes();
      }
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
    for (const { host } of this.hostsBy({ status: ["active", "draining"] })) {
      // Re-read after the previous host's awaits: one that said hello meanwhile is live again.
      const h = this.host(host);
      if (!h) continue;
      const verdict = expiryVerdict({ ...h, wedged: h.wedged_ms !== null }, this.leasesOf(host).some((l) => !l.expired), Date.now(), expiry);
      if (verdict === "expire_held") await this.expireHost(host);
      else if (verdict === "expire_silent") await this.expireSilent(host);
    }
    for (const h of this.hostsBy({ status: "stonith_pending" })) {
      await this.pollStonith(h);
    }
    for (const h of this.hostsBy({ status: LIVE_STATUSES })) {
      const ws = this.socketFor(h.host);
      // Batches no run is carrying (a run lost to a reset): idempotent, a run sends only what wasn't sent.
      if (ws && this.rel.hasPendingAfter(h.host, (ws.deserializeAttachment() as Attachment).sent)) void this.flush(h.host);
      if (ws) await this.ensureStonithFence(h.host);
      if (ws && h.token_exp - now < TOKEN_ROTATE_BEFORE_MS) await this.rotateToken(ws, h.host);
    }
    await this.processReassign();
    // Brains of a lost host whose agent wasn't told yet (its call failed), and owed exits of brains a
    // hello no longer reported.
    for (const h of this.sql.exec<{ host: string }>(LOST_WITH_BRAINS).toArray()) await this.brainsLost(h.host);
    for (const h of this.sql.exec<{ host: string }>("SELECT DISTINCT host FROM host_agents WHERE gone = 1").toArray()) await this.goneExits(h.host);
    for (const h of this.sql.exec<{ host: string }>(
      "SELECT DISTINCT a.host FROM host_agents a JOIN hosts h ON h.host = a.host WHERE h.status = ? AND a.drain_told = 0", "draining" satisfies HostStatus).toArray()) {
      await this.tellDraining(h.host);
    }
    this.reapStale();
    // Launches for waiting agents happen here too, so one after an enroll timeout needn't wait for a retry.
    this.sql.exec("DELETE FROM brain_waiters WHERE since_ms < ?", now - BRAIN_WAIT_TTL_MS);
    if (this.sql.exec("SELECT 1 FROM brain_waiters LIMIT 1").toArray().length && brainHostNeeded(this.brainFacts())) {
      await this.scaleUp(BRAIN_ROLE);
    }
    // A launch whose answer was lost is repeated until EC2 answers it, so its instance is recorded.
    for (const role of [SANDBOX_ROLE, BRAIN_ROLE]) if (this.launchIntent(role)) await this.scaleUp(role, false);
    await this.scaleDown(now);
    await this.confirmTerminations();
    const busy = this.hostsBy({ status: LIVE_STATUSES }).length
      || this.hostsBy({ status: "expired", where: "instance_id IS NOT NULL" }).length
      || this.sql.exec(LOST_WITH_BRAINS).toArray().length
      || this.sql.exec("SELECT 1 FROM host_agents WHERE gone = 1").toArray().length
      || this.sql.exec("SELECT 1 FROM reassignments").toArray().length
      || this.sql.exec("SELECT 1 FROM launched WHERE ended_ms IS NULL AND host IS NULL AND reason IS NULL").toArray().length
      || (this.ec2() && this.sql.exec("SELECT 1 FROM launched WHERE ended_ms IS NULL AND reason IS NOT NULL").toArray().length)
      || this.sql.exec("SELECT 1 FROM evictions").toArray().length
      || this.sql.exec("SELECT 1 FROM brain_waiters").toArray().length
      || this.sql.exec("SELECT 1 FROM stale_incarnations WHERE cmd IS NULL").toArray().length
      || this.sql.exec("SELECT 1 FROM kv WHERE key IN (?, ?)", launchKey(SANDBOX_ROLE), launchKey(BRAIN_ROLE)).toArray().length;
    if (busy) await this.armTick();
  }

  /**
   * Retention (docs/data/#retention): at most once per `PRUNE_INTERVAL_MS`, from any alarm, drop rows
   * of tables that would otherwise only grow, keeping any row something still depends on.
   */
  private prune(now: number): void {
    const last = Number(this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'pruned_ms'").toArray()[0]?.value ?? 0);
    if (now - last < PRUNE_INTERVAL_MS) return;
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('pruned_ms', ?)", String(now));
    // Housekeeping never stalls the alarm (the tick, the sweep) it runs from.
    try {
      this.pruneTables(now);
    } catch (e) {
      console.error("FleetDO: pruning failed; next pass in an hour", e);
    }
  }

  private pruneTables(now: number): void {
    // A kill FleetDO answered for a host whose death isn't proof yet stays: `killProgress` would
    // read a missing row as processed. It asks only about kills, so other FleetDO answers go.
    this.sql.exec(`DELETE FROM commands WHERE result IS NOT NULL AND result_ms < ?
      AND (answered_by IS NULL OR type <> 'agent_stop' OR host NOT IN (SELECT host FROM hosts WHERE lost = 0))`, now - COMMAND_RETENTION_MS);
    this.sql.exec("DELETE FROM stale_incarnations WHERE cmd IS NOT NULL AND first_seen_ms < ?", now - STALE_INCARNATION_RETENTION_MS);
    this.sql.exec("DELETE FROM enroll_tokens WHERE used_ms IS NOT NULL AND used_ms < ?", now - ENROLL_TOKEN_RETENTION_MS);
    const dead = this.hostsBy({
      status: "dead",
      where: `dead_ms < ? AND tunnel_id IS NULL AND dns_record_id IS NULL
        AND host NOT IN (SELECT host FROM leases) AND host NOT IN (SELECT host FROM stale_incarnations)
        AND host NOT IN (SELECT host FROM reassignments) AND host NOT IN (SELECT host FROM evictions)
        AND host NOT IN (SELECT host FROM host_agents) AND lost = 1`,
    }, now - DEAD_HOST_RETENTION_MS);
    for (const { host } of dead) {
      this.sql.exec("DELETE FROM hosts WHERE host = ?", host);
      this.sql.exec("DELETE FROM commands WHERE host = ?", host);
      // Its tunnel and record were deleted by id (the row's ids are null): nothing left to sweep.
      this.sql.exec("DELETE FROM tunnels_created WHERE host = ?", host);
      this.rel.forget(host);
      this.keysSent.delete(host);
    }
    // Only an instance EC2 confirmed gone: a record still names one that may run, or be terminated.
    this.sql.exec("DELETE FROM launched WHERE ended_ms < ?", now - LAUNCH_RETENTION_MS);
    this.sql.exec(
      `DELETE FROM gc_runs WHERE finished_ms IS NOT NULL AND finished_ms < ?
         AND run NOT IN (SELECT run FROM gc_runs ORDER BY marked_ms DESC LIMIT 1)
         AND run NOT IN (SELECT run FROM gc_runs WHERE ${GC_PROVEN} ORDER BY marked_ms DESC LIMIT 1)`,
      now - GC_RUN_RETENTION_MS, GC_MARK_VERSION);
    this.sql.exec("DELETE FROM sandboxes WHERE destroyed_ms < ?", now - DESTROYED_SANDBOX_RETENTION_MS);
    if (dead.length) console.log(`FleetDO: pruned ${dead.length} dead host(s)`);
  }

  /** Empty draining hosts without an instance already reported for an operator (in memory: reported again after a restart). */
  private readonly reportedEmpty = new Set<string>();

  /** Hosts that have the cell's binding keys since their last hello; in memory only, so a restart resends once. */
  private readonly keysSent = new Set<string>();

  /** The cell's binding verification keys, the only thing the host's gateway verifies bindings with. */
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
    const was = prior?.tunnel_state ?? "none";
    this.sql.exec("UPDATE hosts SET tunnel_state = ? WHERE host = ?", state, host);
    if (was === state) return;
    if (state === "none" && prior?.tunnel_hostname) {
      console.error(`FleetDO: ${host} has the tunnel ${prior.tunnel_hostname} but runs none (an old nestd, or no cloudflared on the host): its sandboxes are unreachable until it serves it`);
    } else {
      console.log(`FleetDO: ${host} tunnel ${was} → ${state}`);
    }
  }

  /**
   * Where clients reach `host`'s sandbox gateway (`HostGateway`): the name is FleetDO's, from
   * enrollment, but only the host knows whether its tunnel is served.
   */
  async hostGatewayUrl(host: string): Promise<HostGateway | null> {
    const h = this.host(host);
    // A dead host serves nothing; its sandboxes are being reassigned.
    if (!h || h.status === "dead") return null;
    if (h.tunnel_hostname) {
      if (h.tunnel_state === "connected") return { kind: "tunnel", url: `wss://${h.tunnel_hostname}` };
      if (h.tunnel_state === "connecting") return { kind: "connecting" };
      return { kind: "down", tunnel: h.tunnel_hostname };
    }
    return h.gateway_url ? { kind: "direct", url: h.gateway_url } : null;
  }

  private async rotateToken(ws: WebSocket, host: string): Promise<void> {
    const h = this.host(host);
    if (!h) return;
    const exp = Date.now() + num(this.env.HOST_TOKEN_TTL_MS, 3_600_000);
    const token = await issueHostToken(this.env.HOST_TOKEN_SECRET, { host, cell: h.cell, role: roleName(h.role), exp });
    this.sql.exec("UPDATE hosts SET token_exp = ? WHERE host = ?", exp, host);
    this.send(ws, { type: "host_token", token, expires_ms: exp });
  }

  private ec2(): Ec2 | null {
    if (this.ec2Override !== undefined) return this.ec2Override;
    const a = this.awsOrNull();
    return a?.credentials && a.region ? new AwsEc2(a.credentials.access_key_id, a.credentials.secret_access_key, a.region) : null;
  }

  /**
   * The cell's AWS access for EC2 and SSM, whose callers (STONITH, the autoscaler) treat "no AWS" as
   * waiting for an operator: an unusable `AWS_CELLS` entry is logged and counts as none rather than throwing.
   */
  private awsOrNull(): CellAws | null {
    try {
      return this.aws();
    } catch (e) {
      console.error(`FleetDO: AWS settings for cell ${this.cellName() ?? "(unknown)"} are unusable: ${(e as Error).message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Autoscaling (docs/compute/autoscaling/): launch on demand, retire idle hosts, scale to zero
  // ---------------------------------------------------------------------------------------------

  /** The cell this FleetDO serves: its own name (every FleetDO is `idFromName(cell)`). */
  private cellName(): string | null {
    return this.ctx.id.name ?? null;
  }

  private cellConfig(): AwsCellConfig | null {
    if (this.cellConfigOverride !== undefined) return this.cellConfigOverride;
    const cell = this.cellName();
    return cell ? awsCell(this.env.AWS_CELLS, cell) : null;
  }

  /** A host kind's autoscaler settings: the cell's entry for sandbox hosts, its `brain` section for brain hosts. */
  private scaleSettings(cfg: AwsCellConfig, role: HostKind): (ScaleSettings & { launch_template_id: string; idle_grace_ms: number }) | null {
    if (role === SANDBOX_ROLE) return cfg;
    return cfg.brain ? { ...cfg.brain, subnet_ids: cfg.subnet_ids } : null;
  }

  /**
   * No connected host of `role` could take the work: launch one from that kind's template, as
   * `scaleUpPlan` decides. Each RunInstances attempt is recorded (`kv launch:<kind>`) before it is
   * sent, and an unfinished one is repeated with the same client token before another is planned, so
   * one whose answer was lost is recorded, never launched twice
   * ([idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)). Only
   * demand (`onDemand`) plans a new launch; the tick only repeats.
   */
  private async scaleUp(role: HostKind = SANDBOX_ROLE, onDemand = true): Promise<void> {
    const cfg = this.cellConfig();
    const ec2 = this.ec2();
    const s = cfg ? this.scaleSettings(cfg, role) : null;
    if (!cfg || !s || !ec2 || this.launching.has(role)) return;
    const unfinished = this.launchIntent(role);
    if (unfinished && Date.now() - unfinished.at < cfg.enroll_timeout_ms) {
      await this.launchAttempt(ec2, cfg, s.launch_template_id, role, unfinished);
      return;
    }
    // Too old to repeat (its token may no longer be honoured): an instance it launched never enrolls.
    if (unfinished) this.endLaunchIntent(role, unfinished.token);
    if (!onDemand) return;
    const pending = this.sql.exec(`SELECT 1 FROM launched WHERE host IS NULL AND reason IS NULL AND role IN (${sqlIn([roleName(role), role])})`).toArray().length;
    // A brain host of the previous release (its hello lacked `brain_epochs`) never gets a brain and
    // is drained on sight: it isn't capacity, so it doesn't count toward the cap.
    const live = this.hostsBy({ role, status: ["active", "stonith_pending"] })
      .filter((h) => role !== BRAIN_ROLE || h.brain_epochs === 1 || h.last_rx === null).length;
    const now = Date.now();
    const plan = scaleUpPlan(s, live, pending, now);
    if (!plan.launch) return;
    const cell = this.cellName();
    for (const [i, a] of plan.launch.entries()) {
      const intent = { token: `${cell ?? "cell"}-${role}-${now}-${i}`, type: a.type, subnet: a.subnet, spot: a.spot, at: now };
      if ((await this.launchAttempt(ec2, cfg, s.launch_template_id, role, intent)) !== "capacity") return;
    }
  }

  /** One RunInstances attempt, recorded first; the record ends once it launched or EC2 had no room. */
  private async launchAttempt(
    ec2: Ec2, cfg: AwsCellConfig, template: string, role: HostKind, a: LaunchIntent,
  ): Promise<"launched" | "capacity" | "failed"> {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", launchKey(role), JSON.stringify(a));
    this.launching.add(role);
    try {
      const id = await ec2.launch({
        launchTemplateId: template, instanceType: a.type, subnetId: a.subnet, spot: a.spot, clientToken: a.token,
        // Brain hosts are burstable (IAM allows t3/t3a only): unlimited, so a host full of
        // brains is never held to its baseline. Sandbox hosts aren't, and EC2 refuses the field.
        ...(role === BRAIN_ROLE ? { cpuCredits: "unlimited" as const } : {}),
      });
      this.sql.exec(
        "INSERT OR IGNORE INTO launched (instance_id, launched_ms, role, region, cell) VALUES (?, ?, ?, ?, ?)",
        id, a.at, roleName(role), cfg.region, this.cellName(),
      );
      this.endLaunchIntent(role, a.token);
      console.log(`FleetDO: launched ${role} host ${id} (${a.type}, ${a.spot ? "spot" : "on-demand"}, ${a.subnet})`);
      await this.armTick();
      return "launched";
    } catch (e) {
      if (!(e instanceof CapacityError)) {
        console.error("FleetDO: launch failed; will repeat it", e);
        return "failed";
      }
      this.endLaunchIntent(role, a.token);
      console.warn(`FleetDO: no capacity for ${a.type} (${a.spot ? "spot" : "on-demand"}): ${e.message}`);
      return "capacity";
    } finally {
      this.launching.delete(role);
    }
  }

  private launchIntent(role: HostKind): LaunchIntent | null {
    const v = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", launchKey(role)).toArray()[0]?.value;
    return v === undefined ? null : (JSON.parse(v) as LaunchIntent);
  }

  /** Only the attempt's own record: a later attempt's stays. */
  private endLaunchIntent(role: HostKind, token: string): void {
    if (this.launchIntent(role)?.token === token) this.sql.exec("DELETE FROM kv WHERE key = ?", launchKey(role));
  }

  /**
   * Retire what the cell no longer needs: a launch that never enrolled or connected, a launched host
   * idle for its kind's grace (`idleStep`), a drained host. Each is dead before TerminateInstances.
   */
  private async scaleDown(now: number): Promise<void> {
    const cfg = this.cellConfig();
    if (!cfg) return;
    for (const r of this.sql.exec<{ instance_id: string }>(
      "SELECT instance_id FROM launched WHERE host IS NULL AND reason IS NULL AND launched_ms < ?",
      now - cfg.enroll_timeout_ms).toArray()) {
      this.sql.exec("UPDATE launched SET reason = ? WHERE instance_id = ?", "enroll_timeout" satisfies LaunchEndReason, r.instance_id);
      console.warn(`FleetDO: ${r.instance_id} never enrolled; terminating`);
    }
    // Enrolled but never said hello within the timeout: retired like a launch that never enrolls.
    for (const h of this.hostsBy({ status: "active", where: "last_rx IS NULL AND instance_id IS NOT NULL AND enrolled_ms < ?" }, now - cfg.enroll_timeout_ms)) {
      console.warn(`FleetDO: ${h.host} (${h.instance_id}) never connected; terminating`);
      await this.die(h.host, "enroll_timeout");
    }
    // An expired host (silent, holding no live lease; its brains were released) is retired like an
    // idle one if it doesn't come back within the grace. A kind the cell has no settings for (no
    // `brain` section) is never retired: its hosts were added by hand.
    for (const role of [SANDBOX_ROLE, BRAIN_ROLE]) {
      const grace = this.scaleSettings(cfg, role)?.idle_grace_ms;
      if (grace === undefined) continue;
      for (const { host } of this.hostsBy({ role, status: ["active", "expired"], where: "instance_id IS NOT NULL" })) {
        // Re-read after the previous host's awaits (N1).
        const h = this.hostsBy({ role, status: ["active", "expired"], where: "host = ? AND instance_id IS NOT NULL" }, host)[0];
        if (!h) continue;
        // Suspended sandboxes don't keep a host up; a brain does until its exit is reported (or its
        // host expired): declaring the host dead before would let it run twice.
        const busy = this.leasesOf(h.host).some((l) => l.state !== "suspended") || this.brainsOn(h.host) > 0;
        const step = idleStep(busy, h.idle_since, now, grace);
        if (step === "busy") {
          if (h.idle_since !== null) this.sql.exec("UPDATE hosts SET idle_since = NULL WHERE host = ?", h.host);
        } else if (step === "start") {
          this.sql.exec("UPDATE hosts SET idle_since = ? WHERE host = ?", now, h.host);
        } else if (step === "retire") {
          console.log(`FleetDO: retiring idle ${role} host ${h.host} (${h.instance_id})`);
          await this.die(h.host, "idle");
        }
      }
    }
    // A draining host of any kind goes once empty, rather than at its deadline: never with a lease,
    // an indexed brain (alive until its exit), or a stale incarnation not yet salvaged.
    for (const h of this.hostsBy({ status: "draining" })) {
      if (this.leasesOf(h.host).length) continue;
      if (this.sql.exec("SELECT 1 FROM host_agents WHERE host = ?", h.host).toArray().length) continue;
      if (this.sql.exec("SELECT 1 FROM stale_incarnations WHERE host = ? AND cmd IS NULL", h.host).toArray().length) continue;
      if (!h.instance_id) {
        // Enrolled with a token: waits for an operator's confirm-dead.
        if (!this.reportedEmpty.has(h.host)) {
          this.reportedEmpty.add(h.host);
          console.error(`FleetDO: draining ${h.host} is empty but has no instance to retire; confirm it dead`);
        }
        continue;
      }
      console.log(`FleetDO: drained ${h.host} (${h.instance_id})`);
      await this.die(h.host, "drained");
    }
    await this.processEvictions();
  }

  /** Terminate what was marked to end (`launched.reason`) until EC2 confirms it gone (`ended_ms`). */
  private async confirmTerminations(): Promise<void> {
    const ec2 = this.ec2();
    if (!ec2) return;
    for (const r of this.sql.exec<{ instance_id: string }>(
      "SELECT instance_id FROM launched WHERE reason IS NOT NULL AND ended_ms IS NULL").toArray()) {
      try {
        const state = await ec2.state(r.instance_id);
        if (isDead(state)) {
          this.sql.exec("UPDATE launched SET ended_ms = ? WHERE instance_id = ?", Date.now(), r.instance_id);
          // EC2 confirms a retired host's instance gone: now its death is proof (A6).
          this.sql.exec("UPDATE hosts SET lost = 1 WHERE instance_id = ? AND status = ?", r.instance_id, "dead" satisfies HostStatus);
        }
        // Shutting down: already terminating, polled again next tick.
        else if (state !== "shutting-down") await ec2.terminate(r.instance_id);
      } catch (e) {
        console.error(`FleetDO: terminating ${r.instance_id} failed; will retry`, e);
      }
    }
  }

  /** Forced drain (spot notice): suspended sandboxes leave now, the rest once suspended to the object store. */
  private async drain(host: string, deadlineMs: number): Promise<void> {
    this.move(host, "drain");
    console.warn(`FleetDO: ${host} draining (spot interruption at ${new Date(deadlineMs).toISOString()})`);
    const leases = this.leasesOf(host).filter((l) => !l.expired);
    await this.evict(host, leases.filter((l) => l.state === "suspended").map((l) => l.sandbox));
    const running = leases.filter((l) => l.state !== "suspended");
    if (running.length) {
      this.issueCommands(host, running.map((l) => ({ type: "sandbox_suspend" as const, sandbox: l.sandbox, epoch: l.epoch, mode: "disk_only" as const })));
    }
    // Its brains move now, in the background (the event batch isn't held for brain starts).
    this.ctx.waitUntil(this.tellDraining(host));
    await this.armTick();
  }

  /**
   * A previous-release host: no new placements (`draining`) and its brains condemned, its sandboxes
   * left as they are. Once: the drain is kept across an expiry and STONITH by fence (`drain_ms`).
   */
  private async drainBrains(host: string, why: string): Promise<void> {
    if (this.host(host)?.drain_ms !== null || !this.move(host, "drain")) return;
    console.warn(`FleetDO: ${host} draining of brains (${why})`);
    this.ctx.waitUntil(this.tellDraining(host));
    await this.armTick();
  }

  /** Tell each agent with a brain on draining `host` to move it; retried by the tick, marked per start (command id). */
  private async tellDraining(host: string): Promise<void> {
    const agents = this.sql.exec<{ agent: string; cmd: string }>("SELECT agent, cmd FROM host_agents WHERE host = ? AND drain_told = 0", host).toArray();
    await Promise.all(agents.map(async ({ agent, cmd }) => {
      try {
        await this.agentStub(agent).onHostDraining(host);
        this.sql.exec("UPDATE host_agents SET drain_told = 1 WHERE agent = ? AND host = ? AND cmd = ?", agent, host, cmd);
      } catch (e) {
        console.error(`FleetDO: moving ${agent} off draining ${host} failed; will retry`, e);
      }
    }));
  }

  /**
   * Take suspended sandboxes (head in the object store) off a host going away: lease dropped, SandboxDO
   * told until it answers. The host fences what it still has when its heartbeat's leases are revoked.
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
  private endInstance(instanceId: string, reason: LaunchEndReason, role: HostKind): void {
    this.sql.exec(
      `INSERT INTO launched (instance_id, launched_ms, role, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET reason = COALESCE(launched.reason, excluded.reason)`,
      instanceId, Date.now(), roleName(role), reason,
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
  // credentials, so a sandbox host runs it; FleetDO decides when, and supplies the roots.
  // -------------------------------------------------------------------------------------------

  /** A sandbox was destroyed: its generations stop being roots. */
  async sandboxDestroyed(sandbox: string): Promise<void> {
    this.sql.exec("INSERT INTO sandboxes (sandbox, registered_ms, destroyed_ms) VALUES (?, ?, ?) ON CONFLICT(sandbox) DO UPDATE SET destroyed_ms = excluded.destroyed_ms",
      sandbox, Date.now(), Date.now());
  }

  /** SandboxDO's `create`, before anything is written for the sandbox. A destroyed one stays destroyed. */
  async registerSandbox(sandbox: string, meta?: RegistryMeta): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) VALUES (?, ?)", sandbox, Date.now());
    if (meta) this.sql.exec("UPDATE sandboxes SET client = ?, labels = ? WHERE sandbox = ?", meta.client, meta.labels ? JSON.stringify(meta.labels) : null, sandbox);
  }

  /** Operator: register sandboxes created before the registry existed, so GC keeps their data. */
  async registerSandboxes(sandboxes: string[]): Promise<number> {
    for (const s of sandboxes) this.sql.exec("INSERT OR IGNORE INTO sandboxes (sandbox, registered_ms) VALUES (?, ?)", s, Date.now());
    return this.sql.exec("SELECT 1 FROM sandboxes WHERE destroyed_ms IS NULL").toArray().length;
  }

  /**
   * Sandboxes created before lifetimes have no `expiry` check armed, and a dormant one gets no call
   * that would arm it (nor does one whose check a rolled-back release dropped): each live registered
   * sandbox is asked (`ensureLifetime`, idempotent) once, then again every `LIFETIME_RECHECK_MS`, at
   * most `LIFETIME_BACKFILL_PER_RUN` a day, never-asked first. A failure is asked again the next day.
   */
  private async armLifetimes(): Promise<void> {
    const rows = this.sql.exec<{ sandbox: string }>(
      `SELECT sandbox FROM sandboxes WHERE destroyed_ms IS NULL AND (lifetime_ms IS NULL OR lifetime_ms < ?)
        ORDER BY lifetime_ms IS NOT NULL, lifetime_ms, registered_ms LIMIT ?`, Date.now() - LIFETIME_RECHECK_MS, LIFETIME_BACKFILL_PER_RUN).toArray();
    for (const { sandbox } of rows) {
      try {
        await this.sandbox(sandbox).ensureLifetime();
        this.sql.exec("UPDATE sandboxes SET lifetime_ms = ? WHERE sandbox = ?", Date.now(), sandbox);
      } catch (e) {
        console.warn(`FleetDO: arming ${sandbox}'s lifetime check failed; tried again tomorrow`, e);
      }
    }
  }

  /** Operator: make the next claim start a run now (it still follows the dry-run rule). */
  async gcRequest(): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('gc_requested', '1')");
  }

  /**
   * A sandbox host offers to run GC: due daily (or when requested), one run at a time, abandoned
   * after its 12 h window. Roots are snapshotted now. The first run of a marking version is dry.
   */
  async gcClaim(host: string): Promise<GcClaim | null> {
    const h = this.host(host);
    if (!h || h.role !== SANDBOX_ROLE || h.status !== "active") return null;
    const now = Date.now();
    this.sql.exec("UPDATE gc_runs SET finished_ms = ?, report = '{\"abandoned\":true}' WHERE finished_ms IS NULL AND marked_ms < ?", now, now - GC_WINDOW_MS);
    if (this.sql.exec("SELECT 1 FROM gc_runs WHERE finished_ms IS NULL").toArray().length) return null;
    const last = this.sql.exec<{ marked_ms: number }>("SELECT MAX(marked_ms) AS marked_ms FROM gc_runs").toArray()[0]?.marked_ms ?? 0;
    const requested = this.sql.exec("SELECT 1 FROM kv WHERE key = 'gc_requested'").toArray().length > 0;
    if (!requested && now - last < GC_INTERVAL_MS) return null;
    // Dry unless a completed (not abandoned) run of this marking version has already reported.
    // Since when generation retention is on (recorded at the first claim that sees it; cleared when it
    // isn't): runs marked before then prove nothing, so switching it on (again) makes the next run dry.
    if (retentionMode(this.env) === "on") this.sql.exec("INSERT OR IGNORE INTO kv (key, value) VALUES ('retention_on_ms', ?)", String(now));
    else this.sql.exec("DELETE FROM kv WHERE key = 'retention_on_ms'");
    const since = Number(this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'retention_on_ms'").toArray()[0]?.value ?? 0);
    const proven = this.sql.exec(`SELECT 1 FROM gc_runs WHERE ${GC_PROVEN} AND marked_ms >= ?`, GC_MARK_VERSION, since).toArray().length > 0;
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

  /** Operator view: hosts, launches, and every live sandbox (an unplaced one too). */
  async fleetView(): Promise<FleetView> {
    const hosts = this.hostsBy({}).map((h): HostView => ({
      host: h.host,
      role: h.role,
      instance_id: h.instance_id,
      status: h.status,
      idle_since: h.idle_since,
      enrolled_ms: h.enrolled_ms as number,
      last_rx: h.last_rx,
      tunnel_hostname: h.tunnel_hostname,
      tunnel_state: h.tunnel_state,
      capacity: this.storedCapacity(h),
      leases: this.leasesOf(h.host).length,
      connected: !!this.socketFor(h.host),
      sandboxes: this.leasesOf(h.host).sort((a, b) => (a.sandbox < b.sandbox ? -1 : 1)).map((l) => ({
        sandbox: l.sandbox, epoch: l.epoch, state: l.state, vcpus: l.vcpus, memory_mib: l.memory_mib,
      })),
      agents: this.sql.exec<{ agent: string }>("SELECT DISTINCT agent FROM host_agents WHERE host = ? ORDER BY agent", h.host).toArray().map((a) => a.agent),
      wedged_ms: h.wedged_ms,
      lost: h.lost === 1,
      brain_epochs: h.brain_epochs === 1,
      max_brains: h.role === BRAIN_ROLE ? this.maxBrainsOf(h, this.cellConfig()?.brain?.max_brains_per_host) : null,
    }));
    const launches = this.sql.exec<{ instance_id: string; launched_ms: number; host: string | null; reason: string | null; ended_ms: number | null }>(
      "SELECT instance_id, launched_ms, host, reason, ended_ms FROM launched ORDER BY launched_ms").toArray()
      .map((l): LaunchView => ({
        instance_id: l.instance_id, launched_ms: l.launched_ms, host: l.host,
        reason: storedEnumOrNull(LaunchEndReason, l.reason, "launched.reason"), ended_ms: l.ended_ms,
      }));
    return { hosts, launches, sandboxes: await this.liveSandboxes(), aws: this.awsView() };
  }

  /** A host's last capacity report as stored (validated when it arrived; checked again here). */
  private storedCapacity(h: HostRow): CapacityView | null {
    if (h.capacity === null) return null;
    const r = Capacity.safeParse(JSON.parse(h.capacity));
    if (r.success) return r.data;
    console.error(`FleetDO: stored capacity of ${h.host} does not parse: ${r.error.message}`);
    return null;
  }

  /**
   * Every live sandbox of the cell (registered, not destroyed) with its lease, and SandboxDO's own
   * state and image: the lease table cannot tell a suspended sandbox from an unplaced one.
   */
  private async liveSandboxes(): Promise<SandboxView[]> {
    const rows = this.sql.exec<{ sandbox: string; registered_ms: number; host: string | null; epoch: number | null; state: string | null }>(
      `SELECT s.sandbox, s.registered_ms, l.host, l.epoch, l.state FROM sandboxes s
        LEFT JOIN leases l ON l.sandbox = s.sandbox WHERE s.destroyed_ms IS NULL ORDER BY s.registered_ms`).toArray();
    return Promise.all(rows.map(async (r): Promise<SandboxView> => {
      const base = {
        sandbox: r.sandbox, registered_ms: r.registered_ms, host: r.host, epoch: r.epoch,
        lease_state: storedEnumOrNull(SandboxState, r.state, "leases.state"),
      };
      try {
        const info = await this.sandbox(r.sandbox).info();
        return { ...base, epoch: r.epoch ?? info.epoch, sandbox_state: info.state, image: info.image, info_error: false };
      } catch (e) {
        console.error(`FleetDO: reading ${r.sandbox} for the fleet view failed`, e);
        return { ...base, sandbox_state: null, image: null, info_error: true };
      }
    }));
  }

  /** An agent of this cell exists (and since when its end is done, if it is): AgentDO keeps this current. */
  async registerAgent(agent: string, ended_ms: number | null, meta?: RegistryMeta): Promise<void> {
    this.sql.exec(`INSERT INTO agent_registry (agent, registered_ms, ended_ms) VALUES (?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET ended_ms = excluded.ended_ms`, agent, Date.now(), ended_ms);
    if (meta) this.sql.exec("UPDATE agent_registry SET client = ?, labels = ? WHERE agent = ?", meta.client, meta.labels ? JSON.stringify(meta.labels) : null, agent);
  }

  /**
   * A page of this cell's agents or sandboxes from its registries, oldest first (`GET /v1/agents`,
   * `GET /v1/sandboxes` for the operator): filtered by labels (each must hold), client, and state
   * (`live`: not ended or destroyed). The registries are indexes of the records, kept by each object.
   */
  async listRegistry(kind: "agent" | "sandbox", q: RegistryQuery = {}): Promise<{ items: RegistryRow[]; next_cursor: string | null }> {
    const t = kind === "agent"
      ? { table: "agent_registry", id: "agent", ended: "ended_ms" }
      : { table: "sandboxes", id: "sandbox", ended: "destroyed_ms" };
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const where: string[] = [];
    const args: (string | number)[] = [];
    const state = q.state ?? "live";
    if (state === "live") where.push(`${t.ended} IS NULL`);
    else if (state === "ended") where.push(`${t.ended} IS NOT NULL`);
    if (q.client) {
      where.push("client = ?");
      args.push(q.client);
    }
    if (q.cursor) {
      const m = /^(\d+):(.+)$/.exec(q.cursor);
      if (!m) throw new NestError(ErrorCodes.INVALID_MESSAGE, "bad cursor");
      where.push(`(registered_ms > ? OR (registered_ms = ? AND ${t.id} > ?))`);
      args.push(Number(m[1]), Number(m[1]), m[2]!);
    }
    const lw = labelWhere("labels", q.labels ?? []);
    where.push(lw.sql);
    args.push(...lw.args);
    const rows = this.sql.exec<{ id: string; registered_ms: number; ended: number | null; client: string | null; labels: string | null }>(
      `SELECT ${t.id} AS id, registered_ms, ${t.ended} AS ended, client, labels FROM ${t.table} WHERE ${where.join(" AND ")}
        ORDER BY registered_ms, ${t.id} LIMIT ?`, ...args, limit + 1).toArray();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id, client: r.client, labels: r.labels ? JSON.parse(r.labels) as Labels : {},
        created_ms: r.registered_ms, ended_ms: r.ended,
      })),
      next_cursor: rows.length > limit && last ? `${last.registered_ms}:${last.id}` : null,
    };
  }

  /** Its records are pruned: no longer an agent of this cell. */
  async unregisterAgent(agent: string): Promise<void> {
    this.sql.exec("DELETE FROM agent_registry WHERE agent = ?", agent);
  }

  /**
   * Operator view (docs/control-plane/dashboard/#abandoned), paged: first the sandbox registry's live
   * sandboxes (after `cursor`, in registration order), each read from SandboxDO with its generation
   * counts and classified by the agents attached to it; then the agent registry's agents whose end
   * isn't done, each read from AgentDO, so every agent is read and counted once, whatever it holds
   * (ended ones are counted from the registry). A sandbox page lists an attached agent only once its
   * records are gone (the registry no longer has it). Classified by lib/abandoned.ts, the in-use and
   * the recent counted, the rest listed. Reads are bounded: `limit` rows a page, `LIFETIMES_MAX_AGENTS`
   * attached agents a sandbox page, `LIFETIMES_CONCURRENCY` at a time; one that can't be read is a row
   * with its error.
   */
  async lifetimes(q: { cursor?: string; limit?: number; quiet_ms?: number } = {}): Promise<LifetimesView> {
    const now = Date.now();
    const cell = this.cellName() ?? "";
    const quietMs = q.quiet_ms ?? DEFAULT_QUIET_MS;
    const limit = Math.max(1, Math.min(LIFETIMES_MAX_PAGE, q.limit ?? LIFETIMES_PAGE));
    const after = q.cursor ? parseCursor(q.cursor) : null;
    if (q.cursor && !after) throw new NestError(ErrorCodes.INVALID_MESSAGE, `bad cursor ${q.cursor}`, 400);
    const counts = {
      sandboxes: Object.fromEntries(SANDBOX_LIFETIME_KINDS.map((k) => [k, 0])) as Record<SandboxLifetimeKind, number>,
      agents: Object.fromEntries(AGENT_LIFETIME_KINDS.map((k) => [k, 0])) as Record<AgentLifetimeKind, number>,
    };
    const base = { cell, now_ms: now, quiet_ms: quietMs, cell_idle_ttl_ms: cellIdleTtlMs(this.env, cell), counts };
    const readAgent = async (agent: string): Promise<AgentRead> => {
      try {
        return { facts: await this.agentStub(agent).lifetimeFacts() };
      } catch (e) {
        if (asNestError(e)?.code === ErrorCodes.UNKNOWN_AGENT) return { gone: true };
        console.error(`FleetDO: reading ${agent} for the lifetimes view failed`, e);
        return { error: String(e) };
      }
    };
    const agentView = (agent: string, r: AgentRead, kind: AgentLifetimeKind, found_via: LifetimeAgentView["found_via"]): LifetimeAgentView => {
      const f = "facts" in r ? r.facts : null;
      return {
        agent, kind, template: f?.template ?? null, owner: f?.owner ?? null, sandbox: f?.sandbox ?? null, last_turn_ms: f?.last_turn_ms ?? null,
        stopped_by_operator: f?.stopped_by_operator ?? false, live_children: f?.live_children ?? [],
        ended_ms: f?.ended?.ms ?? null, ended_reason: f?.ended?.reason ?? null, found_via, error: "error" in r ? r.error : null,
      };
    };

    if (after?.phase === "agents") {
      const rows = this.sql.exec<{ agent: string; registered_ms: number }>(
        `SELECT agent, registered_ms FROM agent_registry WHERE ended_ms IS NULL AND (registered_ms > ? OR (registered_ms = ? AND agent > ?))
          ORDER BY registered_ms, agent LIMIT ?`, after.registered_ms, after.registered_ms, after.agent, limit + 1).toArray();
      const page = rows.slice(0, limit);
      // Ended agents (their end done) hold nothing and go at their prune: counted, never read.
      if (after.registered_ms < 0) {
        counts.agents.ended += this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_registry WHERE ended_ms IS NOT NULL").one().n;
      }
      const read = await mapBounded(page, LIFETIMES_CONCURRENCY, (r) => readAgent(r.agent));
      const agents: LifetimeAgentView[] = [];
      page.forEach((row, i) => {
        const r = read[i]!;
        const kind = classifyAgent(r, now, quietMs);
        counts.agents[kind]++;
        // Pruned, yet still registered (its reap's unregister failed): the row goes now.
        if (kind === "gone") this.sql.exec("DELETE FROM agent_registry WHERE agent = ?", row.agent);
        if (kind === "quiet" || kind === "ending" || kind === "unreadable") agents.push(agentView(row.agent, r, kind, "registry"));
      });
      return {
        ...base, sandboxes: [], agents, agents_omitted: 0,
        next_cursor: rows.length > limit ? agentCursorOf(page[page.length - 1]!) : null,
      };
    }

    const rows = this.sql.exec<{ sandbox: string; registered_ms: number }>(
      `SELECT sandbox, registered_ms FROM sandboxes WHERE destroyed_ms IS NULL AND (registered_ms > ? OR (registered_ms = ? AND sandbox > ?))
        ORDER BY registered_ms, sandbox LIMIT ?`, after?.registered_ms ?? -1, after?.registered_ms ?? -1, after?.sandbox ?? "", limit + 1).toArray();
    const page = rows.slice(0, limit);
    const read = await mapBounded(page, LIFETIMES_CONCURRENCY, async (r) => {
      try {
        const stub = this.sandbox(r.sandbox);
        const [info, gens] = await Promise.all([stub.info(), stub.generations()]);
        return { ...r, info, gens: gens.length, mem: gens.filter((g) => g.record.mem_manifest).length };
      } catch (e) {
        console.error(`FleetDO: reading ${r.sandbox} for the lifetimes view failed`, e);
        return { ...r, error: String(e) };
      }
    });

    // The agents attached to them, read to classify each sandbox (and listed only once gone: the agent pages have the rest).
    const attached = [...new Set(read.flatMap((r) => ("info" in r ? r.info.attached : [])))];
    const batch = attached.slice(0, LIFETIMES_MAX_AGENTS);
    const got = await mapBounded(batch, LIFETIMES_CONCURRENCY, readAgent);
    const kindOf = new Map(batch.map((a, i) => [a, classifyAgent(got[i]!, now, quietMs)]));
    const agentViews: LifetimeAgentView[] = [];
    batch.forEach((agent, i) => {
      if (kindOf.get(agent) !== "gone") return;
      counts.agents.gone++;
      agentViews.push(agentView(agent, got[i]!, "gone", "sandbox"));
    });
    const sandboxes: LifetimeSandboxView[] = [];
    for (const r of read) {
      if (!("info" in r)) {
        counts.sandboxes.unreadable++;
        sandboxes.push({
          sandbox: r.sandbox, kind: "unreadable", registered_ms: r.registered_ms, state: null, host: null, owner: null, attached: [],
          idle_ttl_ms: null, own_ttl: false, dormant_since_ms: null, expiry_notice_ms: null, destroy_at_ms: null, generations: null,
          memory_generations: null, error: r.error,
        });
        continue;
      }
      const i = r.info;
      const c = classifySandbox(i, (a) => kindOf.get(a), now, cellIdleTtlMs(this.env, i.cell));
      counts.sandboxes[c.kind]++;
      if (c.kind === "in_use") continue;
      sandboxes.push({
        sandbox: r.sandbox, kind: c.kind, registered_ms: r.registered_ms, state: i.state, host: i.host, owner: i.owner ?? null, attached: i.attached,
        idle_ttl_ms: c.ttl, own_ttl: i.idle_ttl_ms !== undefined, dormant_since_ms: i.dormant_since_ms ?? null,
        expiry_notice_ms: i.expiry_notice_ms ?? null, destroy_at_ms: c.destroy_at, generations: r.gens, memory_generations: r.mem, error: null,
      });
    }
    const agentsLeft = this.sql.exec("SELECT 1 FROM agent_registry LIMIT 1").toArray().length > 0;
    return {
      ...base, sandboxes, agents: agentViews, agents_omitted: attached.length - batch.length,
      next_cursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : agentsLeft ? AGENTS_CURSOR : null,
    };
  }

  /** Operator view: the cell's region and which of its AWS settings it has, never their values. */
  private awsView(): AwsView {
    const cell = this.cellName();
    try {
      const a = this.aws();
      return {
        cell, region: a.region, credentials: a.credentials !== null, kms_key: a.kmsKey !== null,
        ...(a.credentialsError ? { error: a.credentialsError } : {}),
      };
    } catch (e) {
      return { cell, error: (e as Error).message };
    }
  }

  /** Operator view: the cell's host AMIs and the one the launch template resolves to. */
  async images(): Promise<ImagesView> {
    const ec2 = this.ec2();
    const cell = this.cellName();
    const ssm = this.ssm();
    const current = ssm && cell ? await ssm.parameter(`/imagebuilder/nest-${cell}/host-ami`) : null;
    // Sandbox templates (guest images): today the release carries one, `nest-base`, and every host
    // installs it (deploy/host/install.sh); a sandbox names it by `image`. Counted by live sandbox.
    const live = await this.liveSandboxes();
    const inUse = (name: string) => live.filter((s) => s.image === name).length;
    const templates: TemplateView[] = [{ name: DEFAULT_IMAGE, default: true, source: "release (nest-base.ext4.zst)", in_use: inUse(DEFAULT_IMAGE) }];
    for (const name of new Set(live.map((s) => s.image).filter((n): n is string => !!n && n !== DEFAULT_IMAGE))) {
      templates.push({ name, default: false, source: "unknown to hosts", in_use: inUse(name) });
    }
    return { current: current?.value ?? null, current_since_ms: current?.modified_ms ?? null, images: ec2 ? await ec2.images() : [], templates };
  }

  private ssm(): Ssm | null {
    if (this.ssmOverride !== undefined) return this.ssmOverride;
    const a = this.awsOrNull();
    return a?.credentials && a.region ? new AwsSsm(a.credentials.access_key_id, a.credentials.secret_access_key, a.region) : null;
  }

  /** CP-side lease expiry: no sandbox on this host may run anywhere else until STONITH is confirmed. */
  private async expireHost(host: string): Promise<void> {
    if (!this.move(host, "expire_held")) return;
    this.sql.exec("UPDATE leases SET expired = 1 WHERE host = ?", host);
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4408, "lease expired");
    this.failStarts(host);
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
    // Without an instance id or EC2, STONITH waits for a fence or an operator (`confirmHostDead`); a
    // wedged host never reconnects (its hellos are refused).
    else if (row.wedged_ms !== null) {
      console.error(`FleetDO: wedged ${host} has no STONITH (no instance id or EC2); its brains stay recorded until an operator confirms it dead`);
    }
  }

  /**
   * A silent host holding no live lease: nothing can run twice, so no STONITH. Its runner killed its
   * brains when its host lease lapsed (20 s, before this 30 s expiry), so they start again elsewhere.
   */
  private async expireSilent(host: string): Promise<void> {
    if (!this.move(host, "expire_silent")) return;
    for (const ws of this.ctx.getWebSockets(host)) ws.close(4408, "lease expired");
    this.failStarts(host);
    await this.brainsLost(host);
  }

  /**
   * A start never outlives its host's expiry (A3): its unanswered `agent_start`s fail now and are never
   * resent (`sendResolved`). Their index rows stay, so AgentDO hears the loss from `brainsLost`.
   */
  private failStarts(host: string): void {
    this.answerByFleet("host = ? AND type = ?", [host, "agent_start" satisfies CommandType], "host expired before running this start", true);
  }

  /**
   * Every brain on a host proven gone (A6) is handed back to AgentDO. A brain follows its own host's
   * fate, never its sandbox's.
   */
  private async brainsLost(host: string): Promise<void> {
    const agents = this.sql.exec<{ agent: string; epoch: number | null; cmd: string }>("SELECT agent, epoch, cmd FROM host_agents WHERE host = ?", host).toArray();
    for (const { agent, epoch, cmd } of agents) {
      // Only while proven gone; a host that came back reconciles its brains from its hello.
      if (!this.hostLost(host)) return;
      try {
        const taken = await this.agentStub(agent).onHostLost(host, epoch ?? undefined);
        // Forgotten only once the agent took it (A2; kept if it declined, N6), and only the row that
        // notice was for (A5): a newer start's row recorded meanwhile stays.
        if (taken) {
          this.sql.exec("DELETE FROM host_agents WHERE agent = ? AND host = ? AND cmd = ?", agent, host, cmd);
          this.pokeBrainWaitersLater();
        }
      } catch (e) {
        console.error(`FleetDO: telling ${agent} that ${host} is lost failed; will retry`, e);
      }
    }
  }

  /**
   * `host` is gone for good, for `cause` (`deathPlan`), synchronously: no connection, tunnel released,
   * unanswered commands closed without failure handling (index rows stay), instance marked to end.
   * What it returns moves its sandboxes and, on proof, its brains. A host already dead gets only those.
   */
  private die(host: string, cause: DeathCause): Promise<void> {
    const plan = deathPlan(cause);
    const h = this.host(host);
    if (!h) return Promise.resolve();
    if (this.move(host, "die")) {
      if (plan.end && h.instance_id) this.endInstance(h.instance_id, plan.end, h.role);
      for (const ws of this.ctx.getWebSockets(host)) ws.close(4410, cause);
      this.releaseTunnel(host, cause);
      this.answerByFleet("host = ?", [host], `host is dead (${cause})`, false);
      // Its lineage-reset capture, if any, is answered with the rest.
      this.sql.exec("DELETE FROM kv WHERE key = ?", orphansKey(host));
      this.rel.reset(host);
    }
    if (plan.proof) this.sql.exec("UPDATE hosts SET lost = 1 WHERE host = ?", host);
    const sandboxes = this.leasesOf(host).map((l) => l.sandbox);
    // Sandboxes first, then brains, as on every death.
    return (async () => {
      if (plan.leases === "reassign") await this.queueReassign(host, sandboxes, true);
      else await this.evict(host, sandboxes);
      if (plan.proof) await this.brainsLost(host);
    })();
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
      // `shutting-down` (its VMs may still run) or `unknown`: polled again next tick.
    } catch (e) {
      console.error("FleetDO: STONITH poll failed; will retry", e);
    }
  }

  /**
   * A reachable host with expired leases must fence them before they are reassigned. Re-issued on
   * every hello, every tick and after a failed fence until one succeeds.
   */
  private async ensureStonithFence(host: string): Promise<void> {
    // A lease already queued for reassignment needs no fence; a queued row of another lease of the
    // same sandbox (an older epoch, still retrying) doesn't cover this one (sandbox-lease O1).
    const queued = new Set(this.sql.exec<{ sandbox: string; epoch: number }>("SELECT sandbox, epoch FROM reassignments WHERE host = ?", host)
      .toArray().map((r) => `${r.sandbox}/${r.epoch}`));
    const expired = this.leasesOf(host).filter((l) => l.expired && !queued.has(`${l.sandbox}/${l.epoch}`)).map((l) => l.sandbox);
    if (!expired.length) {
      this.stonithDoneIfClear(host);
      return;
    }
    const covered = new Set<string>();
    for (const r of this.sql.exec<{ body: string }>(
      "SELECT body FROM commands WHERE host = ? AND purpose = ? AND result IS NULL", host, "stonith_fence" satisfies Purpose).toArray()) {
      for (const s of (JSON.parse(r.body) as { sandboxes: string[] }).sandboxes) covered.add(s);
    }
    const missing = expired.filter((s) => !covered.has(s));
    if (missing.length) this.issueCommands(host, [{ type: "fence", sandboxes: missing, reason: "lease expired" }], "stonith_fence");
  }

  /**
   * STONITH by fence is done once nothing on a reachable host is expired but what a successful fence
   * just covered (`fenced`). Never on a hello, so a host that dies before its fence result is still
   * polled; never for a wedged or terminating host (`hostStep`).
   */
  private stonithDoneIfClear(host: string, fenced = new Set<string>()): void {
    if (this.leasesOf(host).some((l) => l.expired && !fenced.has(l.sandbox)) || !this.socketFor(host)) return;
    this.move(host, "fence_done");
  }

  /** STONITH confirmed by EC2, or an operator's word (its instance is terminated if it still runs). */
  async confirmHostDead(host: string): Promise<void> {
    await this.die(host, "confirmed");
  }

  /** Queue leases for reassignment and work the queue; failures are retried from the alarm. */
  private async queueReassign(host: string, sandboxes: string[], hostDead: boolean): Promise<void> {
    for (const sandbox of sandboxes) {
      const lease = this.lease(sandbox);
      if (!lease || lease.host !== host) continue;
      this.sql.exec("INSERT OR IGNORE INTO reassignments (sandbox, host, epoch, host_dead) VALUES (?, ?, ?, ?)",
        sandbox, host, lease.epoch, hostDead ? 1 : 0);
    }
    await this.processReassign();
  }

  /** Idempotent per lost lease: drop it if it is still the sandbox's, then have SandboxDO grant a new one elsewhere. */
  private async processReassign(): Promise<void> {
    const rows = this.sql
      .exec<{ sandbox: string; host: string; epoch: number; host_dead: number }>("SELECT sandbox, host, epoch, host_dead FROM reassignments ORDER BY epoch")
      .toArray();
    for (const r of rows) {
      try {
        const lease = this.lease(r.sandbox);
        if (lease && lease.host === r.host && lease.epoch === r.epoch) this.sql.exec("DELETE FROM leases WHERE sandbox = ?", r.sandbox);
        await this.sandbox(r.sandbox).leaseLost(r.host, r.epoch, r.host_dead === 1);
        this.sql.exec("DELETE FROM reassignments WHERE sandbox = ? AND host = ? AND epoch = ?", r.sandbox, r.host, r.epoch);
      } catch (e) {
        this.sql.exec("UPDATE reassignments SET attempts = attempts + 1 WHERE sandbox = ? AND host = ? AND epoch = ?", r.sandbox, r.host, r.epoch);
        console.error(`FleetDO: reassigning ${r.sandbox} failed; will retry`, e);
      }
    }
    if (this.sql.exec("SELECT 1 FROM reassignments").toArray().length) await this.armTick();
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The tick runs within a heartbeat. An earlier one already set is kept, and a re-arm from inside a
   * running tick isn't swallowed by that tick's own row (`Deadlines.set`'s `keepEarlier`).
   */
  private armTick(): Promise<void> {
    return this.deadlines.set(ALARM_TICK, Date.now() + DEFAULT_LEASE_TIMING.heartbeat_ms, true);
  }

  private host(host: string): HostRow | undefined {
    const h = this.sql.exec<HostRow>("SELECT * FROM hosts WHERE host = ?", host).toArray()[0];
    return h && this.checkHost(h);
  }

  /** Host rows matching typed filters (and an optional extra SQL condition), their enums checked. */
  private hostsBy(
    f: { status?: HostStatus | readonly HostStatus[]; role?: HostKind; where?: string; order?: "role" | "enrolled_ms" }, ...args: SqlStorageValue[]
  ): HostRow[] {
    const conds: string[] = [];
    if (f.status !== undefined) conds.push(`status IN (${sqlIn(typeof f.status === "string" ? [f.status] : f.status)})`);
    // Either name of the kind (this release writes the previous release's; dev/deploy.md).
    if (f.role !== undefined) conds.push(`role IN (${sqlIn([roleName(f.role), f.role])})`);
    if (f.where) conds.push(f.where);
    return this.sql.exec<HostRow>(`SELECT * FROM hosts${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY ${f.order ?? "enrolled_ms"}`, ...args)
      .toArray().map((h) => this.checkHost(h));
  }

  private checkHost(h: HostRow): HostRow {
    return {
      ...h,
      role: hostKind(storedEnum(HostRole, h.role, "hosts.role")),
      status: storedEnum(HostStatus, h.status, "hosts.status"),
      tunnel_state: storedEnum(TunnelState, h.tunnel_state, "hosts.tunnel_state"),
    };
  }

  /**
   * Apply `t` to the host's row as it is now (`hostStep`), in one synchronous step, with what it writes
   * besides the status (`lost`, `drain_ms`, `dead_ms`). The new status, or null.
   */
  private move(host: string, t: HostTransition): HostStatus | null {
    const h = this.host(host);
    if (!h) return null;
    // FleetDO terminates the instance of every host it sends to STONITH when it can (`expireHost`).
    const terminating = t === "fence_done" && !!h.instance_id && !!this.ec2();
    const to = hostStep({ status: h.status, draining: h.drain_ms !== null, wedged: h.wedged_ms !== null, terminating }, t);
    if (to === null) return null;
    this.sql.exec("UPDATE hosts SET status = ? WHERE host = ?", to, host);
    if (t === "drain") this.sql.exec("UPDATE hosts SET drain_ms = COALESCE(drain_ms, ?) WHERE host = ?", Date.now(), host);
    if (t === "expire_silent" || t === "hello_back") this.sql.exec("UPDATE hosts SET lost = ? WHERE host = ?", t === "expire_silent" ? 1 : 0, host);
    if (t === "die") this.sql.exec("UPDATE hosts SET dead_ms = ?, wedged_ms = NULL WHERE host = ?", Date.now(), host);
    return to;
  }

  private lease(sandbox: string): LeaseRow | undefined {
    const l = this.sql.exec<LeaseRow>("SELECT * FROM leases WHERE sandbox = ?", sandbox).toArray()[0];
    return l && this.checkLease(l);
  }

  private leasesOf(host: string): LeaseRow[] {
    return this.sql.exec<LeaseRow>("SELECT * FROM leases WHERE host = ?", host).toArray().map((l) => this.checkLease(l));
  }

  private checkLease(l: LeaseRow): LeaseRow {
    return { ...l, state: storedEnumOrNull(SandboxState, l.state, "leases.state") };
  }

  private sandbox(id: string) {
    return this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id));
  }

  private agentStub(id: string) {
    return this.env.AGENT.get(this.env.AGENT.idFromName(id));
  }
}
