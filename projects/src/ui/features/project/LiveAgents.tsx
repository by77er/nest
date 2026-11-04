// Each live agent's sandbox client layer, applied, pending or failed (README.md#network). One layer
// carries both a role's network rules and its secrets, so the Network and Secrets pages show the same list.

import { Badge, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { LayerStatus } from "../../api/types";
import { ago, exact } from "../../common/time";
import { Panel, Row, Stack } from "../../layout";

const STATE: Record<LayerStatus["state"], { label: string; color: "success" | "warning" | "danger" }> = {
  applied: { label: "Applied", color: "success" },
  pending: { label: "Pending", color: "warning" },
  failed: { label: "Failed", color: "danger" },
};

export interface LiveAgentsProps {
  agents: LayerStatus[];
  /** The list's accessible name. */
  label: string;
  /** Shown when no agent is live. */
  empty: string;
  /** A line about one agent's layer, under its role (what the page's part of it holds). */
  detail?: (a: LayerStatus) => ReactNode;
  /** What follows a failed layer's error (a way to the rule it names). */
  onError?: (a: LayerStatus) => ReactNode;
  /** Its own dense Panel (default); off where it already sits in one. */
  framed?: boolean;
}

export function LiveAgents({ agents, label, empty, detail, onError, framed = true }: LiveAgentsProps) {
  if (agents.length === 0) {
    return (
      <Text fz="sm" c="dimmed">
        {empty}
      </Text>
    );
  }
  const list = (
      <Stack gap="md" role="list" aria-label={label}>
        {agents.map((a) => {
          const more = detail?.(a);
          return (
            <Row key={a.agent} role="listitem" justify="space-between" align="flex-start" wrap="nowrap" data-agent={a.agent}>
              <Stack gap="2xs">
                <Text fz="sm" ff="monospace">
                  {a.agent}
                </Text>
                <Text fz="xs" c="dimmed" title={a.at_ms ? exact(a.at_ms) : undefined}>
                  {a.role === "worker" ? "Worker" : a.role === "manager" ? "Manager" : "Reviewer"}
                  {a.at_ms ? ` · updated ${ago(a.at_ms)}` : ""}
                </Text>
                {more && (
                  <Text fz="xs" c="dimmed">
                    {more}
                  </Text>
                )}
                {a.error && (
                  <Text fz="xs" c={a.state === "failed" ? "danger" : "dimmed"}>
                    {a.error}
                  </Text>
                )}
                {a.error && onError?.(a)}
              </Stack>
              <Badge variant="light" color={STATE[a.state].color} data-slot="state">
                {STATE[a.state].label}
              </Badge>
            </Row>
          );
        })}
      </Stack>
  );
  return framed ? <Panel dense>{list}</Panel> : list;
}
