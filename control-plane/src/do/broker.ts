// BrokerDO: credential storage and hand-out (docs/control-plane/durable-objects/broker/). Values never
// leave the control plane except inside agent_start (Claude setup token) and secrets_update (proxy memory).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { generateBindingKey, importPrivateJwk, signBinding as signBindingToken } from "../lib/binding";
import { type OAuthAudit, type OAuthStatus, OAuthStore, type StartAnswer, type StartInput } from "../lib/mcp-auth";
import { b64url, bytesToB64, NestError, newId } from "../lib/util";
import {
  appJwt, type GitHubApi, githubApiOf, GithubRepoPermissions, importAppKey, parseAppSecret, revokeInstallationToken, SANDBOX_READ_TOKEN_PERMISSIONS, SANDBOX_TOKEN_PERMISSIONS,
} from "../lib/github";
import { isClientId } from "../lib/clients";
import { CLIENT_SECRET_PREFIX, clientSecretKey } from "../lib/client-secrets";
import { canonicalRepos, Repo } from "../lib/repos";
import type { GithubPermissions } from "../lib/brokered";
import { canonicalJson } from "../lib/sinks";
import { credentialFor, type CredentialPrincipal } from "../lib/credentials";
import { BINDING_VERSION, type BindingClaims, type BindingKey } from "../protocol/gateway";
import { ErrorCodes, type InjectionSecret } from "../protocol/model";
import {
  generateIdentityKey, IDENTITY_TTL_MS, type IdentityJwk, type IdentityKeyPair, IdentitySubject, importIdentitySigner, keyPlan, type KeyPlan,
  type SignedIdentity, signJwt,
} from "../lib/identity";

/** An installation token is reused while it has this long left (tokens last an hour: reused for 50 minutes). */
const GITHUB_TOKEN_REUSE_MS = 10 * 60_000;
/** A repo's installation id is looked up again after this long. */
const INSTALLATION_TTL_MS = 24 * 3_600_000;
/**
 * A sandbox's injected token is reused while it has this long left. SandboxDO refreshes 15 minutes
 * before expiry, so a refresh always mints.
 */
const SANDBOX_TOKEN_REUSE_MS = 20 * 60_000;
/** The App's identity (`GET /app`) is kept this long; the configured id alone, when GitHub didn't answer, this long. */
const APP_IDENTITY_TTL_MS = 24 * 3_600_000;
const APP_IDENTITY_RETRY_MS = 10 * 60_000;
/** `GET /app` gives up after this long: it delays a client's answer, which doesn't need it. */
const APP_LOOKUP_TIMEOUT_MS = 5_000;
/** Values shorter than this aren't scanned for (they'd match ordinary text). */
const SCAN_MIN_LENGTH = 8;

/** Who asked for a credential, for the issuance audit. */
export interface CredentialCaller {
  agent: string;
  /** The call key (`<agent>/<epoch>/<call>`). */
  call: string;
}

/** Where an injected secret goes: one sandbox at one epoch (the push is fenced by it). */
export interface InjectionTarget {
  sandbox: string;
  epoch: number;
}

/** How a minted injection secret is made: today one source, the GitHub App narrowed to repos. */
/**
 * What to mint an injection secret from. `workflows` (a push token only) adds `workflows: write`; a
 * BrokerDO of the previous release ignores it and mints without, which is narrower.
 */
export type InjectionSource = { kind: "github_app"; binding: string; repos: string[]; workflows?: boolean };

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
}

/** A client binding whose secret a sandbox's proxy should hold: its wire name, its secret's name, and its hosts (audited). */
export interface ClientInjectionRequest {
  binding: string;
  secret: string;
  hosts: string[];
}

/** A minted injection secret, as a reference FleetDO resolves when it sends `secrets_update`. */
export interface MintedInjection extends InjectionSecret {
  /** What the secret covers (github_app: the repos the token was minted for). */
  covers: string[];
}

/** The per-cell binding signing key, stored as a secret named `binding_key:<cell>`. */
type StoredBindingKey = { kid: string; public_key: string; private_jwk: JsonWebKey };

