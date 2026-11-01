import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          HOST_TOKEN_SECRET: "test-host-token-secret-0123456789abcdef",
          ASK_SYNC_WINDOW_MS: "200",
          ALLOW_DEV_CA: "1",
          // The MCP proxy's timeouts, short so lost answers are quick to provoke (test/mcp.test.ts).
          MCP_CALL_TIMEOUT_MS: "1500",
          MCP_LIST_TIMEOUT_MS: "1500",
          // https, so nest offers its client ID metadata document (test/mcp-oauth.test.ts).
          PUBLIC_BASE_URL: "https://nest.test",
          // A brokered request's budget, short so a lost answer is quick to provoke (test/brokered.test.ts).
          BROKERED_TIMEOUT_MS: "1500",
        },
      },
    }),
  ],
  server: { fs: { allow: [".."] } },
});
