// Agents nest refused to stop (README.md#outboxes): each may still be running, with its sandbox and
// credentials, so it's shown here with why, and the owner tries the stop again or dismisses it (the app
// then stops counting it). Until one of those, or nest's word that it ended, it holds its place.

import { Button, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconRefresh } from "@tabler/icons-react";
import { useDismissStop, useRetryStop } from "../../api/queries";
import type { NetworkView } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, MetaItem, MetaRow, Notice, Stack, Toolbar } from "../../layout";

type Stop = NetworkView["failed_stops"][number];

/** A routine run's outcome, as a person says it (a stop's reason is `routine run <outcome>`). */
const RUN_ENDED: Record<string, string> = { done: "finished", failed: "failed", timed_out: "timed out", stopped: "was stopped" };

/** Why it was being stopped, as a sentence: "A routine run timed out", "Its task was cancelled". */
export function stopWhy(s: Pick<Stop, "reason">): string {
  const run = /^routine run (\w+)$/.exec(s.reason);
  if (run) return `A routine run ${RUN_ENDED[run[1]!] ?? run[1]!.replace(/_/g, " ")}`;
  if (s.reason === "manager replaced") return "A manager that was replaced";
  if (s.reason === "start failed") return "Its worker didn't start";
  if (s.reason === "cancelled" || s.reason === "done" || s.reason === "merged") return `Its task was ${s.reason === "done" ? "marked done" : s.reason}`;
  return s.reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function FailedStops({ projectId, stops }: { projectId: string; stops: NetworkView["failed_stops"] }) {
  const retry = useRetryStop(projectId);
  const dismiss = useDismissStop(projectId);
  if (!stops.length) return null;
  const confirmDismiss = (agent: string) =>
    modals.openConfirmModal({
      title: `Dismiss the stop of ${agent}?`,
      children: <Text fz="md">The app stops counting it and owes it nothing more. If it's still running, end it in nest yourself.</Text>,
      labels: { confirm: "Dismiss", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => dismiss.mutate(agent),
    });
  return (
    <Notice tone="warning" title={stops.length === 1 ? "An agent the app couldn't stop" : `${stops.length} agents the app couldn't stop`}>
      <Stack gap="lg" data-slot="failed-stops">
        <Text fz="sm">nest refused to stop {stops.length === 1 ? "it" : "them"}, so {stops.length === 1 ? "it" : "each"} may still be running, and counts as live until it's stopped or dismissed.</Text>
        {stops.map((s) => (
          <Stack key={s.agent} gap="xs" data-agent={s.agent}>
            <MetaRow>
              <MetaItem mono>{s.agent}</MetaItem>
              {/* What it was for: its task, or its routine, by name (a long one wraps: a meta row's links keep to its width). */}
              {s.task ? (
                <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: s.task }} fz="xs" lh="lg" c="bright" underline="always">
                  {s.task_title ?? s.task}
                </AnchorLink>
              ) : s.routine ? (
                <AnchorLink to="/projects/$projectId/routines" params={{ projectId }} fz="xs" lh="lg" c="bright" underline="always">
                  {s.routine.name}
                </AnchorLink>
              ) : null}
              <MetaItem title={exact(s.failed_ms)}>{ago(s.failed_ms)}</MetaItem>
            </MetaRow>
            {/* A reading line's length, inside the notice (an error can be long). */}
            <Text fz="sm" maw="var(--nest-reading-measure)">
              {stopWhy(s)}
              {s.error ? `; ${s.error.startsWith("nest ") ? `nest answered ${s.error.slice(5)}` : s.error}` : "."}
            </Text>
            <Toolbar
              align="start"
              danger={
                <Button variant="subtle" color="danger" onClick={() => confirmDismiss(s.agent)} aria-label={`Dismiss the stop of ${s.agent}`}>
                  Dismiss
                </Button>
              }
            >
              <Button variant="default" leftSection={<IconRefresh size={icon.md} />} loading={retry.isPending && retry.variables === s.agent} onClick={() => retry.mutate(s.agent)} aria-label={`Retry the stop of ${s.agent}`}>
                Retry stop
              </Button>
            </Toolbar>
          </Stack>
        ))}
      </Stack>
    </Notice>
  );
}
