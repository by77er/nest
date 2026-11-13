// The Worker's bindings, vars and secrets (wrangler.jsonc).
import type { DirectoryDO } from "./do/directory";
import type { ProjectDO } from "./do/project";
import type { ReviewDO } from "./do/review";

export interface Env {
  ASSETS: Fetcher;
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  REVIEW: DurableObjectNamespace<ReviewDO>;
  /** nest's base URL: its client API, and the `iss` of Nest-Identity tokens. */
  NEST_CONTROL_PLANE: string;
  /** The cell the app's agents and sandboxes run in: a create's `cell`, and a listing's filter. */
  NEST_CELL: string;
  /** This Worker's base URL; the MCP servers are `${PUBLIC_BASE_URL}/mcp/<server>`. */
  PUBLIC_BASE_URL: string;
  /** The Zero Trust team's domain: the Access token's issuer. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The projects Access application's audience tag. */
  PROJECTS_AUD?: string;
  /** Secret: the `projects` API client's token. */
  NEST_CLIENT_TOKEN?: string;
  /** Secret: signs nest's webhooks to /hooks/nest. */
  NEST_WEBHOOK_SECRET?: string;
  /** Secret: signs the GitHub App's webhooks to /hooks/github. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Secret: the app's GitHub App's id (README.md#github-tokens). */
  GITHUB_APP_ID?: string;
  /** Secret: the App's private key, a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) as GitHub hands it out. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /**
   * The GitHub account ids, besides the App owner's, whose installations of the App the app acts on (comma or space
   * separated; ids only, nothing turns the check off). README.md#repo-authority.
   */
  GITHUB_ACCOUNTS?: string;
  /** `nest`: the app's GitHub tokens come from nest's `POST /v1/clients/self/github-token` (the fallback, for one release); anything else, or unset: from the App. */
  GITHUB_TOKEN_SOURCE?: string;
}

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
export const project = (env: Env, id: string) => env.PROJECT.get(env.PROJECT.idFromName(id));
export const review = (env: Env, id: string) => env.REVIEW.get(env.REVIEW.idFromName(id));
