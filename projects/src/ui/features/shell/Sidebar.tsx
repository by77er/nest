// The sidebar's places: every project, each a group with its pages (Board, Manager, Reviews, Settings),
// the current project's group open, and a badge of how many things in it need the owner.

import { Badge, NavLink, Text } from "@mantine/core";
import { IconFolders, IconLayoutKanban, IconMessage, IconSettings, IconShieldCheck, IconTool } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useProjects } from "../../api/queries";
import type { ProjectRow } from "../../api/types";
import { NavItemLink } from "../../common/links";
import { Stack } from "../../layout/Stack";
import { icon } from "../../theme";
import { useAttention } from "./attention";

/** A project's pages, in the order the sidebar lists them. */
export const PROJECT_PAGES = [
  { to: "/projects/$projectId/board", label: "Board", icon: IconLayoutKanban },
  { to: "/projects/$projectId/manager", label: "Manager", icon: IconMessage },
  { to: "/projects/$projectId/reviews", label: "Reviews", icon: IconShieldCheck },
  { to: "/projects/$projectId/settings", label: "Settings", icon: IconSettings },
] as const;

export function NeedsYouBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <Badge size="sm" color="warning" variant="filled" aria-label={`${count} ${count === 1 ? "thing needs" : "things need"} you`} data-marker="needs-you">
      {count}
    </Badge>
  );
}

function ProjectGroup({ project, current, onNavigate, attention }: { project: ProjectRow; current: boolean; onNavigate: () => void; attention?: number }) {
  const [opened, setOpened] = useState(current);
  // Opening another project's page opens its group; leaving one leaves it as the owner had it.
  useEffect(() => {
    if (current) setOpened(true);
  }, [current]);
  return (
    <NavLink
      component="button"
      aria-expanded={opened}
      label={project.name}
      description={project.repo}
      opened={opened}
      onChange={setOpened}
      rightSection={<NeedsYouBadge count={attention} />}
      childrenOffset="lg"
      aria-label={`${project.name}${attention ? `, ${attention} need you` : ""}`}
      data-project={project.id}
      data-current={current || undefined}
    >
      {PROJECT_PAGES.map((page) => (
        <NavItemLink key={page.to} to={page.to} params={{ projectId: project.id }} label={page.label} leftSection={<page.icon size={icon.md} />} onClick={onNavigate} />
      ))}
    </NavLink>
  );
}

/** A project group with its attention count (a hook per project, so the count can update on its own). */
function ProjectEntry(props: { project: ProjectRow; current: boolean; onNavigate: () => void }) {
  return <ProjectGroup {...props} attention={useAttention(props.project.id)} />;
}

export function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  const projects = useProjects();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  return (
    <Stack gap="2xs">
      <NavItemLink to="/projects" label="Projects" leftSection={<IconFolders size={icon.md} />} activeOptions={{ exact: true }} onClick={onNavigate} />
      {projects.isError && (
        <Text fz="xs" c="danger" px="sm">
          The projects couldn't be loaded.
        </Text>
      )}
      {(projects.data ?? []).map((p) => (
        <ProjectEntry key={p.id} project={p} current={p.id === projectId} onNavigate={onNavigate} />
      ))}
    </Stack>
  );
}

export function SidebarFooter({ onNavigate }: { onNavigate: () => void }) {
  return <NavItemLink to="/admin" label="Admin" leftSection={<IconTool size={icon.md} />} onClick={onNavigate} />;
}
