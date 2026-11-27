// BrokerDO: credential storage and hand-out (docs/control-plane/durable-objects/broker/). Values never
// leave the control plane except inside agent_start (Claude setup token) and secrets_update (proxy memory).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { generateBindingKey, importPrivateJwk, signBinding as signBindingToken } from "../lib/binding";
import { CLIENT_OAUTH_PREFIX, clientOAuthClientPrefix, isClientMcpAuth, clientOAuthEntryPrefix, clientOAuthRef, clientOfRef, type OAuthAudit, type OAuthStatus, OAuthStore, type ServerRevocation, type StartAnswer, type StartInput } from "../lib/mcp-auth";
import { b64url, bytesToB64, NestError, newId } from "../lib/util";
import { isClientId } from "../lib/clients";
import { CLIENT_SECRET_PREFIX, clientSecretKey } from "../lib/client-secrets";
import { addColumn } from "../lib/stored";
import { credentialFor, type CredentialPrincipal } from "../lib/credentials";
import { BINDING_VERSION, type BindingClaims, type BindingKey } from "../protocol/gateway";
import { ErrorCodes, type InjectionSecret } from "../protocol/model";
import {
  generateIdentityKey, IDENTITY_TTL_MS, type IdentityJwk, type IdentityKeyPair, IdentitySubject, importIdentitySigner, keyPlan, type KeyPlan,
  type SignedIdentity, signJwt,
} from "../lib/identity";

/** Values shorter than this aren't scanned for (they'd match ordinary text). */
const SCAN_MIN_LENGTH = 8;
/** Notices of a changed client secret delivered per alarm run, at once; the rest follow in the next run. */
const SECRET_PUSH_BATCH = 50;
/** Tries per notice: 1 s, doubling, about 8.5 minutes in all; past them the sandbox's 15-minute push carries the change. */
const SECRET_PUSH_ATTEMPTS = 10;
const secretPushBackoff = (attempts: number) => 1000 * 2 ** (attempts - 1);
/** One notice's call to its SandboxDO: past this it counts as failed, so one hung sandbox can't hold the alarm run, and every notice queued behind it. */
export const SECRET_PUSH_CALL_TIMEOUT_MS = 10_000;

/** A client's secret as anyone may see it (docs/control-plane/api/clients/#secrets): never its value. */
export interface ClientSecretView {
  name: string;
  description: string | null;
  /** The value's size in bytes (UTF-8). */
  size: number;
  created_ms: number;
  updated_ms: number;
  /** When it was last handed to a sandbox's proxy (`clientInjectionRefs`), or null. */
  last_injected_ms: number | null;
  /** When it stops being injected (its `expires_at`), or null: never. Past it, it is listed but never pushed. */
  expires_ms: number | null;
  /** How many sandboxes' proxies asked for it at their last push: those a write pushes to at once. */
  sandboxes: number;
}

/**
 * What a SandboxDO answered BrokerDO's notice that a client's secret changed (`clientSecretsChanged`):
 * `push` (it pushes again) or `idle` (not on a host: a placement pushes), with the client's secret names its
 * bindings name now; `unbound` (none of that client's bindings apply); `gone` (destroyed or never made).
 */
export interface SecretsChangedAnswer {
  status: "push" | "idle" | "unbound" | "gone";
  secrets?: string[];
}

/** A client binding whose secret a sandbox's proxy should hold: its wire name, its secret's name, and its hosts (audited). */
export interface ClientInjectionRequest {
  binding: string;
  secret: string;
  hosts: string[];
}

/** The per-cell binding signing key, stored as a secret named `binding_key:<cell>`. */
type StoredBindingKey = { kid: string; public_key: string; private_jwk: JsonWebKey };

