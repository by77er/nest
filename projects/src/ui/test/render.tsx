// Render the whole page at a URL, over a FakeApi, the way main.tsx does (but with Mantine's test env:
// no transitions or portals, and no retries, so an error shows at once).

import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";
import { createQueryClient } from "../api/queryClient";
import { createAppRouter } from "../router";
import { FakeApi } from "./fakeApi";

export function renderApp(path: string, api = new FakeApi()) {
  vi.stubGlobal("fetch", api.fetch);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  const user = userEvent.setup();
  const view = render(<App router={router} queryClient={queryClient} env="test" />);
  return { ...view, api, user, router, queryClient };
}
