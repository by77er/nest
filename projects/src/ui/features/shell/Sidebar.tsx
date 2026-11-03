// The sidebar (the nest-ui-design skill's Navigation): which project (the switcher), then that project's
// views as flat rows, one row style; outside a project, the switcher and the projects list. The "needs
// you" count is on the switcher and on Board, where "Needs you" lives. Admin is in the sidebar's foot.

import { Text } from "@mantine/core";
import { IconFolders, IconTool } from "@tabler/icons-react";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { NavRowLink } from "../../common/links";
import { NavGroup, NavGroups } from "../../layout/Nav";
import { useNeedsYou } from "./attention";
import { NeedsYouBadge, ProjectSwitcher } from "./ProjectSwitcher";
import { VIEWS, viewOf } from "./views";

export function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useProjects();
  const needsYou = useNeedsYou(projectId ?? "");
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
              end={v.view === "board" ? <NeedsYouBadge count={needsYou} /> : undefined}
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
