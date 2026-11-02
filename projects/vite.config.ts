import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is a Vite + React build; the Worker in src/worker.ts serves it after the Access check, and
// answers the JSON API, the MCP servers and the webhooks. `vite dev` runs both in workerd; `vite build`
// writes dist/ and the Worker config that `wrangler deploy` picks up.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
