import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the real Worker and Durable Object (wrangler.jsonc), with a test token.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { MCP_TEST_TOKEN: "test-token", ALLOWED_ORIGINS: "https://allowed.example" } },
    }),
  ],
});
