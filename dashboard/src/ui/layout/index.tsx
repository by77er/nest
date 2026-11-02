// The layout primitives (the skill's "Layout primitives"): every screen is composed from these and
// Mantine's components. They hold the layout's values (layout.module.css); feature code arranges them.

import { ActionIcon, Alert, Badge, Button, CopyButton, Group, Loader, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useTimeout } from "@mantine/hooks";
import { IconAlertTriangle, IconCheck, IconCircleCheck, IconCircleX, IconCopy } from "@tabler/icons-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Role } from "../theme";
import classes from "./layout.module.css";

/** The header (product name left, nav right) over the content area. */
export function AppFrame({ product, nav, children }: { product: ReactNode; nav?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className={classes.header}>
        <div className={`${classes.page} ${classes.headerInner}`}>
          <Text fw={600} size="lg">{product}</Text>
          {nav && <Group gap="sm">{nav}</Group>}
        </div>
      </header>
      <main className={`${classes.page} ${classes.content}`}>{children}</main>
    </>
  );
}

/** The page's blocks, `2xl` apart. */
export function Page({ children }: { children: ReactNode }) {
  return <Stack gap="2xl">{children}</Stack>;
}

/** The h1 and its meta line; actions right on the title's baseline, wrapping below it. */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={classes.pageHeader}>
      <Stack gap="xs">
        <Title order={1}>{title}</Title>
        {meta && <Text size="sm" c="dimmed">{meta}</Text>}
      </Stack>
      {actions && <Group gap="sm">{actions}</Group>}
    </div>
  );
}

/** A heading row (h3, an optional count, actions right) over its content, `lg` below the heading. */
export function Section({ id, title, count, meta, actions, children }: {
  id: string;
  title: string;
  count?: number;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section id={id} aria-labelledby={heading} className={classes.section}>
      <div className={classes.sectionHead}>
        <Stack gap="2xs">
          <Group gap="sm" align="baseline">
            <Title order={3} id={heading}>{title}</Title>
            {count !== undefined && <Text size="sm" c="dimmed">{count}</Text>}
          </Group>
          {meta && <Text size="sm" c="dimmed">{meta}</Text>}
        </Stack>
        {actions && <Group gap="sm">{actions}</Group>}
      </div>
      {children}
    </section>
  );
}

/**
 * The bordered surface: cards, banners and table frames. `dense` pads `md`; `flush` not at all (a
 * table); `fill` takes its grid cell's height. With `id` and `tabIndex` it is a place the page can
 * move the focus to.
 */
export function Panel({ children, padding = "default", fill, ...rest }: {
  children: ReactNode;
  padding?: "default" | "dense" | "flush";
  fill?: boolean;
  id?: string;
  tabIndex?: number;
  "aria-label"?: string;
  role?: string;
}) {
  return (
    <Paper withBorder radius="md" p={padding === "default" ? "lg" : padding === "dense" ? "md" : 0} className={fill ? classes.fill : undefined} {...rest}>
      {children}
    </Paper>
  );
}

/** A table in its own frame and scroller, its header kept in view. */
export function DataTable({ label, head, children }: { label: string; head: ReactNode; children: ReactNode }) {
  return (
    <Panel padding="flush">
      <div className={classes.scroller} tabIndex={0} role="group" aria-label={`${label}, scrollable`}>
        <Table stickyHeader highlightOnHover aria-label={label}>
          <Table.Thead><Table.Tr>{head}</Table.Tr></Table.Thead>
          <Table.Tbody>{children}</Table.Tbody>
        </Table>
      </div>
    </Panel>
  );
}

/** A stat tile (the dataviz skill's contract): a label, a value, and a caption line. */
export function StatTile({ label, value, caption }: { label: string; value: ReactNode; caption?: ReactNode }) {
  return (
    <Panel>
      <Stack gap="xs">
        <Text size="sm" fw={500} c="dimmed">{label}</Text>
        <div className={classes.statValue}>{value}</div>
        {caption && <Text size="xs" c="dimmed" component="div">{caption}</Text>}
      </Stack>
    </Panel>
  );
}

