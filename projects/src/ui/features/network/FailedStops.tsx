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
              {s.task ? (
                <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: s.task }} fz="xs" lh="lg" c="bright" underline="always">
                  its task
                </AnchorLink>
              ) : (
                <MetaItem>{s.reason}</MetaItem>
              )}
              <MetaItem title={exact(s.failed_ms)}>{ago(s.failed_ms)}</MetaItem>
            </MetaRow>
            {s.error && <Text fz="sm">{s.error}</Text>}
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
