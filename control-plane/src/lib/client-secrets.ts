// API clients' secrets and the injection bindings that use them (docs/control-plane/api/clients/#secrets,
// #injection). A client stores a secret in BrokerDO under its own namespace; a template, a spawn's
// overrides or a sandbox spec in its subtree declares a binding naming the secret, hosts inside the
// grant's `inject_hosts` and where the credential goes. The sandbox sees only a placeholder nest assigns;
// nest-proxy substitutes the value on those hosts only, as for the operator's bindings: on the wire a
// client's binding is an ordinary `InjectionBinding` (no host change). Pure.
import { z } from "zod";
import { hostPatternMatches, type InjectionBinding } from "../protocol/model";

/** A client's secret name: its own namespace, never another's or the operator's. */
export const ClientSecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/,
  "a secret name is 1-63 lowercase letters, digits, '_' and '-', starting with a letter");
/** `PUT /v1/clients/self/secrets/<name>`'s body. The value is write-only: never answered, logged or audited. */
export const ClientSecretPut = z.strictObject({
  value: z.string().min(1),
  description: z.string().max(500).optional(),
  /**
   * When the value stops being injected: an RFC 3339 time with an offset (e.g. GitHub's `expires_at`).
   * nest-proxy refuses the binding's placeholder from then on. Absent: it never expires.
   */
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
/** Where BrokerDO keeps a client's secret value (its `secrets` table): only `secrets_update` resolves the prefix. */
export const CLIENT_SECRET_PREFIX = "client-secret:";
export const clientSecretKey = (client: string, name: string) => `${CLIENT_SECRET_PREFIX}${client}:${name}`;
/** A grant's default ceiling on secrets: none stored, 4 KiB each. */
export const SECRET_MAX_BYTES_DEFAULT = 4096;

// --- hosts ----------------------------------------------------------------------------------------------

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A DNS name of at least two labels, lowercase, no trailing dot (no IP literal: a credential goes to a name). */
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const hostOk = (h: string) => {
  const name = h.startsWith("*.") ? h.slice(2) : h;
  // Never a numeric host in any form a resolver parses as an address (`127.0.0.1`, `127.0.0.0x1`,
  // `0x7f.0x1`, octal): a top-level label always starts with a letter, and every number form a digit.
  return h.length <= 253 && HOSTNAME.test(name) && /^[a-z]/.test(name.slice(name.lastIndexOf(".") + 1));
};

/**
 * A host a client's secrets may be injected into (a grant's `inject_hosts`) or a binding names: an exact
 * name, or `*.` and a name of at least two labels (`*.example.com`, never `*.com`), lowercase.
 */
export const InjectHost = z.string().refine(hostOk, "an inject host is a lowercase DNS name of two or more labels, or *. followed by one");

/**
 * Whether `host` (a binding's: exact, or `*.` wildcard) is inside `entries` (a grant's `inject_hosts`):
 * an exact host under an exact entry or a wildcard entry it matches; a wildcard host only under a
 * wildcard entry whose suffix is its own or a parent of it.
 */
export function injectHostAllowed(entries: readonly string[], host: string): boolean {
  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    return entries.some((e) => e.startsWith("*.") && (suffix === e.slice(2) || suffix.endsWith(`.${e.slice(2)}`)));
  }
  return entries.some((e) => e === host || (e.startsWith("*.") && hostPatternMatches(e, host)));
}

// --- bindings -------------------------------------------------------------------------------------------

/** A binding's name: no `-` or `.`, so no placeholder nest assigns can contain another (see `injectionPlaceholder`). */
export const InjectionName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "a binding name is 1-32 lowercase letters, digits and '_', starting with a letter");

/**
 * Headers a credential may never be substituted into (docs/sandbox/networking/egress/injection/#scope):
 * they would change routing or framing after the proxy checked it, and the routing overrides nest-proxy
 * strips (docs/sandbox/networking/egress/inspection/): `Fastly-*` except `Fastly-Key`, and the generic ones.
 */
const RESERVED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive",
  "proxy-authorization", "proxy-authenticate", "proxy-connection", "http2-settings",
  "forwarded", "x-forwarded-host", "x-host", "x-original-url", "x-rewrite-url"]);
const reservedHeader = (h: string) => RESERVED_HEADERS.has(h) || (h.startsWith("fastly-") && h !== "fastly-key");
const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "a header name is an HTTP token of 1-64 characters")
  .refine((h) => !reservedHeader(h.toLowerCase()), "that header is reserved: a credential can't go there");

/** Where the credential goes: the existing locations (`protocol/model.ts` `InjectionLocation`), a header's name checked. */
export const ClientInjectionLocation = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("authorization_bearer") }),
  z.strictObject({ type: z.literal("authorization_basic_password") }),
  z.strictObject({ type: z.literal("header"), name: HeaderName }),
]);
export type ClientInjectionLocation = z.output<typeof ClientInjectionLocation>;

/**
 * A client's injection binding: the existing binding's `name`, `hosts` and `locations`, plus `secret`
 * (one of its own secrets' names) and `wildcard` (a `*.` host needs it, as the operator's do). No
 * `placeholder`: nest assigns it (`injectionPlaceholder`) and shows it in the spec and the policy.
 */
