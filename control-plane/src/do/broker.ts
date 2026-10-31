// BrokerDO: credential storage and hand-out (docs/control-plane/durable-objects/broker/). Values never
// leave the control plane except inside agent_start (Claude setup token) and secrets_update (proxy memory).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { generateBindingKey, importPrivateJwk, signBinding as signBindingToken } from "../lib/binding";
import { b64url, NestError } from "../lib/util";
import { Credential } from "../protocol/control";
import { BINDING_VERSION, type BindingClaims, type BindingKey } from "../protocol/gateway";
import { ErrorCodes, type InjectionSecret } from "../protocol/model";

/** The per-cell binding signing key, stored as a secret named `binding_key:<cell>`. */
type StoredBindingKey = { kid: string; public_key: string; private_jwk: JsonWebKey };

export class BrokerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Imported signing keys by kid (memory only; rebuilt from the stored JWK after an eviction). */
  private readonly bindingSigners = new Map<string, Promise<CryptoKey>>();

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.BROKER)) return;
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

  private secret(name: string): { value: string; expires_ms: number | null } | undefined {
    const row = this.sql
      .exec<{ value: string; expires_ms: number | null }>("SELECT value, expires_ms FROM secrets WHERE name = ?", name)
      .toArray()[0];
    return row && (row.expires_ms === null || row.expires_ms > Date.now()) ? row : undefined;
  }

  /**
   * Reference to the `claude setup-token` OAuth token an agent's spec names (`credential`):
   * `claude_oauth_token:<name>`, falling back to `claude_oauth_token` while the named one isn't
   * configured. Only those names: the value is sent to a brain host, so a credential naming any
   * other secret is refused. Other objects store and pass the reference ({@link SECRET_REF_PREFIX});
   * FleetDO resolves it only when it sends `agent_start`, so no copy of the value is kept elsewhere.
   */
  async credentialRef(credential: string): Promise<string> {
    if (!Credential.safeParse(credential).success) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${credential} is not a Claude setup token credential`, 403);
    }
    const name = this.secret(credential) ? credential : "claude_oauth_token";
    if (!this.secret(name)) throw new NestError(ErrorCodes.FORBIDDEN, `no Claude setup token configured for ${credential}`, 409);
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

  // --- binding keys (docs/interfaces/gateway/) --------------------------------------------------

  /**
   * The cell's binding signing key, generated on first use. The private JWK rests here and nowhere
   * else; hosts get only the public point (`bindingPublicKeys`), and SandboxDO gets signed tokens.
   */
  private async bindingKey(cell: string): Promise<StoredBindingKey> {
    const name = `binding_key:${cell}`;
    const row = this.secret(name);
    if (row) return JSON.parse(row.value) as StoredBindingKey;
    const pair = await generateBindingKey();
    // Another caller may have generated one across the await: the first stored key wins.
    const again = this.secret(name);
    if (again) return JSON.parse(again.value) as StoredBindingKey;
    const stored: StoredBindingKey = { kid: pair.kid, public_key: b64url(pair.publicKey), private_jwk: pair.privateJwk };
    await this.putSecret(name, JSON.stringify(stored));
    return stored;
  }

  /**
   * The Cloudflare Access service token in front of the gateways, stored under `access:gateway` as
   * the JSON `{"client_id", "client_secret"}` through the admin secrets route. `null` until it is.
   */
  async accessServiceToken(): Promise<{ client_id: string; client_secret: string } | null> {
    const s = this.secret("access:gateway");
    if (!s) return null;
    try {
      const v = JSON.parse(s.value) as { client_id?: unknown; client_secret?: unknown };
      if (typeof v.client_id === "string" && typeof v.client_secret === "string") return { client_id: v.client_id, client_secret: v.client_secret };
    } catch {
      // not JSON: reported below
    }
    console.error("BrokerDO: access:gateway is not {client_id, client_secret} JSON; targets carry no edge credential");
    return null;
  }

  /**
   * A capability's credential (`cap:<name>`, docs/agents/capabilities/mcp/), for the MCP client in
   * AgentDO, the only caller: it never goes into a host command (`cap:` is in {@link NEVER_RESOLVED}).
   * Null when none is stored.
   */
  async capabilityToken(ref: string): Promise<string | null> {
    if (!/^cap:./.test(ref)) throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a capability credential`, 403);
    return this.secret(ref)?.value ?? null;
  }

  /** Every key a gateway in `cell` must accept (one today; the list is what a rotation extends). */
  async bindingPublicKeys(cell: string): Promise<BindingKey[]> {
    const k = await this.bindingKey(cell);
    return [{ kid: k.kid, public_key: k.public_key }];
  }

  /** Sign a binding for `cell` with its current key; `v` and `kid` are filled in here. */
  async signBinding(cell: string, claims: Omit<BindingClaims, "v" | "kid">): Promise<string> {
    const k = await this.bindingKey(cell);
    let signer = this.bindingSigners.get(k.kid);
    if (!signer) {
      // A rejected import must not poison the cell: the next call imports again.
      signer = importPrivateJwk(k.private_jwk).catch((e: unknown) => {
        this.bindingSigners.delete(k.kid);
        throw e;
      });
      this.bindingSigners.set(k.kid, signer);
    }
    return signBindingToken(await signer, { v: BINDING_VERSION, kid: k.kid, ...claims });
  }

  /**
   * Resolve references to current values, for one purpose: only names `allow` admits (see
   * {@link nameAllowed}) and never a name in {@link NEVER_RESOLVED}. Anything else, and missing or
   * expired secrets, resolve to `null`.
   */
  async resolveRefs(refs: string[], allow: readonly string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const ref of refs) {
      const name = isSecretRef(ref) ? ref.slice(SECRET_REF_PREFIX.length) : null;
      if (name !== null && !nameAllowed(name, allow)) console.warn(`BrokerDO: refusing to resolve ${name} here`);
      out[ref] = name !== null && nameAllowed(name, allow) ? this.secret(name)?.value ?? null : null;
    }
    return out;
  }
}

