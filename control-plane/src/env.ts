import type { AgentDO } from "./do/agent";
import type { BrokerDO } from "./do/broker";
import type { FleetDO } from "./do/fleet";
import type { SandboxDO } from "./do/sandbox";
import type { WorkstreamDO } from "./do/workstream";

export interface Env {
  FLEET: DurableObjectNamespace<FleetDO>;
  SANDBOX: DurableObjectNamespace<SandboxDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  WORKSTREAM: DurableObjectNamespace<WorkstreamDO>;
  BROKER: DurableObjectNamespace<BrokerDO>;
  BUCKET: R2Bucket;

  /** Bearer token for the admin API (Cloudflare Access replaces this later). */
  ADMIN_TOKEN: string;
  /** HMAC key for host tokens and signed blob URLs. */
  HOST_TOKEN_SECRET: string;
  /** Root CA for nest-proxy intermediates: PEM certificate and PKCS#8 ECDSA P-256 key. */
  ROOT_CA_CERT_PEM?: string;
  ROOT_CA_KEY_PEM?: string;
  /** "1" lets FleetDO mint and persist a development root CA when none is configured. */
  ALLOW_DEV_CA?: string;
  /** AWS public certificate for the RSA-2048 instance identity signature (region-specific). */
  AWS_IDENTITY_CERT_PEM?: string;
  /** Scoped IAM user for STONITH (TerminateInstances / DescribeInstances on tagged instances). */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  /** Autoscaled cells: JSON object of cell → `AwsCellConfig` (`src/lib/cells.ts`). */
  AWS_CELLS?: string;

  PUBLIC_BASE_URL: string;
  PREVIEW_DOMAIN: string;
  ASK_SYNC_WINDOW_MS: string;
  HOST_TOKEN_TTL_MS: string;
  PROXY_CA_TTL_MS: string;
  /** Comma-separated list of valid cells; when set, others are refused (no stray FleetDOs). */
  CELLS?: string;
  /** A placed, running sandbox with no agent working is suspended after this long (default 11 min). */
  SANDBOX_SUSPEND_IDLE_MS?: string;
  /** Captain wake batching window. */
  WAKE_BATCH_MS?: string;
}

export const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
