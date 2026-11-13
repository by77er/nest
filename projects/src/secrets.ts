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
  /** nest's name for it: new at each creation (`nestSecretName`), so a binding from before a delete never names a later one. */
  nest_name: string;
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

/**
 * The nest secret's name: project-scoped, so two projects' `npm_token`s don't collide, and with a
 * generation of its own, made at each creation. A binding names a secret by nest name, and a sandbox
 * started before a delete may still hold one: a secret made again under the same name must not be the
 * one it reaches. `prj_<16>-<31>-<6>` is 59 characters, inside nest's 63.
 */
export const nestSecretName = (project: string, name: string, generation: string) => `${project}-${name}-${generation}`;

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

/**
 * Read by gh and git ahead of anything else: the app sets `GH_TOKEN` and git's credential helper (`GIT_CONFIG_*`)
 * for the repo's own token (src/github-access.ts), and the enterprise tokens and `GIT_ASKPASS` would take
 * gh's or git's credential over. One set here would take over the sandbox's GitHub token.
 */
const GITHUB_ENV = new Set(["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS"]);

/** The bindings of the project's own GitHub tokens (src/github-access.ts): no secret of the owner's takes their names. */
export const APP_BINDINGS = { push: "gh_push", read: "gh_read" } as const;
export const isAppBinding = (name: string) => (Object.values(APP_BINDINGS) as string[]).includes(name);
/** The variables the app sets for git and gh beside its GitHub binding (src/github-access.ts). */
export const APP_ENV = ["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"] as const;
export const isAppEnv = (name: string) => (APP_ENV as readonly string[]).includes(name);

/** Why `name` can't be a secret's variable, or null. `taken`: the variables of the project's other secrets. */
export function envProblem(name: string, taken: readonly string[] = []): string | null {
  if (!ENV_NAME.test(name)) return "Capital letters, digits and _, not starting with a digit, at most 64";
  if (GITHUB_ENV.has(name) || name.startsWith("GIT_CONFIG")) return `${name} would take over the sandbox's GitHub token`;
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
  else if (isAppBinding(m.name)) out.name = `${m.name} is the app's own GitHub binding: choose another name`;
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
export function bindingOf(m: Pick<SecretMeta, "name" | "nest_name" | "hosts" | "locations">) {
  return {
    name: m.name, secret: m.nest_name, hosts: [...m.hosts], locations: m.locations.map((l) => ({ ...l })),
    ...(m.hosts.some((h) => h.startsWith("*.")) ? { wildcard: true } : {}),
  };
}

export type Binding = ReturnType<typeof bindingOf>;

const LOCATION_LABEL = (l: SecretLocation) =>
  l.type === "authorization_bearer" ? "a bearer token" : l.type === "authorization_basic_password" ? "a Basic auth password" : `the ${l.name} header`;

/** A secret's hosts outside the grant's `inject_hosts` (none when the grant is unknown: the caller decides). */
export const outsideGrant = (m: Pick<SecretMeta, "hosts">, injectHosts: readonly string[] | null) =>
  injectHosts === null ? [] : m.hosts.filter((h) => !hostAllowed(h, injectHosts));

/**
 * What a role's secrets make of a sandbox's client layer: a binding each, and its variable holding the
 * binding's placeholder (`max` of them, nest's limit of bindings less the app's GitHub one where it has it:
 * the first by name). Fed to `clientLayerFor`, and sent
 * the same at a sandbox's create. Given the grant's `inject_hosts`, only what's inside it: a host outside
 * is left out, and a secret with none left is too (`outside`), so nest never refuses the layer for it,
 * and a refusal of one secret never holds back another's removal.
 */
export function secretFeeds(
  client: string, secrets: readonly SecretMeta[], injectHosts: readonly string[] | null = null, max = MAX_BINDINGS,
): { inject: Binding[]; env: Record<string, string>; secrets: SecretMeta[]; outside: string[] } {
  // A secret named as the app's own GitHub bindings (saved before they were reserved) is never bound: the GitHub one is.
  const inside = secrets.filter((m) => !isAppBinding(m.name)).map((m) => ({ ...m, hosts: m.hosts.filter((h) => !outsideGrant({ hosts: [h] }, injectHosts).length) }));
  const mine = inside.filter((m) => m.hosts.length).slice(0, max);
  return {
    inject: mine.map(bindingOf), env: Object.fromEntries(mine.map((m) => [m.env, placeholder(client, m.name)])), secrets: mine,
    outside: inside.filter((m) => !m.hosts.length).map((m) => m.name),
  };
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
 * name's, upper-cased; for GitHub, since `GH_TOKEN` is the app's own token for the repo).
 */
export const SECRET_PRESETS = [
  { value: "cloudflare", label: "Cloudflare API", hosts: ["api.cloudflare.com"], location: { type: "authorization_bearer" } as SecretLocation, env: "CLOUDFLARE_API_TOKEN", note: null },
  { value: "npm", label: "npm registry", hosts: ["registry.npmjs.org"], location: { type: "authorization_bearer" } as SecretLocation, env: "NPM_TOKEN", note: null },
  { value: "pypi", label: "PyPI upload", hosts: ["upload.pypi.org"], location: { type: "authorization_basic_password" } as SecretLocation, env: "TWINE_PASSWORD", note: "PyPI takes a token as the password, with the user name __token__ (TWINE_USERNAME)." },
  {
    value: "github", label: "GitHub API", hosts: ["api.github.com"], location: { type: "authorization_bearer" } as SecretLocation, env: null,
    note: "The app already gives every sandbox a token for the project's repo (GH_TOKEN): workers push with it, the other roles read. Add one only for another account's API.",
  },
  { value: "custom", label: "Custom", hosts: [], location: { type: "authorization_bearer" } as SecretLocation, env: null, note: null },
] as const;
