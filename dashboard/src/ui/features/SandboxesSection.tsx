// Sandboxes on a host, and a count of those off any host (parked in S3, waiting for one, or neither).

import { Table, Text } from "@mantine/core";
import { age, iso } from "../format";
import { type Live, rowId } from "../fleet";
import { DataTable, EmptyState, Panel, Section, StatusBadge } from "../layout";
import { SANDBOX_STATE_ROLE } from "../status";
import { Id, Mono } from "./common";

export function SandboxesSection({ live, now }: { live: Live; now: number }) {
  const { sandboxes, parked, waiting, other } = live;
  return (
    <Section id="sandboxes" title="Sandboxes" count={sandboxes.length} meta="On a host">
      {sandboxes.length === 0 ? (
        <Panel><EmptyState title="None on a host" /></Panel>
      ) : (
        <DataTable
          label="Sandboxes"
          head={<><Table.Th>Sandbox</Table.Th><Table.Th>Template</Table.Th><Table.Th>On host</Table.Th><Table.Th>State</Table.Th><Table.Th ta="right">Age</Table.Th></>}
        >
          {sandboxes.map((s) => (
            <Table.Tr key={s.sandbox} id={rowId("sandbox", s.sandbox)} tabIndex={-1}>
              <Table.Td><Id id={s.sandbox} /></Table.Td>
              <Table.Td><Mono value={s.image} /></Table.Td>
              <Table.Td><Id id={s.host} /></Table.Td>
              {/* A lease's state is null before the host's first report. */}
              <Table.Td>{s.lease_state ? <StatusBadge role={SANDBOX_STATE_ROLE[s.lease_state]}>{s.lease_state}</StatusBadge> : <StatusBadge role="gray">starting</StatusBadge>}</Table.Td>
              <Table.Td ta="right" title={iso(s.registered_ms)}>{age(s.registered_ms, now)}</Table.Td>
            </Table.Tr>
          ))}
        </DataTable>
      )}
      {(parked > 0 || waiting > 0 || other > 0) && (
        <Text size="xs" c="dimmed" mt="sm">
          {parked > 0 && <>{parked} suspended or archived in S3, not on a host. </>}
          {waiting > 0 && <>{waiting} waiting for a host. </>}
          {other > 0 && <>{other} off any host in another state (failed, fenced or unreadable).</>}
        </Text>
      )}
    </Section>
  );
}
