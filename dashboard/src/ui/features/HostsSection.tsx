// Live hosts (active and connected), each with its reachability, capacity and residents.

import { Divider, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { Host } from "../../api";
import { age, gib, iso } from "../format";
import { rowId } from "../fleet";
import { EmptyState, Panel, Section, StatusBadge } from "../layout";
import { SANDBOX_STATE_ROLE } from "../status";
import { Id } from "./common";

export function HostsSection({ hosts, now }: { hosts: Host[]; now: number }) {
  return (
    <Section id="hosts" title="Hosts" count={hosts.length} meta="Live: active and connected">
      {hosts.length === 0 ? (
        <Panel><EmptyState title="None: the cell is at zero">A sandbox request starts one.</EmptyState></Panel>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {hosts.map((h) => <HostCard key={h.host} h={h} now={now} />)}
        </SimpleGrid>
      )}
    </Section>
  );
}

function HostCard({ h, now }: { h: Host; now: number }) {
  const cap = h.capacity;
  return (
    <Panel id={rowId("host", h.host)} tabIndex={-1} fill aria-label={`Host ${h.host}`}>
      <Stack gap="md">
        <Stack gap="xs">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Title order={4}><Id id={h.host} /></Title>
            <Group gap="xs">
              <StatusBadge role="gray">{h.role}</StatusBadge>
              {h.tunnel_state === "connected" ? <StatusBadge role="success">reachable</StatusBadge>
                : h.tunnel_hostname ? <StatusBadge role="warning">{`tunnel ${h.tunnel_state}`}</StatusBadge>
                : <StatusBadge role="gray">no tunnel</StatusBadge>}
              {h.wedged_ms !== null && <StatusBadge role="danger" title={iso(h.wedged_ms)}>wedged</StatusBadge>}
            </Group>
          </Group>
          <Text size="xs" c="dimmed">
            up <span title={iso(h.enrolled_ms)}>{age(h.enrolled_ms, now)}</span>
            {cap && <> · {gib(cap.memory_mib_free)} free · {cap.vcpus_free} vCPU free</>}
          </Text>
        </Stack>
        <Divider />
        <SimpleGrid cols={2} spacing="md">
          <Residents title="Sandboxes">
            {h.sandboxes.map((s) => (
              <Group key={s.sandbox} gap="xs" wrap="wrap">
                <Text size="sm"><Id id={s.sandbox} /></Text>
                {s.state ? <StatusBadge role={SANDBOX_STATE_ROLE[s.state]}>{s.state}</StatusBadge> : <StatusBadge role="gray">starting</StatusBadge>}
              </Group>
            ))}
          </Residents>
          <Residents title="Brains">
            {h.agents.map((a) => <Text key={a} size="sm"><Id id={a} /></Text>)}
          </Residents>
        </SimpleGrid>
      </Stack>
  </Panel>
  );
}

function Residents({ title, children }: { title: string; children: React.ReactNode[] }) {
  return (
    <Stack gap="xs" miw={0}>
      <Text size="xs" fw={500} c="dimmed">{title}</Text>
      {children.length === 0 ? <Text size="sm" c="dimmed">none</Text> : children}
    </Stack>
  );
}
