// A project's secrets (README.md#secrets): what the app keeps of each (never a value: values go to nest
// at once, write-only, docs/control-plane/api/clients/#secrets), how each becomes an injection binding
// on the sandboxes of the roles it's for (docs/control-plane/api/clients/#injection), and the checks
// against nest's rules and the client's grant. Pure, so the API, ProjectDO and the form share them.

export const SECRET_ROLES = ["worker", "manager", "reviewer"] as const;
export type SecretRole = (typeof SECRET_ROLES)[number];

/** A location nest-proxy writes the value into (`ClientInjection.locations`). */
export type SecretLocation = { type: "authorization_bearer" } | { type: "authorization_basic_password" } | { type: "header"; name: string };

/** What the app keeps of a secret: everything but its value. */
export interface SecretMeta {
  name: string;
  description: string;
  hosts: string[];
  locations: SecretLocation[];
  roles: SecretRole[];
  /** Its value's size in bytes, as last set (nest's `size`). */
  size: number | null;
  created_ms: number;
  updated_ms: number;
}

/** The client's grant, as `GET /v1/clients/self` answers it, in the parts secrets need. */
export interface SecretGrant {
  inject_hosts: string[];
  max_count: number;
  max_bytes: number;
  workflows: boolean;
}

/**
 * A project-local name: also the binding's name (`[a-z][a-z0-9_]{0,31}` in nest) and, after the project's
 * id, the nest secret's (`[a-z][a-z0-9_-]{0,62}`): `prj_<16>-` leaves room for 31 characters.
 */
export const SECRET_NAME = /^[a-z][a-z0-9_]{0,30}$/;
/** nest's limits on a binding (docs/control-plane/api/clients/#injection). */
export const MAX_HOSTS = 16;
export const MAX_LOCATIONS = 3;
export const MAX_BINDINGS = 16;

/** The nest secret's name: project-scoped, so two projects' `npm_token`s don't collide. */
export const nestSecretName = (project: string, name: string) => `${project}-${name}`;

/** The placeholder nest assigns a binding (`nest-ph.<client id>.<name>.`, with its trailing dot). */
export const placeholder = (client: string, name: string) => `nest-ph.${client}.${name}.`;

/** The environment variable the brief suggests for it: `npm_token` → `NPM_TOKEN`. */
export const envName = (name: string) => name.toUpperCase();

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IP = /^\d+(?:\.\d+){3}$/;
/** An HTTP token (RFC 9110), and the headers nest-proxy won't write a secret into. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const RESERVED = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "http2-settings"]);

/** Whether the grant's `inject_hosts` covers `host`: exactly, or by a `*.` entry at least as wide. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    if (a === host) return true;
    if (!a.startsWith("*.")) return false;
    const base = a.slice(1); // ".example.com"
    return host.startsWith("*.") ? host.slice(1).endsWith(base) : host.endsWith(base) && host.length > base.length;
  });
}

/** Each problem with a secret's settings, by field, against nest's rules and the grant; empty when none. */
export function secretProblems(m: Pick<SecretMeta, "name" | "hosts" | "locations" | "roles">, grant: SecretGrant | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!SECRET_NAME.test(m.name)) out.name = "Lowercase letters, digits and _, starting with a letter, at most 31";
  if (m.hosts.length < 1 || m.hosts.length > MAX_HOSTS) out.hosts = `1 to ${MAX_HOSTS} hosts`;
  else {
    const bad = m.hosts.find((h) => !HOST.test(h) || IP.test(h) || (h.startsWith("*.") && h.split(".").length < 3));
    if (bad) out.hosts = `${bad} isn't a host name (a *. host needs two labels after it, like *.example.com)`;
    else if (grant) {
      const outside = m.hosts.filter((h) => !hostAllowed(h, grant.inject_hosts));
      if (outside.length) {
        out.hosts = `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the hosts this app may inject into (${grant.inject_hosts.join(", ") || "none"}): the operator must widen the grant's inject_hosts`;
      }
    }
  }
  if (m.locations.length < 1 || m.locations.length > MAX_LOCATIONS) out.locations = `1 to ${MAX_LOCATIONS} locations`;
  else {
    const h = m.locations.find((l) => l.type === "header" && (!TOKEN.test(l.name) || RESERVED.has(l.name.toLowerCase())));
    if (h && h.type === "header") out.locations = `${h.name || "(empty)"} can't carry a secret: a header name, not ${[...RESERVED].slice(0, 3).join(", ")}…`;
  }
  if (m.roles.length === 0) out.roles = "At least one role";
  return out;
}

/** A value's problem against the grant's size limit, or null. */
export function valueProblem(value: string, grant: SecretGrant | null): string | null {
  if (value.length === 0) return "A value";
  const bytes = new TextEncoder().encode(value).length;
  if (grant && bytes > grant.max_bytes) return `${bytes} bytes: at most ${grant.max_bytes} (the grant's secrets.max_bytes)`;
  return null;
}

/** The binding a secret makes on a sandbox (`ClientInjection`). */
export function bindingOf(project: string, m: Pick<SecretMeta, "name" | "hosts" | "locations">) {
  return {
    name: m.name, secret: nestSecretName(project, m.name), hosts: [...m.hosts], locations: m.locations.map((l) => ({ ...l })),
    ...(m.hosts.some((h) => h.startsWith("*.")) ? { wildcard: true } : {}),
  };
}

export type Binding = ReturnType<typeof bindingOf>;

const LOCATION_LABEL = (l: SecretLocation) =>
  l.type === "authorization_bearer" ? "Authorization: Bearer <placeholder>" : l.type === "authorization_basic_password" ? "the password of Basic auth" : `the ${l.name} header`;

/**
 * The part of an agent's brief that names its credentials: each placeholder, what it's for, and where it
 * works. Names and hosts only: values never reach the app, let alone a brief.
 */
export function secretsBrief(client: string, secrets: readonly Pick<SecretMeta, "name" | "description" | "hosts" | "locations">[]): string {
  if (secrets.length === 0) return "";
  return [
    "",
    "Credentials: nest's egress proxy injects these; your sandbox holds placeholders, never values. Use a placeholder exactly where its value would go; it works only against its hosts.",
    ...secrets.map((s) => `- ${envName(s.name)}=${placeholder(client, s.name)}${s.description ? ` (${s.description})` : ""}: on ${s.hosts.join(", ")}, as ${s.locations.map(LOCATION_LABEL).join(" or ")}.`),
    "Export them as those variables if a tool reads one. Never ask anyone for a secret's value; if you need a credential you don't have, call request_secret.",
  ].join("\n");
}

/** Presets for the form's host picker (README.md#secrets). */
export const SECRET_PRESETS = [
  { value: "cloudflare", label: "Cloudflare API", hosts: ["api.cloudflare.com"], location: { type: "authorization_bearer" } as SecretLocation, note: null },
  { value: "npm", label: "npm registry", hosts: ["registry.npmjs.org"], location: { type: "authorization_bearer" } as SecretLocation, note: null },
  { value: "pypi", label: "PyPI upload", hosts: ["upload.pypi.org"], location: { type: "authorization_basic_password" } as SecretLocation, note: "PyPI takes a token as the password, with the user name __token__." },
  {
    value: "github", label: "GitHub API", hosts: ["api.github.com"], location: { type: "authorization_bearer" } as SecretLocation,
    note: "nest already brokers GitHub for the project's repo: its sandboxes push and read through it with a token of their own. Add one only for another account's API, and prefer the brokered one.",
  },
  { value: "custom", label: "Custom", hosts: [], location: { type: "authorization_bearer" } as SecretLocation, note: null },
] as const;
