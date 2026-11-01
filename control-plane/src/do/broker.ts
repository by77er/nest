// BrokerDO: credential storage and hand-out (docs/control-plane/durable-objects/broker/). Values never
// leave the control plane except inside agent_start (Claude setup token) and secrets_update (proxy memory).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { generateBindingKey, importPrivateJwk, signBinding as signBindingToken } from "../lib/binding";
import { type OAuthAudit, type OAuthStatus, OAuthStore, type StartAnswer, type StartInput } from "../lib/mcp-auth";
import { b64url, bytesToB64, NestError, newId } from "../lib/util";
import { appJwt, githubApiOf, importAppKey, parseAppSecret } from "../lib/github";
import type { GithubPermissions } from "../lib/brokered";
import { canonicalJson } from "../lib/sinks";
import { Credential } from "../protocol/control";
import { BINDING_VERSION, type BindingClaims, type BindingKey } from "../protocol/gateway";
import { ErrorCodes, type InjectionSecret } from "../protocol/model";

/** An installation token is reused while it has this long left (tokens last an hour: reused for 50 minutes). */
const GITHUB_TOKEN_REUSE_MS = 10 * 60_000;
/** A repo's installation id is looked up again after this long. */
const INSTALLATION_TTL_MS = 24 * 3_600_000;
/** Values shorter than this aren't scanned for (they'd match ordinary text). */
const SCAN_MIN_LENGTH = 8;

/** Who asked for a credential, for the issuance audit. */
export interface CredentialCaller {
  agent: string;
  /** The call key (`<agent>/<epoch>/<call>`). */
  call: string;
}

/** The per-cell binding signing key, stored as a secret named `binding_key:<cell>`. */
type StoredBindingKey = { kid: string; public_key: string; private_jwk: JsonWebKey };

