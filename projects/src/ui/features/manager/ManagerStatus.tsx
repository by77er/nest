// The manager's status, in the page header: where it is (from the project's record and nest's agent
// record), what it's doing while it runs, and, after a failed attach, a retry; after it ended or errored,
// a Restart (README.md#the-manager-lifecycle).

import { Badge, Button } from "@mantine/core";
import { IconPlayerPlay, IconRefresh, IconServer } from "@tabler/icons-react";
import { useManager, useRestartManager, useRetryAttach } from "../../api/queries";
import type { ManagerPhase } from "../../api/types";
import { icon, MetaItem, Notice, Row, Stack } from "../../layout";
import type { Role } from "../../theme";

export const PHASE: Record<ManagerPhase, { label: string; color: Role }> = {
  attaching: { label: "Attaching the repo", color: "gray" },
  attach_failed: { label: "Attach failed", color: "danger" },
  starting: { label: "Starting", color: "gray" },
  waiting_for_host: { label: "Waiting for a host", color: "warning" },
  running: { label: "Running", color: "success" },
  errored: { label: "Errored", color: "danger" },
  ended: { label: "Ended", color: "warning" },
  unknown: { label: "Unknown", color: "gray" },
};

/** nest's activity states, as a person reads them. */
const ACTIVITY: Record<string, string> = {
  working: "working",
  idle: "idle",
  ready: "ready",
  waiting_input: "waiting for input",
  waiting_permission: "waiting for an approval",
  compacting: "compacting its context",
  quota_parked: "parked: over the quota",
  stalled: "stalled",
  needs_attention: "needs attention",
};

export function ManagerStatusLine({ projectId }: { projectId: string }) {
  const m = useManager(projectId);
  if (!m.data) return null;
  const phase = PHASE[m.data.phase];
  return (
    <Row gap="sm">
      <Badge color={phase.color} variant="light" data-phase={m.data.phase}>
        {phase.label}
      </Badge>
      {m.data.phase === "running" && m.data.state && <MetaItem>{ACTIVITY[m.data.state] ?? m.data.state.replace(/_/g, " ")}</MetaItem>}
      {m.data.host && (
        <MetaItem icon={IconServer} mono>
          {m.data.host}
        </MetaItem>
      )}
      {m.data.agent && <MetaItem mono>{m.data.agent}</MetaItem>}
    </Row>
  );
}

/** Why the manager isn't running, when there's a reason to show; with a retry when the attach failed, a Restart when it ended or errored. */
export function ManagerProblem({ projectId }: { projectId: string }) {
  const m = useManager(projectId);
  const retry = useRetryAttach(projectId);
  const restart = useRestartManager(projectId);
  const phase = m.data?.phase;
  const restartable = phase === "ended" || phase === "errored";
  if (!m.data || (!m.data.error && !restartable)) return null;
  const failedAttach = phase === "attach_failed";
  return (
    <Notice tone={failedAttach || phase === "errored" ? "danger" : "warning"} title={failedAttach ? "The repo couldn't be attached" : "The manager isn't running"}>
      <Stack gap="sm" align="flex-start">
        {m.data.error ?? "nest reports it errored."}
        {failedAttach && (
          <Button variant="default" leftSection={<IconRefresh size={icon.md} />} loading={retry.isPending} onClick={() => retry.mutate()}>
            Retry attach
          </Button>
        )}
        {restartable && (
          <Button variant="default" leftSection={<IconPlayerPlay size={icon.md} />} loading={restart.isPending} onClick={() => restart.mutate()}>
            Restart manager
          </Button>
        )}
      </Stack>
    </Notice>
  );
}
