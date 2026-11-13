// The page's server state lives in TanStack Query. Failed mutations are announced in one place (a red
// notification titled by the mutation's `meta.failure`), so a component handles only its success.

import { notifications } from "@mantine/notifications";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

declare module "@tanstack/react-query" {
  interface Register {
    /**
     * `failure`: the notification's title; `inline`: the view shows the error itself, so no notification;
     * `inlineStatus`: the same, for answers with these statuses only.
     */
    mutationMeta: { failure?: string; inline?: boolean; inlineStatus?: number[] };
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _vars, _result, mutation) => {
        if (mutation.meta?.inline) return;
        if (error instanceof ApiError && mutation.meta?.inlineStatus?.includes(error.status)) return;
        notifications.show({ color: "danger", title: mutation.meta?.failure ?? "That didn't work", message: error.message });
      },
    }),
    defaultOptions: {
      queries: {
        // A 4xx won't change by asking again; a 5xx or a lost connection might.
        retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
        staleTime: 2_000,
      },
    },
  });
}
