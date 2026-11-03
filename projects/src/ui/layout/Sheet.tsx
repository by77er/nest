// A drawer from the right for one thing's detail (a task): the screen's width on a phone, a fixed width
// beside the page from `sm` on. Its title is the h2; its content, sections `2xl` apart.
//
// With `beside` (a task's worker's trace), from `lg` on it's wider (`--nest-sheet-wide`) and holds two
// columns that scroll on their own: the details in a third (`--nest-sheet-details`), what's beside them in
// the rest, since that's the one read at length (a log's long lines). Below `lg`, where both don't fit at a
// readable width, the two are tabs.

import { Box, Drawer, ScrollArea, Tabs } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { createContext, type ReactNode, useContext } from "react";

const Column = createContext(false);
/** Whether this is a sheet's side column with a height of its own, for its content to fill (and scroll in itself). */
export const useFillColumn = () => useContext(Column);

export function Sheet({ opened, onClose, title, children, beside, labels = ["Details", "Trace"] }: {
  opened: boolean; onClose: () => void; title: string; children: ReactNode; beside?: ReactNode; labels?: [string, string];
}) {
  const phone = useMediaQuery("(max-width: 48em)");
  const wide = useMediaQuery("(min-width: 75em)");
  if (beside && wide) {
    return (
      <Drawer
        opened={opened}
        onClose={onClose}
        position="right"
        size="var(--nest-sheet-wide)"
        title={title}
        styles={{
          content: { display: "flex", flexDirection: "column" },
          body: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "var(--nest-sheet-details) minmax(0, 1fr)", gap: "var(--mantine-spacing-2xl)" },
        }}
      >
        <ScrollArea type="auto" offsetScrollbars style={{ height: "100%", minHeight: 0 }} data-column="details">
          {children}
        </ScrollArea>
        <Box style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, height: "100%" }} data-column="beside">
          <Column.Provider value={true}>{beside}</Column.Provider>
        </Box>
      </Drawer>
    );
  }
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={phone ? "100%" : "xl"} title={title}>
      {beside ? (
        <Tabs defaultValue="details" keepMounted={false}>
          <Tabs.List grow>
            <Tabs.Tab value="details">{labels[0]}</Tabs.Tab>
            <Tabs.Tab value="beside">{labels[1]}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="details" pt="xl">
            {children}
          </Tabs.Panel>
          <Tabs.Panel value="beside" pt="xl">
            {beside}
          </Tabs.Panel>
        </Tabs>
      ) : (
        children
      )}
    </Drawer>
  );
}
