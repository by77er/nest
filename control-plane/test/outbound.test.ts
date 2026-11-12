// lib/outbound.ts: the generic record of a request the control plane sends for an agent's tool.
import { describe, expect, it } from "vitest";
import { type Metered, meteredFetch, OUTBOUND_PATH_MAX, whereOf } from "../src/lib/outbound";

/** A clock that moves 5 ms each read. */
const ticking = () => {
  let t = 1000;
  return () => (t += 5);
};
const utf8 = (s: string) => new TextEncoder().encode(s).length;

describe("meteredFetch", () => {
  it("records where, the outcome and the sizes once the body ends; never the query, a header or a body", async () => {
    const got: Metered[] = [];
    const answer = "é".repeat(100);
    const f = meteredFetch((m) => got.push(m), (async () => new Response(answer, { status: 201 })) as typeof fetch, ticking());
    const body = JSON.stringify({ note: "body-text-never-recorded" });
    const res = await f("https://api.example.com/v1/items?q=query-value-never-recorded#frag", {
      method: "post", body, headers: { authorization: "Bearer header-value-never-recorded" },
    });
    expect(got).toEqual([]); // not before the body ends
    expect(await res.text()).toBe(answer);
    expect(res.status).toBe(201);
    expect(got).toEqual([{ method: "POST", host: "api.example.com", path: "/v1/items", status: 201, bytes_up: utf8(body), bytes_down: utf8(answer), duration_ms: 5 }]);
    expect(JSON.stringify(got)).not.toMatch(/never-recorded|frag/);
  });

  it("records once for a cancelled body, with what was read", async () => {
    const got: Metered[] = [];
    const chunks = [new Uint8Array(10), new Uint8Array(20), new Uint8Array(30)];
    const upstream = (async () => new Response(new ReadableStream({ pull(c) { const x = chunks.shift(); if (x) c.enqueue(x); else c.close(); } }))) as typeof fetch;
    const res = await meteredFetch((m) => got.push(m), upstream)("https://h.example/a");
    const reader = res.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(10);
    await reader.cancel();
    await reader.cancel();
    expect(got).toMatchObject([{ method: "GET", host: "h.example", path: "/a", status: 200, bytes_up: 0, bytes_down: 10 }]);
  });

  it("records a request with no response: aborted (the caller's timeout) or network, and the error still reaches the caller", async () => {
    const got: Metered[] = [];
    const failing = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    await expect(meteredFetch((m) => got.push(m), failing)("https://h.example/x", { method: "PUT", body: "abc" })).rejects.toThrow("connection refused");
    const ctl = new AbortController();
    ctl.abort();
    await expect(meteredFetch((m) => got.push(m), failing)("https://h.example/y", { signal: ctl.signal })).rejects.toThrow();
    expect(got).toMatchObject([{ method: "PUT", path: "/x", error: "network", bytes_up: 3, bytes_down: 0 }, { method: "GET", path: "/y", error: "aborted" }]);
    expect(got[0]!.status).toBeUndefined();
  });

  it("a body that breaks off is recorded with its status and what came; a bodiless answer at once", async () => {
    const got: Metered[] = [];
    let first = true;
    const breaking = (async () => new Response(new ReadableStream({
      pull(c) {
        if (first) {
          first = false;
          c.enqueue(new Uint8Array(7));
        } else c.error(new Error("reset"));
      },
    }), { status: 200 })) as typeof fetch;
    await expect((await meteredFetch((m) => got.push(m), breaking)("https://h.example/b")).text()).rejects.toThrow();
    const empty = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const res = await meteredFetch((m) => got.push(m), empty)("https://h.example/c", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(got).toMatchObject([{ path: "/b", status: 200, error: "network", bytes_down: 7 }, { method: "DELETE", path: "/c", status: 204, bytes_down: 0 }]);
  });

  it("a recorder that throws doesn't fail the request", async () => {
    const res = await meteredFetch(() => {
      throw new Error("ring full");
    }, (async () => new Response("ok")) as typeof fetch)("https://h.example/");
    expect(await res.text()).toBe("ok");
  });
});

describe("whereOf", () => {
  it("is the host and path, bounded, with nest's own credentials redacted; nothing for a URL that doesn't parse", () => {
    expect(whereOf("https://user:pw@API.example.com:8443/a/b?c=d")).toEqual({ host: "api.example.com:8443", path: "/a/b" });
    expect(utf8(whereOf(`https://h.example/${"p".repeat(5000)}`).path)).toBeLessThanOrEqual(OUTBOUND_PATH_MAX);
    const nestToken = ["nest", "cli", "a".repeat(40)].join("_");
    expect(whereOf(`https://h.example/t/${nestToken}`).path).toBe("/t/[redacted]");
    expect(whereOf("not a url")).toEqual({ host: "", path: "" });
  });
});
