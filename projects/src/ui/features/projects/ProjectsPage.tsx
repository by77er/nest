// Every project, and a new one.

import { Anchor, Button, Card, Container, EmptyState, Group, Modal, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconBrandGithub, IconFolders, IconPlus } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { AnchorLink } from "../../common/links";
import { Loading, LoadError } from "../../common/QueryStates";
import { ago, exact } from "../../common/time";
import { CreateProjectForm } from "./CreateProjectForm";

export function ProjectsPage() {
  const projects = useProjects();
  const [creating, { open, close }] = useDisclosure(false);
  const navigate = useNavigate();

  return (
    <Container size="lg">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={2}>Projects</Title>
          <Button leftSection={<IconPlus size={16} />} onClick={open}>
            New project
          </Button>
        </Group>

        {projects.isPending ? (
          <Loading label="Loading projects" />
        ) : projects.isError ? (
          <LoadError what="The projects" error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data.length === 0 ? (
          <Card withBorder padding="xl">
            <EmptyState
              icon={<IconFolders size={28} />}
              withIndicatorBackground
              title="No projects yet"
              description="A project is one GitHub repo, with a manager agent that keeps its board."
            >
              <EmptyState.Actions>
                <Button onClick={open}>Create the first project</Button>
              </EmptyState.Actions>
            </EmptyState>
          </Card>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {projects.data.map((p) => (
              <Card key={p.id} withBorder padding="md">
                <Stack gap={4}>
                  <AnchorLink to="/projects/$projectId" params={{ projectId: p.id }} search={{}} c="dark" fw={600} size="lg">
                    {p.name}
                  </AnchorLink>
                  <Group gap={6} wrap="nowrap">
                    <IconBrandGithub size={14} aria-hidden />
                    <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" size="sm" c="dimmed" truncate>
                      {p.repo}
                    </Anchor>
                  </Group>
                  <Text size="xs" c="dimmed" title={exact(p.created_ms)}>
                    Created {ago(p.created_ms)}
                  </Text>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
        )}
      </Stack>

      <Modal opened={creating} onClose={close} title="New project">
        <CreateProjectForm
          onCancel={close}
          onCreated={(p) => {
            close();
            if (!p.catalog_synced) {
              notifications.show({ color: "warning", title: "The catalog wasn't synced", message: "Its agents may not push to the repo yet: run the sync from Admin." });
            }
            void navigate({ to: "/projects/$projectId", params: { projectId: p.id }, search: {} });
          }}
        />
      </Modal>
    </Container>
  );
}
