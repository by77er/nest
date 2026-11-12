// How many things in a project need the owner (open asks and blocked tasks): the badge on its sidebar
// group, from the projects list's `needs_you` (GET /api/projects), which the list's query keeps fresh.
import { useProjects } from "../../api/queries";

export function useNeedsYou(projectId: string): number | null | undefined {
  return useProjects().data?.find((p) => p.id === projectId)?.needs_you;
}
