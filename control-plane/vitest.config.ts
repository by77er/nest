import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Not vitest's 5 s: on a 4-vCPU CI runner the suite's first ~30 s overlap the other workers' module imports, and
    // tests that take ~0.3 s alone took 1.6-5.8 s there (agent-seams D1, D7, D9, rule 1). Above the helpers' own waits
    // (`Ws.next` 3 s, `until` 10 s), so a message that never comes fails naming what was awaited.
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          HOST_TOKEN_SECRET: "test-host-token-secret-0123456789abcdef",
          // Wide enough that an answer "within the window" never races a loaded runner; a test that needs it to
          // lapse fires its deadline (test/session.test.ts).
          ALLOW_DEV_CA: "1",
          // The MCP proxy's timeouts, short so lost answers are quick to provoke (test/mcp.test.ts).
          MCP_CALL_TIMEOUT_MS: "1500",
          MCP_LIST_TIMEOUT_MS: "1500",
          // https, so nest offers its client ID metadata document (test/mcp-oauth.test.ts).
          PUBLIC_BASE_URL: "https://nest.test",
          // A brokered request's budget, short so a lost answer is quick to provoke (test/brokered.test.ts).
          BROKERED_TIMEOUT_MS: "1500",
          // How long a call waits for a call slot on its server (test/mcp.test.ts "admission").
          MCP_ADMIT_WAIT_MS: "2000",
          // One webhook delivery's budget, short so a hanging webhook is quick to cut off (test/client-events.test.ts).
          CLIENT_WEBHOOK_TIMEOUT_MS: "2000",
        },
      },
    }),
  ],
  server: { fs: { allow: [".."] } },
});
