// A project's views, flat, in the order the sidebar lists them (the manager first: the default view); and which one the URL is on.
import { IconInbox, IconKey, IconLayoutKanban, IconMessage, IconRepeat, IconSettings, IconShieldCheck, IconWorld } from "@tabler/icons-react";

export const VIEWS = [
  { view: "manager", to: "/projects/$projectId/manager", label: "Manager", icon: IconMessage },
  { view: "board", to: "/projects/$projectId/board", label: "Board", icon: IconLayoutKanban },
  { view: "triage", to: "/projects/$projectId/triage", label: "Triage", icon: IconInbox },
  { view: "reviews", to: "/projects/$projectId/reviews", label: "Reviews", icon: IconShieldCheck },
  { view: "routines", to: "/projects/$projectId/routines", label: "Routines", icon: IconRepeat },
  { view: "secrets", to: "/projects/$projectId/secrets", label: "Secrets", icon: IconKey },
  { view: "network", to: "/projects/$projectId/network", label: "Network", icon: IconWorld },
  { view: "settings", to: "/projects/$projectId/settings", label: "Settings", icon: IconSettings },
] as const;

export type View = (typeof VIEWS)[number]["view"];

/** The view a project path is on (`/projects/<id>/<view>`), if any. */
export function viewOf(pathname: string): View | undefined {
  const v = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname)?.[1];
  return VIEWS.find((x) => x.view === v)?.view;
}
