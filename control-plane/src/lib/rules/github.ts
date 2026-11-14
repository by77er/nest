// GitHub's egress rules (docs/sandbox/networking/egress/policy/#github): a constructor that turns "this
// sandbox may push to these repos, and read these" into generic request guards nest-proxy evaluates,
// plus the injection bindings its minted installation tokens go out under. Everything GitHub-specific about
// egress is here; nest-proxy knows only hosts, methods, paths, queries, a body field and bindings.
// Pure. Sources (docs.github.com unless noted, read 2026-11-01):
//   git smart HTTP:  git-scm.com/docs/http-protocol (`info/refs?service=`, `git-receive-pack`, `git-upload-pack`)
//   Git LFS batch:   github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md (`operation`: upload | download)
//   LFS locks:       github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md
//   REST:            /en/rest (repository endpoints under /repos/{owner}/{repo})
//   GraphQL:         /en/graphql/guides/forming-calls-with-graphql (one endpoint, POST /graphql)
import { hostPatternMatches, type InjectionBinding, INJECTED_ANY, type RequestGuard, type RequestMatch } from "../../protocol/model";
import { canonicalRepos, readOnlyRepos } from "../repos";
import type { PolicyFragment } from "./fragment";
import { z } from "zod";

/**
 * Opt-ins on a sandbox's GitHub push token (docs/control-plane/api/clients/#workflow-files): `workflows`
 * adds `workflows: write`, without which GitHub refuses a push that adds or changes a file under
 * `.github/workflows/`. Off by default; never on the read-only token.
 */
export const GithubPush = z.strictObject({ workflows: z.boolean().default(false) });
export type GithubPush = z.output<typeof GithubPush>;

/** The injection binding a sandbox's minted token goes out under. */
export const GITHUB_BINDING = "github";
/** What the guest image's git credential helper and `GITHUB_TOKEN` carry (images/nest-base). Worthless outside nest-proxy. */
export const GITHUB_PLACEHOLDER = "nest-ph-github";
/**
 * The binding a sandbox's read-only token goes out under, when it has read-only repos
 * (docs/sandbox/networking/egress/policy/#read-only-repos): a second token, since an installation
 * token's permissions apply to every repo it names.
 */
export const GITHUB_READ_BINDING = "github_read";
/**
 * Its placeholder: not containing {@link GITHUB_PLACEHOLDER}, since nest-proxy finds a binding's
 * placeholder anywhere in a request (a substring) before it substitutes an exact match.
 */
export const GITHUB_READ_PLACEHOLDER = "nest-ph-read-github";
/**
 * The read-only token under the guest's default placeholder, for a sandbox with read-only repos and no
 * push allowlist, so `git` and `gh` read them unconfigured. Not named `github`: a push token the proxy
 * still holds under `github` while a policy without the allowlist is installed has no binding then, so
 * it can't be substituted (nor its GraphQL exception used) before the read-only token replaces it.
 */
export const GITHUB_READ_DEFAULT_BINDING = "github_read_default";

const READS = ["GET", "HEAD"];
/**
 * Where nest injects no GitHub token of its own (no push allowlist, no read-only repos, no operator binding
 * under a GitHub name or placeholder), the exception that lets a write through: the request's one
 * `Authorization` field is a credential nest's injection wrote whole, whichever binding's
 * (docs/sandbox/networking/egress/policy/#any-injected-credential). So an app's own GitHub binding works and
 * its own guards narrow where it reaches, and a credential planted in the sandbox still writes nowhere.
 */
const NEST_CREDENTIAL: RequestMatch[] = [{ injected: INJECTED_ANY, at: "authorization" }];
const NEST_CREDENTIAL_REASON = "writes to GitHub go only with a credential nest injected (this sandbox has no repos of nest's own)";
/**
 * An operator binding that is a GitHub credential of nest's side: by a GitHub binding's name or placeholder,
 * or by injecting into github.com or any `*.github.com` host (an operator's PAT under any name). Where one
 * is, the guards stay as they were: `*` would accept it too, wherever it reaches.
 */
const ownsGithub = (b: InjectionBinding) =>
  [GITHUB_BINDING, GITHUB_READ_BINDING, GITHUB_READ_DEFAULT_BINDING].includes(b.name) || b.placeholder === GITHUB_PLACEHOLDER || b.placeholder === GITHUB_READ_PLACEHOLDER
  || b.hosts.some((h) => {
    // As nest-proxy matches it: without case, and without trailing dots (`api.github.com.` is api.github.com).
    const x = h.toLowerCase().replace(/\.+$/, "");
    // github.com or a host under it, or a pattern reaching either (`*.com`, `*.github.com`).
    return x === "github.com" || x.endsWith(".github.com") || hostPatternMatches(x, "github.com") || hostPatternMatches(x, "nest-probe.github.com");
  });
