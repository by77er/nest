// Whose PRs are reviewed without the owner's approval (README.md#the-review-gate). Pure.
//
// A review starts an agent on the PR's code, on the owner's subscription and hosts. On a public repo
// anyone can open a PR, so a review starts by itself only for a PR the project trusts: its head is a
// branch of the repo itself (pushing there needs write access), and its author is, by GitHub's id in the
// signed webhook, the project's comments user, the repo's owner, or the GitHub App's own bot (workers'
// task PRs). Any other PR's review is held until the owner approves that head commit.

/** What a project does with a PR it doesn't trust: hold its review for the owner (the default), or review it like any other. */
export type UntrustedPolicy = "hold" | "review";

/** Where a PR comes from, as the signed `pull_request` event says. */
export interface PrOrigin {
  /** Its head isn't a branch of the project's repo. */
  fork: boolean;
  /** Its author's GitHub id (`pull_request.user.id`); null when the event names none. */
  author_id: number | null;
}

/** The GitHub ids a project trusts; null for one it doesn't have (no comments user, an organization's repo, the bot not learned yet). */
export interface TrustedIds {
  comments_from: number | null;
  /** The repo's owner as the signed event being decided names it (`repository.owner`), never a copy kept from before. */
  repo_owner: number | null;
  app_bot: number | null;
}

export function trustedAuthor(o: PrOrigin, ids: TrustedIds): boolean {
  if (o.fork || o.author_id === null) return false;
  return o.author_id === ids.comments_from || o.author_id === ids.repo_owner || o.author_id === ids.app_bot;
}

/** Whether a PR head's review starts by itself (`review`) or waits for the owner (`hold`). */
export function reviewDecision(o: PrOrigin, ids: TrustedIds, policy: UntrustedPolicy): "review" | "hold" {
  return policy === "review" || trustedAuthor(o, ids) ? "review" : "hold";
}

/**
 * Held jobs a project keeps at once. A head past it waits as `overflow` (its check says the review
 * queue is full; not in "Needs you", still approvable on the Reviews page) and is held once a slot frees.
 */
export const MAX_HELD = 50;
/** Overflow jobs a project keeps: past it an untrusted head gets no job (and so no check and no review, whatever GitHub sends) until there is room; it is counted for the owner meanwhile. */
export const MAX_OVERFLOW = 500;
/** At most one held check run per PR in this long: fast pushes to one PR can't spend the installation's GitHub rate limit. */
export const HELD_CHECK_INTERVAL_MS = 60_000;
