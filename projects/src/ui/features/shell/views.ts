// A project's views, flat, in the order the sidebar lists them; and which one the URL is on.
import { IconLayoutKanban, IconMessage, IconSettings, IconShieldCheck } from "@tabler/icons-react";

export const VIEWS = [
  { view: "board", to: "/projects/$projectId/board", label: "Board", icon: IconLayoutKanban },
  { view: "manager", to: "/projects/$projectId/manager", label: "Manager", icon: IconMessage },
  { view: "reviews", to: "/projects/$projectId/reviews", label: "Reviews", icon: IconShieldCheck },
  { view: "settings", to: "/projects/$projectId/settings", label: "Settings", icon: IconSettings },
] as const;

export type View = (typeof VIEWS)[number]["view"];

/** The view a project path is on (`/projects/<id>/<view>`), if any. */
export function viewOf(pathname: string): View | undefined {
  const v = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname)?.[1];
  return VIEWS.find((x) => x.view === v)?.view;
}
