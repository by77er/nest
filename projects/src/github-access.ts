// The project's GitHub access in its agents' sandboxes (README.md#repo-authority, #secrets; the owner's plan,
// phase B3): built only from nest's generic client primitives, never its kernel repos.
// - Two client secrets per project, `gh-push-<project>` and `gh-read-<project>`, each an installation token of
//   the app's own GitHub App narrowed to the project's repo, written with its `expires_at` and refreshed by
//   ProjectDO before it expires (nest pushes each write to the sandboxes bound to it).
// - Per role, a binding of one of them on github.com and api.github.com (workers push; the manager, reviewers
//   and routine runs only read), the environment that points git and gh at its placeholder, and the egress the
//   API needs.
// - The app's own request guards, a port of nest's kernel constructor (`githubGuards` in
//   control-plane/src/lib/rules/github.ts): pushes and API writes reach only the project's repo, GraphQL only
//   with the sandbox's own token written whole into Authorization, and no gist or content-host writes.
// Pure, so ProjectDO, ReviewDO and the tests share it.
//
// Sources (read 2026-11-12):
// - git smart HTTP: https://git-scm.com/docs/http-protocol (`info/refs?service=`, `git-receive-pack`)
// - Git LFS batch: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md (`operation`)
// - git's config from the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, git
//   2.31+): https://git-scm.com/docs/git-config#Documentation/git-config.txt-GITCONFIGCOUNT
// - an empty `credential.helper` resets the helper list, and a `!` helper is a shell snippet given the action:
//   https://git-scm.com/docs/gitcredentials#_custom_helpers
// - gh reads `GH_TOKEN` before `GITHUB_TOKEN`: https://cli.github.com/manual/gh_help_environment

import type { SpawnOverrides } from "./nest";
import { type Binding, type EgressRule, hostAllowed } from "./network";
import { APP_BINDINGS, placeholder } from "./secrets";

/** Which token a role's sandbox gets: workers push, every other role with hands only reads. */
export type GithubKind = "push" | "read";
export const GITHUB_KINDS: readonly GithubKind[] = ["push", "read"];
/** The roles whose sandboxes reach the repo. */
export type GithubRole = "worker" | "manager" | "reviewer" | "routine";
export const kindOf = (role: GithubRole): GithubKind => (role === "worker" ? "push" : "read");

/** The binding names: reserved, so no secret of the owner's takes one (`secrets.ts`). */
export const GITHUB_BINDINGS: Record<GithubKind, string> = APP_BINDINGS;

/** nest's name for a project's token secret: apart from the owner's secrets (`<project>-<name>-<generation>`). */
export const githubSecretName = (project: string, kind: GithubKind) => `gh-${kind}-${project}`;

/**
 * Each token's permissions: the push token's as nest's own push token had them (`contents` and
 * `pull_requests: write`; `contents: write` includes the read a PR needs), plus `workflows: write` only while
 * the project's "Workers may change CI workflows" is on; the read token only reads the code and the repo.
 */
export const githubPermissions = (kind: GithubKind, workflows: boolean): Record<string, string> =>
  kind === "push"
    ? { contents: "write", pull_requests: "write", ...(workflows ? { workflows: "write" } : {}) }
    : { contents: "read", metadata: "read" };

/** Where the binding injects: git over HTTPS (Basic) and the API (Bearer, gh's `token`). */
export const GITHUB_INJECT_HOSTS = ["github.com", "api.github.com"] as const;
/** The hosts the app opens for it: git, the API (not in nest's base layer), and GitHub's content hosts. */
export const GITHUB_EGRESS_HOSTS = ["github.com", "api.github.com", "*.githubusercontent.com"] as const;

/** A token is written again this long before it expires (GitHub's last an hour). */
export const REFRESH_BEFORE_MS = 30 * 60_000;

/** The client's grant, in the parts the access needs (`GET /v1/clients/self`). */
export interface AccessGrant {
  inject_hosts?: string[];
  egress_hosts?: string[];
}

