// Conditional GETs and timing for the JSON API (README.md#the-ui): the page polls, and almost every poll
// finds nothing new. Each JSON `GET` answer carries an `ETag` of its body, and a request naming it in
// `If-None-Match` is answered `304` with no body; every answer says how long the Worker took (`Server-Timing`).

/**
 * The ETag of a body: its SHA-256, the first 16 bytes in hex, quoted, and marked weak (RFC 9110 8.8.3).
 * Weak, though it changes with every byte: Cloudflare may make a strong tag weak or drop it when it
 * compresses an answer (https://developers.cloudflare.com/cache/reference/etag-headers/; for a Worker's
 * uncached answer, unverified), and `If-None-Match` is compared weakly anyway.
 */
export async function etagOf(body: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body), 0, 16);
  return `W/"${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Whether `If-None-Match` names `etag`: a list of tags, or `*`, compared weakly (RFC 9110 13.1.2). */
export function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/**
 * An API answer made conditional: a `GET`'s `200` with a JSON body gets its `ETag`, and is `304` (no body)
 * when the request already has it. Anything else (another method or status, another type, the trace's
 * WebSocket upgrade, `opaque` routes) is returned as it is.
 */
export async function conditional(req: Request, res: Response, opaque = false): Promise<Response> {
  if (opaque || req.method !== "GET" || res.status !== 200 || !res.headers.get("content-type")?.startsWith("application/json")) return res;
  const body = await res.arrayBuffer();
  const etag = await etagOf(body);
  const headers = new Headers(res.headers);
  headers.set("etag", etag);
  if (matches(req.headers.get("if-none-match"), etag)) {
    // What a 304 carries (RFC 9110 15.4.5): the validator and the caching rule, nothing about a body.
    return new Response(null, { status: 304, headers: { etag, "cache-control": headers.get("cache-control") ?? "no-store" } });
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The answer with `Server-Timing: app;dur=<ms>`, the handler's time since `start` (Date.now() advances
 * across I/O only in a Worker, so it is the wall time spent waiting on objects, nest and GitHub, not CPU).
 * A WebSocket upgrade (101) is returned as it is: its headers are the socket's.
 */
export function timed(res: Response, start: number): Response {
  if (res.status === 101) return res;
  const headers = new Headers(res.headers);
  headers.append("server-timing", `app;dur=${Date.now() - start}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
