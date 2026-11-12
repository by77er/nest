// How many things in a project need the owner (open asks and blocked tasks): the badge on its sidebar
// group, from the projects list's `needs_you` (GET /api/projects), which the list's query keeps fresh.
import { useProjects } from "../../api/queries";

export function useNeedsYou(projectId: string): number | null | undefined {
  const projects = useProjects();
  // A refresh that failed after a good read: the count is unknown now, not what it was.
  return unknownIfStale(projects.isRefetchError, projects.data?.find((p) => p.id === projectId)?.needs_you);
}

/** A count from a list whose last refresh failed is unknown (null), not the old number. */
export const unknownIfStale = <T extends number | null | undefined>(stale: boolean, n: T): T | null => (stale && n !== undefined ? null : n);