export const ClientInjection = z.strictObject({
  name: InjectionName,
  secret: ClientSecretName,
  hosts: z.array(InjectHost).min(1).max(16),
  locations: z.array(ClientInjectionLocation).min(1).max(3),
  wildcard: z.boolean().optional(),
}).superRefine((b, ctx) => {
  if (new Set(b.hosts).size !== b.hosts.length) ctx.addIssue({ code: "custom", message: `binding ${b.name}: a host is listed twice` });
  if (!b.wildcard && b.hosts.some((h) => h.startsWith("*."))) ctx.addIssue({ code: "custom", message: `binding ${b.name}: a *. host needs wildcard: true (it reaches every subdomain, third parties' too)` });
  const locs = b.locations.map(locationKey);
  if (new Set(locs).size !== locs.length) ctx.addIssue({ code: "custom", message: `binding ${b.name}: a location is listed twice` });
});
export type ClientInjection = z.output<typeof ClientInjection>;
/** A spec's list: at most 16, each name once. */
export const ClientInjections = z.array(ClientInjection).max(16).refine((l) => new Set(l.map((b) => b.name)).size === l.length, "a binding name is listed twice");

const locationKey = (l: ClientInjectionLocation) => (l.type === "header" ? `header:${l.name.toLowerCase()}` : l.type);

/** A binding as a spec or sandbox keeps it: whose it is (the client whose namespace declared it) and its placeholder. */
export interface HeldInjection extends ClientInjection {
  client: string;
  placeholder: string;
}

/**
 * The placeholder of client `client`'s binding `name`: `nest-ph.<client>.<name>.`. Fixed, so a client
 * knows it before the sandbox exists. No assigned placeholder contains another, nor the GitHub ones
 * (`nest-ph-github`, `nest-ph-read-github`): nest-proxy finds a placeholder as a substring, and a name
 * (`InjectionName`) or a client id holds no `.` or `-`.
 */
export const injectionPlaceholder = (client: string, name: string) => `nest-ph.${client}.${name}.`;
/** Its name in the wire policy: apart from the operator's and the constructed ones (`github`, …). */
export const CLIENT_BINDING_PREFIX = "client:";
export const injectionWireName = (name: string) => `${CLIENT_BINDING_PREFIX}${name}`;

export const holdInjections = (client: string, list: readonly ClientInjection[]): HeldInjection[] =>
  list.map((b) => ({ ...b, hosts: [...b.hosts], locations: b.locations.map((l) => ({ ...l })), client, placeholder: injectionPlaceholder(client, b.name) }));

/** A binding as nest-proxy reads it (`InjectionBinding`): what was declared, under its wire name. */
export const wireBinding = (b: HeldInjection): InjectionBinding => ({
  name: injectionWireName(b.name), hosts: [...b.hosts], placeholder: b.placeholder, locations: b.locations.map((l) => ({ ...l })),
});

/** What a list of bindings injects outside a grant's `inject_hosts`. Empty: within it. */
export function injectionsOutsideGrant(list: readonly Pick<ClientInjection, "name" | "hosts">[], injectHosts: readonly string[]): string[] {
  return list.flatMap((b) => b.hosts.filter((h) => !injectHostAllowed(injectHosts, h)).map((h) => `inject host ${h} (binding ${b.name})`));
}

/**
 * Attenuation: `asked` (a spawn's overrides) replaces `base` (the template's) only by narrowing it.
 * Each binding names one of the base's, with the same secret, a subset of its hosts and locations,
 * and no wildcard it didn't have. Absent: the base's.
 */
export function narrowInjections(base: readonly HeldInjection[], asked: readonly ClientInjection[] | undefined):
  { ok: true; value: HeldInjection[] } | { ok: false; error: string } {
  if (!asked) return { ok: true, value: [...base] };
  const out: HeldInjection[] = [];
  for (const a of asked) {
    const b = base.find((x) => x.name === a.name);
    if (!b) return { ok: false, error: `can't add the binding ${a.name}` };
    if (a.secret !== b.secret) return { ok: false, error: `binding ${a.name}: can't change its secret` };
    const wider = a.hosts.filter((h) => !b.hosts.includes(h));
    if (wider.length) return { ok: false, error: `binding ${a.name}: can't widen its hosts with ${wider.join(", ")}` };
    const locs = new Set(b.locations.map(locationKey));
    if (a.locations.some((l) => !locs.has(locationKey(l)))) return { ok: false, error: `binding ${a.name}: can't add a location` };
    if (a.wildcard && !b.wildcard) return { ok: false, error: `binding ${a.name}: can't add wildcard` };
    // The asked one's own hosts, locations and wildcard flag (it needs one for a `*.` host, as parsed).
    const { wildcard: _w, ...kept } = b;
    out.push({ ...kept, hosts: [...a.hosts], locations: a.locations.map((l) => ({ ...l })), ...(a.wildcard ? { wildcard: true } : {}) });
  }
  return { ok: true, value: out };
}
