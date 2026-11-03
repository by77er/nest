// A drawer from the right for one thing's detail (a task): the screen's width on a phone, a fixed width
// beside the page from `sm` on. Its title is the h2; its content, sections `2xl` apart.
//
// `split` (a task's drawer, which may hold its worker's trace): one width whatever it holds, so its title
// never moves between tasks. From `xl` on that's `--nest-sheet-wide`, and with `beside` two columns that
// scroll on their own: the details in a third (`--nest-sheet-details`), what's beside them in the rest,
// since that's the one read at length (a log's long lines). Below `xl`, where both don't fit at a readable
// width (at 1200 px the wide sheet would cover the page), the two are tabs, each the sheet's full height,
// kept mounted so switching keeps a trace's connection, scroll and what's expanded.

import { Box, Drawer, ScrollArea, Tabs } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconFileText, IconTimeline } from "@tabler/icons-react";
import { createContext, type ReactNode, useContext } from "react";
import { icon } from "../theme";

const Column = createContext<{ fill: boolean; untitled: boolean }>({ fill: false, untitled: false });
/**
 * Whether this is a sheet's side column or tab with a height of its own, for its content to fill (and
 * scroll in itself); `untitled`: a tab already names it, so it needs no heading of its own on screen.
 */
export const useFillColumn = () => useContext(Column);

const FULL = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;

export function Sheet({ opened, onClose, title, children, beside, split = false, labels = ["Details", "Trace"] }: {
  opened: boolean; onClose: () => void; title: string; children: ReactNode; beside?: ReactNode; split?: boolean; labels?: [string, string];
}) {
  const phone = useMediaQuery("(max-width: 48em)");
  const wide = useMediaQuery("(min-width: 88em)");
  const size = phone ? "100%" : split && wide ? "var(--nest-sheet-wide)" : "xl";
  if (beside && wide && split) {
    return (
      <Drawer
        opened={opened}
        onClose={onClose}
        position="right"
        size={size}
        title={title}
        styles={{
          content: { display: "flex", flexDirection: "column" },
          body: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "var(--nest-sheet-details) minmax(0, 1fr)", gap: "var(--mantine-spacing-2xl)" },
        }}
      >
        <ScrollArea type="auto" offsetScrollbars style={{ height: "100%", minHeight: 0 }} data-column="details">
          {children}
        </ScrollArea>
        <Box style={{ ...FULL, minWidth: 0, height: "100%" }} data-column="beside">
          <Column.Provider value={{ fill: true, untitled: false }}>{beside}</Column.Provider>
        </Box>
      </Drawer>
    );
  }
  if (beside) {
    return (
      <Drawer
        opened={opened}
        onClose={onClose}
        position="right"
        size={size}
        title={title}
        styles={{ content: { display: "flex", flexDirection: "column" }, body: { ...FULL } }}
      >
        <Tabs defaultValue="details" keepMounted style={FULL}>
          <Tabs.List>
            <Tabs.Tab value="details" leftSection={<IconFileText size={icon.md} />}>
              {labels[0]}
            </Tabs.Tab>
            <Tabs.Tab value="beside" leftSection={<IconTimeline size={icon.md} />}>
              {labels[1]}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="details" pt="xl" style={{ flex: 1, minHeight: 0 }}>
            <ScrollArea type="auto" offsetScrollbars style={{ height: "100%" }} data-column="details">
              {children}
            </ScrollArea>
          </Tabs.Panel>
          <Tabs.Panel value="beside" pt="xl" style={{ ...FULL }} data-column="beside">
            <Column.Provider value={{ fill: true, untitled: true }}>{beside}</Column.Provider>
          </Tabs.Panel>
        </Tabs>
      </Drawer>
    );
  }
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={size} title={title}>
      {split && wide ? <Box maw="var(--nest-measure)">{children}</Box> : children}
    </Drawer>
  );
}
