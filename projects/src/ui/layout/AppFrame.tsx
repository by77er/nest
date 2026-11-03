// The frame around every page: a persistent sidebar on the surface (the product's name, small, then the
// places, and a footer set apart by a hairline at its bottom) beside the content on the page's ground. Below `md` the sidebar is a
// drawer behind a burger in a slim header; it collapses in 180 ms (motion `base`), honouring reduced
// motion, and closes when the owner picks a place.

import { AppShell, Burger, Group, ScrollArea } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import type { ReactNode } from "react";
import { layout, motion } from "../theme";
import navClasses from "./Nav.module.css";

export interface AppFrameProps {
  /** The product's name, a link home. */
  brand: ReactNode;
  /** The sidebar's places; `close` closes the drawer (call it when a place is picked). */
  nav: (close: () => void) => ReactNode;
  /** What stays at the sidebar's bottom (Admin). */
  navFooter?: (close: () => void) => ReactNode;
  children: ReactNode;
}

export function AppFrame({ brand, nav, navFooter, children }: AppFrameProps) {
  const [opened, { toggle, close }] = useDisclosure(false);
  // `md` and up: the sidebar is always there, and the header isn't needed.
  const narrow = useMediaQuery("(max-width: 61.99em)") ?? false;
  return (
    <AppShell
      header={{ height: "var(--nest-header-height)", collapsed: !narrow }}
      navbar={{ width: layout.sidebar, breakpoint: "md", collapsed: { mobile: !opened } }}
      padding={0}
      transitionDuration={motion.base}
      transitionTimingFunction={motion.enter}
    >
      <AppShell.Header px="lg" style={{ background: "var(--nest-surface)", borderBottom: "var(--nest-border)" }}>
        <Group h="100%" gap="md" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} size="sm" aria-label={opened ? "Close the menu" : "Open the menu"} aria-expanded={opened} aria-controls="sidebar" />
          {brand}
        </Group>
      </AppShell.Header>
      <AppShell.Navbar id="sidebar" aria-label="Sidebar" style={{ background: "var(--nest-surface)", borderRight: "var(--nest-border)" }} data-ds="sidebar" data-opened={opened || undefined}>
        {!narrow && (
          <AppShell.Section px="sm">
            <div className={navClasses.brand}>{brand}</div>
          </AppShell.Section>
        )}
        <AppShell.Section grow component={ScrollArea} px="sm" pt={narrow ? "lg" : "xs"} pb="xl">
          <nav aria-label="Main">{nav(close)}</nav>
        </AppShell.Section>
        {navFooter && (
          <AppShell.Section px="sm" pt="md" pb="lg" style={{ borderTop: "var(--nest-border)" }}>
            {navFooter(close)}
          </AppShell.Section>
        )}
      </AppShell.Navbar>
      <AppShell.Main style={{ background: "var(--nest-page-bg)" }}>{children}</AppShell.Main>
    </AppShell>
  );
}
