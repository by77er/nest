// What waits for triage, in words (README.md#triage): the repo's issues and the tasks routines proposed,
// said the same way in "Needs you" and in the Manager page's context.

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "3 issues and 1 proposed task wait", "1 issue waits", "2 proposed tasks wait". */
export function triageWaits(issues: number, proposals: number): string {
  const parts = [issues ? n(issues, "issue", "issues") : null, proposals ? n(proposals, "proposed task", "proposed tasks") : null].filter((p): p is string => p !== null);
  return `${parts.join(" and ")} ${issues + proposals === 1 ? "waits" : "wait"}`;
}

/** Whose they are, for the item's caption. */
export function triageSource(issues: number, proposals: number): string {
  if (issues && proposals) return "Issues and routines' proposals";
  return proposals ? "Routines' proposals" : "The repo's issues";
}

/**
 * Who "you" is for whose issues come into triage (README.md#triage): the PR comments user and the repo's
 * owner (a person's repo), by login (or id, when no login was seen), each once. Empty: no one yet (an
 * organization's repo with no comments user set).
 */
export function issuesFromWho(s: { comments_from: { id: number; login: string | null } | null; repo_owner: { id: number; login: string } | null }): string[] {
  const who: { id: number; name: string }[] = [];
  if (s.comments_from) who.push({ id: s.comments_from.id, name: s.comments_from.login ?? `user ${s.comments_from.id}` });
  if (s.repo_owner && !who.some((w) => w.id === s.repo_owner!.id)) who.push({ id: s.repo_owner.id, name: s.repo_owner.login });
  return who.map((w) => w.name);
}

/**
 * Why the default PR comments user went (README.md#pr-comments), said the same way in "Needs you" and in
 * the Manager page's context: the repo's owner is another account now.
 */
export function commentsCleared(x: { was: { id: number; login: string | null }; owner: { login: string } }): string {
  return `${x.owner.login} owns the repo now, so ${x.was.login ?? `user ${x.was.id}`} is no longer the PR comments user`;
}

/** "by77er", "by77er and alice". */
export const names = (who: string[]) => (who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : (who[0] ?? ""));
