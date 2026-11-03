// Environment variables for a sandbox's processes (docs/control-plane/api/clients/#environment): a
// sandbox's own `env` (its create, or its client layer) and each agent's spec's `env` (its template and
// overrides) become the guest slot's environment (`agent_attach.env` → nestd → the guest's
// `AgentSlot.env`), which every process the agent runs there gets: hands `Bash`, a terminal, anything
// it starts. Values are literals or placeholders: never a credential (a placeholder that a binding of
// the same sandbox or spec substitutes at nest-proxy, or a value stored in BrokerDO). Pure.
import { z } from "zod";

/** How a placeholder nest assigns starts (lib/client-secrets.ts `injectionPlaceholder`). */
export const PLACEHOLDER_PREFIX = "nest-ph.";
/** At most this many variables in one `env`, each value at most this many bytes. */
export const ENV_MAX = 64;
export const ENV_VALUE_MAX = 4096;

/**
 * Names nest or the guest set for every process, or that change how every process runs: never a
 * spec's. `NEST_*` is nest's own (`NEST_AGENT_ID`, …); the proxy variables route egress through
 * nest-proxy; `GITHUB_TOKEN` carries the GitHub placeholder the image sets (images/guest/); the CA variables
 * say which roots a tool trusts. `GIT_CONFIG*` (`GIT_CONFIG_COUNT`/`_KEY_<n>`/`_VALUE_<n>`,
 * `_PARAMETERS`, `_GLOBAL`, `_SYSTEM`, `_NOSYSTEM`) is reserved whole: git reads config from it, an
 * `http.extraHeader` or a credential helper of its own over the image's (`credential.helper nest`, in
 * the system config).
 */
const RESERVED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TERM", "HOSTNAME", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "GITHUB_TOKEN",
  // What git and `gh` would use over the sandbox's own GitHub credential (the placeholder nest-proxy swaps for
  // the token minted for its push allowlist): `gh` prefers `GH_TOKEN` to `GITHUB_TOKEN`, the enterprise
  // tokens are its others, and git asks `GIT_ASKPASS` where no helper answers. A client's value there (a
  // literal, or its own secret's placeholder) would take the sandbox's GitHub access over.
  "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS",
  // Which CAs a tool trusts: the image points them at nest-proxy's root (`NODE_EXTRA_CA_CERTS`); set otherwise
  // they could only break TLS through the proxy.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO"]);

export const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "an env name is 1-64 of A-Z, 0-9 and '_', not starting with a digit")
  .refine((n) => !RESERVED.has(n) && !n.startsWith("NEST_") && !n.startsWith("GIT_CONFIG"),
    "that env name is nest's or the guest's own (PATH, HOME, NEST_*, the proxy variables, GITHUB_TOKEN, GH_TOKEN, GIT_CONFIG*, …)");
export const EnvValue = z.string().refine((v) => new TextEncoder().encode(v).byteLength <= ENV_VALUE_MAX, `an env value is at most ${ENV_VALUE_MAX} bytes`)
  .refine((v) => !v.includes("\0"), "an env value has no NUL");
export const SandboxEnv = z.record(EnvName, EnvValue).refine((e) => Object.keys(e).length <= ENV_MAX, `at most ${ENV_MAX} env variables`);
export type SandboxEnv = z.output<typeof SandboxEnv>;

/**
 * The variables whose value holds a placeholder (`nest-ph.…`) that isn't exactly one of `bound` (the
 * placeholders of the bindings declared with it): a placeholder nothing in that sandbox substitutes
 * would go out as is, or name another sandbox's binding. Empty: none.
 */
export function unboundPlaceholders(env: Readonly<Record<string, string>>, bound: readonly string[]): string[] {
  return Object.entries(env).filter(([, v]) => v.includes(PLACEHOLDER_PREFIX) && !bound.includes(v)).map(([k]) => `env ${k}: a placeholder no binding here has`);
}

/** A slot's environment: the sandbox's, then the agent's (which wins on a name both set). */
export const slotEnv = (sandbox: Readonly<Record<string, string>>, agent: Readonly<Record<string, string>> | undefined): Record<string, string> =>
  ({ ...sandbox, ...(agent ?? {}) });