export class BrokerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Imported signing keys by kid (memory only; rebuilt from the stored JWK after an eviction). */
  private readonly bindingSigners = new Map<string, Promise<CryptoKey>>();
  /** MCP servers' OAuth tokens (lib/mcp-auth.ts); its tables are read by nothing else. */
  private readonly oauth!: OAuthStore;

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
    // Minted GitHub installation tokens, by (repo, permissions): reused while they have 10 minutes left.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_tokens (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_ms INTEGER NOT NULL,
      installation INTEGER NOT NULL, minted_ms INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_installations (repo TEXT PRIMARY KEY, installation INTEGER NOT NULL, fetched_ms INTEGER NOT NULL)`);
    this.oauth = new OAuthStore({
      sql: this.sql,
      secret: (name) => this.secret(name)?.value ?? null,
      audit: (r) => this.audit(r),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      allowLoopback: env.ALLOW_LOOPBACK_MCP === "1",
    });
  }

  /**
   * One issuance audit record to R2 (`audit/broker/<day>/<ms>-<id>.json`, #issuance-audit): never a value.
   * Written in the background; a failed write is logged and doesn't fail what it records.
   */
  private audit(r: OAuthAudit): void {
    const ts = Date.now();
    const key = `audit/broker/${new Date(ts).toISOString().slice(0, 10)}/${ts}-${newId("")}.json`;
    this.ctx.waitUntil(this.env.BUCKET.put(key, JSON.stringify({ ts_ms: ts, ...r })).then(() => undefined, (e: unknown) => {
      console.error(`BrokerDO: audit write failed (${r.event})`, e);
    }));
  }

  // --- MCP OAuth (docs/agents/capabilities/mcp/#oauth) --------------------------------------------

  /** The operator starts authorizing an mcp capability: the URL to open (admin route only). */
  async oauthStart(input: StartInput): Promise<StartAnswer> {
    return await this.oauth.start(input, "operator");
  }

  /** The authorization server's redirect through the Worker's callback route (no admin token: the state is the proof). */
  async oauthCallback(q: { state?: string; code?: string; error?: string; iss?: string }): Promise<{ ok: boolean; capability: string | null; message: string }> {
    return await this.oauth.callback(q, "callback");
  }

  /**
   * An mcp capability's OAuth access token, for AgentDO's MCP client (the only caller): refreshed as
   * needed; the refresh token never leaves BrokerDO. See `OAuthStore.token`.
   */
  async mcpOAuthToken(ref: string, serverUrl: string, refused?: string): Promise<string | null> {
    if (!/^cap:./.test(ref)) throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a capability credential`, 403);
    return await this.oauth.token(ref, serverUrl, refused, "AgentDO");
  }

  /** What the operator may see of an OAuth authorization: never a token. */
  async oauthStatus(ref: string): Promise<OAuthStatus> {
    return this.oauth.status(ref);
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

  /**
   * An http profile's credential (`http:<name>`, docs/agents/capabilities/#brokered-actions), for
   * AgentDO's brokered pipeline, the only caller. Never resolvable into a host command. Null when none is stored.
   */
  async brokeredSecret(ref: string): Promise<string | null> {
    if (!/^http:./.test(ref)) throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a brokered-action credential`, 403);
    return this.secret(ref)?.value ?? null;
  }

  /**
   * The names of stored secrets whose value appears in any of `strings` (a brokered action's
   * arguments): the value itself, its base64, or (for a JSON value) any string in it of 16 characters
   * or more. Names only: no value leaves here. Values under 8 characters aren't looked for.
   */
  async scanSecrets(strings: string[]): Promise<string[]> {
    const rows = this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM secrets").toArray();
    const hits: string[] = [];
    for (const { name, value } of rows) {
      if (secretNeedles(value).some((n) => strings.some((s) => s.includes(n)))) hits.push(name);
    }
    return hits;
  }

  /**
   * An installation token for one repo with exactly these permissions, minted with the GitHub App
   * (`github_app`: `{"app_id", "private_key"}`) and cached until it has 10 minutes left. Every mint and
   * every refusal is audited to R2 before the token is handed out (never the value).
   */
  async githubToken(repo: string, permissions: GithubPermissions, caller: CredentialCaller): Promise<{ token: string; expires_ms: number }> {
    const r = repo.toLowerCase();
    const key = `${r}|${canonicalJson(permissions)}`;
    const cached = this.sql.exec<{ token: string; expires_ms: number }>("SELECT token, expires_ms FROM github_tokens WHERE key = ?", key).toArray()[0];
    if (cached && cached.expires_ms - Date.now() > GITHUB_TOKEN_REUSE_MS) return cached;
    const audit = { event: "github_installation_token", repos: [r], permissions, caller };
    let audited = false;
    const refuse = async (e: NestError, installation?: number): Promise<never> => {
      audited = true;
      await this.auditMint({ ...audit, ...(installation !== undefined ? { installation } : {}), refused: e.detail });
      throw e;
    };
    const app = this.secret("github_app");
    const creds = app ? parseAppSecret(app.value) : null;
    if (!creds) {
      return refuse(new NestError(ErrorCodes.FORBIDDEN, app ? "github_app isn't {\"app_id\", \"private_key\"} JSON" : "no GitHub App is configured (github_app)", 409));
    }
    const api = githubApiOf(this.env);
    let jwt: string;
    try {
      jwt = await appJwt(creds.app_id, await importAppKey(creds.private_key));
    } catch {
      return refuse(new NestError(ErrorCodes.FORBIDDEN, "github_app's private_key isn't an RSA private key (PKCS#1 or PKCS#8 PEM)", 409));
    }
    const known = this.sql.exec<{ installation: number; fetched_ms: number }>("SELECT installation, fetched_ms FROM github_installations WHERE repo = ?", r).toArray()[0];
    let installation = known && Date.now() - known.fetched_ms < INSTALLATION_TTL_MS ? known.installation : null;
    try {
      if (installation === null) {
        installation = await api.installation(jwt, r);
        if (installation === null) return await refuse(new NestError(ErrorCodes.FORBIDDEN, `the GitHub App isn't installed on ${r}`, 403));
        this.sql.exec(`INSERT INTO github_installations (repo, installation, fetched_ms) VALUES (?, ?, ?)
          ON CONFLICT(repo) DO UPDATE SET installation = excluded.installation, fetched_ms = excluded.fetched_ms`, r, installation, Date.now());
      }
      const t = await api.mint(jwt, installation, r.split("/")[1]!, permissions);
      // Audited before anyone holds it: a mint whose record can't be written is never handed out.
      await this.auditMint({ ...audit, installation, expires_ms: t.expires_ms });
      this.sql.exec(`INSERT INTO github_tokens (key, token, expires_ms, installation, minted_ms) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET token = excluded.token, expires_ms = excluded.expires_ms, installation = excluded.installation, minted_ms = excluded.minted_ms`,
      key, t.token, t.expires_ms, installation, Date.now());
      return t;
    } catch (e) {
      // A refusal (e.g. permissions the installation lacks) is audited; a lost answer isn't a refusal.
      if (e instanceof NestError && !e.retryable && !audited) await refuse(e, installation ?? undefined);
      throw e;
    }
  }

  /**
   * A GitHub mint's (or refusal's) issuance audit record, in the same place as {@link audit}'s, but
   * awaited: a mint whose record can't be written is never handed out. Never a value.
   */
  private async auditMint(record: Record<string, unknown>): Promise<void> {
    const ts = Date.now();
    await this.env.BUCKET.put(`audit/broker/${new Date(ts).toISOString().slice(0, 10)}/${ts}-${newId("")}.json`,
      JSON.stringify({ ts_ms: ts, ...record }), { httpMetadata: { contentType: "application/json" } });
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
export const NEVER_RESOLVED = ["binding_key:", "access:", "cap:", "hook:", "http:", "github_app"] as const;

/** An entry ending in `:` admits that prefix; any other admits the name itself and `<name>:…`. */
export function nameAllowed(name: string, allow: readonly string[]): boolean {
  if (NEVER_RESOLVED.some((p) => name.startsWith(p))) return false;
  return allow.some((p) => (p.endsWith(":") ? name.startsWith(p) && name.length > p.length : name === p || name.startsWith(`${p}:`)));
}

/** What `scanSecrets` looks for of one stored value: it, its base64, and a JSON value's long strings. */
export function secretNeedles(value: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length < SCAN_MIN_LENGTH) return;
    out.add(v);
    out.add(bytesToB64(new TextEncoder().encode(v)));
  };
  add(value);
  try {
    const walk = (x: unknown): void => {
      if (typeof x === "string" && x.length >= 16) add(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(JSON.parse(value));
  } catch {
    // not JSON: the value as a whole
  }
  // A PEM's body lines: a key pasted without its armour is still the key.
  for (const line of value.split(/\r?\n/)) if (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim())) out.add(line.trim());
  return [...out];
}
