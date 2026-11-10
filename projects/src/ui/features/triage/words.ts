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
