// BrokerDO: credential storage and hand-out (docs/control-plane/durable-objects/broker/). Values never
// leave the control plane except inside agent_start (Claude setup token) and secrets_update (proxy memory).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { NestError } from "../lib/util";
import { type AgentRole, ErrorCodes, type InjectionSecret } from "../protocol/model";

/** Mints short-lived GitHub App installation tokens per workstream. Not implemented yet. */
export interface GitHubAppMinter {
  installationToken(workstream: string, repos: string[]): Promise<{ token: string; expires_ms: number }>;
}

export class NotImplementedGitHubAppMinter implements GitHubAppMinter {
  async installationToken(): Promise<{ token: string; expires_ms: number }> {
    // TODO: sign an app JWT with the GitHub App private key (RS256) and call
    // POST /app/installations/{id}/access_tokens with the workstream's repositories.
    throw new NestError(ErrorCodes.NOT_IMPLEMENTED, "GitHub App token minting is not implemented", 501);
  }
}

export class BrokerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  github: GitHubAppMinter = new NotImplementedGitHubAppMinter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL,
      expires_ms INTEGER, updated_ms INTEGER NOT NULL)`);
  }

  async putSecret(name: string, value: string, expiresMs?: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO secrets (name, value, expires_ms, updated_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, expires_ms = excluded.expires_ms, updated_ms = excluded.updated_ms`,
      name, value, expiresMs ?? null, Date.now(),
    );
  }

  async deleteSecret(name: string): Promise<void> {
    this.sql.exec("DELETE FROM secrets WHERE name = ?", name);
  }

  async listSecretNames(): Promise<string[]> {
    return this.sql.exec<{ name: string }>("SELECT name FROM secrets ORDER BY name").toArray().map((r) => r.name);
  }

  private secret(name: string): { value: string; expires_ms: number | null } | undefined {
    const row = this.sql
      .exec<{ value: string; expires_ms: number | null }>("SELECT value, expires_ms FROM secrets WHERE name = ?", name)
      .toArray()[0];
    return row && (row.expires_ms === null || row.expires_ms > Date.now()) ? row : undefined;
  }

  /**
   * Reference to the `claude setup-token` OAuth token for a role: `claude_oauth_token:<role>`, falling
   * back to `claude_oauth_token`. Other objects store and pass the reference ({@link SECRET_REF_PREFIX});
   * FleetDO resolves it only when it sends `agent_start`, so no copy of the value is kept elsewhere.
   */
  async oauthTokenRef(role: AgentRole): Promise<string> {
    const name = this.secret(`claude_oauth_token:${role}`) ? `claude_oauth_token:${role}` : "claude_oauth_token";
    if (!this.secret(name)) throw new NestError(ErrorCodes.FORBIDDEN, `no Claude setup token configured for ${role}`, 409);
    return secretRef(name);
  }

  /**
   * Injection secrets for bindings, as references: `inject:<binding>:<workstream>`, else `inject:<binding>`.
   * The `value` of each entry is a reference that FleetDO resolves when it sends `secrets_update`.
   */
  async injectionSecretRefs(bindings: string[], workstream: string): Promise<InjectionSecret[]> {
    const out: InjectionSecret[] = [];
    for (const binding of bindings) {
      const name = this.secret(`inject:${binding}:${workstream}`) ? `inject:${binding}:${workstream}` : `inject:${binding}`;
      const s = this.secret(name);
      if (s) out.push({ binding, value: secretRef(name), ...(s.expires_ms !== null ? { expires_ms: s.expires_ms } : {}) });
    }
    return out;
  }

  /** Resolve references to current values; missing or expired secrets resolve to `null`. */
  async resolveRefs(refs: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const ref of refs) out[ref] = isSecretRef(ref) ? this.secret(ref.slice(SECRET_REF_PREFIX.length))?.value ?? null : null;
    return out;
  }
}

/** Placeholder for a BrokerDO secret inside stored or queued command bodies (never sent to hosts). */
export const SECRET_REF_PREFIX = "$nest-secret:";
export const secretRef = (name: string) => `${SECRET_REF_PREFIX}${name}`;
export const isSecretRef = (v: unknown): v is string => typeof v === "string" && v.startsWith(SECRET_REF_PREFIX);
