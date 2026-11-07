// A project's routines (README.md#routines): background runs on a timer or the board's counters. Top to
// bottom: the routines (each with its triggers, where it stands, its next and last run; Run now and Edit,
// the editor in a Sheet), the tasks they proposed waiting for the owner, their recent runs (each with its
// report, what it made and its agent's trace), and the project's memory (README.md#memory).

import { Badge, Button, Menu, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconBrain, IconChevronDown, IconPlayerPlay, IconPlus, IconRepeat } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { PRESETS } from "../../../routines";
import { useAddPreset, useDeleteRoutine, useRoutines, useRunRoutine } from "../../api/queries";
import type { Routine } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Row, Section, SectionGrid, Sheet, Stack } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { counterProgress, routineStatus, triggerPhrases, waitingText } from "./describe";
import { MemorySection } from "./MemorySection";
import { ProposalsSection } from "./ProposalsSection";
import { RoutineForm } from "./RoutineForm";
import { RunsSection, StatusBadge } from "./RunsSection";

const PRESET_ICON = { review: IconRepeat, dreaming: IconBrain } as const;

function AddRoutine({ projectId, routines, onCustom }: { projectId: string; routines: Routine[]; onCustom: () => void }) {
  const add = useAddPreset(projectId);
  const has = (p: "review" | "dreaming") => routines.some((r) => r.preset === p);
  return (
    <Menu position="bottom-end" shadow="overlay">
      <Menu.Target>
        <Button leftSection={<IconPlus size={icon.md} />} rightSection={<IconChevronDown size={icon.sm} />} loading={add.isPending}>
          Add routine
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {(["review", "dreaming"] as const).map((p) => {
          const Icon = PRESET_ICON[p];
          return (
            <Menu.Item key={p} leftSection={<Icon size={icon.md} />} disabled={has(p)} onClick={() => add.mutate(p)}>
              {PRESETS[p].name}
              {has(p) ? " (added)" : ""}
            </Menu.Item>
          );
        })}
        <Menu.Divider />
        <Menu.Item leftSection={<IconPlus size={icon.md} />} onClick={onCustom}>
          Custom routine…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function RoutineCard({ projectId, r, cap, onEdit }: { projectId: string; r: Routine; cap: number; onEdit: () => void }) {
  const run = useRunRoutine(projectId);
  const status = routineStatus(r);
  const waiting = waitingText(r, cap, (ms) => ago(ms));
  const last = r.last_run;
  return (
    <Panel data-routine={r.id}>
      <Stack gap="sm">
        <Row justify="space-between" wrap="nowrap" align="flex-start">
          <Row gap="sm">
            <Title order={4}>{r.name}</Title>
            {status && (
              <Badge size="sm" variant={status.color === "gray" ? "outline" : "light"} color={status.color} data-slot="status">
                {status.label}
              </Badge>
            )}
          </Row>
          <Row gap="xs" wrap="nowrap">
            <Button variant="subtle" color="gray" size="xs" onClick={onEdit} aria-label={`Edit ${r.name}`}>
              Edit
            </Button>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlayerPlay size={icon.sm} />}
              disabled={r.live_run !== null || r.due?.trigger === "manual"}
              loading={run.isPending}
              onClick={() => run.mutate(r.id)}
              aria-label={`Run ${r.name} now`}
            >
              Run now
            </Button>
          </Row>
        </Row>
        <Text fz="sm">{triggerPhrases(r.triggers).join(" · ")}</Text>
        <MetaRow>
          {r.next_timer_ms !== null && <MetaItem title={exact(r.next_timer_ms)}>Timer {ago(r.next_timer_ms)}</MetaItem>}
          {counterProgress(r).map((c) => (
            <MetaItem key={c}>{c}</MetaItem>
          ))}
          {last ? (
            <MetaItem title={exact(last.ended_ms ?? last.queued_ms)}>
              Last run {ago(last.ended_ms ?? last.queued_ms)}
            </MetaItem>
          ) : (
            <MetaItem>Not run yet</MetaItem>
          )}
          {last && <StatusBadge run={last} />}
        </MetaRow>
        {waiting && (
          <Text fz="sm" c="dimmed" data-slot="waiting">
            {waiting}
          </Text>
        )}
      </Stack>
    </Panel>
  );
}

export function RoutinesPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/routines" });
  const routines = useRoutines(projectId);
  const del = useDeleteRoutine(projectId);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const list = routines.data?.routines ?? [];
  const close = () => setEditing(null);
  const editingRoutine = editing && editing !== "new" ? list.find((r) => r.id === editing.id) ?? editing : undefined;

  const confirmDelete = (r: Routine) =>
    modals.openConfirmModal({
      title: `Delete ${r.name}?`,
      children: <Text fz="md">Its runs' history goes with it. Tasks it proposed and notes it wrote stay.</Text>,
      labels: { confirm: "Delete", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => del.mutate(r.id, { onSuccess: close }),
    });

  return (
    <ProjectFrame projectId={projectId}>
      {() => (
        <Stack gap="2xl">
          <Section
            title="Routines"
            count={routines.data?.routines.length}
            actions={routines.data && <AddRoutine projectId={projectId} routines={list} onCustom={() => setEditing("new")} />}
          >
            {routines.isPending ? (
              <LoadingState label="Loading the routines" />
            ) : routines.isError ? (
              <ErrorState title="The routines couldn't be loaded" error={routines.error} onRetry={() => void routines.refetch()} />
            ) : list.length === 0 ? (
              <Panel>
                <EmptyState
                  icon={IconRepeat}
                  title="No routines yet"
                  description="A routine starts an agent in the background, on a timer or after so many tasks done or PRs merged: a spontaneous review of what merged, or dreaming over the project's memory. It proposes tasks for you to accept."
                />
              </Panel>
            ) : (
              <SectionGrid>
                {list.map((r) => (
                  <RoutineCard key={r.id} projectId={projectId} r={r} cap={routines.data.max_routine_runs} onEdit={() => setEditing(r)} />
                ))}
              </SectionGrid>
            )}
          </Section>
          <ProposalsSection projectId={projectId} />
          <RunsSection projectId={projectId} routines={list} />
          <MemorySection projectId={projectId} />
          <Sheet opened={editing !== null} onClose={close} title={editingRoutine ? `Edit ${editingRoutine.name}` : "New routine"} closeOnEscape>
            {editing !== null && (
              <Stack gap="2xl">
                <RoutineForm key={editingRoutine?.id ?? "new"} projectId={projectId} editing={editingRoutine} onDone={close} />
                {editingRoutine && (
                  <Section title="Delete" order={4} region={false}>
                    <Stack gap="sm">
                      <Text fz="sm" c="dimmed">
                        {editingRoutine.live_run ? "Stop its run first: a routine with a run going isn't deleted." : "Its runs' history goes with it."}
                      </Text>
                      <Row>
                        <Button variant="default" color="danger" disabled={editingRoutine.live_run !== null} onClick={() => confirmDelete(editingRoutine)}>
                          Delete routine
                        </Button>
                      </Row>
                    </Stack>
                  </Section>
                )}
              </Stack>
            )}
          </Sheet>
        </Stack>
      )}
    </ProjectFrame>
  );
}
