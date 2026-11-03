// Which project: the sidebar's switcher (layout/Switcher). Its button is the current project's name with
// its "needs you" badge, or "All projects" outside one. Picking a project keeps the view you're on (the
// board from outside a project); "All projects" goes to the list.

import { Badge } from "@mantine/core";
import { IconFolders } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { Switcher } from "../../layout/Switcher";
import type { View } from "./views";

const ALL = "__all";
const needs = (n: number | undefined) => (n ? `, ${n} need you` : "");

export function NeedsYouBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <Badge size="sm" color="warning" variant="filled" aria-label={`${count} ${count === 1 ? "thing needs" : "things need"} you`} data-marker="needs-you">
      {count}
    </Badge>
  );
}

export function ProjectSwitcher({ projectId, view, onNavigate }: { projectId: string | undefined; view: View | undefined; onNavigate: () => void }) {
  const projects = useProjects();
  const navigate = useNavigate();
  const list = projects.data ?? [];
  const current = list.find((p) => p.id === projectId);
  const name = current?.name ?? "All projects";

  const pick = (value: string) => {
    onNavigate();
    if (value === ALL) return void navigate({ to: "/projects" });
    const params = { projectId: value };
    switch (view ?? "board") {
      case "manager":
        return void navigate({ to: "/projects/$projectId/manager", params, search: {} });
      case "reviews":
        return void navigate({ to: "/projects/$projectId/reviews", params });
      case "settings":
        return void navigate({ to: "/projects/$projectId/settings", params });
      default:
        return void navigate({ to: "/projects/$projectId/board", params, search: {} });
    }
  };

  return (
    <Switcher
      icon={IconFolders}
      current={{ label: name, end: <NeedsYouBadge count={current?.needs_you} />, ariaLabel: `Project: ${name}${needs(current?.needs_you)}. Switch project` }}
      items={[
        { value: ALL, label: "All projects" },
        ...list.map((p) => ({ value: p.id, label: p.name, keywords: p.repo, end: <NeedsYouBadge count={p.needs_you} />, ariaLabel: `${p.name}${needs(p.needs_you)}` })),
      ]}
      active={current?.id ?? ALL}
      searchLabel="Find a project"
      empty={(s) => `No project matches “${s}”`}
      onPick={pick}
    />
  );
}
