// The summary row: what is live (agents, sandboxes, hosts) and how many things need attention.

import { Group, SimpleGrid, Text } from "@mantine/core";
import type { AgentsResponse } from "../../api";
import type { AttentionItem, Live } from "../fleet";
import { Flash, RoleIcon, StatTile, StatusBadge } from "../layout";

export function Summary({ live, agents, items, checking }: {
  live: Live;
  agents: AgentsResponse | undefined;
  items: AttentionItem[];
  /** Whether a read the attention list depends on is still in flight. */
  checking: boolean;
}) {
  const errors = items.filter((i) => i.role === "danger").length;
  const warnings = items.length - errors;
  const sandboxHosts = live.hosts.filter((h) => h.role === "sandbox").length;
  const offHost = [live.parked > 0 && `${live.parked} in S3`, live.waiting > 0 && `${live.waiting} waiting for a host`].filter(Boolean).join(" · ");

  return (
    <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md" aria-label="Summary">
      <StatTile
        label="Live agents"
        value={<Flash value={live.agents.length}>{live.agents.length}</Flash>}
        caption={agents?.omitted ? `with a brain · ${agents.omitted} not read` : "with a brain on a live host"}
      />
      <StatTile
        label="Sandboxes"
        value={<Flash value={live.sandboxes.length}>{live.sandboxes.length}</Flash>}
        caption={offHost ? `on a host · ${offHost}` : "on a host"}
      />
      <StatTile
        label="Hosts"
        value={<Flash value={live.hosts.length}>{live.hosts.length}</Flash>}
        caption={live.hosts.length ? `${sandboxHosts} sandbox · ${live.hosts.length - sandboxHosts} brain` : "the cell is at zero"}
      />
      <StatTile
        label="Needs attention"
        value={<Flash value={items.length}>{items.length}</Flash>}
        caption={
          <Group gap="xs" aria-live="polite">
            {errors > 0 && <StatusBadge role="danger" icon={<RoleIcon role="danger" />}>{`${errors} ${errors === 1 ? "error" : "errors"}`}</StatusBadge>}
            {warnings > 0 && <StatusBadge role="warning" icon={<RoleIcon role="warning" />}>{`${warnings} ${warnings === 1 ? "warning" : "warnings"}`}</StatusBadge>}
            {items.length === 0 && (checking ? <Text inherit>checking…</Text> : <StatusBadge role="success" icon={<RoleIcon role="success" />}>all clear</StatusBadge>)}
          </Group>
        }
      />
    </SimpleGrid>
  );
}
