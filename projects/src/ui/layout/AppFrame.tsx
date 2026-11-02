// The frame around every page: a header (the product's name left, its places right) on the surface,
// over the content on the page's ground.

import { AppShell, Group } from "@mantine/core";
import type { ReactNode } from "react";

export function AppFrame({ brand, nav, children }: { brand: ReactNode; nav?: ReactNode; children: ReactNode }) {
  return (
    <AppShell header={{ height: "var(--nest-header-height)" }} padding={0}>
      <AppShell.Header px={{ base: "lg", sm: "xl", md: "2xl" }} style={{ background: "var(--nest-surface)", borderBottom: "var(--nest-border)" }}>
        <Group h="100%" justify="space-between" wrap="nowrap" gap="lg">
          {brand}
          {nav && (
            <Group gap="lg" component="nav" aria-label="Main" wrap="nowrap">
              {nav}
            </Group>
          )}
        </Group>
      </AppShell.Header>
      <AppShell.Main style={{ background: "var(--nest-page-bg)" }}>{children}</AppShell.Main>
    </AppShell>
  );
}
