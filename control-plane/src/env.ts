import type { AgentDO } from "./do/agent";
import type { BrokerDO } from "./do/broker";
import type { CatalogDO } from "./do/catalog";
import type { ChannelDO } from "./do/channel";
import type { FleetDO } from "./do/fleet";
import type { McpConnectorDO } from "./do/mcp-connector";
import type { SandboxDO } from "./do/sandbox";
import type { TaskLedgerDO } from "./do/tasks";
import type { WorkstreamDO } from "./do/workstream";

export interface Env {
  FLEET: DurableObjectNamespace<FleetDO>;
  SANDBOX: DurableObjectNamespace<SandboxDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  WORKSTREAM: DurableObjectNamespace<WorkstreamDO>;
  BROKER: DurableObjectNamespace<BrokerDO>;
  CATALOG: DurableObjectNamespace<CatalogDO>;
  CHANNEL: DurableObjectNamespace<ChannelDO>;
  /** Task ledgers, one per name (`ledger/<name>`). */
  TASKS: DurableObjectNamespace<TaskLedgerDO>;
  /** One per remote MCP server and credential (`connectorName`): the shared tool list and admission. */
  MCP_CONNECTOR: DurableObjectNamespace<McpConnectorDO>;
  BUCKET: R2Bucket;

  /** Bearer token for the admin API (Cloudflare Access replaces this later). */
  ADMIN_TOKEN: string;
  /** HMAC key for host tokens and signed blob URLs. */
  HOST_TOKEN_SECRET: string;
  /**
   * Root CA for nest-proxy intermediates, development form: PEM certificate and PKCS#8 ECDSA P-256
   * key. A cell with a KMS key uses that instead, and FleetDO keeps the cell's root certificate.
   */
  ROOT_CA_CERT_PEM?: string;
  ROOT_CA_KEY_PEM?: string;
  /** "1" lets FleetDO mint and persist a development root CA when none is configured. */
  ALLOW_DEV_CA?: string;
  /** AWS public certificate for the RSA-2048 instance identity signature (region-specific). */
  AWS_IDENTITY_CERT_PEM?: string;
  /** Per-cell AWS settings (a var from the cell stacks): JSON object of cell → `AwsCellConfig` (`src/lib/cells.ts`). */
  AWS_CELLS?: string;
  /** Per-cell AWS credentials (a secret): JSON object of cell → `{access_key_id, secret_access_key}` of `nest-<cell>-control-plane`. */
  AWS_CELL_CREDENTIALS?: string;

  PUBLIC_BASE_URL: string;
  ASK_SYNC_WINDOW_MS: string;
  HOST_TOKEN_TTL_MS: string;
  PROXY_CA_TTL_MS: string;
  /** Comma-separated list of valid cells; when set, others are refused (no stray FleetDOs). */
  CELLS?: string;
  /** A placed, running sandbox with no agent working is suspended after this long (default 11 min). */
  SANDBOX_SUSPEND_IDLE_MS?: string;
  /** A sandbox without its own idle TTL is destroyed after it was dormant this long (default 30 days; a cell's `sandbox_idle_ttl_ms` wins). */
  SANDBOX_IDLE_TTL_MS?: string;
  /** Batching window of the workstream channel's subscriber wakes. */
  WAKE_BATCH_MS?: string;
  /** The nest domain, `<label>.<zone>` (e.g. `nest.bitcru.sh`): sandbox hosts get `<host>-gw-<label>.<zone>`, previews `<port>-<sandbox>-preview-<label>.<zone>`, share links `<port>-<sandbox>-share-<label>.<zone>`. Unset: no tunnels, and preview names use `nest.localhost`. */
  NEST_DOMAIN?: string;
  /** The Cloudflare account that holds the tunnels (a var) and a token with Account › Cloudflare One Connector: cloudflared › Edit and Zone › DNS › Edit (a secret). */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_TUNNEL_API_TOKEN?: string;
  /** "1" lets an mcp capability name a loopback URL (http or https): tests and local development only (docs/agents/capabilities/mcp/). */
  ALLOW_LOOPBACK_MCP?: string;
  /** How long one forwarded MCP `tools/call` may take (default 45 s; below the runner's 150 s platform call timeout). */
  MCP_CALL_TIMEOUT_MS?: string;
  /** The budget of listing one MCP server's tools, initialize included (default 4 s; the runner waits 10 s for a tool list). */
  MCP_LIST_TIMEOUT_MS?: string;
  /** "1" lets a brokered http profile, and `GITHUB_API_URL`, name a loopback URL: tests and local development only. */
  ALLOW_LOOPBACK_BROKERED?: string;
  /** The GitHub REST API the App's actions use (default https://api.github.com); a local fake in the e2e harness. */
  GITHUB_API_URL?: string;
  /** How long one brokered request may take (default 30 s; below the runner's 150 s platform call timeout). */
  BROKERED_TIMEOUT_MS?: string;
  /** How long an MCP call waits for one of its server's call slots before `rate_limited` (default 10 s). */
  MCP_ADMIT_WAIT_MS?: string;
  /** While brains use an MCP server's list, its connector lists it again this often (default 60 s). */
  MCP_RELIST_MS?: string;
}

export const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
