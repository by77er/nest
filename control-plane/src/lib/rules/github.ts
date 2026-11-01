// GitHub's egress rules (docs/sandbox/networking/egress/policy/#github): a constructor that turns "this
// sandbox may push to these repos" into generic request guards nest-proxy evaluates, plus the
// injection binding a minted installation token goes out under. Everything GitHub-specific about
// egress is here; nest-proxy knows only hosts, methods, paths, queries, a body field and bindings.
// Pure. Sources (docs.github.com unless noted, read 2026-11-01):
//   git smart HTTP:  git-scm.com/docs/http-protocol (`info/refs?service=`, `git-receive-pack`, `git-upload-pack`)
//   Git LFS batch:   github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md (`operation`: upload | download)
//   LFS locks:       github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md
//   REST:            /en/rest (repository endpoints under /repos/{owner}/{repo})
//   GraphQL:         /en/graphql/guides/forming-calls-with-graphql (one endpoint, POST /graphql)
import type { InjectionBinding, RequestGuard, RequestMatch } from "../../protocol/model";
import { canonicalRepos } from "../repos";
import type { PolicyFragment } from "./fragment";

/** The injection binding a sandbox's minted token goes out under. */
export const GITHUB_BINDING = "github";
/** What the guest image's git credential helper and `GITHUB_TOKEN` carry (images/nest-base). Worthless outside nest-proxy. */
export const GITHUB_PLACEHOLDER = "nest-ph-github";

const READS = ["GET", "HEAD"];
const RECEIVE_DISCOVERY: RequestMatch = { path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] };
const writes = (): RequestMatch => ({ methods_except: [...READS] });

/** Paths under a repo on github.com, with and without git's `.git`. */
const webRepo = (repos: readonly string[]): RequestMatch[] => repos.flatMap((r) => [{ path: `/${r}/**` }, { path: `/${r}.git/**` }]);
/** Paths under a repo in the REST API. */
const apiRepo = (repos: readonly string[]): RequestMatch[] => repos.map((r) => ({ path: `/repos/${r}/**` }));

/**
 * The guards for a push allowlist (exact `owner/name`; none: no push anywhere). Each refuses, on its
 * hosts, what its scope covers unless an exception does:
 * - `github-push` (github.com): git's receive-pack and its discovery, except into an allowed repo;
 * - `github-write` (github.com): any other write (web forms with someone's cookie, LFS uploads and
 *   locks), except fetches (`git-upload-pack` is a POST), LFS batch downloads, and allowed repos;
 * - `github-api-write` (every `*.github.com`: api, uploads, www, …): writes outside an allowed repo's
 *   `/repos/{owner}/{repo}/…`, and GraphQL only with the sandbox's own token, which is narrowed to the
 *   allowed repos (GraphQL is one POST endpoint: its target isn't in the path);
 * - `gist-write`: no writes to gists (each is a git repo);
 * - `githubusercontent-write`: no writes to `*.githubusercontent.com` (signed upload URLs).
 */
export function githubGuards(allowlist: readonly string[]): RequestGuard[] {
  const repos = canonicalRepos(allowlist);
  const named = repos.length ? ` (${repos.join(", ")})` : "";
  const pushReason = `git pushes reach only the repos on this sandbox's push allowlist${named || " (none)"}`;
  const writeReason = `writes to GitHub reach only the repos on this sandbox's push allowlist${named || " (none)"}`;
  const guards: RequestGuard[] = [
    {
      name: "github-push", hosts: ["github.com"], scope: [{ path: "/**/git-receive-pack" }, RECEIVE_DISCOVERY], allow: webRepo(repos),
      reason: pushReason, ignore_case: true,
    },
    {
      name: "github-write", hosts: ["github.com"], scope: [writes()],
      allow: [
        { methods: ["POST"], path: "/**/git-upload-pack" },
        { methods: ["POST"], path: "/**/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
        ...webRepo(repos),
      ],
      reason: writeReason, ignore_case: true,
    },
    {
      name: "github-api-write", hosts: ["*.github.com"], scope: [writes()],
      allow: [...apiRepo(repos), ...(repos.length ? [{ methods: ["POST"], path: "/graphql", injected: GITHUB_BINDING }] : [])],
      reason: `${writeReason}; GraphQL writes go only with the sandbox's own GitHub token`, ignore_case: true,
    },
    { name: "gist-write", hosts: ["gist.github.com"], scope: [writes(), RECEIVE_DISCOVERY], reason: "gists are read-only from a sandbox", ignore_case: true },
    { name: "githubusercontent-write", hosts: ["*.githubusercontent.com"], scope: [writes()], reason: "GitHub's content hosts are read-only from a sandbox", ignore_case: true },
  ];
  // No exceptions: `allow` absent, as the wire writes it.
  return guards.map(({ allow, ...g }) => (allow?.length ? { ...g, allow } : g));
}

/** The injection binding for a sandbox's installation token: git over HTTPS (Basic) and the API (Bearer). */
export function githubBinding(): InjectionBinding {
  return {
    name: GITHUB_BINDING, hosts: ["github.com", "api.github.com"], placeholder: GITHUB_PLACEHOLDER,
    locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password" }],
  };
}

/**
 * What a push allowlist adds to a sandbox's policy: the guards always (an empty list refuses every
 * push), and with any repo the API host (for `gh`) and the binding its token is injected under.
 */
export function githubEgress(allowlist: readonly string[]): PolicyFragment {
  const repos = canonicalRepos(allowlist);
  return {
    allow: repos.length ? [{ host: "api.github.com" }] : [],
    inject: repos.length ? [githubBinding()] : [],
    guards: githubGuards(repos),
  };
}
