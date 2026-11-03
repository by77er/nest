import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects:
// - `worker`: the Worker and its Durable Objects, in workerd with the app's bindings (wrangler.jsonc),
//   without the Vite plugin (vite.config.ts). nest is a fake: each test file swaps the global fetch the
//   Worker and its objects call (test/fake-nest.ts), and signs Nest-Identity tokens and webhooks with
//   keys it makes.
// - `ui`: the page's components (src/ui/), in jsdom with Testing Library, against a stubbed fetch.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                NEST_CONTROL_PLANE: "https://nest.test",
                PUBLIC_BASE_URL: "https://projects.test",
                ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
                PROJECTS_AUD: "aud-of-the-projects-application",
                // A client token's shape (nest_cli_<id>_<64 hex>), low in entropy (dev/review-lessons.md 9).
                NEST_CLIENT_TOKEN: `nest_cli_app_${"0".repeat(64)}`,
                NEST_WEBHOOK_SECRET: `whsec_${"1".repeat(64)}`,
                GITHUB_WEBHOOK_SECRET: `ghsec_${"2".repeat(40)}`,
              },
            },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 15_000 },
      },
      {
        plugins: [react()],
        test: { name: "ui", environment: "jsdom", include: ["src/ui/**/*.test.{ts,tsx}"], setupFiles: ["src/ui/test/setup.ts"], testTimeout: 15_000 },
      },
    ],
  },
});
