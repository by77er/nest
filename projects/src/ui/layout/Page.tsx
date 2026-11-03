// A page: centred, at most 1440 px wide, with gutters of `lg` (phone), `xl` (tablet) and `2xl`
// (desktop), and its blocks `2xl` apart. Its header carries the one h1.

import { Box, Group, Stack, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * `measure` keeps the content to a line length, centred in the content area (balance: no empty half):
 * `form` (forms, prose: 45rem) or `reading` (a conversation: about 70 characters). The header is inside
 * the column, so the h1 and the content share one left edge.
 */
export function Page({ children, measure }: { children: ReactNode; measure?: "form" | "reading" }) {
  return (
    <Box maw="var(--nest-page-max)" mx="auto" px={{ base: "lg", sm: "xl", md: "2xl" }} py={{ base: "lg", sm: "xl", md: "2xl" }} data-ds="page">
      <Stack gap="2xl" maw={measure === "form" ? "var(--nest-measure)" : measure === "reading" ? "var(--nest-reading-measure)" : undefined} mx={measure ? "auto" : undefined} data-measure={measure}>
        {children}
      </Stack>
    </Box>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  /** A caption line under the title (a repo, a setting). */
  meta?: ReactNode;
  /** The page's actions, its primary one rightmost: on the title's baseline, wrapping below it when narrow. */
  actions?: ReactNode;
}

export function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <Stack gap="xs" data-ds="page-header">
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
