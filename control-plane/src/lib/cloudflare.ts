// The Cloudflare API calls the control plane makes for sandbox hosts (docs/sandbox/gateway/,
// Addressing): one Cloudflare Tunnel and one proxied DNS record per sandbox host, created at
// enrollment and deleted when the host dies; a daily sweep removes leaks. Every URL and body is
// here and nowhere else; FleetDO talks to the `CloudflareApi` interface so tests inject a fake.
//
// Names: with NEST_DOMAIN `nest.bitcru.sh`, the label is `nest` and the zone `bitcru.sh`; a host
// `hst_01abc` gets the tunnel `nest-01abc` and the hostname `01abc-gw-nest.bitcru.sh`. Cleanup and
// the sweep match only these shapes: the account holds tunnels and records that are not nest's.
import type { Env } from "../env";
import { ErrorCodes } from "../protocol/model";
import { NestError } from "./util";

export const API_BASE = "https://api.cloudflare.com/client/v4";
/** Every call is bounded; a slow API must not hold an enrollment or a tick. */
export const CALL_TIMEOUT_MS = 10_000;
/** The gateway listens on loopback; cloudflared on the host forwards the hostname to it. */
export const GATEWAY_SERVICE = "http://127.0.0.1:18790";

export interface TunnelConfig {
  token: string;
  accountId: string;
  /** NEST_DOMAIN, e.g. `nest.bitcru.sh`. */
  domain: string;
}

/** The configuration, or `null` when any part is missing (the harness, tests): then no tunnels exist. */
export function tunnelConfig(env: Pick<Env, "CLOUDFLARE_TUNNEL_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID" | "NEST_DOMAIN">): TunnelConfig | null {
  const { CLOUDFLARE_TUNNEL_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, NEST_DOMAIN: domain } = env;
  return token && accountId && domain ? { token, accountId, domain } : null;
}

/** `nest.bitcru.sh` → the label `nest` and the zone `bitcru.sh`. */
export function splitDomain(domain: string): { label: string; zone: string } {
  const dot = domain.indexOf(".");
  if (dot <= 0 || dot === domain.length - 1) throw new NestError(ErrorCodes.INTERNAL, `NEST_DOMAIN must be <label>.<zone>, not ${domain}`);
  return { label: domain.slice(0, dot), zone: domain.slice(dot + 1) };
}

/** The body of a host id: 26 Crockford base32 characters (`newId` in util.ts). Nothing else is a host. */
export const HOST_ID_BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;
/** The host id without its prefix: `hst_01abc…` → `01abc…`. */
export const hostLabel = (host: string) => host.replace(/^hst_/, "");
export const tunnelPrefix = (label: string) => `${label}-`;
export const tunnelName = (label: string, host: string) => `${tunnelPrefix(label)}${hostLabel(host)}`;
export const hostnameSuffix = (label: string, zone: string) => `-gw-${label}.${zone}`;
export const gatewayHostname = (label: string, zone: string, host: string) => `${hostLabel(host)}${hostnameSuffix(label, zone)}`;

/** The host id a nest tunnel name or hostname belongs to, or `null` for anything that is not nest's. */
export function hostOfTunnelName(label: string, name: string): string | null {
  const p = tunnelPrefix(label);
  return name.startsWith(p) && HOST_ID_BODY.test(name.slice(p.length)) ? `hst_${name.slice(p.length)}` : null;
}
export function hostOfHostname(label: string, zone: string, name: string): string | null {
  const s = hostnameSuffix(label, zone);
  const id = name.endsWith(s) ? name.slice(0, -s.length) : "";
  return HOST_ID_BODY.test(id) ? `hst_${id}` : null;
}

/** How many pages of 100 a listing reads at most. */
export const LIST_MAX_PAGES = 10;

/** A listing; `complete` is false when it stopped at `LIST_MAX_PAGES` with more pages left. */
export interface Listing {
  items: { id: string; name: string }[];
  complete: boolean;
}

export interface CloudflareApi {
  zoneId(zone: string): Promise<string>;
  /** A remotely managed tunnel; the token is what cloudflared runs with. */
  createTunnel(name: string): Promise<{ id: string; token: string }>;
  /** Route `hostname` to the gateway on the host, everything else to 404. */
  configureIngress(tunnelId: string, hostname: string): Promise<void>;
  /** Cleans up stale connections first; throws (retryable) while connections are still active. Already gone is success. */
  deleteTunnel(tunnelId: string): Promise<void>;
  listTunnels(namePrefix: string): Promise<Listing>;
  createRecord(zoneId: string, hostname: string, tunnelId: string, comment: string): Promise<{ id: string }>;
  listRecords(zoneId: string, hostnameSuffix: string): Promise<Listing>;
  /** Already gone is success. */
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

type ApiEnvelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result: T };

