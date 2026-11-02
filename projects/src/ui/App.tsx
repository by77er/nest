// The providers around the page: Mantine (the theme, modals, notifications), TanStack Query and the router.

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { AppRouter } from "./router";
import { theme } from "./theme";

/** `env: "test"` turns Mantine's transitions and portals off (component tests). */
export function App({ router, queryClient, env }: { router: AppRouter; queryClient: QueryClient; env?: "default" | "test" }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="light" env={env}>
      <QueryClientProvider client={queryClient}>
        <ModalsProvider>
          <Notifications position="top-right" />
          <RouterProvider router={router} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
