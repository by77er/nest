// A project: what its agents are waiting on, its board, the chat with its manager, its settings, and the
// drawer of the task named in the URL.

import { Anchor, Badge, Box, Breadcrumbs, Button, Flex, Group, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure, useLocalStorage } from "@mantine/hooks";
import { IconBrandGithub, IconMessage, IconSettings } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useProject } from "../../api/queries";
import { AnchorLink } from "../../common/links";
import { Loading, LoadError } from "../../common/QueryStates";
import { AsksPanel } from "../asks/AsksPanel";
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

  if (project.isPending) return <Loading label="Loading the project" />;
  if (project.isError) {
    return (
      <Stack>
        <LoadError what="The project" error={project.error} onRetry={() => void project.refetch()} />
        <AnchorLink to="/">All projects</AnchorLink>
      </Stack>
    );
  }
  const p = project.data;

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Breadcrumbs separatorMargin={6}>
          <AnchorLink to="/" size="sm" c="dimmed">
            Projects
          </AnchorLink>
          <Text size="sm">{p.name}</Text>
        </Breadcrumbs>
        <Group justify="space-between" align="flex-end" gap="sm">
          <Stack gap={2}>
            <Title order={1} size="h2">
              {p.name}
            </Title>
            <Group gap="sm">
              <Group gap={4}>
                <IconBrandGithub size={14} aria-hidden />
                <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" size="sm" c="dimmed">
                  {p.repo}
                </Anchor>
              </Group>
              <Badge size="sm" variant="default">
                Auto-assign {p.settings.auto_assign ? "on" : "off"}
              </Badge>
              <Badge size="sm" variant="default">
                Max {p.settings.max_workers} {p.settings.max_workers === 1 ? "worker" : "workers"}
              </Badge>
            </Group>
          </Stack>
          <Group gap="xs">
            <Button variant="default" leftSection={<IconMessage size={16} />} aria-pressed={chatOpen} onClick={() => setChatOpen((o) => !o)}>
              {chatOpen ? "Hide chat" : "Show chat"}
            </Button>
            <Button variant="default" leftSection={<IconSettings size={16} />} onClick={settings.open}>
              Settings
            </Button>
          </Group>
        </Group>
      </Stack>

      <AsksPanel projectId={projectId} />

      {/* The chat is a side panel from lg on, of a fixed width, and below the board on narrower screens. */}
      <Flex direction={{ base: "column", lg: "row" }} gap="md" align={{ base: "stretch", lg: "flex-start" }}>
        <Box flex={1} miw={0}>
          <Board projectId={projectId} repo={p.repo} />
        </Box>
        {chatOpen && (
          <Box w={{ base: "100%", lg: 320 }} style={{ flexShrink: 0 }}>
            <ChatPanel projectId={projectId} settings={p.settings} />
          </Box>
        )}
      </Flex>

      <TaskDrawer projectId={projectId} repo={p.repo} taskId={task} onClose={() => void navigate({ search: {} })} />

      <Modal opened={settingsOpen} onClose={settings.close} title="Project settings">
        <SettingsForm key={String(settingsOpen)} projectId={projectId} settings={p.settings} onDone={settings.close} />
      </Modal>
    </Stack>
  );
}
