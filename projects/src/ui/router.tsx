// The page's routes, typed (TanStack Router, code-based). The Worker serves index.html for any path
// (wrangler.jsonc's single-page-application handling), after the Access check.
//
//   /projects                          every project
//   /projects/$projectId/board         its board; `?task=` opens a task's drawer
//   /projects/$projectId/manager       the chat with its manager (the default page); `?view=trace` its trace
//   /projects/$projectId/reviews       its review jobs
//   /projects/$projectId/routines      its routines, their runs and proposals, and its memory
//   /projects/$projectId/network       its agents' network rules
//   /projects/$projectId/settings      its settings
//   /admin                             the catalog sync
//
// `/` redirects to the list, `/projects/$projectId` to its manager, and an old `/projects/$projectId?task=…`
// to the board with the same task.
//
// Each route's loader starts the reads its page shows first (README.md#the-ui) the moment the route
// matches, or a link to it is hovered or focused (preload on intent): in parallel with the page's chunk
// and with the project, never awaited, so navigation never waits for data. The pages' hooks then find
// the same cache entries in flight or filled (`reads` in api/queries.ts).

import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, redirect, type RouterHistory } from "@tanstack/react-router";
import { type Read, reads, warm } from "./api/queries";
import { NotFound, RouteError, Shell } from "./features/shell/Shell";

// Each page is its own chunk, loaded when its route is first visited (or hovered: preload on intent).
const ProjectsPage = lazyRouteComponent(() => import("./features/projects/ProjectsPage"), "ProjectsPage");
const BoardPage = lazyRouteComponent(() => import("./features/project/BoardPage"), "BoardPage");
const ManagerPage = lazyRouteComponent(() => import("./features/manager/ManagerPage"), "ManagerPage");
const ReviewsPage = lazyRouteComponent(() => import("./features/reviews/ReviewsPage"), "ReviewsPage");
const RoutinesPage = lazyRouteComponent(() => import("./features/routines/RoutinesPage"), "RoutinesPage");
const SettingsPage = lazyRouteComponent(() => import("./features/settings/SettingsPage"), "SettingsPage");
const NetworkPage = lazyRouteComponent(() => import("./features/network/NetworkPage"), "NetworkPage");
const TriagePage = lazyRouteComponent(() => import("./features/triage/TriagePage"), "TriagePage");
const SecretsPage = lazyRouteComponent(() => import("./features/secrets/SecretsPage"), "SecretsPage");
const AdminPage = lazyRouteComponent(() => import("./features/admin/AdminPage"), "AdminPage");

const TASK_ID = /^tsk_[a-z0-9]+$/;
const taskSearch = (s: Record<string, unknown>): { task?: string } => (typeof s.task === "string" && TASK_ID.test(s.task) ? { task: s.task } : {});

/** What every loader gets: the app's query cache, the one its pages' hooks read. */
export interface RouterContext {
  queryClient: QueryClient;
}

/** The shell's sidebar lists the projects (and their counts) on every page. */
const root = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  loader: ({ context: { queryClient } }) => warm(queryClient, reads.projects()),
});

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects", replace: true });
  },
});

const projects = createRoute({ getParentRoute: () => root, path: "/projects", component: ProjectsPage });

/** A project: its pages are its children (the route renders them; each page has its own header). */
const project = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId",
  // Every view's frame shows the project; the views' own reads start beside it, not after it.
  loader: ({ context: { queryClient }, params: { projectId } }) => warm(queryClient, reads.project(projectId)),
});

/** A view's loader: warms `of(projectId)`'s reads. */
const viewReads =
  (of: (id: string) => Read[]) =>
  ({ context: { queryClient }, params: { projectId } }: { context: RouterContext; params: { projectId: string } }) => {
    for (const o of of(projectId)) warm(queryClient, o);
  };

const projectIndex = createRoute({
  getParentRoute: () => project,
  path: "/",
  validateSearch: taskSearch,
  beforeLoad: ({ params, search }) => {
    // The manager is a project's default view; an old link to a task still opens it on the board.
    if (search.task) throw redirect({ to: "/projects/$projectId/board", params, search, replace: true });
    throw redirect({ to: "/projects/$projectId/manager", params, search: {}, replace: true });
  },
});

