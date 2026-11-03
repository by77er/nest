// A titled block: a heading row of one height everywhere (the title, an optional count, its actions at
// the right), then its content `lg` below. `dense` is a board column's: an h4 and `sm` below.

import { Badge, Group, Stack, Text, Title } from "@mantine/core";
import { type ReactNode, useId } from "react";
import { icon as iconSize, type Role } from "../theme";

export interface SectionProps {
  title: ReactNode;
  /** How many things it holds, beside the title. */
  count?: number;
  /** Its actions, the primary one rightmost, at the top right. */
  actions?: ReactNode;
  dense?: boolean;
  /** The heading's level: 3 for a page's section, 4 for a Panel's within one (and a dense one's). */
  order?: 3 | 4;
  /** An icon before the title, in a role's color (a banner's). */
  icon?: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  iconColor?: Role;
  /** A landmark (`region`) named by its title; off for a section that isn't a place of its own. */
  region?: boolean;
  children?: ReactNode;
}

export function Section({ title, count, actions, dense = false, order, region = true, icon: Icon, iconColor = "gray", children }: SectionProps) {
  const id = useId();
  return (
    <Stack gap={dense ? "sm" : "lg"} component={region ? "section" : "div"} aria-labelledby={region ? id : undefined} data-ds="section" miw={0}>
      <Group justify="space-between" align="center" wrap="wrap" gap="sm" mih={dense ? "var(--nest-dense-head)" : "var(--nest-section-head)"} data-slot="head">
        <Group gap="sm" wrap="nowrap" align="center" miw={0}>
          {Icon && (
            <Text component="span" c={iconColor === "gray" ? "dimmed" : iconColor} style={{ display: "inline-flex", flexShrink: 0 }}>
              <Icon size={iconSize.lg} aria-hidden />
            </Text>
          )}
          <Title order={order ?? (dense ? 4 : 3)} id={id}>
            {title}
          </Title>
          {count !== undefined && (
            <Badge size="sm" variant="default" aria-label={`${count} ${count === 1 ? "item" : "items"}`} data-slot="count">
              {count}
            </Badge>
          )}
        </Group>
        {actions && (
          <Group gap="sm" wrap="wrap" justify="flex-end" ml="auto" data-slot="actions">
            {actions}
          </Group>
        )}
      </Group>
      {children}
    </Stack>
  );
}
