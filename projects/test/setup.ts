// The deployed Worker: `vite build` sets import.meta.env.DEV to false, which turns the Access check on
// (src/worker.ts). Vitest's default is true, which would skip it in every test.
import { vi } from "vitest";

vi.stubEnv("DEV", false);
