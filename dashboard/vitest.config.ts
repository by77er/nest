import { defineConfig } from "vitest/config";

// Tests run in Node without the Cloudflare plugin (vite.config.ts): the Worker is called as a plain
// function with a stub ASSETS binding and a stubbed fetch.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
