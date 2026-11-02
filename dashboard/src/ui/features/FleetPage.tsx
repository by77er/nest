// The page: one cell's fleet. What is wrong first (the summary row, then what needs attention), then
// the detail: agents, sandboxes, hosts with their residents, templates, and what is left lying around.

import { Alert, Select, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { age } from "../format";
import { attention, live } from "../fleet";
import { AppFrame, ErrorState, LoadingState, Page, PageHeader, Panel } from "../layout";
import { describe, REFRESH_MS, useAgents, useCells, useFleet, useImages, useLifetimes } from "../queries";
import { useNow } from "../useNow";
import { AgentsSection } from "./AgentsSection";
import { Attention } from "./Attention";
import { HostsSection } from "./HostsSection";
import { LifetimesSection } from "./LifetimesSection";
import { SandboxesSection } from "./SandboxesSection";
import { Summary } from "./Summary";
import { TemplatesSection } from "./TemplatesSection";

/** A 404 from a control plane from before the lifetimes route (the two deploy separately). */
const lifetimesError = (e: unknown) =>
  e && typeof e === "object" && "status" in e && e.status === 404 ? "this control plane does not serve GET /v1/admin/lifetimes yet" : describe(e);

export function FleetPage() {
  const cells = useCells();
  const [cell, setCell] = useState("");
  useEffect(() => {
    if (!cells.data || cell) return;
    const fromHash = location.hash.replace(/^#/, "");
    setCell(cells.data.cells.includes(fromHash) ? fromHash : (cells.data.cells[0] ?? ""));
  }, [cells.data, cell]);

  const fleet = useFleet(cell);
  const images = useImages(cell);
  const agents = useAgents(cell);
  const lifetimes = useLifetimes(cell);
  const now = useNow();

  const agentsError = agents.isError && !agents.data ? describe(agents.error) : null;
  const lifeError = lifetimes.isError ? lifetimesError(lifetimes.error) : null;
  const l = useMemo(() => live(fleet.data, agents.data), [fleet.data, agents.data]);
  const items = useMemo(
    () => attention({ fleet: fleet.data, agents: agents.data, agentsError, lifetimes: lifetimes.data, lifetimesError: lifetimes.data ? null : lifeError, now }),
    [fleet.data, agents.data, agentsError, lifetimes.data, lifeError, now],
  );
  const checking = agents.isPending || lifetimes.isPending;

  const choose = (c: string) => {
    setCell(c);
    location.hash = c;
  };
  const list = cells.data?.cells ?? [];
  const nav = list.length > 1
    ? <Select aria-label="Cell" data={list} value={cell} onChange={(c) => c && choose(c)} allowDeselect={false} size="sm" />
    : cell ? <Text size="sm" c="dimmed">cell <Text span ff="monospace" inherit>{cell}</Text></Text> : null;

  return (
    <AppFrame product="nest" nav={nav}>
      <Page>
        <PageHeader
          title="Fleet"
          meta={<>Read-only · refreshes every {REFRESH_MS / 1000} s{fleet.dataUpdatedAt > 0 && <> · updated {age(fleet.dataUpdatedAt, now) || "0s"} ago</>}</>}
        />
        {cells.isError ? <ErrorState title="Couldn't reach the dashboard's Worker" error={describe(cells.error)} onRetry={() => void cells.refetch()} />
          : !fleet.data ? (
            fleet.isError ? <ErrorState title="Couldn't read the control plane" error={describe(fleet.error)} onRetry={() => void fleet.refetch()} />
              : <Panel><LoadingState label="Reading the fleet" /></Panel>
          ) : (
            <>
              <Stack gap="lg">
                {fleet.isError && (
                  <Alert color="warning" title="Couldn't refresh" role="alert">
                    {describe(fleet.error)}. Showing what was read {age(fleet.dataUpdatedAt, now)} ago.
                  </Alert>
                )}
                <Summary live={l} agents={agents.data} items={items} checking={checking} />
              </Stack>
              <Attention items={items} checking={checking} />
              <AgentsSection agents={l.agents} info={agents.data} infoError={agentsError} onRetry={() => void agents.refetch()} now={now} />
              <SandboxesSection live={l} now={now} />
              <HostsSection hosts={l.hosts} now={now} />
            </>
          )}
        <TemplatesSection
          images={images.data}
          error={images.isError && !images.data ? describe(images.error) : null}
          onRetry={() => void images.refetch()}
          sandboxes={fleet.data ? l.sandboxes : undefined}
        />
        <LifetimesSection view={lifetimes.data} error={lifeError} onRetry={() => void lifetimes.refetch()} now={now} />
      </Page>
    </AppFrame>
  );
}