/**
 * What the grant lacks for the app's own GitHub access, as the start's error says it, or null: the binding
 * injects into both GitHub hosts (`inject_hosts`), and the app opens every host the guards and git use
 * (`egress_hosts`: the API, which nest's base layer doesn't, github.com and the content hosts, which it does
 * today but the operator may trim).
 */
export function githubGrantMissing(grant: AccessGrant): string | null {
  const inject = GITHUB_INJECT_HOSTS.filter((h) => !hostAllowed(h, grant.inject_hosts ?? []));
  const egress = GITHUB_EGRESS_HOSTS.filter((h) => !hostAllowed(h, grant.egress_hosts ?? []));
  if (!inject.length && !egress.length) return null;
  const list = (hosts: readonly string[]) => (hosts.length > 1 ? `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}` : hosts[0]!);
  return `waiting for nest's grant for this app to cover its GitHub access: the operator must add ${[
    ...(inject.length ? [`${list(inject)} to inject_hosts`] : []), ...(egress.length ? [`${list(egress)} to egress_hosts`] : []),
  ].join(", and ")}`;
}

/**
 * git's credential helper for github.com, from the environment: the image's helper reset (an empty value
 * empties the list), then one that answers `get` with `x-access-token` and the placeholder in `$GH_TOKEN`
 * (read when git runs it, so the value never holds the placeholder itself). nest-proxy swaps the placeholder
 * in the Basic password for the token.
 */
export const CREDENTIAL_HELPER = `!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;
const HELPER_KEY = "credential.https://github.com.helper";


/** One request matcher and guard, nest's `ClientRequestMatch` and `ClientGuard` (docs/control-plane/api/clients/#request-guards). */
export interface Match {
  methods?: string[];
  methods_except?: string[];
  path?: string;
  query?: { name: string; values?: string[] }[];
  body_json?: { pointer: string; values: string[] };
  injected?: string;
  at?: string;
}
export interface Guard {
  name: string;
  hosts: string[];
  scope: Match[];
  allow?: Match[];
  reason?: string;
  ignore_case?: boolean;
}

const READS = ["GET", "HEAD"];
const writes = (): Match => ({ methods_except: [...READS] });
const RECEIVE_DISCOVERY = (): Match => ({ path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] });

/**
 * The app's guards for a sandbox of `kind` on `repo` (`owner/name`), each refusing on its hosts what its
 * scope covers unless an exception does (a port of nest's `githubGuards` for one repo):
 * - `github-push` (github.com): git's receive-pack and its discovery, except into the repo, and only for push;
 * - `github-write` (github.com): any other write (web forms with someone's cookie, LFS uploads and locks),
 *   except fetches (`git-upload-pack` is a POST), LFS batch downloads, and the repo for push;
 * - `github-api-write` (every `*.github.com`): writes outside the repo's `/repos/{owner}/{repo}/…` (none for
 *   read), and GraphQL only with the sandbox's own binding written whole into `Authorization` (its token is
 *   narrowed to the repo by GitHub; GraphQL is one POST endpoint, its target isn't in the path);
 * - `gist-write`: no writes to gists (each is a git repo);
 * - `githubusercontent-write`: no writes to `*.githubusercontent.com` (signed upload URLs).
 */
export function githubGuards(repo: string, kind: GithubKind): Guard[] {
  const r = repo.toLowerCase();
  const push = kind === "push";
  const web: Match[] = push ? [{ path: `/${r}/**` }, { path: `/${r}.git/**` }] : [];
  const reason = push ? `writes to GitHub reach only ${r}` : `this sandbox only reads ${r}`;
  const guards: Guard[] = [
    { name: "github-push", hosts: ["github.com"], scope: [{ path: "/**/git-receive-pack" }, RECEIVE_DISCOVERY()], allow: web, reason: push ? `git pushes reach only ${r}` : reason, ignore_case: true },
    {
      name: "github-write", hosts: ["github.com"], scope: [writes()],
      allow: [
        { methods: ["POST"], path: "/**/git-upload-pack" },
        { methods: ["POST"], path: "/**/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
        ...web,
      ],
      reason, ignore_case: true,
    },
    {
      name: "github-api-write", hosts: ["*.github.com"], scope: [writes()],
      allow: [...(push ? [{ path: `/repos/${r}/**` }] : []), { methods: ["POST"], path: "/graphql", injected: GITHUB_BINDINGS[kind], at: "authorization" }],
      reason: `${reason}; GraphQL goes only with this sandbox's own GitHub token`, ignore_case: true,
    },
    { name: "gist-write", hosts: ["gist.github.com"], scope: [writes(), RECEIVE_DISCOVERY()], reason: "gists are read-only from a sandbox", ignore_case: true },
    { name: "githubusercontent-write", hosts: ["*.githubusercontent.com"], scope: [writes()], reason: "GitHub's content hosts are read-only from a sandbox", ignore_case: true },
  ];
  // No exceptions: `allow` absent.
  return guards.map(({ allow, ...g }) => (allow?.length ? { ...g, allow } : g));
}

