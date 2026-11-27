// A project's manager, in the same frame as every view: the conversation at a reading measure on the
// frame's left edge, the context column beside it (its tasks, what needs you); the composer pinned to
// the bottom; its status in the header; and beside "Chat", its live trace (`?view=trace`). Both tabs read
// one connection to the manager's trace, kept across a switch.

import { Tabs } from "@mantine/core";
import { IconMessage, IconTimeline } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
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
  // The trace, once opened, stays (hidden while Chat shows, as the task drawer's does): coming back to it
  // draws nothing again, and the reader's place in it is kept. The chat is drawn anew each time.
  const [traceOpened, setTraceOpened] = useState(tab === "trace");
  if (tab === "trace" && !traceOpened) setTraceOpened(true);
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        // One trace connection for both tabs: a switch doesn't reconnect or fetch its history again.
        <SharedTrace agent={p.settings.manager}>
        <WithContext measure="reading" contextLabel="About the manager" context={<ManagerContext projectId={projectId} />}>
        <Section title="Manager" actions={<ManagerStatusLine projectId={projectId} />}>
        <Stack gap="xl">
          <ManagerProblem projectId={projectId} />
          {/* `display-none`, not Mantine's default `activity` (React's <Activity hidden>), whose effects' cleanups
              would close the trace's socket and lose its scroll (the Sheet's tabs do the same). */}
          <Tabs value={tab} onChange={(v) => void navigate({ search: v === "trace" ? { view: "trace" } : {} })} keepMounted keepMountedMode="display-none">
            <Tabs.List>
              <Tabs.Tab value="chat" leftSection={<IconMessage size={icon.md} />}>
                Chat
              </Tabs.Tab>
              <Tabs.Tab value="trace" leftSection={<IconTimeline size={icon.md} />}>
                Trace
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="chat" pt="xl">
              {tab === "chat" && <ChatView projectId={projectId} agent={p.settings.manager} />}
            </Tabs.Panel>
            <Tabs.Panel value="trace" pt="xl">
              {traceOpened && <ManagerTrace settings={p.settings} />}
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
