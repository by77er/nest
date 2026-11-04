// A project's network rules (README.md#network): per role, the hosts its agents' sandboxes may reach on
// top of the operator's policy, as nest's client egress rules (docs/control-plane/api/clients/#egress),
// within the client's grant's `egress_hosts`. And `clientLayerFor`, the one function that builds a
// sandbox's whole client layer (`PUT /v1/sandboxes/<id>/client-policy` replaces it whole) from every
// page that feeds it. Pure, so the API, ProjectDO and the page share them.

export const NETWORK_ROLES = ["worker", "manager"] as const;
export type NetworkRole = (typeof NETWORK_ROLES)[number];

/** One allow rule, nest's shape: a host, and its ports (absent: 80 and 443). */
export interface EgressRule {
  host: string;
  ports?: number[];
}
export type RoleRules = Record<NetworkRole, EgressRule[]>;
export const NO_RULES: RoleRules = { worker: [], manager: [] };

/** nest's limits (`ClientEgress`): 64 rules, each host once, 1-16 ports. */
export const MAX_RULES = 64;
export const MAX_PORTS = 16;
export const WEB_PORTS = [80, 443] as const;

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Whether a grant's `egress_hosts` covers `host`: exactly, or by a `*.` entry at least as wide (nest's `injectHostAllowed`). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    if (a === host) return true;
    if (!a.startsWith("*.")) return false;
    const base = a.slice(1); // ".example.com"
    return host.startsWith("*.") ? host.slice(1).endsWith(base) : host.endsWith(base) && host.length > base.length;
  });
}

/** Presets for the page (each a set of hosts on the web ports), and custom. */
export const NETWORK_PRESETS = [
  { value: "npm", label: "npm", hosts: ["registry.npmjs.org"] },
  { value: "node", label: "Node downloads", hosts: ["nodejs.org"] },
  { value: "pypi", label: "PyPI", hosts: ["pypi.org", "files.pythonhosted.org"] },
  { value: "crates", label: "crates.io", hosts: ["crates.io", "static.crates.io", "index.crates.io"] },
  { value: "go", label: "Go modules", hosts: ["proxy.golang.org", "sum.golang.org"] },
  { value: "docker", label: "Docker Hub", hosts: ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"] },
  { value: "github-releases", label: "GitHub releases", hosts: ["objects.githubusercontent.com"] },
] as const;

/**
 * Each problem with a role's rules, against nest's rules and the grant (`egress_hosts`, null when it
 * couldn't be read: nest checks it again). Keyed by host (or `rules` for the list).
 */
/** A host outside the grant's `egress_hosts`, as the page and the API say it. */
export const OUTSIDE = "isn't in this app's grant; the operator must add it";

export function rulesProblems(rules: readonly EgressRule[], egressHosts: readonly string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (rules.length > MAX_RULES) out.rules = `At most ${MAX_RULES} hosts`;
  const seen = new Set<string>();
  for (const r of rules) {
    const h = r.host;
    if (seen.has(h)) out[h] = `${h} is listed twice`;
    seen.add(h);
    if (!HOST.test(h) || (h.startsWith("*.") && h.split(".").length < 3)) out[h] = `${h || "(empty)"} isn't a host name (a *. host needs two labels after it, like *.example.com)`;
    else if (r.ports !== undefined && (r.ports.length < 1 || r.ports.length > MAX_PORTS || r.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65_535))) {
      out[h] = `${h}: 1 to ${MAX_PORTS} ports, each 1 to 65535`;
    } else if (egressHosts && !hostAllowed(h, egressHosts)) {
      out[h] = `${h} ${OUTSIDE}`;
    }
  }
  return out;
}

/** Rules as stored and sent: each host once, lowercase, ports sorted (absent for the web ports). */
export function normalizeRules(rules: readonly EgressRule[]): EgressRule[] {
  return rules.map((r) => {
    const ports = r.ports ? [...new Set(r.ports)].sort((a, b) => a - b) : undefined;
    const web = ports && ports.length === WEB_PORTS.length && ports.every((p, i) => p === WEB_PORTS[i]);
    return { host: r.host.trim().toLowerCase(), ...(ports && !web ? { ports } : {}) };
  });
}

/** Where a binding's credential goes (nest's `ClientInjectionLocation`). */
export type BindingLocation = { type: "authorization_bearer" } | { type: "authorization_basic_password" } | { type: "header"; name: string };

/** A client's injection binding as `PUT …/client-policy` takes it (nest's `ClientInjection`, a strict object). */
export interface Binding {
  name: string;
  secret: string;
  hosts: string[];
  locations: BindingLocation[];
  wildcard?: boolean;
}

/**
 * A binding as `GET …/client-policy` answers it (nest's `HeldInjection`): the PUT shape plus whose it is
 * and the placeholder nest assigned (`nest-ph.<client>.<name>.`), which the PUT refuses.
 */