export class BrokerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Imported signing keys by kid (memory only; rebuilt from the stored JWK after an eviction). */
  private readonly bindingSigners = new Map<string, Promise<CryptoKey>>();
  /** Imported caller-identity signing keys by kid (memory only; rebuilt from the stored JWK after an eviction). */
  private readonly identitySigners = new Map<string, Promise<CryptoKey>>();
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
    // The tables of the kernel's GitHub minting, gone since (docs/control-plane/durable-objects/broker/):
    // read and written by nothing here (`injections` aside, which this constructor empties), still created
    // for the previous release after a rollback, and dropped in a later release. Installation tokens, by
    // repo and permissions:
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_tokens (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_ms INTEGER NOT NULL,
      installation INTEGER NOT NULL, minted_ms INTEGER NOT NULL)`);
    // Installations, by repo alone:
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_installations (repo TEXT PRIMARY KEY, installation INTEGER NOT NULL, fetched_ms INTEGER NOT NULL)`);
    // What owner-wide grant entries and clients' GitHub tokens kept (each repo's owner, each installation's
    // account, each account's login and repos, each client's lookup budget):
    this.sql.exec("CREATE TABLE IF NOT EXISTS github_repo_owners (repo TEXT PRIMARY KEY, owner_id INTEGER, fetched_ms INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS github_installation_accounts (installation INTEGER PRIMARY KEY, account_id INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS github_account_logins (account_id INTEGER PRIMARY KEY, login TEXT, fetched_ms INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS github_lookup_budget (client TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, used INTEGER NOT NULL)");
    addColumn(this.sql, "github_account_logins", "failed", "INTEGER");
    this.sql.exec("CREATE TABLE IF NOT EXISTS github_account_repos (account_id INTEGER PRIMARY KEY, body TEXT NOT NULL, fetched_ms INTEGER NOT NULL)");
    // The App's installation on each repo, by the App and repo:
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_app_installations (app_id TEXT NOT NULL, repo TEXT NOT NULL, installation INTEGER NOT NULL,
      fetched_ms INTEGER NOT NULL, PRIMARY KEY (app_id, repo))`);
    // The App's identity:
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_app_identity (configured TEXT PRIMARY KEY, app_id INTEGER NOT NULL, slug TEXT,
      expires_ms INTEGER NOT NULL)`);
    // Sandboxes' minted tokens, one per (sandbox, binding); the value is the secret `inject:<binding>:<sandbox>`.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS injections (sandbox TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL,
      covers TEXT NOT NULL, expires_ms INTEGER NOT NULL, minted_ms INTEGER NOT NULL, PRIMARY KEY (sandbox, binding))`);
    // Nothing mints now: what a release before this one minted for sandboxes goes at each start, so an operator's
    // static binding of the same name never resolves to one (`inject:<binding>:<sandbox>` is the most specific name
    // it looks up), placed or not (dev/rollout/2026-11-15-kernel-github-minting.md).
    this.sql.exec("DELETE FROM secrets WHERE name IN (SELECT 'inject:' || binding || ':' || sandbox FROM injections)");
    this.sql.exec("DELETE FROM injections");
    // The installation tokens it cached (live for up to an hour after the previous release): read by nothing now.
    this.sql.exec("DELETE FROM github_tokens");
    // API clients' secrets (docs/control-plane/api/clients/#secrets): what anyone may see of each. The
    // value is the secret `client-secret:<client>:<name>`, which only `secrets_update` resolves.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS client_secrets (client TEXT NOT NULL, name TEXT NOT NULL, description TEXT, size INTEGER NOT NULL,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, injected_ms INTEGER, PRIMARY KEY (client, name))`);
    // Which sandboxes asked for each client secret at their last push (`clientInjectionRefs`): those a
    // write or delete of it pushes to at once (#client-secret-pushes). A row stays until that sandbox's
    // next push names other secrets, or a notice finds it gone or no longer bound.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS client_secret_sandboxes (client TEXT NOT NULL, name TEXT NOT NULL, sandbox TEXT NOT NULL,
      asked_ms INTEGER NOT NULL, PRIMARY KEY (client, name, sandbox))`);
    // Notices owed to sandboxes that a client's secret changed, one per (sandbox, client), delivered from the
    // alarm and deleted only once answered (`seq` matches, so an answer to an older notice leaves a newer one).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS client_secret_pushes (sandbox TEXT NOT NULL, client TEXT NOT NULL, due_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (sandbox, client))`);
    // Notices left waiting with no alarm (a previous release, without an alarm handler, ran one): arm it again.
    if (this.sql.exec("SELECT 1 FROM client_secret_pushes LIMIT 1").toArray().length) void ctx.blockConcurrencyWhile(() => this.armSecretPushes());
    // Caller-identity signing keys (lib/identity.ts): the private JWK rests here and nowhere else.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS identity_keys (kid TEXT PRIMARY KEY, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL,
      signs_from_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL)`);
    this.oauth = new OAuthStore({
      sql: this.sql,
      secret: (name) => this.secret(name)?.value ?? null,
      audit: (r) => this.audit(r),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      allowLoopback: env.ALLOW_LOOPBACK_MCP === "1",
      // CatalogDO holds the capability; a callback asks it, then stores in the next synchronous step.
      incarnationOf: (capability) => this.incarnationOf(capability),
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
  async oauthCallback(q: { state?: string; code?: string; error?: string; iss?: string }, owner?: string): Promise<{ ok: boolean; capability: string | null; message: string }> {
    return await this.oauth.callback(q, "callback", owner);
  }

  /**
   * An mcp capability's OAuth access token, for AgentDO's MCP client (the only caller): refreshed as
   * needed; the refresh token never leaves BrokerDO. See `OAuthStore.token`.
   */
  async mcpOAuthToken(ref: string, serverUrl: string, refused?: string): Promise<string | null> {
    // An operator's record, or an API client's own (docs/control-plane/api/clients/#mcp-credentials).
    if (!/^cap:./.test(ref) && !(ref.startsWith(CLIENT_OAUTH_PREFIX) && clientOfRef(ref) !== null)) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a capability credential`, 403);
    }
    return await this.oauth.token(ref, serverUrl, refused, "AgentDO");
  }

  /** What the operator may see of an OAuth authorization: never a token. */
  async oauthStatus(ref: string): Promise<OAuthStatus> {
    return this.oauth.status(ref);
  }

  /**
   * Revoke a capability's OAuth authorizations (`OAuthStore.revoke`): gone here at once, revoked at the AS
   * where it can be. `caller`: the operator, or the API client whose namespace the capability is in.
   */
  async oauthRevoke(capability: string, caller = "operator"): Promise<{ revoked: { ref: string; issuer: string; server: ServerRevocation }[] }> {
    return { revoked: await this.oauth.revoke(capability, caller) };
  }

  /**
   * An API client starts authorizing an mcp capability of its own namespace (`{authorize}` auth,
   * docs/control-plane/api/clients/#mcp-credentials): as `oauthStart`, its tokens kept under the record
   * derived from the client and the entry, never one it names.
   */
  /** The incarnation a client's `{authorize}` capability holds now in CatalogDO, or null (gone, or another form). */
  private async incarnationOf(capability: string): Promise<string | null> {
    let cap: unknown;
    try {
      cap = await this.env.CATALOG.get(this.env.CATALOG.idFromName("catalog")).entry("capabilities", capability);
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 404 || /unknown capability/.test(String(e))) return null;
      throw e;
    }
    const auth = (cap as { mcp?: { auth?: unknown } } | undefined)?.mcp?.auth;
    return isClientMcpAuth(auth) && "authorize" in auth ? (auth.incarnation ?? "0") : null;
  }

  async clientOAuthStart(input: { client: string; clientName: string; capability: string; entry: string; incarnation: string; url: string; scopes?: string[]; capScopes?: string[]; caller?: string }): Promise<StartAnswer> {
    const auth = { oauth: clientOAuthRef(input.client, input.entry, input.incarnation), ...(input.capScopes ? { scopes: input.capScopes } : {}) };
    return await this.oauth.start({
      owner: { id: input.client, name: input.clientName }, capability: input.capability, url: input.url, auth, ...(input.scopes ? { scopes: input.scopes } : {}),
    }, input.caller ?? input.client);
  }

  /**
   * An API client revokes its own capability's authorizations: every record of the entry, whatever its
   * incarnation, so it works after the capability was deleted and never touches a record of another client's.
   * A start or callback in flight for it stores nothing.
   */
  async clientOAuthRevoke(client: string, capability: string, entry: string, o?: { write: true; caller?: string }, caller = client): Promise<{ revoked: { ref: string; issuer: string; server: ServerRevocation }[] }> {
    // A write (`o`) revokes every incarnation but the one the capability holds now, as CatalogDO says it (read
    // here, not taken from the caller, so a write's revocation that arrives late never takes a newer
    // authorization), and a start or callback in flight for another incarnation stores nothing. A delete
    // revokes all, and cancels everything in flight for the capability.
    if (o) {
      const current = await this.incarnationOf(capability);
      const keep = current === null ? undefined : clientOAuthRef(client, entry, current);
      return { revoked: await this.oauth.revokePrefix(clientOAuthEntryPrefix(client, entry), o.caller ?? client, { write: true }, keep) };
    }
    return { revoked: await this.oauth.revokePrefix(clientOAuthEntryPrefix(client, entry), caller, { capability }) };
  }

  /** What an API client may see of its own capability's authorization (its current incarnation's): never a token. */
  async clientOAuthStatus(client: string, entry: string, incarnation: string): Promise<OAuthStatus> {
    return this.oauth.status(clientOAuthRef(client, entry, incarnation));
  }

  /**
   * The operator deletes a secret it stored (state-machine sweep, bug 11): the row goes, value and all,
   * and what named it resolves to nothing from then on. Not the broker's own keys, nor a client's secrets
   * (theirs to delete, or their client's delete). Audited by name, never a value.
   */
  async deleteSecret(name: string): Promise<{ deleted: boolean }> {
    if (name.startsWith("binding_key:")) throw new NestError(ErrorCodes.FORBIDDEN, "binding keys are the broker's own", 403);
    if (name.startsWith(CLIENT_SECRET_PREFIX)) throw new NestError(ErrorCodes.FORBIDDEN, "an API client's secrets are deleted with its own token", 403);
    const deleted = this.sql.exec("DELETE FROM secrets WHERE name = ?", name).rowsWritten > 0;
    this.auditInBackground({ event: "secret_deleted", name, deleted, caller: "operator" });
    return { deleted };
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
   * Reference to the `claude setup-token` OAuth token an agent's spec names (`credential`), as
   * `credentialFor` decides it: for the operator's agents the named one, else `claude_oauth_token`;
   * for an API client's agent (`principal`, with its grant's `credentials` as they are now) exactly the
   * named one, or a refusal. Only those names: the value is sent to a brain host, so a credential naming
   * any other secret is refused. Other objects store and pass the reference ({@link SECRET_REF_PREFIX});
   * FleetDO resolves it only when it sends `agent_start`, so no copy of the value is kept elsewhere.
   * Without `principal` (a caller of the previous release) it decides for the operator. Every caller
   * of this release (AgentDO's `startCredential`) passes the principal for a client's agent, so the
   * operator's branch, with its fallback, is never reached for one; AgentDO also refuses any reference
   * but the spec's own for a client's agent.
   */
  async credentialRef(credential: string, principal?: { client: string; credentials: string[] | null }): Promise<string> {
    const who: CredentialPrincipal = principal ? { kind: "client", client: principal.client } : { kind: "operator" };
    const grant = principal ? (principal.credentials ? { credentials: principal.credentials } : null) : null;
    const c = credentialFor(who, credential, grant, (name) => this.secret(name) !== undefined);
    if (!c.ok) throw new NestError(ErrorCodes.FORBIDDEN, c.message, c.reason === "not_a_credential" ? 403 : 409);
    return secretRef(c.name);
  }

  /**
   * Static injection secrets for bindings, as references: the most specific stored of
   * `inject:<binding>:<sandbox>`, `inject:<binding>:<workstream>` (kept for secrets stored before the
   * sandbox key; nothing new is keyed by workstream) and `inject:<binding>`. The `value` of each entry
   * is a reference that FleetDO resolves when it sends `secrets_update`. `scope` as a bare string is the
   * previous release's workstream argument.
   */
  async injectionSecretRefs(bindings: string[], scope: string | { sandbox: string; workstream?: string }): Promise<InjectionSecret[]> {
    const keys = typeof scope === "string" ? [scope] : [scope.sandbox, ...(scope.workstream ? [scope.workstream] : [])];
    const out: InjectionSecret[] = [];
    for (const binding of bindings) {
      const name = [...keys.map((k) => `inject:${binding}:${k}`), `inject:${binding}`].find((n) => this.secret(n));
      const s = name ? this.secret(name) : undefined;
      if (name && s) out.push({ binding, value: secretRef(name), ...(s.expires_ms !== null ? { expires_ms: s.expires_ms } : {}) });
    }
    return out;
  }

  /**
   * Forget the tokens a release before this one minted for a sandbox (`injections`, and each one's secret
   * `inject:<binding>:<sandbox>`): SandboxDO's destroy, here and in the release before. Nothing writes
   * `injections` now (the constructor empties it); the table goes in a later release.
   */
  async forgetInjections(sandbox: string): Promise<void> {
    for (const { binding } of this.sql.exec<{ binding: string }>("SELECT binding FROM injections WHERE sandbox = ?", sandbox).toArray()) {
      this.sql.exec("DELETE FROM secrets WHERE name = ?", `inject:${binding}:${sandbox}`);
    }
    this.sql.exec("DELETE FROM injections WHERE sandbox = ?", sandbox);
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

  // --- caller identity for MCP servers (docs/control-plane/api/clients/#caller-identity-for-mcp-servers) ---

  /** The stored keys' schedule at `now` (lib/identity.ts `keyPlan`). */
  private identityPlan(now: number): KeyPlan {
    return keyPlan(this.sql.exec<{ kid: string; signs_from_ms: number }>("SELECT kid, signs_from_ms FROM identity_keys").toArray(), now);
  }

  /**
   * The keys as the schedule wants them now: a due next key generated (the first one signs at once,
   * every later one is published a day before it signs) and keys retired over a day ago deleted. Run
   * by every sign and every JWKS read, so no alarm is needed: a key that would have been due while
   * nothing ran is made later, and the current key signs on until it has been published a day.
   */
  private async identityKeysNow(): Promise<KeyPlan> {
    let plan = this.identityPlan(Date.now());
    if (plan.next_signs_from_ms !== null) {
      const k: IdentityKeyPair = await generateIdentityKey();
      // Another caller may have added the key across the await: re-plan, and insert only if one is still due.
      plan = this.identityPlan(Date.now());
      if (plan.next_signs_from_ms !== null) {
        this.sql.exec("INSERT INTO identity_keys (kid, private_jwk, public_jwk, signs_from_ms, created_ms) VALUES (?, ?, ?, ?, ?)",
          k.kid, JSON.stringify(k.private_jwk), JSON.stringify(k.public_jwk), plan.next_signs_from_ms, Date.now());
        plan = this.identityPlan(Date.now());
      }
    }
    for (const kid of plan.drop) {
      this.sql.exec("DELETE FROM identity_keys WHERE kid = ?", kid);
      this.identitySigners.delete(kid);
    }
    return plan;
  }

  /** The JWKS (`GET /.well-known/jwks.json`): the signing key, the next one, and recently retired ones. */
  async identityJwks(): Promise<{ keys: IdentityJwk[] }> {
    const plan = await this.identityKeysNow();
    const rows = new Map(this.sql.exec<{ kid: string; public_jwk: string }>("SELECT kid, public_jwk FROM identity_keys").toArray()
      .map((r) => [r.kid, JSON.parse(r.public_jwk) as IdentityJwk]));
    return { keys: plan.published.flatMap((kid) => rows.get(kid) ?? []) };
  }

  /**
   * Sign a caller identity (AgentDO's MCP proxy, the connector): `subject` is every claim but `iss`
   * (the Worker's public base URL), `iat` and `exp` (5 minutes on), which are set here.
   */
  async signIdentity(subject: IdentitySubject): Promise<SignedIdentity> {
    const s = IdentitySubject.safeParse(subject);
    if (!s.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, `caller identity: ${s.error.message}`);
    const plan = await this.identityKeysNow();
    const kid = plan.signer;
    const row = kid && this.sql.exec<{ private_jwk: string }>("SELECT private_jwk FROM identity_keys WHERE kid = ?", kid).toArray()[0];
    if (!kid || !row) throw new NestError(ErrorCodes.INTERNAL, "no caller-identity signing key", 500, true);
    let signer = this.identitySigners.get(kid);
    if (!signer) {
      // A rejected import must not stick: the next call imports again.
      signer = importIdentitySigner(JSON.parse(row.private_jwk) as JsonWebKey).catch((e: unknown) => {
        this.identitySigners.delete(kid);
        throw e;
      });
      this.identitySigners.set(kid, signer);
    }
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + IDENTITY_TTL_MS / 1000;
    const token = await signJwt(await signer, kid, { ...s.data, iss: this.env.PUBLIC_BASE_URL, iat, exp });
    return { token, exp_ms: exp * 1000 };
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
    // An operator's `cap:` secret, or an API client's own secret its capability names as the bearer
    // (`{secret}`, docs/control-plane/api/clients/#mcp-credentials): expansion derived the key from the
    // capability's own client, so it is never another client's. An expired one is no bearer.
    if (!/^cap:./.test(ref) && !(ref.startsWith(CLIENT_SECRET_PREFIX) && clientOfRef(ref) !== null)) {
      throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a capability credential`, 403);
    }
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

  // --- API clients' secrets (docs/control-plane/api/clients/#secrets) ---------------------------------

  /**
   * Store (or replace) client `client`'s secret `name`, within its grant's `secrets` (at most `max_count`
   * of them, each at most `max_bytes`): checked and written in one synchronous step, so two writes can't
   * both take the last place. Audited (never the value). Answers what anyone may see of it.
   */
  async putClientSecret(client: string, name: string, value: string, description: string | null, limit: { max_count: number; max_bytes: number }): Promise<ClientSecretView> {
    return this.writeClientSecret(client, name, { value, description, expires_ms: null }, limit);
  }

  /**
   * As `putClientSecret`, with an expiry (`expires_ms`, null: none): the value resolves to nothing from
   * then on, and each push carries it so nest-proxy refuses the placeholder at that moment. A new method
   * rather than a new argument, so a BrokerDO of the previous release refuses it (503) instead of storing
   * the value without its expiry. The write is pushed at once to every sandbox that asked for it.
   */
  async writeClientSecret(client: string, name: string, input: { value: string; description: string | null; expires_ms: number | null },
    limit: { max_count: number; max_bytes: number }): Promise<ClientSecretView> {
    const { value, description } = input;
    if (!isClientId(client)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${client} is not a client`, 400);
    const size = new TextEncoder().encode(value).byteLength;
    if (size > limit.max_bytes) throw new NestError(ErrorCodes.FORBIDDEN, `outside ${client}'s grant: a secret of ${size} bytes (secrets.max_bytes is ${limit.max_bytes})`, 403);
    const now = Date.now();
    const cur = this.sql.exec<{ created_ms: number }>("SELECT created_ms FROM client_secrets WHERE client = ? AND name = ?", client, name).toArray()[0];
    if (!cur) {
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM client_secrets WHERE client = ?", client).one().n;
      if (n >= limit.max_count) throw new NestError(ErrorCodes.FORBIDDEN, `outside ${client}'s grant: it has ${n} secrets (secrets.max_count is ${limit.max_count})`, 403);
    }
    this.sql.exec(`INSERT INTO client_secrets (client, name, description, size, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client, name) DO UPDATE SET description = excluded.description, size = excluded.size, updated_ms = excluded.updated_ms`,
    client, name, description, size, cur?.created_ms ?? now, now);
    await this.putSecret(clientSecretKey(client, name), value, input.expires_ms ?? undefined);
    await this.queueSecretPushes(client, name);
    this.auditInBackground({ event: "client_secret_put", client, secret: name, size, replaced: !!cur,
      ...(input.expires_ms !== null ? { expires_ms: input.expires_ms } : {}) });
    return this.clientSecretView(client, name)!;
  }

  /**
   * Delete client `client`'s secret `name` (404 when it has none). Every sandbox that asked for it is
   * pushed again at once, which takes it out of its proxy. Who asked stays recorded: a sandbox still
   * bound to the name gets a value stored under it again the same way.
   */
  async deleteClientSecret(client: string, name: string): Promise<void> {
    const n = this.sql.exec("DELETE FROM client_secrets WHERE client = ? AND name = ?", client, name).rowsWritten;
    this.sql.exec("DELETE FROM secrets WHERE name = ?", clientSecretKey(client, name));
    if (!n) throw new NestError(ErrorCodes.NOT_FOUND, `no secret ${name}`, 404);
    await this.queueSecretPushes(client, name);
    this.auditInBackground({ event: "client_secret_deleted", client, secret: name });
  }

  /** Every secret of client `client`, by name: never a value. */
  async clientSecrets(client: string): Promise<ClientSecretView[]> {
    return this.sql.exec<{ name: string }>("SELECT name FROM client_secrets WHERE client = ? ORDER BY name", client).toArray()
      .map((r) => this.clientSecretView(client, r.name)!);
  }

  /** A deleted client's secrets, all of them, and its own OAuth authorizations (revoked at their servers in the background). */
  async deleteClientSecrets(client: string): Promise<number> {
    // Its records go in this call's synchronous first step; the revocations at the servers follow.
    this.ctx.waitUntil(this.oauth.revokePrefix(clientOAuthClientPrefix(client), "client_deleted", { client }).then(() => undefined, (e: unknown) => {
      console.error("BrokerDO: revoking a deleted client's OAuth tokens", e);
    }));
    const names = this.sql.exec<{ name: string }>("SELECT name FROM client_secrets WHERE client = ?", client).toArray().map((r) => r.name);
    for (const name of names) this.sql.exec("DELETE FROM secrets WHERE name = ?", clientSecretKey(client, name));
    this.sql.exec("DELETE FROM client_secrets WHERE client = ?", client);
    // Nothing of a deleted client lives (its delete is refused while anything does): no sandbox to push to.
    this.sql.exec("DELETE FROM client_secret_sandboxes WHERE client = ?", client);
    this.sql.exec("DELETE FROM client_secret_pushes WHERE client = ?", client);
    if (names.length) this.auditInBackground({ event: "client_secrets_deleted", client, secrets: names });
    return names.length;
  }

  /**
   * References to client `client`'s secrets for sandbox `sandbox`'s proxy (SandboxDO's push), one per
   * binding whose secret it has (a binding naming one it doesn't have gets none, and nest-proxy refuses
   * its placeholder). Only that client's own secrets: the name is looked up under its id alone. Each
   * push is audited (the bindings, secrets and hosts, never a value) before any reference is answered,
   * and marks each secret's `last_injected_ms`. Each reference carries its secret's expiry, so nest-proxy
   * refuses the placeholder from then on; an expired secret gets none.
   *
   * Records which secrets the sandbox asked for, held or not (`client_secret_sandboxes`), before any await:
   * a write of one of them is pushed to it at once, a secret stored after its binding included. Additive
   * only: pushes overlap (one held while a newer one ran), so the last to arrive isn't the newest, and
   * replacing the set would let a stale push take a newer one's secrets off it. Rows go only on a
   * notice's answer, for what was asked before the notice went (`deliverSecretPushes`), or at the
   * sandbox's destroy (`forgetClientSecretSandbox`).
   */
  async clientInjectionRefs(client: string, sandbox: string, bindings: ClientInjectionRequest[], caller: string): Promise<InjectionSecret[]> {
    if (!isClientId(client)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${client} is not a client`, 400);
    const asked = Date.now();
    for (const name of new Set(bindings.map((b) => b.secret))) {
      this.sql.exec(`INSERT INTO client_secret_sandboxes (client, name, sandbox, asked_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(client, name, sandbox) DO UPDATE SET asked_ms = MAX(asked_ms, excluded.asked_ms)`, client, name, sandbox, asked);
    }
    const held = bindings.flatMap((b) => {
      const s = this.clientSecretView(client, b.secret) && this.secret(clientSecretKey(client, b.secret));
      return s ? [{ ...b, expires_ms: s.expires_ms }] : [];
    });
    if (!held.length) return [];
    await this.auditMint({ event: "client_secret_injected", client, sandbox, caller, bindings: held.map((b) => ({ binding: b.binding, secret: b.secret, hosts: b.hosts })) });
    const now = Date.now();
    for (const b of held) this.sql.exec("UPDATE client_secrets SET injected_ms = ? WHERE client = ? AND name = ?", now, client, b.secret);
    return held.map((b) => ({ binding: b.binding, value: secretRef(clientSecretKey(client, b.secret)), ...(b.expires_ms !== null ? { expires_ms: b.expires_ms } : {}) }));
  }

  /**
   * A client's secret `name` changed (written or deleted): owe each sandbox that asked for it a notice,
   * delivered from the alarm (`deliverSecretPushes`). One row per (sandbox, client), so a burst of writes
   * is one push per sandbox. Armed in the step that queues it.
   */
  private async queueSecretPushes(client: string, name: string): Promise<void> {
    const sandboxes = this.sql.exec<{ sandbox: string }>("SELECT sandbox FROM client_secret_sandboxes WHERE client = ? AND name = ?", client, name).toArray();
    if (!sandboxes.length) return;
    const now = Date.now();
    for (const { sandbox } of sandboxes) {
      this.sql.exec(`INSERT INTO client_secret_pushes (sandbox, client, due_ms, attempts, seq) VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(sandbox, client) DO UPDATE SET due_ms = excluded.due_ms, attempts = 0, seq = seq + 1`, sandbox, client, now);
    }
    await this.armSecretPushes();
  }

  private async armSecretPushes(): Promise<void> {
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(due_ms) AS at FROM client_secret_pushes").one().at;
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > next) await this.ctx.storage.setAlarm(Math.max(next, 1));
  }

  /** A destroyed sandbox asks for no client secret: SandboxDO's destroy, beside `forgetInjections`. */
  async forgetClientSecretSandbox(sandbox: string): Promise<void> {
    this.sql.exec("DELETE FROM client_secret_sandboxes WHERE sandbox = ?", sandbox);
    this.sql.exec("DELETE FROM client_secret_pushes WHERE sandbox = ?", sandbox);
  }

  /** BrokerDO's only alarm: the notices owed to sandboxes whose client secrets changed. */
  override async alarm(): Promise<void> {
    if (isHealthInstance(this.ctx, this.env.BROKER)) return;
    await this.deliverSecretPushes();
  }

  /**
   * Tell each sandbox owed a notice that its client's secrets changed, at most `SECRET_PUSH_BATCH` at a
   * time; it pushes them again from its own alarm. A notice goes once answered, unless a newer write
   * re-queued it meanwhile (`seq`). A failure, or no answer in `SECRET_PUSH_CALL_TIMEOUT_MS`, backs off
   * (1 s, doubling) and is dropped after `SECRET_PUSH_ATTEMPTS`: the sandbox's 15-minute push still
   * carries the change. What the answer says the sandbox no longer asks for is forgotten: everything when
   * it is gone, the client's secrets when unbound, the names its bindings don't name otherwise; only rows
   * asked for before the notice went, so a push recorded meanwhile stands.
   */
  private async deliverSecretPushes(): Promise<void> {
    const sent = Date.now();
    const due = this.sql.exec<{ sandbox: string; client: string; attempts: number; seq: number }>(
      "SELECT sandbox, client, attempts, seq FROM client_secret_pushes WHERE due_ms <= ? ORDER BY due_ms LIMIT ?", sent, SECRET_PUSH_BATCH).toArray();
    await Promise.all(due.map(async (r) => {
      const match = [r.sandbox, r.client, r.seq] as const;
      let answer: SecretsChangedAnswer;
      try {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${SECRET_PUSH_CALL_TIMEOUT_MS} ms`)), SECRET_PUSH_CALL_TIMEOUT_MS);
        });
        try {
          answer = await Promise.race([this.env.SANDBOX.get(this.env.SANDBOX.idFromName(r.sandbox)).clientSecretsChanged(r.client), timeout]);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      } catch (e) {
        const attempts = r.attempts + 1;
        if (attempts >= SECRET_PUSH_ATTEMPTS) {
          console.warn(`BrokerDO: sandbox ${r.sandbox} didn't take client ${r.client}'s secret change after ${attempts} tries; its periodic push will`, e);
          this.sql.exec("DELETE FROM client_secret_pushes WHERE sandbox = ? AND client = ? AND seq = ?", ...match);
        } else {
          console.warn(`BrokerDO: telling sandbox ${r.sandbox} of client ${r.client}'s secret change failed; retrying`, e);
          this.sql.exec("UPDATE client_secret_pushes SET attempts = ?, due_ms = ? WHERE sandbox = ? AND client = ? AND seq = ?",
            attempts, Date.now() + secretPushBackoff(attempts), ...match);
        }
        return;
      }
      this.sql.exec("DELETE FROM client_secret_pushes WHERE sandbox = ? AND client = ? AND seq = ?", ...match);
      if (answer.status === "gone") {
        this.sql.exec("DELETE FROM client_secret_sandboxes WHERE sandbox = ? AND asked_ms < ?", r.sandbox, sent);
      } else {
        const keep = answer.status === "unbound" ? [] : answer.secrets ?? null;
        // `secrets` absent (not a list): nothing is known to go.
        if (keep === null) return;
        this.sql.exec(`DELETE FROM client_secret_sandboxes WHERE sandbox = ? AND client = ? AND asked_ms < ?
          AND name NOT IN (SELECT value FROM json_each(?))`, r.sandbox, r.client, sent, JSON.stringify(keep));
      }
    }));
    await this.armSecretPushes();
  }

  private clientSecretView(client: string, name: string): ClientSecretView | undefined {
    const r = this.sql.exec<{ name: string; description: string | null; size: number; created_ms: number; updated_ms: number; injected_ms: number | null }>(
      "SELECT name, description, size, created_ms, updated_ms, injected_ms FROM client_secrets WHERE client = ? AND name = ?", client, name).toArray()[0];
    if (!r) return undefined;
    // Read past `secret()`'s expiry filter: an expired one is still listed, with when it expired.
    const expires = this.sql.exec<{ expires_ms: number | null }>("SELECT expires_ms FROM secrets WHERE name = ?", clientSecretKey(client, name)).toArray()[0];
    const sandboxes = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM client_secret_sandboxes WHERE client = ? AND name = ?", client, name).one().n;
    return { name: r.name, description: r.description, size: r.size, created_ms: r.created_ms, updated_ms: r.updated_ms, last_injected_ms: r.injected_ms,
      expires_ms: expires?.expires_ms ?? null, sandboxes };
  }

  /** An audit record written in the background: its failure is logged, and doesn't fail what it records. */
  private auditInBackground(record: Record<string, unknown>): void {
    this.ctx.waitUntil(this.auditMint(record).catch((e: unknown) => console.error(`BrokerDO: audit write failed (${String(record.event)})`, e)));
  }

  /**
   * As `scanSecrets`, for an environment's values (index.ts `refuseSecretValues`): with `client`, only that
   * client's own secrets are compared, so the answer reveals nothing of another tenant's or the
   * operator's; without, every stored secret (the operator's caller). Names only.
   */
  async scanSecretValues(strings: string[], client: string | null): Promise<string[]> {
    const rows = client === null
      ? this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM secrets").toArray()
      : this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM secrets WHERE substr(name, 1, ?) = ?",
        clientSecretKey(client, "").length, clientSecretKey(client, "")).toArray();
    return rows.filter(({ value }) => secretNeedles(value).some((n) => strings.some((s) => s.includes(n)))).map((r) => r.name);
  }

  /**
   * The names of stored secrets whose value appears in any of `strings` (a brokered action's
   * arguments): the value itself, its base64, or (for a JSON value) any string in it of 16 characters
   * or more. Names only: no value leaves here. Values under 8 characters aren't looked for.
   * Exact values only, no credential shapes (2026-11-12).
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
   * An issuance audit record (a client secret handed to a sandbox's proxy), in the same place as
   * {@link audit}'s, but awaited: a hand-out whose record can't be written doesn't happen. Never a value.
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
   * As `resolveRefs`, each with its expiry as stored at this moment (null: none), so a push carries the
   * value and its expiry read together: a value replaced while the push was on its way never goes out
   * with the old value's expiry. FleetDO stamps it on the `secrets_update` entry.
   */
  async resolveRefsExpiring(refs: string[], allow: readonly string[]): Promise<Record<string, { value: string; expires_ms: number | null } | null>> {
    const out: Record<string, { value: string; expires_ms: number | null } | null> = {};
    for (const ref of refs) {
      const name = isSecretRef(ref) ? ref.slice(SECRET_REF_PREFIX.length) : null;
      if (name !== null && !nameAllowed(name, allow)) console.warn(`BrokerDO: refusing to resolve ${name} here`);
      const s = name !== null && nameAllowed(name, allow) ? this.secret(name) : undefined;
      out[ref] = s ? { value: s.value, expires_ms: s.expires_ms } : null;
    }
    return out;
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
  /** `secrets_update.secrets[].value`: injection secrets for nest-proxy, the operator's and API clients'. */
  secrets_update: ["inject:", CLIENT_SECRET_PREFIX],
} as const satisfies Record<string, readonly string[]>;

