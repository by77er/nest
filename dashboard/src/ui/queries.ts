// The page's server state, in TanStack Query: the fleet, templates and agents every 10 s, what is left
// lying around every 60 s (heavier: every registered sandbox and the agents they lead to). Polling
// stops while the tab is hidden (TanStack Query's default) and resumes, with a read, when it shows.

import { QueryClient, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api";

export const REFRESH_MS = 10_000;
export const LIFETIMES_REFRESH_MS = 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A 4xx won't change by asking again; a 5xx or a lost connection might.
        retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
        refetchIntervalInBackground: false,
      },
    },
  });
}

export const useCells = () => useQuery({ queryKey: ["cells"], queryFn: api.cells, staleTime: Infinity });

export const useFleet = (cell: string) =>
  useQuery({ queryKey: ["fleet", cell], queryFn: () => api.fleet(cell), enabled: !!cell, refetchInterval: REFRESH_MS });

export const useImages = (cell: string) =>
  useQuery({ queryKey: ["images", cell], queryFn: () => api.images(cell), enabled: !!cell, refetchInterval: REFRESH_MS });

export const useAgents = (cell: string) =>
  useQuery({ queryKey: ["agents", cell], queryFn: () => api.agents(cell), enabled: !!cell, refetchInterval: REFRESH_MS });

export const useLifetimes = (cell: string) =>
  useQuery({ queryKey: ["lifetimes", cell], queryFn: () => api.lifetimes(cell), enabled: !!cell, refetchInterval: LIFETIMES_REFRESH_MS });

/** A failed read as the page says it. */
export const describe = (e: unknown) => (e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e));