/**
 * github.com's writes that authenticate by the request's own credential (`Authorization`), not by a session
 * cookie: git's receive-pack and Git LFS's API (batch and locks: github.com/git-lfs/git-lfs/blob/main/docs/api/),
 * anchored at the repo (`/<owner>/<repo>/…`): the web editor's routes end in a path the user chooses
 * (`/<o>/<r>/tree-save/<branch>/<path>`), so a pattern open in front would take them. Only these take nest's
 * credential as an exception on github.com: every other write there is a web route a planted `Cookie` would
 * authenticate, which `at` never sees.
 */
const TOKEN_WRITES: RequestMatch[] = [
  { methods: ["POST"], path: "/*/*/git-receive-pack" },
  { methods: ["POST"], path: "/*/*/info/lfs/objects/batch" },
  { methods: ["POST"], path: "/*/*/info/lfs/locks" },
  { methods: ["POST"], path: "/*/*/info/lfs/locks/verify" },
  { methods: ["POST"], path: "/*/*/info/lfs/locks/*/unlock" },
];
const RECEIVE_DISCOVERY: RequestMatch = { path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] };
const writes = (): RequestMatch => ({ methods_except: [...READS] });

/** Paths under a repo on github.com, with and without git's `.git`. */
const webRepo = (repos: readonly string[]): RequestMatch[] => repos.flatMap((r) => [{ path: `/${r}/**` }, { path: `/${r}.git/**` }]);
/** Paths under a repo in the REST API. */
const apiRepo = (repos: readonly string[]): RequestMatch[] => repos.map((r) => ({ path: `/repos/${r}/**` }));

/**
 * The guards for a push allowlist (exact `owner/name`; none: no push anywhere) and the read-only repos
 * beside it. Each refuses, on its hosts, what its scope covers unless an exception does:
 * - `github-push` (github.com): git's receive-pack and its discovery, except into an allowed repo
 *   (never a read-only one);
 * - `github-write` (github.com): any other write (web forms with someone's cookie, LFS uploads and
 *   locks), except fetches (`git-upload-pack` is a POST), LFS batch downloads, and allowed repos;
 * - `github-api-write` (every `*.github.com`: api, uploads, www, …): writes outside an allowed repo's
 *   `/repos/{owner}/{repo}/…`, and GraphQL only with the sandbox's own token, which is narrowed to the
 *   allowed repos, or with its read-only token, which can't write (GraphQL is one POST endpoint: its
 *   target isn't in the path);
 * - `gist-write`: no writes to gists (each is a git repo);
 * - `githubusercontent-write`: no writes to `*.githubusercontent.com` (signed upload URLs).
 * Where nest injects no GitHub token of its own (no repos of either kind, no `operator` binding that is a
 * GitHub credential: `ownsGithub`), the first three except a credential nest injected whole in `Authorization`
 * instead (`NEST_CREDENTIAL`): on github.com only for its token-authenticated writes (`TOKEN_WRITES`), and
 * push discovery goes bare. An app's own binding writes, its own client guards narrow where, and a
 * credential planted in the sandbox (a token, or a cookie for github.com's web routes) writes nowhere. On
 * the other `*.github.com` hosts the exception holds only where a binding injects (nest-proxy refuses a
 * placeholder on a host its binding doesn't name), so on the hosts the operator granted an app.
 */