/** Placeholder for a BrokerDO secret inside stored or queued command bodies (never sent to hosts). */
export const SECRET_REF_PREFIX = "$nest-secret:";
export const secretRef = (name: string) => `${SECRET_REF_PREFIX}${name}`;
export const isSecretRef = (v: unknown): v is string => typeof v === "string" && v.startsWith(SECRET_REF_PREFIX);

/**
 * Which secret names a reference may resolve to, by where it sits in a host command. Only these slots
 * are resolved (FleetDO), so a reference anywhere else (a prompt, say) goes out as its literal text.
 */
export const REF_PURPOSES = {
  /** `agent_start.oauth_token`: the Claude setup token (`claude_oauth_token`, `claude_oauth_token:<name>`). */
  agent_start: ["claude_oauth_token"],
  /** `secrets_update.secrets[].value`: injection secrets for nest-proxy. */
  secrets_update: ["inject:"],
} as const satisfies Record<string, readonly string[]>;

export type RefPurpose = keyof typeof REF_PURPOSES;
export interface RefSlot {
  purpose: RefPurpose;
  ref: string;
  set: (value: string) => void;
}

/** The secret-reference slots of one host command (mutated in place by `set`). */
export function commandRefSlots(cmd: Record<string, unknown>): RefSlot[] {
  const slots: RefSlot[] = [];
  if (cmd.type === "agent_start" && isSecretRef(cmd.oauth_token)) {
    slots.push({ purpose: "agent_start", ref: cmd.oauth_token, set: (v) => { cmd.oauth_token = v; } });
  } else if (cmd.type === "secrets_update" && Array.isArray(cmd.secrets)) {
    for (const s of cmd.secrets as { value?: unknown }[]) {
      if (isSecretRef(s.value)) slots.push({ purpose: "secrets_update", ref: s.value, set: (v) => { s.value = v; } });
    }
  }
  return slots;
}

/** Never resolvable into a command, whatever the purpose: they never leave the control plane. */
export const NEVER_RESOLVED = ["binding_key:", "access:", "cap:", "hook:"] as const;

/** An entry ending in `:` admits that prefix; any other admits the name itself and `<name>:…`. */
export function nameAllowed(name: string, allow: readonly string[]): boolean {
  if (NEVER_RESOLVED.some((p) => name.startsWith(p))) return false;
  return allow.some((p) => (p.endsWith(":") ? name.startsWith(p) && name.length > p.length : name === p || name.startsWith(`${p}:`)));
}
