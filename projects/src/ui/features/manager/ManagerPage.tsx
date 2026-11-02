// A project's manager: the conversation with it, full width at a reading measure, the composer pinned
// to the bottom; its status in the header; and beside "Chat", the "Trace" tab's slot (`?view=trace`).

import { Tabs } from "@mantine/core";
import { IconMessage, IconTimeline } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { icon, Stack } from "../../layout";
import { ChatView } from "../chat/ChatView";
import { ProjectFrame } from "../project/ProjectFrame";
import { ManagerProblem, ManagerStatusLine } from "./ManagerStatus";
import { TraceSlot } from "./TraceSlot";

export function ManagerPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/manager" });
  const { view } = useSearch({ from: "/projects/$projectId/manager" });
  const navigate = useNavigate({ from: "/projects/$projectId/manager" });
  const tab = view ?? "chat";
  return (
    <ProjectFrame projectId={projectId} title="Manager" measure="reading" meta={() => <ManagerStatusLine projectId={projectId} />}>
      {(p) => (
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
              <TraceSlot projectId={projectId} agent={p.settings.manager} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </ProjectFrame>
  );
}