export function githubGuards(allowlist: readonly string[], readOnly: readonly string[] = [], operator: readonly InjectionBinding[] = []): RequestGuard[] {
  const repos = canonicalRepos(allowlist);
  const read = readOnlyRepos(repos, readOnly);
  // No GitHub token of nest's own here: a write passes with a credential nest injected in its Authorization
  // (an app's own binding, or the operator's under another name), never one the sandbox planted.
  const viaNest = repos.length || read.length || operator.some(ownsGithub) ? [] : NEST_CREDENTIAL;
  const named = repos.length ? ` (${repos.join(", ")})` : "";
  const readNamed = read.length ? `; ${read.join(", ")} ${read.length > 1 ? "are" : "is"} read-only` : "";
  const pushReason = `git pushes reach only the repos on this sandbox's push allowlist${named || " (none)"}${readNamed}`;
  const writeReason = `writes to GitHub reach only the repos on this sandbox's push allowlist${named || " (none)"}${readNamed}`;
  // GraphQL goes with the sandbox's own tokens: `github` with an allowlist (as before read-only repos,
  // the operator's own `github` binding included), and the read-only bindings only when nest mints
  // their token (an operator's binding of that name carries whatever the operator gave it).
  const tokens = [...(repos.length ? [GITHUB_BINDING] : []), ...readBindings(repos, read, operator).filter((b) => !operator.some((o) => o.name === b))];
  const guards: RequestGuard[] = [
    {
      name: "github-push", hosts: ["github.com"], scope: [{ path: "/**/git-receive-pack" }, RECEIVE_DISCOVERY],
      // git asks for a credential only once discovery is answered 401: that GET goes without one.
      allow: [...webRepo(repos), ...(viaNest.length ? [{ methods: [...READS], ...RECEIVE_DISCOVERY }] : []), ...viaNest],
      reason: viaNest.length ? NEST_CREDENTIAL_REASON : pushReason, ignore_case: true,
    },
    {
      name: "github-write", hosts: ["github.com"], scope: [writes()],
      allow: [
        // A fetch, anchored at the repo as git sends it: an open front would take the web editor's routes too.
        { methods: ["POST"], path: "/*/*/git-upload-pack" },
        { methods: ["POST"], path: "/*/*/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
        ...webRepo(repos),
        ...(viaNest.length ? TOKEN_WRITES.map((m) => ({ ...m, ...viaNest[0] })) : []),
      ],
      reason: viaNest.length ? NEST_CREDENTIAL_REASON : writeReason, ignore_case: true,
    },
    {
      name: "github-api-write", hosts: ["*.github.com"], scope: [writes()],
      allow: [...apiRepo(repos), ...tokens.map((injected) => ({ methods: ["POST"], path: "/graphql", injected, at: "authorization" })), ...viaNest],
      reason: viaNest.length ? NEST_CREDENTIAL_REASON : `${writeReason}; GraphQL writes go only with the sandbox's own GitHub token`, ignore_case: true,
    },
    { name: "gist-write", hosts: ["gist.github.com"], scope: [writes(), RECEIVE_DISCOVERY], reason: "gists are read-only from a sandbox", ignore_case: true },
    { name: "githubusercontent-write", hosts: ["*.githubusercontent.com"], scope: [writes()], reason: "GitHub's content hosts are read-only from a sandbox", ignore_case: true },
  ];
  // No exceptions: `allow` absent, as the wire writes it.
  return guards.map(({ allow, ...g }) => (allow?.length ? { ...g, allow } : g));
}

/**
 * The injection binding for a sandbox's installation token: git over HTTPS (Basic) and the API (Bearer). Its
 * Basic username is the one GitHub documents for an installation token (`x-access-token`), written by nest-proxy
 * whatever git sent, so the field is nest's whole and a guard's `at` holds for it.
 */
export function githubBinding(): InjectionBinding {
  return {
    name: GITHUB_BINDING, hosts: ["github.com", "api.github.com"], placeholder: GITHUB_PLACEHOLDER,
    locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password", username: "x-access-token" }],
  };
}

/** The injection binding for a sandbox's read-only token: as {@link githubBinding}, under its own name and placeholder. */
export function githubReadBinding(): InjectionBinding {
  return { ...githubBinding(), name: GITHUB_READ_BINDING, placeholder: GITHUB_READ_PLACEHOLDER };
}

/**
 * The bindings a sandbox's read-only token goes out under: `github_read`, and with no allowlist
 * `github_read_default` (the guest's default placeholder) unless an operator binding already takes
 * that name or placeholder (`operator`: the operator's layer's bindings).
 */
export function readBindings(allowlist: readonly string[], readOnly: readonly string[], operator: readonly InjectionBinding[] = []): string[] {
  const read = readOnlyRepos(allowlist, readOnly);
  if (!read.length) return [];
  // An operator's `github_read` carries the operator's credential, not a token nest mints: nothing to repeat under the default placeholder.
  const taken = operator.some((o) => [GITHUB_BINDING, GITHUB_READ_BINDING, GITHUB_READ_DEFAULT_BINDING].includes(o.name) || o.placeholder === GITHUB_PLACEHOLDER);
  return [GITHUB_READ_BINDING, ...(canonicalRepos(allowlist).length || taken ? [] : [GITHUB_READ_DEFAULT_BINDING])];
}

/**
 * What a push allowlist and read-only repos add to a sandbox's policy: the guards always (with no repo,
 * writes pass only with a credential nest injected), and with any repo the API host (for `gh`) and the bindings its tokens
 * are injected under (`operator`: the operator's layer's bindings, which win over these by name).
 */
export function githubEgress(allowlist: readonly string[], readOnly: readonly string[] = [], operator: readonly InjectionBinding[] = []): PolicyFragment {
  const repos = canonicalRepos(allowlist);
  const read = readOnlyRepos(repos, readOnly);
  const readOnes = readBindings(repos, read, operator);
  return {
    allow: repos.length || read.length ? [{ host: "api.github.com" }] : [],
    inject: [
      ...(repos.length ? [githubBinding()] : []),
      ...readOnes.map((name) => (name === GITHUB_READ_BINDING ? githubReadBinding() : { ...githubBinding(), name })),
    ],
    guards: githubGuards(repos, read, operator),
  };
}
