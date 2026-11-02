// A page: centred, at most 1440 px wide, with gutters of `lg` (phone), `xl` (tablet) and `2xl`
// (desktop), and its blocks `2xl` apart. Its header carries the one h1.

import { Box, Breadcrumbs, Group, Stack, Title } from "@mantine/core";
import type { ReactNode } from "react";

export function Page({ children, measure = false }: { children: ReactNode; /** Keep the content to a readable measure (forms, prose), on the page's left edge. */ measure?: boolean }) {
  return (
    <Box maw="var(--nest-page-max)" mx="auto" px={{ base: "lg", sm: "xl", md: "2xl" }} py={{ base: "lg", sm: "xl", md: "2xl" }} data-ds="page">
      <Stack gap="2xl" maw={measure ? "var(--nest-measure)" : undefined}>
        {children}
      </Stack>
    </Box>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Links above the title, ending at the current page. */
  breadcrumbs?: ReactNode[];
  /** A caption line under the title (a repo, a setting). */
  meta?: ReactNode;
  /** The page's actions, its primary one rightmost: on the title's baseline, wrapping below it when narrow. */
  actions?: ReactNode;
}

export function PageHeader({ title, breadcrumbs, meta, actions }: PageHeaderProps) {
  return (
    <Stack gap="xs" data-ds="page-header">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumbs separatorMargin="xs" fz="sm">
          {breadcrumbs}
        </Breadcrumbs>
      )}
      <Group justify="space-between" align="baseline" wrap="wrap" gap="md" data-slot="title-row">
        <Title order={1} style={{ flex: "1 1 16rem", minWidth: 0 }}>
          {title}
        </Title>
        {actions && (
          <Group gap="sm" wrap="wrap" justify="flex-end" ml="auto" data-slot="actions">
            {actions}
          </Group>
        )}
      </Group>
      {meta && (
        <Group gap="sm" wrap="wrap" data-slot="meta">
          {meta}
        </Group>
      )}
    </Stack>
  );
}
