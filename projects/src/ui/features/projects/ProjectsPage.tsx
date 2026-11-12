// Every project, and a new one. The focal element is the list; its one action, top right.

import { Anchor, Badge, Button, Modal, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconBrandGithub, IconFolders, IconPlus } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { AnchorLink, BadgeLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { CardGrid, EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Page, PageHeader, Panel, Row, Stack, weight } from "../../layout";
import { CreateProjectForm } from "./CreateProjectForm";

export function ProjectsPage() {
  const projects = useProjects();
  const [creating, { open, close }] = useDisclosure(false);
  const navigate = useNavigate();

  return (
    <Page>
      <PageHeader
        title="Projects"
        actions={
          <Button leftSection={<IconPlus size={icon.md} />} onClick={open}>
            New project
          </Button>
        }
      />

      {projects.isPending ? (
        <LoadingState label="Loading projects" />
      ) : projects.isError ? (
        <ErrorState title="The projects couldn't be loaded" error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <Panel>
          <EmptyState
            icon={IconFolders}
            title="No projects yet"
            description="A project is one GitHub repo, with a manager agent that keeps its board."
            action={<Button onClick={open}>Create the first project</Button>}
          />
        </Panel>
      ) : (
        <CardGrid>
          {projects.data.map((p) => (
            <Panel key={p.id} component="article" aria-label={p.name}>
              {/* Two rows of controls (the title and its badge, the repo): a touch pitch apart. */}
              <Stack gap="sm" data-touch-pitch>
                <Row gap="sm" justify="space-between" wrap="nowrap">
                  {/* Still being created (README.md#creating-a-project): nothing to open yet. */}
                  {p.state === "pending" ? (
                    <Text fw={weight.bold} fz="lg">
                      {p.name}
                    </Text>
                  ) : (
                    <AnchorLink to="/projects/$projectId/manager" params={{ projectId: p.id }} search={{}} c="bright" fw={weight.bold} fz="lg">
                      {p.name}
                    </AnchorLink>
                  )}
                  {p.state === "pending" && (
                    <Badge color="gray" variant="light" data-marker="creating">
                      Being created
                    </Badge>
                  )}
                  {p.needs_you === null && (
                    // nest couldn't be read for the agents' asks: unknown, not none.
                    <BadgeLink
                      to="/projects/$projectId/board"
                      params={{ projectId: p.id }}
                      search={{}}
                      color="warning"
                      variant="light"
                      data-marker="needs-you-unknown"
                      aria-label="Couldn't check what needs you: open the board"
                    >
                      Couldn't check what needs you
                    </BadgeLink>
                  )}
                  {p.needs_you !== null && p.needs_you > 0 && (
                    // Asks are answered on the Board; the project itself opens on its Manager.
                    <BadgeLink
                      to="/projects/$projectId/board"
                      params={{ projectId: p.id }}
                      search={{}}
                      color="warning"
                      variant="filled"
                      data-marker="needs-you"
                      aria-label={`${p.needs_you} ${p.needs_you === 1 ? "thing needs" : "things need"} you: open the board`}
                    >
                      {p.needs_you} {p.needs_you === 1 ? "needs" : "need"} you
                    </BadgeLink>
                  )}
                </Row>
                <MetaRow>
                  <MetaItem icon={IconBrandGithub}>
                    <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" inherit c="dimmed">
                      {p.repo}
                    </Anchor>
                  </MetaItem>
                  <Text component="span" fz="xs" c="dimmed" title={exact(p.created_ms)}>
                    Created {ago(p.created_ms)}
                  </Text>
                </MetaRow>
              </Stack>
            </Panel>
          ))}
        </CardGrid>
      )}

      <Modal opened={creating} onClose={close} title="New project">
        <CreateProjectForm
          onCancel={close}
          onCreated={(p) => {
            close();
            if (!p.catalog_synced) {
              notifications.show({ color: "warning", title: "The catalog wasn't synced", message: "Its agents may not push to the repo yet: run the sync from Admin." });
            }
            void navigate({ to: "/projects/$projectId/manager", params: { projectId: p.id }, search: {} });
          }}
        />
      </Modal>
    </Page>
  );
}
