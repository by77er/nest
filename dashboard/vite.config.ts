import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is a Vite + React build; the Worker in src/worker.ts serves it and proxies /api/* to the
// control plane's admin API with the token it holds. `vite dev` runs both in workerd; `vite build`
// writes dist/ and the Worker config that `wrangler deploy` picks up.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
