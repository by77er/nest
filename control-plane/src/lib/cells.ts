// Per-cell AWS settings for the autoscaler (`AWS_CELLS`, a JSON object keyed by cell). A cell
// without an entry has no autoscaling: its hosts are added by hand and never retired.
import { z } from "zod";

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
});

export const DEFAULT_SANDBOX_RESERVE_MIB = 768;

export type AwsCellConfig = z.infer<typeof AwsCell>;

export function awsCell(json: string | undefined, cell: string): AwsCellConfig | null {
  if (!json) return null;
  const entry = (JSON.parse(json) as Record<string, unknown>)[cell];
  return entry === undefined ? null : AwsCell.parse(entry);
}
