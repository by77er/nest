import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      /** The public half of the App's key made for this run (vitest.config.ts): the fake GitHub checks the JWT with it. */
      TEST_GITHUB_APP_PUBLIC_KEY: string;
    }
  }
}

export {};
