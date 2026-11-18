// What a page of things the owner manages shares (the Routines page's routines, the Reviews page's
// reviewers): a thing's Panel head (its name and badges, its actions at the top right, Edit among them), its
// editor in a Sheet with Delete last and set apart, and the confirmation a delete asks, Keep it the default.

import { Button, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { ReactNode } from "react";
import { Row, Section, Sheet, Stack } from "../layout";

/** A managed thing's head in its Panel: its name (an h4) and badges, and its actions at the top right. */
export function ThingHead({ name, badges, actions }: { name: string; badges?: ReactNode; actions: ReactNode }) {
  return (
    <Row justify="space-between" wrap="nowrap" align="flex-start">
      <Row gap="sm">
        <Title order={4}>{name}</Title>
        {badges}
      </Row>
      <Row gap="xs" wrap="nowrap">
        {actions}
      </Row>
    </Row>
  );
}

/** Edit, the quiet action that opens a thing's editor. */
export function EditButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button variant="subtle" color="gray" size="xs" onClick={onClick} aria-label={`Edit ${name}`}>
      Edit
    </Button>
  );
}

/** Asks before deleting: `title` the question, `body` what goes with it; cancelling ("Keep it") is focused. */
export function confirmDelete({ title, body, onConfirm }: { title: string; body: ReactNode; onConfirm: () => void }) {
  modals.openConfirmModal({
    title,
    children: <Text fz="md">{body}</Text>,
    labels: { confirm: "Delete", cancel: "Keep it" },
    confirmProps: { color: "danger" },
    cancelProps: { variant: "default", "data-autofocus": true },
    onConfirm,
  });
}

/**
 * A thing's editor in a Sheet: its form, then, for one that exists, Delete last and set apart (`del`: what
 * deleting means, the button's label, whether it's possible now, and what it does, confirmDelete first).
 */
export function EditorSheet({ opened, onClose, title, children, del }: {
  opened: boolean; onClose: () => void; title: string; children: ReactNode;
  del?: { note: ReactNode; label: string; disabled?: boolean; onClick: () => void };
}) {
  return (
    <Sheet opened={opened} onClose={onClose} title={title} closeOnEscape>
      {opened && (
        <Stack gap="2xl">
          {children}
          {del && (
            <Section title="Delete" order={4} region={false}>
              <Stack gap="sm">
                <Text fz="sm" c="dimmed">
                  {del.note}
                </Text>
                <Row>
                  <Button variant="light" color="danger" disabled={del.disabled} onClick={del.onClick}>
                    {del.label}
                  </Button>
                </Row>
              </Stack>
            </Section>
          )}
        </Stack>
      )}
    </Sheet>
  );
}
