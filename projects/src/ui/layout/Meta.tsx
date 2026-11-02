// A caption line of small facts (who, when, which PR) below the thing they're about: dimmed, wrapping
// rather than clipping. Ids are set in the mono family.

import { Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { icon as iconSize } from "../theme";

export function MetaRow({ children }: { children: ReactNode }) {
  return (
    <Group gap="sm" wrap="wrap" data-ds="meta" style={{ rowGap: "var(--mantine-spacing-2xs)" }}>
      {children}
    </Group>
  );
}

/** One fact, with an optional icon before it (decoration, hidden from readers). `mono` for an id. */
export function MetaItem({ icon: Icon, children, title, mono = false }: { icon?: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" align="center" miw={0} title={title}>
      {Icon && (
        <Text component="span" c="dimmed" style={{ display: "inline-flex", flexShrink: 0 }}>
          <Icon size={iconSize.sm} aria-hidden />
        </Text>
      )}
      <Text component="span" size="xs" c="dimmed" ff={mono ? "monospace" : undefined} miw={0}>
        {children}
      </Text>
    </Group>
  );
}
