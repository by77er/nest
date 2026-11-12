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
 * nest-proxy; the CA variables say which roots a tool trusts.
 */
const RESERVED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TERM", "HOSTNAME", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  // Which CAs a tool trusts: the image points them at nest-proxy's root (`NODE_EXTRA_CA_CERTS`); set otherwise
  // they could only break TLS through the proxy.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO"]);

/**
 * What git and `gh` would use over the GitHub token nest itself injects (the image's `GITHUB_TOKEN`
 * placeholder, which nest-proxy swaps for the token minted for a sandbox's repos): `gh` prefers `GH_TOKEN`
 * to `GITHUB_TOKEN`, the enterprise tokens are its others, git asks `GIT_ASKPASS` where no helper answers,
 * and takes config from `GIT_CONFIG*` (`GIT_CONFIG_COUNT`/`_KEY_<n>`/`_VALUE_<n>`, `_PARAMETERS`, `_GLOBAL`,
 * `_SYSTEM`, `_NOSYSTEM`: a credential helper or an `http.extraHeader` of its own over the image's).
 * Reserved only in a sandbox where nest injects a GitHub token of its own (`githubEnvConflict`): a client's
 * value there would take that access over. Elsewhere they are a client's to set (its own token's
 * placeholder, its own credential helper). Goes when the kernel's GitHub token does (docs/README.md, principle 10).
 */
const GITHUB_ENV = new Set(["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS"]);
export const isGithubEnvName = (n: string): boolean => GITHUB_ENV.has(n) || n.startsWith("GIT_CONFIG");

export const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "an env name is 1-64 of A-Z, 0-9 and '_', not starting with a digit")
  .refine((n) => !RESERVED.has(n) && !n.startsWith("NEST_"),
    "that env name is nest's or the guest's own (PATH, HOME, NEST_*, the proxy and CA variables, …)");
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

/**
 * Where nest injects a GitHub token of its own (`kernelGithub`: a push allowlist, read-only repos or a
 * `github_push` opt-in, in the sandbox or an attached agent's spec), the names in any of `envs` that
 * `isGithubEnvName` reserves there, sorted; empty: no conflict.
 */
export function githubEnvConflict(kernelGithub: boolean, ...envs: (Readonly<Record<string, string>> | undefined)[]): string[] {
  if (!kernelGithub) return [];
  return [...new Set(envs.flatMap((e) => Object.keys(e ?? {})).filter(isGithubEnvName))].sort();
}

/** The refusal for `githubEnvConflict`'s names. */
export const githubEnvRefusal = (names: readonly string[]): string =>
  `env ${names.join(", ")}: reserved where nest injects its own GitHub token (repos, read_repos or github_push here, or in an attached agent's spec)`;
