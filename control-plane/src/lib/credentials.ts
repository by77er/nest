// Which Claude setup token a brain starts on (docs/control-plane/durable-objects/broker/#claude-setup-tokens).
// Pure: BrokerDO answers `available` from its `secrets` table, AgentDO supplies the principal and grant.
import { Credential, SETUP_TOKEN_SECRET } from "../protocol/control";

/** The operator's default setup token. */
export const DEFAULT_CREDENTIAL = SETUP_TOKEN_SECRET;

/** Whose agent is starting: the operator's own (no client), or one in an API client's subtree. */
export type CredentialPrincipal = { kind: "operator" } | { kind: "client"; client: string };

/** Why no credential: the spec names a non-credential, the client's grant doesn't name it, or no usable value is stored. */
export type CredentialRefusal = "not_a_credential" | "not_granted" | "unavailable";

export type CredentialChoice =
  | { ok: true; name: string; fallback: boolean }
  | { ok: false; reason: CredentialRefusal; message: string };

/**
 * The secret a brain's `agent_start` names for an agent whose spec asks for `requested`.
 * - **The operator's agents:** the named token if stored and unexpired, else the default (`fallback`),
 *   else none. The operator holds every credential, so falling back stays within its authority.
 * - **A client's agents:** exactly `requested`, only while the client's grant (`credentials`, as it is
 *   now: null once the client is gone) names it and a value is stored. Never another credential,
 *   whatever the grant also names: a fallback would cross authority, onto a token the client never
 *   chose and maybe the operator's own subscription.
 */
export function credentialFor(
  principal: CredentialPrincipal, requested: string, grant: { credentials: readonly string[] } | null, available: (name: string) => boolean,
): CredentialChoice {
  if (!Credential.safeParse(requested).success) {
    return { ok: false, reason: "not_a_credential", message: `${requested} is not a Claude setup token credential` };
  }
  if (principal.kind === "operator") {
    if (available(requested)) return { ok: true, name: requested, fallback: false };
    if (requested !== DEFAULT_CREDENTIAL && available(DEFAULT_CREDENTIAL)) return { ok: true, name: DEFAULT_CREDENTIAL, fallback: true };
    return { ok: false, reason: "unavailable", message: `no Claude setup token configured for ${requested}` };
  }
  if (!grant || !grant.credentials.includes(requested)) {
    return { ok: false, reason: "not_granted", message: `client ${principal.client}'s grant doesn't name the credential ${requested}` };
  }
  if (!available(requested)) {
    return {
      ok: false, reason: "unavailable",
      message: `the Claude setup token ${requested} isn't configured or has expired; an API client's agent runs only on the credential its spec names (no fallback)`,
    };
  }
  return { ok: true, name: requested, fallback: false };
}