/** What a role's sandbox gets for the repo: the binding, its environment, the egress (within the grant), and the guards. */
export interface GithubAccess {
  kind: GithubKind;
  inject: Binding;
  env: Record<string, string>;
  egress: EgressRule[];
  guards: Guard[];
}

/** The binding of the project's token of `kind` (nest names its placeholder `nest-ph.<client>.<binding>.`). */
export const githubBinding = (project: string, kind: GithubKind): Binding => ({
  name: GITHUB_BINDINGS[kind], secret: githubSecretName(project, kind), hosts: [...GITHUB_INJECT_HOSTS],
  // nest-proxy writes this username itself (nest #273), so a Basic field is nest's whole only with it: git sends
  // whatever its helper answers, and GitHub takes a token as the username too.
  locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password", username: "x-access-token" }],
});

/** `GH_TOKEN` holding the binding's placeholder, and git's credential helper answering with it. */
export const githubEnv = (client: string, kind: GithubKind): Record<string, string> => ({
  GH_TOKEN: placeholder(client, GITHUB_BINDINGS[kind]),
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: HELPER_KEY,
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: HELPER_KEY,
  GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
});

/** The GitHub hosts the grant's `egress_hosts` lets the app open. */
export const githubEgress = (egressHosts: readonly string[]): EgressRule[] =>
  GITHUB_EGRESS_HOSTS.filter((h) => hostAllowed(h, egressHosts)).map((host) => ({ host }));

/** The sandbox's part for `role` on `repo`: the binding, its environment, the egress within the grant, and the guards. */
export function githubAccess(o: { client: string; project: string; repo: string; role: GithubRole; egressHosts: readonly string[] }): GithubAccess {
  const kind = kindOf(o.role);
  return { kind, inject: githubBinding(o.project, kind), env: githubEnv(o.client, kind), egress: githubEgress(o.egressHosts), guards: githubGuards(o.repo, kind) };
}

/** A start's frozen GitHub part (ProjectDO's `StartSpec.github`): absent for a start frozen before it. */
export interface FrozenGithub {
  github?: { egress: EgressRule[]; guards: Guard[] };
}

/**
 * What a start's spawn sends: with the app's access (its guards are the sandbox's own, `startExtras`), nest's
 * repos narrowed to none, since a shared template the catalog sync hasn't rewritten since the deploy still
 * names every project's repo, and nest would otherwise give the agent its own GitHub token for them (and refuse
 * the app's `GH_TOKEN` beside it): goes with nest's repos (phase C). Frozen before it (`github` absent): nest's
 * repos narrowed to the project's, pushed or read.
 */
export function spawnOverrides(spec: FrozenGithub, repo: string, push: boolean): SpawnOverrides {
  if (spec.github) return { repos: [], read_repos: [] };
  return push ? { repos: [repo] } : { read_repos: [repo] };
}

/** A start's sandbox egress: its role's rules as frozen, then the GitHub hosts its spec adds that no rule names. */
export function startEgress(rules: readonly EgressRule[], spec: FrozenGithub): { egress?: { allow: EgressRule[] } } {
  const allow = [...rules, ...(spec.github?.egress ?? []).filter((g) => !rules.some((r) => r.host === g.host))];
  return allow.length ? { egress: { allow } } : {};
}