export class BrokerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Imported signing keys by kid (memory only; rebuilt from the stored JWK after an eviction). */
  private readonly bindingSigners = new Map<string, Promise<CryptoKey>>();
  /**
   * The latest `injectionSecret` request per `<sandbox>|<binding>` (memory: an eviction ends the requests
   * in flight too). An older request that finishes later stores nothing, so it can't replace the value a
   * newer push's reference resolves to.
   */
  private readonly injectionRequests = new Map<string, number>();
  private injectionSeq = 0;
  /** `githubApp`'s lookup in flight, and when an App nothing could tell may be asked about again, per configured `app_id` (memory only). */
  private readonly appLookups = new Map<string, Promise<{ app_id: number; app_slug?: string } | null>>();
  private readonly appUnknownUntil = new Map<string, number>();
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
    // Minted GitHub installation tokens, by (repo, permissions): reused while they have 10 minutes left.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_tokens (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_ms INTEGER NOT NULL,
      installation INTEGER NOT NULL, minted_ms INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_installations (repo TEXT PRIMARY KEY, installation INTEGER NOT NULL, fetched_ms INTEGER NOT NULL)`);
    // The App's identity (`GET /app`), by the `app_id` its credentials name (a new App is a new row): its
    // numeric id and slug, kept until `expires_ms`.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS github_app_identity (configured TEXT PRIMARY KEY, app_id INTEGER NOT NULL, slug TEXT,
      expires_ms INTEGER NOT NULL)`);
    // Minted injection secrets, one per (sandbox, binding): what it was minted from and for, so a push
    // with the same source reuses it. The value is the secret `inject:<binding>:<sandbox>`.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS injections (sandbox TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL,
      covers TEXT NOT NULL, expires_ms INTEGER NOT NULL, minted_ms INTEGER NOT NULL, PRIMARY KEY (sandbox, binding))`);
    // API clients' secrets (docs/control-plane/api/clients/#secrets): what anyone may see of each. The
    // value is the secret `client-secret:<client>:<name>`, which only `secrets_update` resolves.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS client_secrets (client TEXT NOT NULL, name TEXT NOT NULL, description TEXT, size INTEGER NOT NULL,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, injected_ms INTEGER, PRIMARY KEY (client, name))`);
    // Caller-identity signing keys (lib/identity.ts): the private JWK rests here and nowhere else.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS identity_keys (kid TEXT PRIMARY KEY, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL,
      signs_from_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL)`);
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
   * A minted injection secret for one sandbox (docs/control-plane/durable-objects/broker/#injection-minting):
   * for `github_app`, an installation token narrowed to the source's repos with
   * {@link SANDBOX_TOKEN_PERMISSIONS} (its push allowlist), stored as `inject:<binding>:<sandbox>` and reused while it has 20
   * minutes left. `null` when nothing can be minted (no App, or it's installed on none of the repos): any
   * earlier token for the sandbox is dropped then, so a narrowed allowlist never keeps a wider token.
   * Repos in several installations get the installation holding most of them; the others are refused
   * and audited. Every mint and refusal is audited before the value is stored. A request overtaken by a
   * newer one for the same sandbox and binding while GitHub answered stores nothing and answers null
   * (its caller's push is stale too).
   */
  async injectionSecret(target: InjectionTarget, source: InjectionSource, caller: string): Promise<MintedInjection | null> {
    return await this.mintInjection(target, source, "write", caller);
  }

  /**
   * As {@link injectionSecret}, for a sandbox's read-only repos: the token has
   * {@link SANDBOX_READ_TOKEN_PERMISSIONS}, nothing that writes. A method of its own, not a field of the
   * source: a BrokerDO of the previous release, which would ignore such a field and mint a push token,
   * refuses a method it lacks instead.
   */
  async readInjectionSecret(target: InjectionTarget, source: InjectionSource, caller: string): Promise<MintedInjection | null> {
    return await this.mintInjection(target, source, "read", caller);
  }

  private async mintInjection(target: InjectionTarget, source: InjectionSource, access: "write" | "read", caller: string): Promise<MintedInjection | null> {
    // `workflows` only on a push token, and only when asked (docs/control-plane/api/clients/#workflow-files).
    const workflows = access === "write" && source.workflows === true;
    const permissions: GithubPermissions = access === "read" ? SANDBOX_READ_TOKEN_PERMISSIONS
      : workflows ? { ...SANDBOX_TOKEN_PERMISSIONS, workflows: "write" } : SANDBOX_TOKEN_PERMISSIONS;
    const repos = canonicalRepos(source.repos);
    const name = `inject:${source.binding}:${target.sandbox}`;
    const slot = `${target.sandbox}|${source.binding}`;
    const seq = ++this.injectionSeq;
    this.injectionRequests.set(slot, seq);
    const overtaken = () => this.injectionRequests.get(slot) !== seq;
    // A push token's key is the previous release's, so its tokens are reused across the deploy; a read
    // token's names its access, so neither is ever reused for the other.
    // With `workflows`, its own key: never reused for a token without it, nor the other way round.
    const key = JSON.stringify(access === "read" ? { kind: source.kind, repos, access } : workflows ? { kind: source.kind, repos, workflows } : { kind: source.kind, repos });
    const now = Date.now();
    this.sql.exec("DELETE FROM secrets WHERE name LIKE 'inject:%:sbx\\_%' ESCAPE '\\' AND expires_ms IS NOT NULL AND expires_ms <= ?", now);
    const audit = { event: "github_installation_token", permissions, target, binding: source.binding, caller };
    const held = this.sql.exec<{ source: string; covers: string; expires_ms: number }>(
      "SELECT source, covers, expires_ms FROM injections WHERE sandbox = ? AND binding = ?", target.sandbox, source.binding).toArray()[0];
    if (held?.source === key && held.expires_ms - now > SANDBOX_TOKEN_REUSE_MS && this.secret(name)) {
      return { binding: source.binding, value: secretRef(name), expires_ms: held.expires_ms, covers: JSON.parse(held.covers) as string[] };
    }
    // A held token with `workflows: write` that this one doesn't replace in kind (the opt-in turned off,
    // or nothing mintable now): it goes from the proxy at the next push, but stays valid at GitHub for
    // its hour, so it's revoked there once it's no longer held (`retire`).
    const wider = !workflows && held && (JSON.parse(held.source) as { workflows?: boolean }).workflows === true ? this.secret(name)?.value ?? null : null;
    const retire = async () => {
      if (!wider) return;
      // Tried twice: a revoke that fails, with a host that also missed the push replacing it, would leave
      // the token usable for the rest of its hour. Either way audited, never the token.
      let last: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await revokeInstallationToken(githubApiOf(this.env), wider);
          await this.auditMint({ event: "github_installation_token_revoked", target, binding: source.binding, caller, why: "workflows: write no longer asked", attempt });
          return;
        } catch (e) {
          last = e;
        }
      }
      console.warn(`sandbox ${target.sandbox}: revoking its previous token (with workflows) failed twice; it expires within the hour`, last);
      await this.auditMint({ event: "github_installation_token_revoke_failed", target, binding: source.binding, caller, why: last instanceof Error ? last.message.slice(0, 300) : String(last) });
    };
    const forget = async () => {
      if (overtaken()) return;
      this.sql.exec("DELETE FROM secrets WHERE name = ?", name);
      this.sql.exec("DELETE FROM injections WHERE sandbox = ? AND binding = ?", target.sandbox, source.binding);
      await retire();
    };
    const app = this.secret("github_app");
    const creds = app ? parseAppSecret(app.value) : null;
    if (!creds || !repos.length) {
      await forget();
      if (repos.length) await this.auditMint({ ...audit, repos, refused: app ? "github_app isn't {\"app_id\", \"private_key\"} JSON" : "no GitHub App is configured (github_app)" });
      return null;
    }
    const api = githubApiOf(this.env);
    let jwt: string;
    try {
      jwt = await appJwt(creds.app_id, await importAppKey(creds.private_key));
    } catch {
      await forget();
      await this.auditMint({ ...audit, repos, refused: "github_app's private_key isn't an RSA private key (PKCS#1 or PKCS#8 PEM)" });
      return null;
    }
    // A lost answer throws (retryable): the caller tries again. Repos the App isn't on are left out.
    const byInstallation = new Map<number, string[]>();
    const missing: string[] = [];
    for (const r of repos) {
      const id = await this.installationOf(api, jwt, r);
      if (id === null) missing.push(r);
      else byInstallation.set(id, [...(byInstallation.get(id) ?? []), r]);
    }
    const best = [...byInstallation.entries()].sort((x, y) => y[1].length - x[1].length || x[1][0]!.localeCompare(y[1][0]!))[0];
    const installation: number | null = best ? best[0] : null;
    const covers: string[] = best ? best[1] : [];
    const others = repos.filter((r) => !covers.includes(r));
    if (others.length) {
      await this.auditMint({ ...audit, repos: others, refused: missing.length === others.length ? "the GitHub App isn't installed on these repos"
        : "these repos aren't in the one installation the token is minted for (or the App isn't installed on them)" });
    }
    if (installation === null) {
      await forget();
      return null;
    }
    let t: { token: string; expires_ms: number };
    try {
      t = await api.mint(jwt, installation, covers.map((r) => r.split("/")[1]!), permissions);
    } catch (e) {
      if (e instanceof NestError && !e.retryable) {
        await forget();
        await this.auditMint({ ...audit, repos: covers, installation, refused: e.detail });
      }
      throw e;
    }
    // Audited before anyone holds it: a mint whose record can't be written is never stored or pushed.
    await this.auditMint({ ...audit, repos: covers, installation, expires_ms: t.expires_ms });
    if (overtaken()) return null;
    await this.putSecret(name, t.token, t.expires_ms);
    this.sql.exec(`INSERT INTO injections (sandbox, binding, source, covers, expires_ms, minted_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sandbox, binding) DO UPDATE SET source = excluded.source, covers = excluded.covers, expires_ms = excluded.expires_ms, minted_ms = excluded.minted_ms`,
    target.sandbox, source.binding, key, JSON.stringify(covers), t.expires_ms, Date.now());
    await retire();
    return { binding: source.binding, value: secretRef(name), expires_ms: t.expires_ms, covers };
  }

  /** Forget a sandbox's minted secrets (it was destroyed). */
  async forgetInjections(sandbox: string): Promise<void> {
    for (const { binding } of this.sql.exec<{ binding: string }>("SELECT binding FROM injections WHERE sandbox = ?", sandbox).toArray()) {
      this.sql.exec("DELETE FROM secrets WHERE name = ?", `inject:${binding}:${sandbox}`);
    }
    this.sql.exec("DELETE FROM injections WHERE sandbox = ?", sandbox);
  }

  /** The App's installation on `repo` (lowercase), looked up and cached a day; null when it isn't installed there. */
  private async installationOf(api: GitHubApi, jwt: string, repo: string): Promise<number | null> {
    const known = this.sql.exec<{ installation: number; fetched_ms: number }>("SELECT installation, fetched_ms FROM github_installations WHERE repo = ?", repo).toArray()[0];
    if (known && Date.now() - known.fetched_ms < INSTALLATION_TTL_MS) return known.installation;
    const id = await api.installation(jwt, repo);
    if (id !== null) {
      this.sql.exec(`INSERT INTO github_installations (repo, installation, fetched_ms) VALUES (?, ?, ?)
        ON CONFLICT(repo) DO UPDATE SET installation = excluded.installation, fetched_ms = excluded.fetched_ms`, repo, id, Date.now());
    }
    return id;
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
    if (!/^cap:./.test(ref)) throw new NestError(ErrorCodes.FORBIDDEN, `${ref} is not a capability credential`, 403);
    return this.secret(ref)?.value ?? null;
  }

  /**
   * The operator's own GitHub token (`github_user`), for AgentDO's `github.fork`, the only caller: the
   * App can't fork from an account it isn't installed on. Never resolvable into a host command.
   */
  async githubUserToken(): Promise<string> {
    const s = this.secret("github_user");
    if (!s) throw new NestError(ErrorCodes.FORBIDDEN, "no GitHub user token is configured (github_user): forks need one", 409);
    return s.value;
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
    await this.putSecret(clientSecretKey(client, name), value);
    this.auditInBackground({ event: "client_secret_put", client, secret: name, size, replaced: !!cur });
    return this.clientSecretView(client, name)!;
  }

  /** Delete client `client`'s secret `name` (404 when it has none). A sandbox holding it loses it at its next push. */
  async deleteClientSecret(client: string, name: string): Promise<void> {
    const n = this.sql.exec("DELETE FROM client_secrets WHERE client = ? AND name = ?", client, name).rowsWritten;
    this.sql.exec("DELETE FROM secrets WHERE name = ?", clientSecretKey(client, name));
    if (!n) throw new NestError(ErrorCodes.NOT_FOUND, `no secret ${name}`, 404);
    this.auditInBackground({ event: "client_secret_deleted", client, secret: name });
  }

  /** Every secret of client `client`, by name: never a value. */
  async clientSecrets(client: string): Promise<ClientSecretView[]> {
    return this.sql.exec<{ name: string }>("SELECT name FROM client_secrets WHERE client = ? ORDER BY name", client).toArray()
      .map((r) => this.clientSecretView(client, r.name)!);
  }

  /** A deleted client's secrets, all of them. */
  async deleteClientSecrets(client: string): Promise<number> {
    const names = this.sql.exec<{ name: string }>("SELECT name FROM client_secrets WHERE client = ?", client).toArray().map((r) => r.name);
    for (const name of names) this.sql.exec("DELETE FROM secrets WHERE name = ?", clientSecretKey(client, name));
    this.sql.exec("DELETE FROM client_secrets WHERE client = ?", client);
    if (names.length) this.auditInBackground({ event: "client_secrets_deleted", client, secrets: names });
    return names.length;
  }

  /**
   * References to client `client`'s secrets for sandbox `sandbox`'s proxy (SandboxDO's push), one per
   * binding whose secret it has (a binding naming one it doesn't have gets none, and nest-proxy refuses
   * its placeholder). Only that client's own secrets: the name is looked up under its id alone. Each
   * push is audited (the bindings, secrets and hosts, never a value) before any reference is answered,
   * and marks each secret's `last_injected_ms`.
   */
  async clientInjectionRefs(client: string, sandbox: string, bindings: ClientInjectionRequest[], caller: string): Promise<InjectionSecret[]> {
    if (!isClientId(client)) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${client} is not a client`, 400);
    const held = bindings.filter((b) => this.clientSecretView(client, b.secret) && this.secret(clientSecretKey(client, b.secret)));
    if (!held.length) return [];
    await this.auditMint({ event: "client_secret_injected", client, sandbox, caller, bindings: held.map((b) => ({ binding: b.binding, secret: b.secret, hosts: b.hosts })) });
    const now = Date.now();
    for (const b of held) this.sql.exec("UPDATE client_secrets SET injected_ms = ? WHERE client = ? AND name = ?", now, client, b.secret);
    return held.map((b) => ({ binding: b.binding, value: secretRef(clientSecretKey(client, b.secret)) }));
  }

  private clientSecretView(client: string, name: string): ClientSecretView | undefined {
    const r = this.sql.exec<{ name: string; description: string | null; size: number; created_ms: number; updated_ms: number; injected_ms: number | null }>(
      "SELECT name, description, size, created_ms, updated_ms, injected_ms FROM client_secrets WHERE client = ? AND name = ?", client, name).toArray()[0];
    return r && { name: r.name, description: r.description, size: r.size, created_ms: r.created_ms, updated_ms: r.updated_ms, last_injected_ms: r.injected_ms };
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
    return await this.mintGithub(`${r}|${canonicalJson(permissions)}`, r, permissions, caller);
  }

  /**
   * An installation token an API client asked for (`POST /v1/clients/self/github-token`,
   * docs/control-plane/api/clients/#github-tokens): one repo, exactly these repository permissions.
   * The caller (the Worker) has held the request to the client's grant; this checks the shape again,
   * so no caller gets a token for every permission (none named) or for anything outside
   * `GITHUB_REPO_PERMISSIONS`. Cached per client, repo and permissions (never shared with another
   * client or an agent's action), reused while it has 10 minutes left; expired client tokens are
   * deleted here. Audited as every mint is, with `caller: {client}`.
   */
  async clientGithubToken(client: string, repo: string, permissions: GithubPermissions): Promise<{ token: string; expires_ms: number }> {
    const r = Repo.safeParse(repo);
    const p = GithubRepoPermissions.safeParse(permissions);
    if (!isClientId(client) || !r.success || !p.success || !Object.keys(p.data).length) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, "a client's GitHub token is for a cli_ client, one owner/name repo and at least one repository permission", 400);
    }
    this.sql.exec("DELETE FROM github_tokens WHERE key LIKE 'client:%' AND expires_ms <= ?", Date.now());
    const name = r.data.toLowerCase();
    return await this.mintGithub(`client:${client}|${name}|${canonicalJson(p.data)}`, name, p.data, { client });
  }

  /**
   * The GitHub App's identity, for API clients (docs/control-plane/api/clients/#github-tokens): its
   * numeric id (what a required status check pins to an App) and its slug. Not secret. Read with
   * `GET /app` and the App's JWT, kept a day per configured App, one lookup at a time. When GitHub
   * doesn't answer: what was read before, else the id its credentials name if that is the numeric one
   * (GitHub also takes the client id as the JWT's issuer), each kept 10 minutes; else null, and nobody
   * asks again for 10 minutes. Null too when no App is configured. Never throws for GitHub's sake.
   */
  async githubApp(): Promise<{ app_id: number; app_slug?: string } | null> {
    const app = this.secret("github_app");
    const creds = app ? parseAppSecret(app.value) : null;
    if (!creds) return null;
    const known = this.sql.exec<{ app_id: number; slug: string | null; expires_ms: number }>(
      "SELECT app_id, slug, expires_ms FROM github_app_identity WHERE configured = ?", creds.app_id).toArray()[0];
    const answer = (k: { app_id: number; slug: string | null }) => ({ app_id: k.app_id, ...(k.slug ? { app_slug: k.slug } : {}) });
    if (known && known.expires_ms > Date.now()) return answer(known);
    if ((this.appUnknownUntil.get(creds.app_id) ?? 0) > Date.now()) return null;
    // One lookup at a time per configured App: concurrent callers share it.
    let lookup = this.appLookups.get(creds.app_id);
    if (!lookup) {
      lookup = this.lookupApp(creds).finally(() => this.appLookups.delete(creds.app_id));
      this.appLookups.set(creds.app_id, lookup);
    }
    return await lookup;
  }

  /** {@link githubApp}'s `GET /app`, and what it keeps; never throws. */
  private async lookupApp(creds: { app_id: string; private_key: string }): Promise<{ app_id: number; app_slug?: string } | null> {
    const keep = (app_id: number, slug: string | null, ttl: number) => {
      this.sql.exec(`INSERT INTO github_app_identity (configured, app_id, slug, expires_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(configured) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, expires_ms = excluded.expires_ms`,
      creds.app_id, app_id, slug, Date.now() + ttl);
    };
    try {
      const jwt = await appJwt(creds.app_id, await importAppKey(creds.private_key));
      const a = await githubApiOf(this.env, APP_LOOKUP_TIMEOUT_MS).app(jwt);
      keep(a.id, a.slug, APP_IDENTITY_TTL_MS);
      return { app_id: a.id, app_slug: a.slug };
    } catch (e) {
      console.warn("BrokerDO: reading the GitHub App's identity (GET /app) failed", e instanceof Error ? e.message : e);
      // What it was is still what it is (an App's id never changes): served, and asked again later.
      const stale = this.sql.exec<{ app_id: number; slug: string | null }>(
        "SELECT app_id, slug FROM github_app_identity WHERE configured = ?", creds.app_id).toArray()[0];
      const id = /^[1-9][0-9]{0,15}$/.test(creds.app_id) && Number.isSafeInteger(Number(creds.app_id)) ? Number(creds.app_id) : null;
      if (stale && (id === null || stale.app_id === id)) {
        keep(stale.app_id, stale.slug, APP_IDENTITY_RETRY_MS);
        return { app_id: stale.app_id, ...(stale.slug ? { app_slug: stale.slug } : {}) };
      }
      if (id === null) {
        // Nothing to tell (a client id configured): callers don't each wait out GitHub meanwhile.
        this.appUnknownUntil.set(creds.app_id, Date.now() + APP_IDENTITY_RETRY_MS);
        return null;
      }
      keep(id, null, APP_IDENTITY_RETRY_MS);
      return { app_id: id };
    }
  }

  /**
   * The mint behind {@link githubToken} and {@link clientGithubToken}: the token cached under `key`
   * while it has 10 minutes left, else a new one for repo `r` (lowercase) with exactly `permissions`,
   * audited (with `caller`) before anyone holds it.
   */
  private async mintGithub(key: string, r: string, permissions: GithubPermissions, caller: unknown): Promise<{ token: string; expires_ms: number }> {
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
  /** `secrets_update.secrets[].value`: injection secrets for nest-proxy, the operator's and API clients'. */
  secrets_update: ["inject:", CLIENT_SECRET_PREFIX],
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
