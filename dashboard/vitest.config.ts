import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects, neither with the Cloudflare plugin (vite.config.ts):
// - `worker`: the Worker in Node, called as a plain function with a stub ASSETS binding and a stubbed fetch;
// - `ui`: the page (src/ui/) in jsdom with Testing Library, against a stubbed fetch serving fixtures/admin.ts.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "worker", include: ["test/*.test.ts"], environment: "node" } },
      {
        plugins: [react()],
        // The theme and status tests read their oracles as text from outside dashboard/: the skill's
        // tables (.claude/skills/nest-ui-design/) and the control plane's enums. Tests only: the build
        // reads nothing from there.
        server: { fs: { allow: [".."] } },
        test: { name: "ui", include: ["test/ui/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["test/ui/setup.ts"], testTimeout: 15_000 },
      },
    ],
  },
});
