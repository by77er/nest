// Everything AWS is per cell, keyed by the cell name (docs/compute/cells/):
// - `AWS_CELLS` (a var the cell stacks write to SSM): JSON object of cell → that cell's region,
//   sandbox-host launch template, subnets, autoscaler settings, proxy root CA key and brain-host
//   section (`brain`: its own template, instance types and cap). A cell without an entry
//   has no autoscaling: its hosts are added by hand and never retired.
// - `AWS_CELL_CREDENTIALS` (a secret): JSON object of cell → the access key of that cell's
//   `nest-<cell>-control-plane` IAM user.
// A cell missing from either falls back, for one release, to the legacy globals (`AWS_ACCESS_KEY_ID`,
// `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ROOT_CA_KMS_KEY_ID`); `cellAws` says which source it used.
import { z } from "zod";
import type { Env } from "../env";

/** `arn:<partition>:kms:<region>:<account>:key/<id>`, capturing the region. */
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/(?:mrk-)?[0-9a-f-]+$/;

/**
 * The cell's brain hosts (docs/compute/brain-hosts/): their own launch template, instance types and
 * cap; they launch into the cell's subnets. A cell without it launches no brain host (its brain
 * hosts, if any, are added by hand and never retired).
 */
const BrainHosts = z.object({
  launch_template_id: z.string().regex(/^lt-[0-9a-f]+$/),
  /** In preference order; the first is also the on-demand fallback. */
  instance_types: z.array(z.string().min(1)).min(1),
  spot: z.boolean().default(true),
  /** 3 two-vCPU hosts hold about 12 brains at the default capacity (the cell stack writes its own value). */
  max_hosts: z.number().int().positive().default(3),
  /** How long a brain host holding no brain stays before it's terminated. */
  idle_grace_ms: z.number().int().nonnegative().default(1_800_000),
  /** Brains per host; 0 derives it from the instance's size (`maxBrains` in lib/placement.ts). */
  max_brains_per_host: z.number().int().nonnegative().default(0),
});

const AwsCell = z.object({
  region: z.string().min(1),
  launch_template_id: z.string().regex(/^lt-[0-9a-f]+$/),
  subnet_ids: z.array(z.string().regex(/^subnet-[0-9a-f]+$/)).min(1),
  /** In preference order; the first is also the on-demand fallback. */
  instance_types: z.array(z.string().min(1)).min(1),
  spot: z.boolean().default(true),
  max_hosts: z.number().int().positive().default(1),
  /** How long a sandbox host holding no running sandbox stays before it's terminated. */
  idle_grace_ms: z.number().int().nonnegative().default(600_000),
  /** A launched instance that hasn't enrolled by then is terminated. */
  enroll_timeout_ms: z.number().int().positive().default(600_000),
  /**
   * What a sandbox on regular pages is expected to use (MiB), reserved against the host's reported
   * free memory until the host counts it; its declared size is a ceiling, not a cost.
   */
  sandbox_reserve_mib: z.number().int().positive().default(768),
  /** At most this many sandboxes per host on regular pages; 0 is no cap (memory decides). */
  max_sandboxes_per_host: z.number().int().nonnegative().default(0),
  /**
   * The cell's proxy root CA key (the stack's own KMS key), in the cell's region. Optional for one
   * release: an entry written before the stack carried it falls back to `ROOT_CA_KMS_KEY_ID`.
   */
  proxy_root_key_arn: z.string().regex(KMS_KEY_ARN).optional(),
  /** Optional for one release: an entry written before brain hosts has none. */
  brain: BrainHosts.optional(),
}).refine((c) => c.proxy_root_key_arn === undefined || KMS_KEY_ARN.exec(c.proxy_root_key_arn)?.[1] === c.region, {
  message: "proxy_root_key_arn must be a key in the cell's region",
  path: ["proxy_root_key_arn"],
});

export const DEFAULT_SANDBOX_RESERVE_MIB = 768;

export type AwsCellConfig = z.infer<typeof AwsCell>;

/**
 * A JSON object keyed by cell, parsed without echoing the input: `JSON.parse`'s message quotes the
 * text it failed on, and for the credentials secret that text is the secret.
 */
