// Which project: the sidebar's switcher (layout/Switcher). Its button is the current project's name, or
// "All projects" outside one (its "needs you" count is on its Board row, and every project's in the list). Picking a project keeps the view you're on (the
// manager, its default, from outside a project); "All projects" goes to the list.

import { Badge } from "@mantine/core";
import { IconFolders } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../api/queries";
import { Switcher } from "../../layout/Switcher";
import type { View } from "./views";
import { unknownIfStale } from "./attention";

const ALL = "__all";
const needs = (n: number | null | undefined) => (n === null ? ", couldn't check what needs you" : n ? `, ${n} need you` : "");

/** How many things need the owner; `null`: unknown (nest couldn't be read for the agents' asks), shown as "?". */
export function NeedsYouBadge({ count }: { count: number | null | undefined }) {
  if (count === null) {
    return (
      <Badge size="sm" color="warning" variant="light" aria-label="Couldn't check what needs you" data-marker="needs-you-unknown">
        ?
      </Badge>
    );
  }
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
    switch (view ?? "manager") {
      case "board":
        return void navigate({ to: "/projects/$projectId/board", params, search: {} });
      case "reviews":
        return void navigate({ to: "/projects/$projectId/reviews", params });
      case "settings":
        return void navigate({ to: "/projects/$projectId/settings", params });
      default:
        return void navigate({ to: "/projects/$projectId/manager", params, search: {} });
    }
  };

  return (
    <Switcher
      icon={IconFolders}
      // The current project's count is on its Board row, once; the list shows every project's.
      current={{ label: name, ariaLabel: `Project: ${name}. Switch project` }}
      items={[
        { value: ALL, label: "All projects" },
        ...list.map((p) => {
          const n = unknownIfStale(projects.isRefetchError, p.needs_you);
          return { value: p.id, label: p.name, keywords: p.repo, end: <NeedsYouBadge count={n} />, ariaLabel: `${p.name}${needs(n)}` };
        }),
      ]}
      active={current?.id ?? ALL}
      searchLabel="Find a project"
      empty={(s) => `No project matches “${s}”`}
      onPick={pick}
    />
  );
}