export type RefPurpose = keyof typeof REF_PURPOSES;
export interface RefSlot {
  purpose: RefPurpose;
  ref: string;
  set: (value: string) => void;
  /** A `secrets_update` entry's expiry, as read with its value (null: none). */
  setExpiry?: (expiresMs: number | null) => void;
}

/** The secret-reference slots of one host command (mutated in place by `set`). */
export function commandRefSlots(cmd: Record<string, unknown>): RefSlot[] {
  const slots: RefSlot[] = [];
  if (cmd.type === "agent_start" && isSecretRef(cmd.oauth_token)) {
    slots.push({ purpose: "agent_start", ref: cmd.oauth_token, set: (v) => { cmd.oauth_token = v; } });
  } else if (cmd.type === "secrets_update" && Array.isArray(cmd.secrets)) {
    for (const s of cmd.secrets as { value?: unknown; expires_ms?: unknown }[]) {
      if (isSecretRef(s.value)) {
        slots.push({ purpose: "secrets_update", ref: s.value, set: (v) => { s.value = v; }, setExpiry: (e) => {
          if (e === null) delete s.expires_ms;
          else s.expires_ms = e;
        } });
      }
    }
  }
  return slots;
}

/**
 * Never resolvable into a command, whatever the purpose: they never leave the control plane. `github_app`
 * (the GitHub App's key, which nest minted with) and `github_user` (the operator's GitHub token) are read by
 * nothing now: a stored value may remain until the operator deletes it.
 */
export const NEVER_RESOLVED = ["binding_key:", "access:", "cap:", "hook:", "http:", "github_app", "github_user"] as const;

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
