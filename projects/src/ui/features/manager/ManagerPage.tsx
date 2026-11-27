// A project's manager, in the same frame as every view: the conversation at a reading measure on the
// frame's left edge, the context column beside it (its tasks, what needs you); the composer pinned to
// the bottom; its status in the header; and beside "Chat", its live trace (`?view=trace`). Both tabs read
// one connection to the manager's trace, kept across a switch.

import { Tabs } from "@mantine/core";
import { IconMessage, IconTimeline } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { icon, Section, Stack, WithContext } from "../../layout";
import { ManagerContext } from "./ManagerContext";
import { ChatView } from "../chat/ChatView";
import { ProjectFrame } from "../project/ProjectFrame";
import { ManagerProblem, ManagerStatusLine } from "./ManagerStatus";
import { ManagerTrace } from "../trace/AgentTraces";
import { SharedTrace } from "../trace/SharedTrace";

export function ManagerPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/manager" });
  const { view } = useSearch({ from: "/projects/$projectId/manager" });
  const navigate = useNavigate({ from: "/projects/$projectId/manager" });
  const tab = view ?? "chat";
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        // One trace connection for both tabs: a switch doesn't reconnect or fetch its history again.
        <SharedTrace agent={p.settings.manager}>
        <WithContext measure="reading" contextLabel="About the manager" context={<ManagerContext projectId={projectId} />}>
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
              <ChatView projectId={projectId} agent={p.settings.manager} />
            </Tabs.Panel>
            <Tabs.Panel value="trace" pt="xl">
              <ManagerTrace settings={p.settings} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
        </Section>
        </WithContext>
        </SharedTrace>
      )}
    </ProjectFrame>
  );
}
