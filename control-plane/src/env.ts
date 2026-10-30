import type { AgentDO } from "./do/agent";
import type { BrokerDO } from "./do/broker";
import type { CatalogDO } from "./do/catalog";
import type { ChannelDO } from "./do/channel";
import type { FleetDO } from "./do/fleet";
import type { SandboxDO } from "./do/sandbox";
import type { WorkstreamDO } from "./do/workstream";

export interface Env {
  FLEET: DurableObjectNamespace<FleetDO>;
  SANDBOX: DurableObjectNamespace<SandboxDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  WORKSTREAM: DurableObjectNamespace<WorkstreamDO>;
  BROKER: DurableObjectNamespace<BrokerDO>;
  CATALOG: DurableObjectNamespace<CatalogDO>;
  CHANNEL: DurableObjectNamespace<ChannelDO>;
  BUCKET: R2Bucket;

  /** Bearer token for the admin API (Cloudflare Access replaces this later). */
  ADMIN_TOKEN: string;
  /** HMAC key for host tokens and signed blob URLs. */
  HOST_TOKEN_SECRET: string;
  /**
   * Root CA for nest-proxy intermediates, development form: PEM certificate and PKCS#8 ECDSA P-256
   * key. A cell with a KMS key uses that instead, and FleetDO keeps the cell's root certificate.
   * Legacy (one release): for a cell with a KMS key, a `ROOT_CA_CERT_PEM` for that key is
   * adopted as the cell's certificate rather than minting a new one; one for another key is refused.
   */
  ROOT_CA_CERT_PEM?: string;
  ROOT_CA_KEY_PEM?: string;
  /** Legacy (one release): the KMS key for cells whose `AWS_CELLS` entry carries no `proxy_root_key_arn`. */
  ROOT_CA_KMS_KEY_ID?: string;
  /** "1" lets FleetDO mint and persist a development root CA when none is configured. */
  ALLOW_DEV_CA?: string;
  /** AWS public certificate for the RSA-2048 instance identity signature (region-specific). */
  AWS_IDENTITY_CERT_PEM?: string;
  /** Per-cell AWS settings (a var from the cell stacks): JSON object of cell → `AwsCellConfig` (`src/lib/cells.ts`). */
  AWS_CELLS?: string;
  /** Per-cell AWS credentials (a secret): JSON object of cell → `{access_key_id, secret_access_key}` of `nest-<cell>-control-plane`. */
  AWS_CELL_CREDENTIALS?: string;
  /** Legacy (one release): the credentials and region for a cell missing from `AWS_CELL_CREDENTIALS` / `AWS_CELLS`. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;

  PUBLIC_BASE_URL: string;
  ASK_SYNC_WINDOW_MS: string;
  HOST_TOKEN_TTL_MS: string;
  PROXY_CA_TTL_MS: string;
  /** Comma-separated list of valid cells; when set, others are refused (no stray FleetDOs). */
  CELLS?: string;
  /** A placed, running sandbox with no agent working is suspended after this long (default 11 min). */
  SANDBOX_SUSPEND_IDLE_MS?: string;
  /** Batching window of the workstream channel's subscriber wakes. */
  WAKE_BATCH_MS?: string;
  /** The nest domain, `<label>.<zone>` (e.g. `nest.bitcru.sh`): sandbox hosts get `<host>-gw-<label>.<zone>`, previews `<port>-<sandbox>-preview-<label>.<zone>`, share links `<token>-share-<label>.<zone>`. Unset: no tunnels, and preview names use `nest.localhost`. */
  NEST_DOMAIN?: string;
  /** The Cloudflare account that holds the tunnels (a var) and a token with Account › Cloudflare One Connector: cloudflared › Edit and Zone › DNS › Edit (a secret). */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_TUNNEL_API_TOKEN?: string;
}

export const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
