// The project's memory (README.md#memory): the notes the manager and routines keep, which the manager and
// workers read. Read-only here but for deleting a note. Each note's text is an agent's, shown as plain text,
// with who wrote it; one a tainted session wrote is marked as from an untrusted source.

import { ActionIcon, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconNotebook, IconTrash } from "@tabler/icons-react";
import { MAX_NOTES } from "../../../memory";
import { useDeleteNote, useMemory } from "../../api/queries";
import type { Note } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, Token } from "../../layout";
import { sourceText, UntrustedBadge } from "./Untrusted";

function NoteRow({ projectId, n }: { projectId: string; n: Note }) {
  const del = useDeleteNote(projectId);
  const confirm = () =>
    modals.openConfirmModal({
      title: `Delete the note ${n.key}?`,
      children: <Text fz="md">The manager, workers and routines won't see it again.</Text>,
      labels: { confirm: "Delete", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => del.mutate(n.key),
    });
  return (
    <Stack gap="xs" role="listitem" data-note={n.key}>
      <Row gap="sm">
        <Token size="sm" dimmed={false}>
          {n.key}
        </Token>
        {n.tainted && <UntrustedBadge what={`The note ${n.key}`} />}
      </Row>
      <Prose size="sm">{n.text}</Prose>
      <Row justify="space-between" wrap="nowrap">
        <MetaRow>
          <MetaItem>By {sourceText(n.source)}</MetaItem>
          <MetaItem title={exact(n.updated_ms)}>{ago(n.updated_ms)}</MetaItem>
        </MetaRow>
        <Tooltip label="Delete">
          <ActionIcon variant="subtle" color="danger" aria-label={`Delete the note ${n.key}`} onClick={confirm} loading={del.isPending}>
            <IconTrash size={icon.md} />
          </ActionIcon>
        </Tooltip>
      </Row>
    </Stack>
  );
}

export function MemorySection({ projectId }: { projectId: string }) {
  const memory = useMemory(projectId);
  return (
    <Section title="Memory" count={memory.data?.length}>
      {memory.isPending ? (
        <LoadingState label="Loading the memory" />
      ) : memory.isError ? (
        <ErrorState title="The memory couldn't be loaded" error={memory.error} onRetry={() => void memory.refetch()} />
      ) : memory.data.length === 0 ? (
        <Panel>
          <EmptyState icon={IconNotebook} title="No notes yet" description="The manager and routines write what they learn about the project here: your preferences, its conventions, its traps. The manager and workers read it." />
        </Panel>
      ) : (
        <Stack gap="sm">
          <Panel>
            <Stack gap="xl" role="list" aria-label="Memory notes">
              {memory.data.map((n) => (
                <NoteRow key={n.key} projectId={projectId} n={n} />
              ))}
            </Stack>
          </Panel>
          <Text fz="xs" c="dimmed">
            {memory.data.length} of {MAX_NOTES} notes. Dreaming merges and prunes them.
          </Text>
        </Stack>
      )}
    </Section>
  );
}
