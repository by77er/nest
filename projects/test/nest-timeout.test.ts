// A call to nest that never answers is abandoned (src/nest.ts `CALL_TIMEOUT_MS`): an error the caller
// handles as nest not answering, never a request that holds a read (or the Durable Object) for ever.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_TIMEOUT_MS, Nest } from "../src/nest";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** A nest that takes every request and answers none, until the request is aborted. */
function silent(seen: { signal: AbortSignal | null }[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    seen.push({ signal: signal ?? null });
    return new Promise<Response>((_, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  }) as typeof fetch;
}

describe("nest calls time out", () => {
  it("a call nest never answers fails after the timeout", async () => {
    const seen: { signal: AbortSignal | null }[] = [];
    globalThis.fetch = silent(seen);
    const nest = new Nest({ base: "https://nest.test", token: "t", cell: "use1", timeoutMs: 50 });
    const started = Date.now();
    await expect(nest.openAsks({ project: "prj_x" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).not.toBeNull();
  });

  it("by default (no `timeoutMs`), after CALL_TIMEOUT_MS: 15 s", async () => {
    expect(CALL_TIMEOUT_MS).toBe(15_000);
    const seen: { signal: AbortSignal | null }[] = [];
    globalThis.fetch = silent(seen);
    // The default's own signal, made to fire now: the call must fail on it, so it's the one the request carries.
    const asked: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      return AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    });
    try {
      const nest = new Nest({ base: "https://nest.test", token: "t", cell: "use1" });
      await expect(nest.openAsks({ project: "prj_x" })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(asked).toEqual([CALL_TIMEOUT_MS]);
    expect(seen[0]!.signal?.aborted).toBe(true);
  });
});
