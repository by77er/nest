// A project's manager, in the same frame as every view: the conversation at a reading measure on the
// frame's left edge, the context column beside it (its tasks, what needs you); the composer pinned to
// the bottom; its status in the header; and beside "Chat", its live trace (`?view=trace`).

import { Tabs } from "@mantine/core";
import { IconMessage, IconTimeline } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { icon, Measure, Section, Stack, WithContext } from "../../layout";
import { ManagerContext } from "./ManagerContext";
import { ChatView } from "../chat/ChatView";
import { ProjectFrame } from "../project/ProjectFrame";
import { ManagerProblem, ManagerStatusLine } from "./ManagerStatus";
import { ManagerTrace } from "../trace/AgentTraces";

export function ManagerPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/manager" });
  const { view } = useSearch({ from: "/projects/$projectId/manager" });
  const navigate = useNavigate({ from: "/projects/$projectId/manager" });
  const tab = view ?? "chat";
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <WithContext measure="reading" contextLabel="About the manager" context={<ManagerContext projectId={projectId} />}>
        <Measure type="reading">
        <Section title="Manager" actions={<ManagerStatusLine projectId={projectId} />}>
        <Stack gap="xl">
          <ManagerProblem projectId={projectId} />
          <Tabs value={tab} onChange={(v) => void navigate({ search: v === "trace" ? { view: "trace" } : {} })} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="chat" leftSection={<IconMessage size={icon.md} />}>
                Chat
              </Tabs.Tab>
              <Tabs.Tab value="trace" leftSection={<IconTimeline size={icon.md} />}>
                Trace
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="chat" pt="xl">
              <ChatView projectId={projectId} />
            </Tabs.Panel>
            <Tabs.Panel value="trace" pt="xl">
              <ManagerTrace settings={p.settings} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
        </Section>
        </Measure>
        </WithContext>
      )}
    </ProjectFrame>
  );
}