export interface HeldBinding extends Binding {
  client?: string;
  placeholder?: string;
}

/** A sandbox's client layer, nest's `PUT …/client-policy` body (every part present: an absent one is emptied). */
export interface ClientLayer {
  egress: { allow: EgressRule[] };
  inject: Binding[];
  env: Record<string, string>;
}

/** A sandbox's client layer as `GET …/client-policy` answers it. */
export interface HeldClientLayer {
  egress: { allow: EgressRule[] };
  inject: HeldBinding[];
  env: Record<string, string>;
}

/** A held binding back in the PUT's shape: nest's strict schema refuses `client` and `placeholder`. */
export function asBinding(b: HeldBinding): Binding {
  return { name: b.name, secret: b.secret, hosts: [...b.hosts], locations: b.locations.map((l) => ({ ...l })), ...(b.wildcard !== undefined ? { wildcard: b.wildcard } : {}) };
}

/**
 * What feeds a sandbox's client layer besides the network rules: a role's injection bindings and
 * environment (the Secrets page's, README.md#secrets). Absent: that page doesn't manage them for the
 * role, so the layer keeps what the sandbox has now (its create's, or the last write's).
 */
export interface LayerFeeds {
  inject?: Binding[];
  env?: Record<string, string>;
}

/**
 * The one way the app builds a sandbox's whole client layer, since nest replaces it whole: the
 * network rules for its role, and each other part from its feed, else as the sandbox has it now. So a
 * network change never drops a secret's binding, and a secrets change never drops a host. A kept
 * binding goes back in the PUT's shape, its placeholder (nest's, and unchanged) left for nest to assign.
 */
export function clientLayerFor(rules: RoleRules, role: NetworkRole, feeds: LayerFeeds, current: HeldClientLayer | null): ClientLayer {
  return {
    egress: { allow: normalizeRules(rules[role]) },
    inject: (feeds.inject ?? current?.inject ?? []).map(asBinding),
    env: feeds.env ?? current?.env ?? {},
  };
}

/** One allow rule of a sandbox's effective policy (`GET /v1/sandboxes/<id>/policy`): its layer, and where it came from. */
export interface PolicyAllow {
  host: string;
  ports?: number[];
  layer?: string;
  /** nest's `source` (docs/sandbox/networking/egress/policy/#sources); absent from an older control plane. */
  source?: string;
}

/**
 * A rule the operator's side of a sandbox's policy allows, by its source: nest's defaults (`base`), the
 * operator's layer (`operator`), or the rules nest builds from the repo allowlists (`repos`).
 */
export interface OperatorRule {
  host: string;
  ports: number[];
  source: "base" | "operator" | "repos";
}

const OPERATOR_SOURCES: readonly string[] = ["base", "operator", "repos"];

/**
 * The operator's rules in a sandbox's effective policy, read-only on the page: those whose `source` is
 * `base`, `operator` or `repos`. The app's own (`client`) are the role editors', and temporary grants
 * (`grant`) are left out.
 *
 * Fallback, while a control plane answers no `source` (before nest's #sources; delete it once every
 * one does): there `layer` is `base` for nest's defaults, `sandbox` for grants, and `workstream` for the
 * rest, the client's own among them. So the operator's are those less one per rule of the client's own
 * layer (`own`, from `GET …/client-policy`, compiled as nest does: no ports is 80 and 443), and the
 * repo allowlists' can't be told from the operator's.
 */
export function operatorRules(allow: readonly PolicyAllow[], own: readonly EgressRule[]): OperatorRule[] {
  if (allow.some((r) => r.source !== undefined)) {
    return allow
      .filter((r) => r.source !== undefined && OPERATOR_SOURCES.includes(r.source))
      .map((r) => ({ host: r.host, ports: [...(r.ports ?? WEB_PORTS)], source: r.source as OperatorRule["source"] }));
  }
  const key = (host: string, ports: readonly number[] | undefined) => `${host} ${[...(ports ?? WEB_PORTS)].sort((a, b) => a - b).join(",")}`;
  const mine = new Map<string, number>();
  for (const r of own) mine.set(key(r.host, r.ports), (mine.get(key(r.host, r.ports)) ?? 0) + 1);
  const out: OperatorRule[] = [];
  for (const r of allow) {
    const ports = [...(r.ports ?? WEB_PORTS)];
    if (r.layer === "base") {
      out.push({ host: r.host, ports, source: "base" });
    } else if (r.layer === "workstream") {
      const k = key(r.host, r.ports);
      const n = mine.get(k) ?? 0;
      if (n > 0) mine.set(k, n - 1);
      else out.push({ host: r.host, ports, source: "operator" });
    }
  }
  return out;
}
