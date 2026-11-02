// A project: what its agents are waiting on, its board, the chat with its manager, its settings, and the
// drawer of the task named in the URL.

import { Anchor, Button, Modal, Text } from "@mantine/core";
import { useDisclosure, useLocalStorage } from "@mantine/hooks";
import { IconBrandGithub, IconMessage, IconSettings } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useProject } from "../../api/queries";
import { AnchorLink } from "../../common/links";
import { ErrorState, icon, LoadingState, MetaItem, MetaRow, Page, PageHeader, SplitView } from "../../layout";
import { NeedsYou } from "../attention/NeedsYou";
import { Board } from "../board/Board";
import { ChatPanel } from "../chat/ChatPanel";
import { SettingsForm } from "../settings/SettingsForm";
import { TaskDrawer } from "../task/TaskDrawer";

export function ProjectPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { task } = useSearch({ from: "/projects/$projectId" });
  const navigate = useNavigate({ from: "/projects/$projectId" });
  const project = useProject(projectId);
  const [settingsOpen, settings] = useDisclosure(false);
  // Whether the chat panel shows, remembered in this browser; hiding it gives the board the width.
  const [chatOpen, setChatOpen] = useLocalStorage({ key: "nest-projects:chat-open", defaultValue: true, getInitialValueInEffect: false });

  if (project.isPending) {
    return (
      <Page>
        <LoadingState label="Loading the project" />
      </Page>
    );
  }
  if (project.isError) {
    return (
      <Page>
        <ErrorState title="The project couldn't be loaded" error={project.error} onRetry={() => void project.refetch()} />
        <AnchorLink to="/">All projects</AnchorLink>
      </Page>
    );
  }
  const p = project.data;

  return (
    <Page>
      <PageHeader
        breadcrumbs={[
          <AnchorLink key="projects" to="/" c="dimmed">
            Projects
          </AnchorLink>,
          <Text key="this" fz="sm">
            {p.name}
          </Text>,
        ]}
        title={p.name}
        meta={
          <MetaRow>
            <MetaItem icon={IconBrandGithub}>
              <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" inherit c="dimmed">
                {p.repo}
              </Anchor>
            </MetaItem>
            <MetaItem>Auto-assign {p.settings.auto_assign ? "on" : "off"}</MetaItem>
            <MetaItem>
              Up to {p.settings.max_workers} {p.settings.max_workers === 1 ? "worker" : "workers"}
            </MetaItem>
          </MetaRow>
        }
        actions={
          <>
            <Button variant="default" leftSection={<IconMessage size={icon.md} />} aria-pressed={chatOpen} onClick={() => setChatOpen((o) => !o)}>
              {chatOpen ? "Hide chat" : "Show chat"}
            </Button>
            <Button variant="default" leftSection={<IconSettings size={icon.md} />} onClick={settings.open}>
              Settings
            </Button>
          </>
        }
      />

      <NeedsYou projectId={projectId} />

      {/* The board is the focal element; the chat is a side panel from lg on, below the board before. */}
      <SplitView aside={chatOpen ? <ChatPanel projectId={projectId} settings={p.settings} /> : undefined}>
        <Board projectId={projectId} repo={p.repo} />
      </SplitView>

      <TaskDrawer projectId={projectId} repo={p.repo} taskId={task} onClose={() => void navigate({ search: {} })} />

      <Modal opened={settingsOpen} onClose={settings.close} title="Project settings">
        <SettingsForm key={String(settingsOpen)} projectId={projectId} settings={p.settings} onDone={settings.close} />
      </Modal>
    </Page>
  );
}
