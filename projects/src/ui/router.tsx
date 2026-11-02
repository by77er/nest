// The page's routes, typed (TanStack Router, code-based). The Worker serves index.html for any path
// (wrangler.jsonc's single-page-application handling), after the Access check.

import { createRootRoute, createRoute, createRouter, lazyRouteComponent, type RouterHistory } from "@tanstack/react-router";
import { NotFound, RouteError, Shell } from "./features/shell/Shell";

// Each page is its own chunk, loaded when its route is first visited (or hovered: preload on intent).
const ProjectsPage = lazyRouteComponent(() => import("./features/projects/ProjectsPage"), "ProjectsPage");
const ProjectPage = lazyRouteComponent(() => import("./features/project/ProjectPage"), "ProjectPage");
const AdminPage = lazyRouteComponent(() => import("./features/admin/AdminPage"), "AdminPage");

const TASK_ID = /^tsk_[a-z0-9]+$/;

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound, errorComponent: RouteError });

const projects = createRoute({ getParentRoute: () => root, path: "/", component: ProjectsPage });

/** A project's page; `?task=` opens that task's drawer, so a task is a link. */
const project = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId",
  validateSearch: (s: Record<string, unknown>): { task?: string } => (typeof s.task === "string" && TASK_ID.test(s.task) ? { task: s.task } : {}),
  component: ProjectPage,
});

const admin = createRoute({ getParentRoute: () => root, path: "/admin", component: AdminPage });

export const routeTree = root.addChildren([projects, project, admin]);

export function createAppRouter(o: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, ...(o.history ? { history: o.history } : {}), defaultPreload: "intent", scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
