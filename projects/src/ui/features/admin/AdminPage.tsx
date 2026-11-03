// The operator's page: write the app's templates and capabilities to nest's catalog again
// (README.md#setup-the-operators), and beside it what the last sync wrote: two Panels, two-up.

import { Button, Code, List, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useSync, useSyncState } from "../../api/queries";
import type { SyncState } from "../../api/types";
import { ago, exact } from "../../common/time";
import { ErrorState, icon, LoadingState, Notice, Page, PageHeader, Panel, Section, SectionGrid, Stack } from "../../layout";

function Written({ s }: { s: Pick<SyncState, "written" | "repos"> }) {
  return (
    <Stack gap="sm">
      <Text fz="md" fw="medium">
        Wrote {s.written.length} {s.written.length === 1 ? "entry" : "entries"}
      </Text>
      <List fz="md" spacing="xs" listStyleType="none">
        {s.written.map((w) => (
          <List.Item key={w}>
            <Code>{w}</Code>
          </List.Item>
        ))}
      </List>
      <Text fz="sm" c="dimmed">
        Repos the templates may push to: {s.repos.length ? s.repos.join(", ") : "none yet"}
      </Text>
    </Stack>
  );
}

export function AdminPage() {
  const state = useSyncState();
  const sync = useSync();

  return (
    <Page>
      <PageHeader title="Admin" />
      <SectionGrid>
        <Panel>
          <Section
            title="Catalog sync"
            order={4}
            region={false}
            actions={
              <Button leftSection={<IconRefresh size={icon.md} />} loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync catalog
              </Button>
            }
          >
            <Stack gap="xl">
              <Text fz="md" c="dimmed">
                Writes the manager, worker and reviewer templates and their capabilities to nest's catalog, naming every project's repo. Creating a project runs it too.
              </Text>
              {sync.isSuccess && (
                <Notice tone="success" title="Synced">
                  <Written s={sync.data} />
                </Notice>
              )}
              {sync.isError && (
                <Notice tone="danger" title="The sync failed" role="alert">
                  {sync.error.message}
                </Notice>
              )}
            </Stack>
          </Section>
        </Panel>
        <Panel>
          <Section title="Last successful sync" order={4} region={false}>
            {state.isPending ? (
              <LoadingState label="Loading the last sync" />
            ) : state.isError ? (
              <ErrorState title="The last sync couldn't be loaded" error={state.error} onRetry={() => void state.refetch()} />
            ) : state.data === null ? (
              <Text fz="md" c="dimmed">
                Never synced.
              </Text>
            ) : (
              <Stack gap="sm">
                <Text fz="sm" c="dimmed" title={exact(state.data.at_ms)}>
                  {ago(state.data.at_ms)}
                </Text>
                <Written s={state.data} />
              </Stack>
            )}
          </Section>
        </Panel>
      </SectionGrid>
    </Page>
  );
}
