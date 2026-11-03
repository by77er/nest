// The page's routes, typed (TanStack Router, code-based). The Worker serves index.html for any path
// (wrangler.jsonc's single-page-application handling), after the Access check.
//
//   /projects                          every project
//   /projects/$projectId/board         its board; `?task=` opens a task's drawer (the default page)
//   /projects/$projectId/manager       the chat with its manager; `?view=trace` the manager's trace
//   /projects/$projectId/reviews       its review jobs
//   /projects/$projectId/settings      its settings
//   /admin                             the catalog sync
//
// Old links redirect: `/` to the list, `/projects/$projectId?task=…` to the board with the same task.

import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect, type RouterHistory } from "@tanstack/react-router";
import { NotFound, RouteError, Shell } from "./features/shell/Shell";

// Each page is its own chunk, loaded when its route is first visited (or hovered: preload on intent).
const ProjectsPage = lazyRouteComponent(() => import("./features/projects/ProjectsPage"), "ProjectsPage");
const BoardPage = lazyRouteComponent(() => import("./features/project/BoardPage"), "BoardPage");
const ManagerPage = lazyRouteComponent(() => import("./features/manager/ManagerPage"), "ManagerPage");
const ReviewsPage = lazyRouteComponent(() => import("./features/reviews/ReviewsPage"), "ReviewsPage");
const SettingsPage = lazyRouteComponent(() => import("./features/settings/SettingsPage"), "SettingsPage");
const SecretsPage = lazyRouteComponent(() => import("./features/secrets/SecretsPage"), "SecretsPage");
const AdminPage = lazyRouteComponent(() => import("./features/admin/AdminPage"), "AdminPage");

const TASK_ID = /^tsk_[a-z0-9]+$/;
const taskSearch = (s: Record<string, unknown>): { task?: string } => (typeof s.task === "string" && TASK_ID.test(s.task) ? { task: s.task } : {});

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound, errorComponent: RouteError });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects", replace: true });
  },
});

const projects = createRoute({ getParentRoute: () => root, path: "/projects", component: ProjectsPage });

/** A project: its pages are its children (the route renders them; each page has its own header). */
const project = createRoute({ getParentRoute: () => root, path: "/projects/$projectId" });

const projectIndex = createRoute({
  getParentRoute: () => project,
  path: "/",
  validateSearch: taskSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/projects/$projectId/board", params, search, replace: true });
  },
});

const board = createRoute({ getParentRoute: () => project, path: "board", validateSearch: taskSearch, component: BoardPage });

const manager = createRoute({
  getParentRoute: () => project,
  path: "manager",
  validateSearch: (s: Record<string, unknown>): { view?: "trace" } => (s.view === "trace" ? { view: "trace" } : {}),
  component: ManagerPage,
});

const reviews = createRoute({ getParentRoute: () => project, path: "reviews", component: ReviewsPage });
const settings = createRoute({ getParentRoute: () => project, path: "settings", component: SettingsPage });
/** `?add=<name>&hosts=<a,b>` opens the form prefilled: an agent's request, from "Needs you". */
const secrets = createRoute({
  getParentRoute: () => project,
  path: "secrets",
  validateSearch: (s: Record<string, unknown>): { add?: string; hosts?: string } => ({
    ...(typeof s.add === "string" ? { add: s.add.slice(0, 64) } : {}),
    ...(typeof s.hosts === "string" ? { hosts: s.hosts.slice(0, 2000) } : {}),
  }),
  component: SecretsPage,
});

const admin = createRoute({ getParentRoute: () => root, path: "/admin", component: AdminPage });

export const routeTree = root.addChildren([home, projects, project.addChildren([projectIndex, board, manager, reviews, secrets, settings]), admin]);

export function createAppRouter(o: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, ...(o.history ? { history: o.history } : {}), defaultPreload: "intent", scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