const board = createRoute({
  getParentRoute: () => project,
  path: "board",
  validateSearch: taskSearch,
  // The drawer's task is a dependency: opening one from the board warms it too.
  loaderDeps: ({ search }) => ({ task: search.task }),
  // "Needs you" and the board (BoardPage's BoardAndAsks), and the drawer's task when the URL opens one.
  loader: ({ context: { queryClient }, params: { projectId }, deps: { task } }) => {
    warm(queryClient, reads.tasks(projectId));
    warm(queryClient, reads.attention(projectId));
    // The drawer: its task, and the reviews its PRs show their verdicts from (TaskPrs).
    if (task) {
      warm(queryClient, reads.task(projectId, task));
      warm(queryClient, reads.reviews(projectId));
    }
  },
  component: BoardPage,
});

const manager = createRoute({
  getParentRoute: () => project,
  path: "manager",
  validateSearch: (s: Record<string, unknown>): { view?: "trace" } => (s.view === "trace" ? { view: "trace" } : {}),
  // The chat, its waits and the status line (ChatView, ManagerStatusLine), and the context column (ManagerContext: its tasks, what
  // needs you; its task cards show their PRs' verdicts from the reviews, as the chat's do).
  loader: viewReads((id) => [reads.chat(id), reads.manager(id), reads.waits(id), reads.tasks(id), reads.attention(id), reads.reviews(id)]),
  component: ManagerPage,
});

const reviews = createRoute({ getParentRoute: () => project, path: "reviews", loader: viewReads((id) => [reads.reviews(id), reads.reviewers(id)]), component: ReviewsPage });
const routines = createRoute({
  getParentRoute: () => project,
  path: "routines",
  // Its four sections: the routines, their runs, the proposals and the memory.
  loader: viewReads((id) => [reads.routines(id), reads.runs(id), reads.proposals(id), reads.memory(id)]),
  component: RoutinesPage,
});
// The project (the parent's loader) is the form; its workflows setting and live workers read the secrets' answer.
const settings = createRoute({ getParentRoute: () => project, path: "settings", loader: viewReads((id) => [reads.secrets(id)]), component: SettingsPage });
const network = createRoute({ getParentRoute: () => project, path: "network", loader: viewReads((id) => [reads.network(id)]), component: NetworkPage });
// The queue, and whether proposals wait (which changes what an empty queue says).
const triage = createRoute({ getParentRoute: () => project, path: "triage", loader: viewReads((id) => [reads.issues(id), reads.proposals(id)]), component: TriagePage });
/** `?add=<name>&hosts=<a,b>` opens the form prefilled: an agent's request, from "Needs you". */
const secrets = createRoute({
  getParentRoute: () => project,
  path: "secrets",
  validateSearch: (s: Record<string, unknown>): { add?: string; hosts?: string } => ({
    ...(typeof s.add === "string" ? { add: s.add.slice(0, 64) } : {}),
    ...(typeof s.hosts === "string" ? { hosts: s.hosts.slice(0, 2000) } : {}),
  }),
  loader: viewReads((id) => [reads.secrets(id)]),
  component: SecretsPage,
});

const admin = createRoute({
  getParentRoute: () => root,
  path: "/admin",
  loader: ({ context: { queryClient } }) => {
    warm(queryClient, reads.syncState());
    warm(queryClient, reads.bindings());
  },
  component: AdminPage,
});

export const routeTree = root.addChildren([home, projects, project.addChildren([projectIndex, board, triage, manager, reviews, routines, secrets, network, settings]), admin]);

/** `queryClient`: the app's, the one `App` provides to the pages (their hooks share the loaders' cache entries). */
export function createAppRouter(o: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({ routeTree, context: { queryClient: o.queryClient }, ...(o.history ? { history: o.history } : {}), defaultPreload: "intent", scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
