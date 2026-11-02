// The operator's page: write the app's templates and capabilities to nest's catalog again
// (README.md#setup-the-operators), and see what the last sync wrote.

import { Alert, Button, Card, Code, Container, Group, List, Stack, Text, Title } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useSync, useSyncState } from "../../api/queries";
import type { SyncState } from "../../api/types";
import { Loading, LoadError } from "../../common/QueryStates";
import { ago, exact } from "../../common/time";

function Written({ s }: { s: Pick<SyncState, "written" | "repos"> }) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Wrote {s.written.length} {s.written.length === 1 ? "entry" : "entries"}
      </Text>
      <List size="sm" spacing={2} listStyleType="none">
        {s.written.map((w) => (
          <List.Item key={w}>
            <Code>{w}</Code>
          </List.Item>
        ))}
      </List>
      <Text size="sm" c="dimmed">
        Repos the templates may push to: {s.repos.length ? s.repos.join(", ") : "none yet"}
      </Text>
    </Stack>
  );
}

export function AdminPage() {
  const state = useSyncState();
  const sync = useSync();

  return (
    <Container size="sm">
      <Stack gap="md">
        <Title order={2}>Admin</Title>
        <Card withBorder padding="lg">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <Stack gap={2} maw={420}>
                <Title order={3} size="h4">
                  Catalog sync
                </Title>
                <Text size="sm" c="dimmed">
                  Writes the manager, worker and reviewer templates and their capabilities to nest's catalog, naming every project's repo. Creating a project runs it too.
                </Text>
              </Stack>
              <Button leftSection={<IconRefresh size={16} />} loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync catalog
              </Button>
            </Group>

            {sync.isSuccess && (
              <Alert color="success" variant="light" title="Synced">
                <Written s={sync.data} />
              </Alert>
            )}
            {sync.isError && (
              <Alert color="danger" variant="light" title="The sync failed" role="alert">
                {sync.error.message}
              </Alert>
            )}

            <Stack gap="xs">
              <Title order={4} size="sm" c="dimmed" tt="uppercase">
                Last successful sync
              </Title>
              {state.isPending ? (
                <Loading label="Loading the last sync" />
              ) : state.isError ? (
                <LoadError what="The last sync" error={state.error} onRetry={() => void state.refetch()} />
              ) : state.data === null ? (
                <Text size="sm" c="dimmed">
                  Never synced.
                </Text>
              ) : (
                <Stack gap="xs">
                  <Text size="sm" title={exact(state.data.at_ms)}>
                    {ago(state.data.at_ms)}
                  </Text>
                  <Written s={state.data} />
                </Stack>
              )}
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
