// Every project, and a new one. The focal element is the list; its one action, top right.

import { Anchor, Badge, Button, Modal, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconBrandGithub, IconFolders, IconPlus } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { CardGrid, EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Page, PageHeader, Panel, Row, Stack } from "../../layout";
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
              <Stack gap="sm">
                <Row gap="sm" justify="space-between" wrap="nowrap">
                  <AnchorLink to="/projects/$projectId" params={{ projectId: p.id }} search={{}} c="bright" fw="bold" fz="lg">
                    {p.name}
                  </AnchorLink>
                  {p.needs_you > 0 && (
                    <Badge color="warning" variant="filled" data-marker="needs-you" aria-label={`${p.needs_you} ${p.needs_you === 1 ? "thing needs" : "things need"} you`}>
                      {p.needs_you} {p.needs_you === 1 ? "needs" : "need"} you
                    </Badge>
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
            void navigate({ to: "/projects/$projectId", params: { projectId: p.id }, search: {} });
          }}
        />
      </Modal>
    </Page>
  );
}
