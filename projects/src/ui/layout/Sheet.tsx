// A drawer from the right for one thing's detail (a task): the screen's width on a phone, a fixed width
// beside the page from `sm` on. Its title is the h2; its content, sections `2xl` apart.

import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ReactNode } from "react";

export function Sheet({ opened, onClose, title, children }: { opened: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const phone = useMediaQuery("(max-width: 48em)");
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={phone ? "100%" : "xl"} title={title}>
      {children}
    </Drawer>
  );
}
