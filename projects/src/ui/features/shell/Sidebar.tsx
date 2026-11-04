// The sidebar (the nest-ui-design skill's Navigation): which project (the switcher), then that project's
// views as flat rows, one row style; outside a project, the switcher and the projects list. The "needs
// you" count is on Board, where "Needs you" lives, once; the switcher's list shows every project's. Admin is in the sidebar's foot.

import { Badge, Text } from "@mantine/core";
import { IconFolders, IconTool } from "@tabler/icons-react";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { NavRowLink } from "../../common/links";
import { NavGroup, NavGroups } from "../../layout/Nav";
import { useNeedsYou } from "./attention";
import { useUnread } from "./unread";
import { NeedsYouBadge, ProjectSwitcher } from "./ProjectSwitcher";
import { VIEWS, viewOf } from "./views";

export function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useProjects();
  const needsYou = useNeedsYou(projectId ?? "");
  const unread = useUnread(projectId, viewOf(pathname) === "manager");
  return (
    <NavGroups>
      <NavGroup label="Project">
        <ProjectSwitcher projectId={projectId} view={viewOf(pathname)} onNavigate={onNavigate} />
        {projects.isError && (
          <Text fz="xs" c="danger">
            The projects couldn't be loaded.
          </Text>
        )}
      </NavGroup>
      {projectId ? (
        <NavGroup label="Views">
          {VIEWS.map((v) => (
            <NavRowLink
              key={v.view}
              to={v.to}
              params={{ projectId }}
              icon={v.icon}
              label={v.label}
              // Badges once each: what needs you on Board, unread messages on Manager.
              end={v.view === "board" ? <NeedsYouBadge count={needsYou} /> : v.view === "manager" && unread ? <UnreadDot count={unread} /> : undefined}
              onClick={onNavigate}
            />
          ))}
        </NavGroup>
      ) : (
        <NavGroup label="Places">
          <NavRowLink to="/projects" icon={IconFolders} label="All projects" activeOptions={{ exact: true }} onClick={onNavigate} />
        </NavGroup>
      )}
    </NavGroups>
  );
}

export function SidebarFooter({ onNavigate }: { onNavigate: () => void }) {
  return <NavRowLink to="/admin" icon={IconTool} label="Admin" onClick={onNavigate} />;
}

/** Unread messages from the manager: a quiet dot in the primary role, its count for readers. */
function UnreadDot({ count }: { count: number }) {
  return (
    <Badge size="xs" circle color="primary" variant="filled" aria-label={`${count} unread ${count === 1 ? "message" : "messages"}`} data-marker="unread">
      {count > 9 ? "9+" : count}
    </Badge>
  );
}
