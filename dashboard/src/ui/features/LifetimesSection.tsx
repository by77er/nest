// "Left lying around": the control plane's lifetimes view (docs/control-plane/dashboard/#abandoned),
// oldest first, with when the idle TTL takes a dormant sandbox and the API call an operator would
// make, as text. It acts on nothing.

import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useMemo } from "react";
import type { LifetimesResponse } from "../../api";
import { iso, span } from "../format";
import { rowId } from "../fleet";
import { DataTable, EmptyState, ErrorState, LoadingState, Panel, Prose, Section } from "../layout";
import { agentCall, byAge, destroyIn, idleSince, operatorCall, SANDBOX_WHY, total } from "../lifetimes";
import { AGENT_LIFETIME_ROLE, SANDBOX_LIFETIME_ROLE } from "../status";
import { Id, Mono, None, Status } from "./common";

export function LifetimesSection({ view, error, onRetry, now }: {
  view: LifetimesResponse | undefined;
  error: string | null;
  onRetry: () => void;
  now: number;
}) {
  return (
    <Section id="lifetimes" title="Left lying around" meta="Read every minute">
      {error && <ErrorState title="Couldn't read what is left lying around" error={error} onRetry={onRetry} />}
      {view ? <Lifetimes view={view} now={now} /> : !error && <Panel><LoadingState label="Reading the lifetimes view" /></Panel>}
    </Section>
  );
}

/** The view read: its rules, then its sandboxes and agents, then what it could not cover. */
export function Lifetimes({ view, now }: { view: LifetimesResponse; now: number }) {
  const agents = useMemo(() => new Map(view.agents.map((a) => [a.agent, a])), [view]);
  const sandboxes = useMemo(() => byAge(view.sandboxes, (s) => idleSince(s, agents)), [view, agents]);
  const agentRows = useMemo(() => byAge(view.agents, (a) => a.last_turn_ms), [view]);
  const c = view.counts;

  return (
    <Stack gap="xl">
      <Prose>
        Agents with no turn for {span(view.quiet_ms)} count as quiet; the cell's idle TTL is {span(view.cell_idle_ttl_ms)}.
        {" "}Read {total(c.sandboxes)} sandboxes ({c.sandboxes.in_use ?? 0} in use, not listed) and {total(c.agents)} agents
        {" "}({c.agents.active ?? 0} active and {c.agents.recent ?? 0} recently used, {c.agents.ended ?? 0} ended awaiting their 30-day prune: not listed).
        {" "}Footprint in S3 is shown as generation counts: the control plane has no sizes.
      </Prose>

      <Stack gap="sm">
        <Title order={4}>Sandboxes</Title>
        {sandboxes.length === 0 ? <Panel><EmptyState title="Nothing: every sandbox is in use" /></Panel> : (
          <DataTable
            label="Sandboxes left lying around"
            head={<>
              <Table.Th>Sandbox</Table.Th><Table.Th>Kind</Table.Th><Table.Th>State</Table.Th><Table.Th ta="right">Unused for</Table.Th>
              <Table.Th ta="right">Idle TTL</Table.Th><Table.Th>Destroyed</Table.Th><Table.Th ta="right">Generations</Table.Th>
              <Table.Th>Attached</Table.Th><Table.Th>Made for</Table.Th><Table.Th>Operator</Table.Th>
            </>}
          >
            {sandboxes.map((s) => (
              <Table.Tr key={s.sandbox} id={rowId("lifetime", s.sandbox)} tabIndex={-1}>
                <Table.Td><Id id={s.sandbox} /></Table.Td>
                <Table.Td><Status table={SANDBOX_LIFETIME_ROLE} value={s.kind} title={s.error ?? SANDBOX_WHY[s.kind]} /></Table.Td>
                <Table.Td><Mono value={s.state} /></Table.Td>
                <Table.Td ta="right" title={iso(idleSince(s, agents))}>{span(now - idleSince(s, agents))}</Table.Td>
                <Table.Td ta="right">
                  {s.idle_ttl_ms === null ? <None /> : <Group gap="xs" justify="flex-end" wrap="nowrap">{s.own_ttl && <Badge color="gray">own</Badge>}{span(s.idle_ttl_ms)}</Group>}
                </Table.Td>
                <Table.Td title={iso(s.destroy_at_ms)}>{destroyIn(s, now)}</Table.Td>
                <Table.Td ta="right">{s.generations === null ? <None /> : `${s.generations}${s.memory_generations ? ` (${s.memory_generations} with memory)` : ""}`}</Table.Td>
                <Table.Td>{s.attached.length ? <Group gap="xs" wrap="nowrap">{s.attached.map((a) => <Id key={a} id={a} />)}</Group> : <None />}</Table.Td>
                <Table.Td>{s.owner ? <Id id={s.owner} /> : <None>operator</None>}</Table.Td>
                <Table.Td><Text span size="xs" c="dimmed" ff="monospace">{operatorCall(s)}</Text></Table.Td>
              </Table.Tr>
            ))}
          </DataTable>
        )}
      </Stack>

      <Stack gap="sm">
        <Title order={4}>Agents</Title>
        {agentRows.length === 0 ? <Panel><EmptyState title="None quiet, stuck ending or gone" /></Panel> : (
          <DataTable
            label="Agents left lying around"
            head={<>
              <Table.Th>Agent</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Template</Table.Th><Table.Th ta="right">Last turn</Table.Th>
              <Table.Th>Sandbox</Table.Th><Table.Th ta="right">Live children</Table.Th><Table.Th>Found via</Table.Th><Table.Th>Operator</Table.Th>
            </>}
          >
            {agentRows.map((a) => (
              <Table.Tr key={a.agent} id={rowId("lifetime", a.agent)} tabIndex={-1}>
                <Table.Td><Id id={a.agent} /></Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Status table={AGENT_LIFETIME_ROLE} value={a.kind} title={a.error ?? (a.ended_reason ? `ended (${a.ended_reason})` : undefined)} />
                    {a.stopped_by_operator && <Badge color="gray">stopped</Badge>}
                  </Group>
                </Table.Td>
                <Table.Td><Mono value={a.template} /></Table.Td>
                <Table.Td ta="right" title={iso(a.last_turn_ms)}>{a.last_turn_ms === null ? <None>never</None> : `${span(now - a.last_turn_ms)} ago`}</Table.Td>
                <Table.Td><Id id={a.sandbox} /></Table.Td>
                <Table.Td ta="right">{a.live_children.length}</Table.Td>
                <Table.Td><Text span size="sm" c="dimmed">{a.found_via}</Text></Table.Td>
                <Table.Td><Text span size="xs" c="dimmed" ff="monospace">{agentCall(a)}</Text></Table.Td>
              </Table.Tr>
            ))}
          </DataTable>
        )}
      </Stack>

      <Stack gap="xs">
        {view.truncated && <Text size="xs" c="dimmed">More sandboxes than the {view.pages} pages read.</Text>}
        {view.agents_omitted > 0 && <Text size="xs" c="dimmed">{view.agents_omitted} agents found but not read (over the per-page cap).</Text>}
        <Text size="xs" c="dimmed">
          Agents are found from the cell's agent registry; one whose records are gone is found attached to a listed sandbox.
        </Text>
      </Stack>
    </Stack>
  );
}
