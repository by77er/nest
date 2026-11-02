// Agents with a brain on a live host, with AgentDO's detail as the Worker reads it. An agent without a
// brain is not listed: no route lists agents, and the fleet view knows only the brains it indexes.

import { Table, Text } from "@mantine/core";
import type { AgentsResponse } from "../../api";
import { age, iso } from "../format";
import type { LiveAgent } from "../fleet";
import { rowId } from "../fleet";
import { DataTable, EmptyState, ErrorState, Panel, Section, StatusBadge } from "../layout";
import { AGENT_STATE_ROLE, LIFECYCLE_ROLE, PHASE_ROLE } from "../status";
import { Id, Mono, None, Status } from "./common";

export function AgentsSection({ agents, info, infoError, onRetry, now }: {
  agents: LiveAgent[];
  info: AgentsResponse | undefined;
  /** The agents' detail could not be read: the rest of the page still is, and its rows say unknown. */
  infoError: string | null;
  onRetry: () => void;
  now: number;
}) {
  return (
    <Section id="agents" title="Agents" count={agents.length} meta="With a brain on a live host">
      {infoError && <ErrorState title="Couldn't read the agents' detail" error={infoError} onRetry={onRetry} />}
      {agents.length === 0 ? (
        <Panel><EmptyState title="No brain is running" /></Panel>
      ) : (
        <DataTable
          label="Agents"
          head={<>
            <Table.Th>Agent</Table.Th><Table.Th>Template</Table.Th><Table.Th>State</Table.Th><Table.Th>Lifecycle</Table.Th>
            <Table.Th>Activity</Table.Th><Table.Th>Turn</Table.Th><Table.Th>Brain on host</Table.Th><Table.Th>Phase</Table.Th>
            <Table.Th ta="right">Phase since</Table.Th><Table.Th>Sandbox</Table.Th>
          </>}
        >
          {agents.map(({ agent, host, row }) => {
            const i = row?.info;
            return (
              <Table.Tr key={agent} id={rowId("agent", agent)} tabIndex={-1}>
                <Table.Td><Id id={agent} /></Table.Td>
                {!row ? <Table.Td colSpan={5}><None>{infoError ? "unknown" : "loading"}</None></Table.Td>
                  : !i ? <Table.Td colSpan={5}><StatusBadge role="danger" title={row.error ?? ""}>{`could not read: ${row.error}`}</StatusBadge></Table.Td>
                  : <>
                    <Table.Td><Mono value={i.template} /></Table.Td>
                    <Table.Td><Status table={AGENT_STATE_ROLE} value={i.state} /></Table.Td>
                    <Table.Td><Status table={LIFECYCLE_ROLE} value={i.lifecycle} /></Table.Td>
                    <Table.Td><Status table={AGENT_STATE_ROLE} value={i.activity} /></Table.Td>
                    <Table.Td><Id id={i.current_turn} /></Table.Td>
                  </>}
                <Table.Td><Id id={i?.brain?.host ?? host} /></Table.Td>
                <Table.Td><Status table={PHASE_ROLE} value={i?.brain?.phase} /></Table.Td>
                <Table.Td ta="right" title={iso(i?.brain?.since_ms)}>{i?.brain ? `${age(i.brain.since_ms, now)} ago` : <None />}</Table.Td>
                <Table.Td><Id id={i?.sandbox} /></Table.Td>
              </Table.Tr>
            );
          })}
        </DataTable>
      )}
      {!!info?.omitted && (
        <Text size="xs" c="dimmed" mt="sm">{info.omitted} more agents not read (the Worker reads at most {info.agents.length}).</Text>
      )}
    </Section>
  );
}