/** A status: its label in its role's badge, flashing once when it changes. */
export function StatusBadge({ role, children, title, icon }: { role: Role; children: ReactNode; title?: string; icon?: ReactNode }) {
  return (
    <Flash value={String(children)}>
      <Badge color={role} title={title} leftSection={icon}>{children}</Badge>
    </Flash>
  );
}

/**
 * Its children, whose tint flashes once (opacity only, `base`) when `value` changes after the first
 * render; an unchanged value on a poll does nothing.
 */
export function Flash({ value, children }: { value: string | number; children: ReactNode }) {
  const previous = useRef(value);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanges((n) => n + 1);
  }, [value]);
  return <span key={changes} className={classes.flash} data-flash={changes > 0 ? "" : undefined}>{children}</span>;
}

/** A hit target of the skill's minimum size around an inline control. */
export function Target({ children }: { children: ReactNode }) {
  return <span className={classes.target}>{children}</span>;
}

/** Nothing to show, said plainly, centred in its container. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={classes.state}>
      <Stack gap="xs" align="center">
        <Text size="sm" fw={500}>{title}</Text>
        {children && <Text size="sm" c="dimmed">{children}</Text>}
      </Stack>
    </div>
  );
}

/** One spinner for its container, shown only after 300 ms. */
export function LoadingState({ label }: { label: string }) {
  const [shown, setShown] = useState(false);
  const { start, clear } = useTimeout(() => setShown(true), 300);
  useEffect(() => {
    start();
    return clear;
  }, [start, clear]);
  return (
    <div className={classes.state} role="status" aria-live="polite" aria-busy="true">
      {shown && (
        <Group gap="sm" justify="center">
          <Loader size="sm" color="gray" />
          <Text size="sm" c="dimmed">{label}</Text>
        </Group>
      )}
    </div>
  );
}

/** A read that failed, with a retry. */
export function ErrorState({ title, error, onRetry }: { title: string; error: string; onRetry?: () => void }) {
  return (
    <Alert color="danger" title={title} role="alert">
      <Stack gap="sm" align="flex-start">
        <Text size="sm">{error}</Text>
        {onRetry && <Button size="xs" variant="default" onClick={onRetry}>Try again</Button>}
      </Stack>
    </Alert>
  );
}

/** The icon that goes with a role's label, so status is never color alone. */
export function RoleIcon({ role }: { role: Role }) {
  if (role === "danger") return <IconCircleX size={14} stroke={2} aria-hidden />;
  if (role === "warning") return <IconAlertTriangle size={14} stroke={2} aria-hidden />;
  if (role === "success") return <IconCircleCheck size={14} stroke={2} aria-hidden />;
  return null;
}

/** A list of rows in a Panel, divided by hairlines; its rows (`<li>`) are the feature's. */
export function ItemList({ label, children }: { label: string; children: ReactNode }) {
  return <ul className={classes.list} aria-label={label}>{children}</ul>;
}

/** A paragraph of secondary text, kept to a readable measure. */
export function Prose({ children }: { children: ReactNode }) {
  return <Text size="sm" c="dimmed" className={classes.prose}>{children}</Text>;
}

/**
 * A command the reader may run themselves (the page runs nothing): mono, caption size, wrapping at any
 * character within a bounded measure so a table column stays readable, with a button that copies it.
 */
export function Command({ text }: { text: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text span size="xs" c="dimmed" ff="monospace" className={classes.command}>{text}</Text>
      <CopyButton value={text} timeout={1500}>
        {({ copied, copy }) => (
          <ActionIcon variant="subtle" color={copied ? "success" : "gray"} size="lg" className={classes.copy} onClick={copy} aria-label={copied ? "Copied" : `Copy command: ${text}`}>
            {copied ? <IconCheck size={14} stroke={2} aria-hidden /> : <IconCopy size={14} stroke={2} aria-hidden />}
          </ActionIcon>
        )}
      </CopyButton>
    </Group>
  );
}
