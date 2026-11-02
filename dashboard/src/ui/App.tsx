// The providers around the page: Mantine (the theme, light and dark following the system) and
// TanStack Query.

import { MantineProvider } from "@mantine/core";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetPage } from "./features/FleetPage";
import { cssVariablesResolver, theme } from "./theme";

/** `env: "test"` turns Mantine's transitions and portals off (component tests). */
export function App({ queryClient, env }: { queryClient: QueryClient; env?: "default" | "test" }) {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto" env={env}>
      <QueryClientProvider client={queryClient}>
        <FleetPage />
      </QueryClientProvider>
    </MantineProvider>
  );
}
