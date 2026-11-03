// A column and a row whose gaps come from the spacing scale only.

import { Group, type GroupProps, Stack as MantineStack, type StackProps as MantineStackProps, Text } from "@mantine/core";
import type { Space } from "../theme";

export type StackProps = Omit<MantineStackProps, "gap" | "style"> & { gap?: Space; fill?: boolean };
export type RowProps = Omit<GroupProps, "gap" | "style"> & { gap?: Space };

/** Blocks one above the other, `gap` apart (`md` by default). */
export function Stack({ gap = "md", fill = false, ...rest }: StackProps) {
  // `fill`: takes the rest of a column with a height (its last child may then fill it too).
  return <MantineStack gap={gap} {...rest} style={fill ? { flex: 1, minHeight: 0 } : undefined} />;
}

/** Things side by side, `gap` apart (`sm` by default), wrapping, vertically centred. */
export function Row({ gap = "sm", wrap = "wrap", ...rest }: RowProps) {
  return <Group gap={gap} wrap={wrap} {...rest} />;
}

/** Text that keeps its line breaks (a message, a question, a spec's paragraphs). */
export function Prose({ children, size = "md", dimmed = false }: { children: React.ReactNode; size?: "sm" | "md" | "lg"; dimmed?: boolean }) {
  return (
    <Text fz={size} c={dimmed ? "dimmed" : undefined} style={{ whiteSpace: "pre-wrap" }} data-ds="prose">
      {children}
    </Text>
  );
}
