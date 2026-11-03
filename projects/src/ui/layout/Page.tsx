// A page: centred, at most 1440 px wide, with gutters of `lg` (phone), `xl` (tablet) and `2xl`
// (desktop), and its blocks `2xl` apart. Its header carries the one h1.

import { Box, Group, Stack, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * The frame never moves: every page of a section has this one container (max width, gutters), so its
 * header and edges stay put as you switch views; only the content changes. Narrow content goes in a
 * `Measure`, left-aligned to the frame, with related context beside it (`WithContext`).
 */
export function Page({ children }: { children: ReactNode }) {
  return (
    <Box maw="var(--nest-page-max)" mx="auto" px={{ base: "lg", sm: "xl", md: "2xl" }} py={{ base: "lg", sm: "xl", md: "2xl" }} data-ds="page">
      <Stack gap="2xl" data-ds="page-content">
        {children}
      </Stack>
    </Box>
  );
}

/** Content kept to a line length (`reading`: a conversation; `form`: a form or prose), on the frame's left edge. */
export function Measure({ children, type }: { children: ReactNode; type: "reading" | "form" }) {
  return (
    <Box maw={type === "form" ? "var(--nest-measure)" : "var(--nest-reading-measure)"} w="100%" data-ds="measure" data-measure={type}>
      {children}
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
