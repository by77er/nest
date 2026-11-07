// The routines' recent runs, newest first (README.md#routines): which routine, why it started, how it went
// or is going, when and how long, what it made; opened, its report (the agent's last turn, shown as plain
// text: an agent wrote it after reading anyone's text) and its agent's trace. A live run can be stopped.
// A table, or below `sm` a card per run; the latest 10, the rest behind "Show older".

import { Badge, Button, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconChevronDown, IconChevronRight, IconHistory } from "@tabler/icons-react";
import { Fragment, useState } from "react";
import { useRoutineRuns, useStopRun } from "../../api/queries";
import type { Routine, RoutineRun } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, TableFrame, Toolbar, usePhone } from "../../layout";
import { RunTrace } from "../trace/AgentTraces";
import { createdText, duration, runStatus, runTrigger } from "./describe";

/** Runs shown before "Show older". */
export const RUNS_SHOWN = 10;

export function StatusBadge({ run }: { run: RoutineRun }) {
  const s = runStatus(run);
  return (
    <Badge size="sm" variant={s.color === "gray" ? "outline" : "light"} color={s.color} data-outcome={run.outcome ?? run.state}>
      {s.label}
    </Badge>
  );
}

function Toggle({ label, open, onToggle, long = false }: { label: string; open: boolean; onToggle: () => void; long?: boolean }) {
  return (
    <Button
      // In a phone's card, the row's whole width: a full target, nothing beside it.
      fullWidth={long}
      justify={long ? "flex-start" : undefined}
      variant="subtle"
      color="gray"
      size="xs"
      leftSection={open ? <IconChevronDown size={icon.sm} /> : <IconChevronRight size={icon.sm} />}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} ${label}`}
      onClick={onToggle}
    >
      {open ? "Hide" : "Show"}
      {long ? " details" : ""}
    </Button>
  );
}

/** An opened run: why it ended, its report, what it made, its trace; Stop while it's live. */
function RunDetail({ projectId, run, name }: { projectId: string; run: RoutineRun; name: string }) {
  const stop = useStopRun(projectId);
  const confirmStop = () =>
    modals.openConfirmModal({
      title: `Stop run ${run.n} of ${name}?`,
      children: <Text fz="md">Its agent is stopped and its sandbox destroyed. What it already proposed or wrote stays.</Text>,
      labels: { confirm: "Stop", cancel: "Let it run" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => stop.mutate(run.id),
    });
  const live = run.state !== "ended";
  return (
    <Stack gap="lg" data-run-detail={run.id}>
      {(run.error || run.note) && (
        <Text fz="sm" c={run.error ? "danger" : "dimmed"}>
          {run.error ?? `Ended: ${run.note}.`}
        </Text>
      )}
      {run.summary && (
        <Stack gap="xs">
          <Text fz="xs" c="dimmed">
            Its report
          </Text>
          <Prose size="sm">{run.summary}</Prose>
        </Stack>
      )}
      {run.created.length > 0 && (
        <Stack gap="xs">
          <Text fz="xs" c="dimmed">
            What it made
          </Text>
          <MetaRow>
            {run.created.map((c, i) => (
              <MetaItem key={i} mono={c.kind === "memory_write" || c.kind === "memory_delete"}>
                {c.kind === "proposal" ? `Proposed: ${c.title}` : c.kind === "task" ? `Draft task: ${c.title}` : c.kind === "memory_write" ? `Wrote ${c.key}` : `Deleted ${c.key}`}
              </MetaItem>
            ))}
          </MetaRow>
        </Stack>
      )}
      {live && (
        <Toolbar align="start" danger={<Button variant="default" color="danger" size="xs" onClick={confirmStop} loading={stop.isPending}>Stop run</Button>} />
      )}
      <RunTrace run={run} name={name} />
    </Stack>
  );
}

export function RunsSection({ projectId, routines }: { projectId: string; routines: Routine[] }) {
  const runs = useRoutineRuns(projectId);
  const phone = usePhone();
  const [open, setOpen] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const shown = older ? runs.data ?? [] : (runs.data ?? []).slice(0, RUNS_SHOWN);
  const more = (runs.data?.length ?? 0) - RUNS_SHOWN;
  const name = (id: string) => routines.find((r) => r.id === id)?.name ?? "A deleted routine";
  return (
    <Section title="Runs" count={runs.data?.length}>
      {runs.isPending ? (
        <LoadingState label="Loading the runs" />
      ) : runs.isError ? (
        <ErrorState title="The runs couldn't be loaded" error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <Panel>
          <EmptyState icon={IconHistory} title="No runs yet" description="Each run of a routine shows here: why it started, how it went, what it made, and its agent's trace." />
        </Panel>
      ) : phone ? (
        <Stack gap="sm" role="list" aria-label="Routine runs">
          {shown.map((run) => {
            const shown = open === run.id;
            return (
              <Panel dense key={run.id}>
                <Stack gap="sm" role="listitem" data-run={run.id}>
                  <Row gap="sm">
                    <Text fz="sm">{name(run.routine)}</Text>
                    <StatusBadge run={run} />
                  </Row>
                  <MetaRow>
                    <MetaItem>{runTrigger(run)}</MetaItem>
                    <MetaItem title={exact(run.queued_ms)}>{ago(run.started_ms ?? run.queued_ms)}</MetaItem>
                    <MetaItem>{createdText(run.created)}</MetaItem>
                  </MetaRow>
                  <Row>
                    <Toggle label={`run ${run.n} of ${name(run.routine)}`} open={shown} onToggle={() => setOpen(shown ? null : run.id)} long />
                  </Row>
                  {shown && <RunDetail projectId={projectId} run={run} name={name(run.routine)} />}
                </Stack>
              </Panel>
            );
          })}
        </Stack>
      ) : (
        <TableFrame label="Routine runs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Routine</Table.Th>
              <Table.Th>Why</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th>Made</Table.Th>
              <Table.Th ta="right">Started</Table.Th>
              <Table.Th ta="right">Took</Table.Th>
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((run) => {
              const shown = open === run.id;
              return (
                <Fragment key={run.id}>
                  <Table.Tr data-run={run.id}>
                    <Table.Td>
                      <Text fz="sm">{name(run.routine)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="sm">{runTrigger(run)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge run={run} />
                    </Table.Td>
                    <Table.Td>
                      <Text fz="sm" c={run.created.length ? undefined : "dimmed"}>
                        {createdText(run.created)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fz="sm" c="dimmed" title={exact(run.started_ms ?? run.queued_ms)}>
                        {ago(run.started_ms ?? run.queued_ms)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fz="sm" c="dimmed">
                        {duration(run)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Toggle label={`run ${run.n} of ${name(run.routine)}`} open={shown} onToggle={() => setOpen(shown ? null : run.id)} />
                    </Table.Td>
                  </Table.Tr>
                  {shown && (
                    <Table.Tr data-trace={run.id}>
                      <Table.Td colSpan={7}>
                        <RunDetail projectId={projectId} run={run} name={name(run.routine)} />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              );
            })}
          </Table.Tbody>
        </TableFrame>
      )}
      {more > 0 && (
        <Row>
          <Button variant="default" onClick={() => setOlder((x) => !x)} aria-expanded={older}>
            {older ? "Show the latest" : `Show older (${more})`}
          </Button>
        </Row>
      )}
    </Section>
  );
}
