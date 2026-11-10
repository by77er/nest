// Whose GitHub issues come into triage, and how many wait at once (README.md#triage). Shared by ProjectDO
// and the UI.

/** `trusted`: the comments user's and the repo owner's only, by the issue's author id (the default). `anyone`: every issue. */
export const ISSUES_FROM = ["trusted", "anyone"] as const;
export type IssuesFrom = (typeof ISSUES_FROM)[number];

/** At most this many issues wait for triage at once: past it, new ones are dropped (and counted). */
export const MAX_UNTRIAGED_ISSUES = 200;