/** A Cloudflare call that failed. `status` is the HTTP status (0: no response), so a caller can tell a revoked token (401/403) from an outage. */
export class CloudflareError extends NestError {
  constructor(message: string, readonly httpStatus: number, retryable: boolean) {
    super(ErrorCodes.INTERNAL, message, 502, retryable);
  }
  /** The token is revoked, expired or lacks a permission: no retry will help until an operator acts. */
  get unauthorized(): boolean {
    return this.httpStatus === 401 || this.httpStatus === 403;
  }
}

export class CloudflareHttp implements CloudflareApi {
  constructor(private readonly cfg: TunnelConfig, private readonly fetchFn: typeof fetch = fetch, private readonly base = API_BASE) {}

  /**
   * One API call. `notFoundOk` makes a 404 a success (a delete of something already gone); the
   * result is then `undefined`. Errors are `NestError` 502, retryable on 429, 5xx or when asked.
   */
  private async call<T>(method: string, path: string, body?: unknown, opts: { retryable?: boolean; notFoundOk?: boolean } = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    let res: Response;
    try {
      // Never `this.fetchFn(...)`: the global fetch called as a method of this object gets the
      // wrong `this` and workerd throws "Illegal invocation" (a fake fetch does not, which is why
      // only the live Worker saw it; `the default fetch works under workerd` is the test).
      const fetchFn = this.fetchFn;
      res = await fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new CloudflareError(`cloudflare ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 && opts.notFoundOk) return undefined as T;
    let env: ApiEnvelope<T> | null = null;
    try {
      env = (await res.json()) as ApiEnvelope<T>;
    } catch {
      // a non-JSON body: reported by status below
    }
    // Some responses (a DNS record delete) carry `result` with no `success` field: a 2xx with a
    // parsed envelope that does not say `success: false` is a success.
    if (!res.ok || !env || env.success === false) {
      const messages = (env?.errors ?? []).map((e) => (e.code ? `${e.code}: ${e.message ?? ""}` : e.message ?? "")).join("; ");
      throw new CloudflareError(`cloudflare ${method} ${path}: HTTP ${res.status}${messages ? ` (${messages})` : ""}`, res.status,
        !!opts.retryable || res.status === 429 || res.status >= 500);
    }
    return env.result;
  }

  private get account(): string {
    return `/accounts/${this.cfg.accountId}`;
  }

  async zoneId(zone: string): Promise<string> {
    const zones = await this.call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(zone)}`);
    const z = zones.find((x) => x.name === zone);
    if (!z) throw new NestError(ErrorCodes.INTERNAL, `cloudflare: zone ${zone} is not on this account`, 502);
    return z.id;
  }

  async createTunnel(name: string): Promise<{ id: string; token: string }> {
    const t = await this.call<{ id: string; token?: unknown }>("POST", `${this.account}/cfd_tunnel`, { name, config_src: "cloudflare" });
    // The token is the one thing the host needs; a response without it must not look like success
    // (the host would run no cloudflared while resolve points brains at its hostname).
    if (typeof t.token !== "string" || !t.token) throw new NestError(ErrorCodes.INTERNAL, `cloudflare: tunnel ${t.id} was created without a token`, 502);
    return { id: t.id, token: t.token };
  }

  async configureIngress(tunnelId: string, hostname: string): Promise<void> {
    await this.call("PUT", `${this.account}/cfd_tunnel/${tunnelId}/configurations`, {
      config: { ingress: [{ hostname, service: GATEWAY_SERVICE }, { service: "http_status:404" }] },
    });
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    // Stale connections from a terminated host linger for a while; cleaning them lets the delete
    // succeed sooner. A failure here is not the delete's failure.
    await this.call("DELETE", `${this.account}/cfd_tunnel/${tunnelId}/connections`).catch(() => undefined);
    await this.call("DELETE", `${this.account}/cfd_tunnel/${tunnelId}`, undefined, { retryable: true, notFoundOk: true });
  }

  async listTunnels(namePrefix: string): Promise<Listing> {
    const items: { id: string; name: string }[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const tunnels = await this.call<{ id: string; name: string }[]>("GET", `${this.account}/cfd_tunnel?is_deleted=false&per_page=100&page=${page}`);
      items.push(...tunnels.filter((t) => t.name.startsWith(namePrefix)));
      if (tunnels.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  async createRecord(zoneId: string, hostname: string, tunnelId: string, comment: string): Promise<{ id: string }> {
    const r = await this.call<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, {
      type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment,
    });
    return { id: r.id };
  }

  async listRecords(zoneId: string, suffix: string): Promise<Listing> {
    const items: { id: string; name: string }[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const records = await this.call<{ id: string; name: string; type: string }[]>(
        "GET", `/zones/${zoneId}/dns_records?type=CNAME&name.endswith=${encodeURIComponent(suffix)}&per_page=100&page=${page}`);
      items.push(...records.filter((r) => r.name.endsWith(suffix)).map((r) => ({ id: r.id, name: r.name })));
      if (records.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call("DELETE", `/zones/${zoneId}/dns_records/${recordId}`, undefined, { retryable: true, notFoundOk: true });
  }
}
