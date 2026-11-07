// The project's memory (README.md#memory): the notes the manager and routines keep, which the manager and
// workers read. Read-only here but for deleting a note. Each note's text is an agent's, shown as plain text
// (its first lines, "Show more" for the rest), with who wrote it; one a tainted session wrote is marked.
// The latest notes first, the rest behind "Show all", with a filter by key or text once there are many.

import { ActionIcon, Button, Text, TextInput, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconNotebook, IconSearch, IconTrash } from "@tabler/icons-react";
import { useId, useState } from "react";
import { MAX_NOTES } from "../../../memory";
import { useDeleteNote, useMemory } from "../../api/queries";
import type { Note } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, Token } from "../../layout";
import { preview } from "../triage/TriagePage";
import { sourceText, UntrustedBadge } from "./Untrusted";

/** Notes shown before "Show all". */
export const NOTES_SHOWN = 10;

function NoteRow({ projectId, n }: { projectId: string; n: Note }) {
  const del = useDeleteNote(projectId);
  const [more, setMore] = useState(false);
  const textId = useId();
  const short = preview(n.text);
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
        {/* Beside the key, not on the meta line: a badge's touch target there would reach over "Show more". */}
        {n.tainted && <UntrustedBadge what={`the note ${n.key}`} />}
      </Row>
      <Stack gap="xs" align="flex-start">
        <div id={textId}>
          <Prose size="sm">{short !== null && !more ? short : n.text}</Prose>
        </div>
        {short !== null && (
          <Button variant="subtle" color="gray" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-controls={textId}>
            {more ? "Show less" : "Show more"}
          </Button>
        )}
      </Stack>
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
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");
  const notes = [...(memory.data ?? [])].sort((a, b) => b.updated_ms - a.updated_ms);
  const q = filter.trim().toLowerCase();
  const matching = q ? notes.filter((n) => n.key.includes(q) || n.text.toLowerCase().includes(q)) : notes;
  const shown = all || q ? matching : matching.slice(0, NOTES_SHOWN);
  return (
    <Section title="Memory" count={memory.data?.length}>
      {memory.isPending ? (
        <LoadingState label="Loading the memory" />
      ) : memory.isError ? (
        <ErrorState title="The memory couldn't be loaded" error={memory.error} onRetry={() => void memory.refetch()} />
      ) : notes.length === 0 ? (
        <Panel>
          <EmptyState icon={IconNotebook} title="No notes yet" description="The manager and routines write what they learn about the project here: your preferences, its conventions, its traps. The manager and workers read it." />
        </Panel>
      ) : (
        <Stack gap="md">
          <Text fz="sm" c="dimmed">
            {notes.length} of {MAX_NOTES} notes, the latest first. Dreaming merges and prunes them.
          </Text>
          {notes.length > NOTES_SHOWN && (
            <TextInput aria-label="Filter notes" placeholder="Filter by key or text" leftSection={<IconSearch size={icon.md} />} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
          )}
          {shown.length === 0 ? (
            <Text fz="sm" c="dimmed">
              No note matches.
            </Text>
          ) : (
            <Panel>
              <Stack gap="xl" role="list" aria-label="Memory notes">
                {shown.map((n) => (
                  <NoteRow key={n.key} projectId={projectId} n={n} />
                ))}
              </Stack>
            </Panel>
          )}
          {!q && matching.length > NOTES_SHOWN && (
            <Row>
              <Button variant="default" onClick={() => setAll((x) => !x)} aria-expanded={all}>
                {all ? "Show the latest" : `Show all (${matching.length})`}
              </Button>
            </Row>
          )}
        </Stack>
      )}
    </Section>
  );
}
