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
        },
      },
    }),
  ],
  server: { fs: { allow: [".."] } },
});