function keyed(json: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} must be a JSON object keyed by cell`);
  return v as Record<string, unknown>;
}

export function awsCell(json: string | undefined, cell: string): AwsCellConfig | null {
  if (!json) return null;
  const entry = keyed(json, "AWS_CELLS")[cell];
  return entry === undefined ? null : AwsCell.parse(entry);
}

const Credentials = z.object({
  access_key_id: z.string().regex(/^[A-Z0-9]{16,128}$/),
  secret_access_key: z.string().min(1),
}).strict();

export type AwsCredentials = z.infer<typeof Credentials>;

/** A cell name, as the Worker accepts one. */
const CELL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function credentialsEntry(entry: unknown, cell: string): AwsCredentials {
  const r = Credentials.safeParse(entry);
  if (r.success) return r.data;
  const fields = [...new Set(r.error.issues.flatMap((i) => ("keys" in i ? (i.keys as string[]) : [i.path.join(".") || "(entry)"])))];
  throw new Error(`AWS_CELL_CREDENTIALS.${cell} is malformed (${fields.join(", ")})`);
}

/** The cell's entry in `AWS_CELL_CREDENTIALS`, or `null` when it has none. Errors name fields, never values. */
export function cellCredentials(json: string | undefined, cell: string): AwsCredentials | null {
  if (!json) return null;
  const entry = keyed(json, "AWS_CELL_CREDENTIALS")[cell];
  return entry === undefined ? null : credentialsEntry(entry, cell);
}

/** The whole of `AWS_CELL_CREDENTIALS`, every entry checked (`dev/cell-credentials.sh` runs this before putting it). */
export function parseCellCredentials(json: string): Record<string, AwsCredentials> {
  const out: Record<string, AwsCredentials> = {};
  const all = keyed(json, "AWS_CELL_CREDENTIALS");
  if (!Object.keys(all).length) throw new Error("AWS_CELL_CREDENTIALS has no cells");
  for (const [cell, entry] of Object.entries(all)) {
    if (!CELL_NAME.test(cell)) throw new Error(`AWS_CELL_CREDENTIALS: "${cell}" is not a cell name`);
    out[cell] = credentialsEntry(entry, cell);
  }
  return out;
}

/** A setting and where it came from: the cell's own entry, the legacy global, or nowhere. */
export type Sourced<T> = { source: "cell" | "legacy"; value: T } | { source: "none" };
export type AwsSource = Sourced<unknown>["source"];

export const valueOf = <T>(s: Sourced<T>): T | null => (s.source === "none" ? null : s.value);

/** What FleetDO uses to reach AWS for one cell. */
export interface CellAws {
  region: Sourced<string>;
  credentials: Sourced<AwsCredentials>;
  /** The proxy root CA key: an ARN, or for the legacy global any id or alias KMS accepts. */
  kmsKey: Sourced<string>;
  /** Why the cell's own credentials were passed over (fields named, never values). */
  credentialsError?: string;
}

export type AwsEnv = Pick<Env, "AWS_CELL_CREDENTIALS" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "AWS_REGION" | "ROOT_CA_KMS_KEY_ID">;

function pick<T>(mine: T | null | undefined, global: T | null | undefined): Sourced<T> {
  if (mine) return { source: "cell", value: mine };
  if (global) return { source: "legacy", value: global };
  return { source: "none" };
}

/**
 * A cell's AWS access: its `AWS_CELLS` entry (`config`) and its `AWS_CELL_CREDENTIALS` entry first,
 * each setting falling back to its legacy global on its own. A malformed credentials entry falls back
 * too, with the error kept for the operator view. `cell` is `null` when FleetDO has no name, so only
 * the legacy globals can apply.
 */
export function cellAws(env: AwsEnv, cell: string | null, config: AwsCellConfig | null): CellAws {
  let own: AwsCredentials | null = null;
  let credentialsError: string | undefined;
  try {
    own = cell ? cellCredentials(env.AWS_CELL_CREDENTIALS, cell) : null;
  } catch (e) {
    credentialsError = (e as Error).message;
  }
  const legacy = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { access_key_id: env.AWS_ACCESS_KEY_ID, secret_access_key: env.AWS_SECRET_ACCESS_KEY }
    : null;
  return {
    region: pick(config?.region, env.AWS_REGION),
    credentials: pick(own, legacy),
    kmsKey: pick(config?.proxy_root_key_arn, env.ROOT_CA_KMS_KEY_ID),
    ...(credentialsError ? { credentialsError } : {}),
  };
}
