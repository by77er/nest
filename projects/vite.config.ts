import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is a Vite + React build; the Worker in src/worker.ts serves it after the Access check, and
// answers the JSON API, the MCP servers and the webhooks. `vite dev` runs both in workerd; `vite build`
// writes dist/ and the Worker config that `wrangler deploy` picks up.
// The page's libraries are chunks of their own (Mantine, React, the rest), so a release that changes only
// the app's code leaves them cached.
export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                { name: "mantine", test: /node_modules[\\/]@mantine[\\/]/ },
                { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
                { name: "vendor", test: /node_modules[\\/]/ },
              ],
            },
          },
        },
      },
    },
  },
});
