import type { Env as NestEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends NestEnv {}
  }
}
declare module "*?raw" {
  const text: string;
  export default text;
}

export {};
