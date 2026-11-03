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
  /** The environment variable that holds its placeholder in the sandboxes of its roles. */
  env: string;
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

/** The environment variable the form suggests for a name: `npm_token` → `NPM_TOKEN`. */
export const envName = (name: string) => name.toUpperCase();

/** nest's environment names (docs/control-plane/api/clients/#environment), and the ones nest or the guest sets. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TERM", "HOSTNAME", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "GITHUB_TOKEN",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO",
]);

/** Why `name` can't be a secret's variable, or null. `taken`: the variables of the project's other secrets. */
export function envProblem(name: string, taken: readonly string[] = []): string | null {
  if (!ENV_NAME.test(name)) return "Capital letters, digits and _, not starting with a digit, at most 64";
  if (RESERVED_ENV.has(name) || name.startsWith("NEST_")) return `${name} is set by nest or the sandbox`;
  if (taken.includes(name)) return `Another secret uses ${name}`;
  return null;
}

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
export function secretProblems(
  m: Pick<SecretMeta, "name" | "hosts" | "locations" | "roles" | "env">, grant: SecretGrant | null, takenEnv: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!SECRET_NAME.test(m.name)) out.name = "Lowercase letters, digits and _, starting with a letter, at most 31";
  const env = envProblem(m.env, takenEnv);
  if (env) out.env = env;
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
  l.type === "authorization_bearer" ? "a bearer token" : l.type === "authorization_basic_password" ? "a Basic auth password" : `the ${l.name} header`;

/**
 * What a role's secrets make of a sandbox's client layer: a binding each, and its variable holding the
 * binding's placeholder (nest's limit of bindings: the first by name). Fed to `clientLayerFor`, and sent
 * the same at a sandbox's create.
 */
export function secretFeeds(client: string, project: string, secrets: readonly SecretMeta[]): { inject: Binding[]; env: Record<string, string>; secrets: SecretMeta[] } {
  const mine = secrets.slice(0, MAX_BINDINGS);
  return { inject: mine.map((m) => bindingOf(project, m)), env: Object.fromEntries(mine.map((m) => [m.env, placeholder(client, m.name)])), secrets: mine };
}

/**
 * The brief's note on credentials: which variables exist and where each works. Names and hosts only: the
 * variables hold placeholders (in the sandbox, not here), and values never reach the app.
 */
export function secretsBrief(secrets: readonly Pick<SecretMeta, "description" | "hosts" | "locations" | "env">[]): string {
  if (secrets.length === 0) return "";
  return [
    "",
    "Credentials: your sandbox's commands have these variables. Each holds a placeholder that nest's egress proxy swaps for the real value, only on its hosts; use it where the value would go.",
    ...secrets.map((s) => `- $${s.env}${s.description ? ` (${s.description})` : ""}: ${s.hosts.join(", ")}, as ${s.locations.map(LOCATION_LABEL).join(" or ")}.`),
    "The owner may add or remove secrets while you run, which changes these variables. Never ask anyone for a secret's value; if you need a credential you don't have, call request_secret.",
  ].join("\n");
}

/**
 * Presets for the form's host picker (README.md#secrets), with the variable their tools read (`null`: the
 * name's, upper-cased; for GitHub, so `GH_TOKEN` doesn't take over the brokered token).
 */
export const SECRET_PRESETS = [
  { value: "cloudflare", label: "Cloudflare API", hosts: ["api.cloudflare.com"], location: { type: "authorization_bearer" } as SecretLocation, env: "CLOUDFLARE_API_TOKEN", note: null },
  { value: "npm", label: "npm registry", hosts: ["registry.npmjs.org"], location: { type: "authorization_bearer" } as SecretLocation, env: "NPM_TOKEN", note: null },
  { value: "pypi", label: "PyPI upload", hosts: ["upload.pypi.org"], location: { type: "authorization_basic_password" } as SecretLocation, env: "TWINE_PASSWORD", note: "PyPI takes a token as the password, with the user name __token__ (TWINE_USERNAME)." },
  {
    value: "github", label: "GitHub API", hosts: ["api.github.com"], location: { type: "authorization_bearer" } as SecretLocation, env: null,
    note: "nest already brokers GitHub for the project's repo: its sandboxes push and read through it with a token of their own. Add one only for another account's API, and prefer the brokered one.",
  },
  { value: "custom", label: "Custom", hosts: [], location: { type: "authorization_bearer" } as SecretLocation, env: null, note: null },
] as const;
