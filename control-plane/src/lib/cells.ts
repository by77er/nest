// Everything AWS is per cell, keyed by the cell name (docs/compute/cells/):
// - `AWS_CELLS` (a var the cell stacks write to SSM): JSON object of cell → that cell's region,
//   launch template, subnets, autoscaler settings and proxy root CA key. A cell without an entry
//   has no autoscaling: its hosts are added by hand and never retired.
// - `AWS_CELL_CREDENTIALS` (a secret): JSON object of cell → the access key of that cell's
//   `nest-<cell>-control-plane` IAM user.
// A cell missing from either falls back, for one release, to the legacy globals (`AWS_ACCESS_KEY_ID`,
// `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ROOT_CA_KMS_KEY_ID`); `cellAws` says which source it used.
import { z } from "zod";
import type { Env } from "../env";

/** `arn:<partition>:kms:<region>:<account>:key/<id>`, capturing the region. */
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/(?:mrk-)?[0-9a-f-]+$/;

const AwsCell = z.object({
  region: z.string().min(1),
  launch_template_id: z.string().regex(/^lt-[0-9a-f]+$/),
  subnet_ids: z.array(z.string().regex(/^subnet-[0-9a-f]+$/)).min(1),
  /** In preference order; the first is also the on-demand fallback. */
  instance_types: z.array(z.string().min(1)).min(1),
  spot: z.boolean().default(true),
  max_hosts: z.number().int().positive().default(1),
  /** How long a burst host holding no sandbox and no agent stays before it's terminated. */
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

/** The cell's entry in `AWS_CELL_CREDENTIALS`, or `null` when it has none. Errors name fields, never values. */
export function cellCredentials(json: string | undefined, cell: string): AwsCredentials | null {
  if (!json) return null;
  const entry = keyed(json, "AWS_CELL_CREDENTIALS")[cell];
  if (entry === undefined) return null;
  const r = Credentials.safeParse(entry);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.flatMap((i) => ("keys" in i ? (i.keys as string[]) : [i.path.join(".") || "(entry)"])))];
    throw new Error(`AWS_CELL_CREDENTIALS.${cell} is malformed (${fields.join(", ")})`);
  }
  return r.data;
}

/** Where a cell's AWS setting came from: its own entry, the legacy global, or nowhere. */
export type AwsSource = "cell" | "legacy" | "none";

/** What FleetDO uses to reach AWS for one cell. */
export interface CellAws {
  region: string | null;
  credentials: AwsCredentials | null;
  /** The proxy root CA key: an ARN, or for the legacy global any id or alias KMS accepts. */
  kmsKeyId: string | null;
  /** Which source each setting came from, never the values: FleetDO's operator view shows it. */
  sources: { region: AwsSource; credentials: AwsSource; kms_key: AwsSource };
}

export type AwsEnv = Pick<Env, "AWS_CELL_CREDENTIALS" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "AWS_REGION" | "ROOT_CA_KMS_KEY_ID">;

/**
 * A cell's AWS access: its `AWS_CELLS` entry (`config`) and its `AWS_CELL_CREDENTIALS` entry first,
 * each setting falling back to its legacy global on its own. `cell` is `null` when FleetDO doesn't
 * know its cell yet, so only the legacy globals can apply.
 */
export function cellAws(env: AwsEnv, cell: string | null, config: AwsCellConfig | null): CellAws {
  const own = cell ? cellCredentials(env.AWS_CELL_CREDENTIALS, cell) : null;
  const legacy = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { access_key_id: env.AWS_ACCESS_KEY_ID, secret_access_key: env.AWS_SECRET_ACCESS_KEY }
    : null;
  const pick = <T>(mine: T | null | undefined, global: T | null | undefined): [T | null, AwsSource] =>
    mine ? [mine, "cell"] : global ? [global, "legacy"] : [null, "none"];
  const [region, regionSource] = pick(config?.region, env.AWS_REGION);
  const [credentials, credentialsSource] = pick(own, legacy);
  const [kmsKeyId, kmsSource] = pick(config?.proxy_root_key_arn, env.ROOT_CA_KMS_KEY_ID);
  return { region, credentials, kmsKeyId, sources: { region: regionSource, credentials: credentialsSource, kms_key: kmsSource } };
}
