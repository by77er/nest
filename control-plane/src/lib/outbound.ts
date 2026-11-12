// Records of the requests the control plane sends on an agent's behalf (docs/control-plane/api/#live-trace):
// what was called, where, the outcome, the size and the duration. Generic: nothing here knows a service,
// and nothing records a query, a header or a body. AgentDO puts each record on the agent's live trace.
// A sandbox's own egress is recorded by nest-proxy's audit, not here.
import { redactText } from "./trace";
import { clip } from "./util";

/** Which of the agent's tools sent it: a brokered action, or a remote MCP tool. */
export type OutboundVia = "brokered" | "mcp";

/** One request that left, as the trace shows it. */
export interface OutboundRecord {
  type: "outbound";
  via: OutboundVia;
  /** What was called: the brokered action, or the MCP capability and its tool (`<capability>.<tool>`). */
  name: string;
  method: string;
  host: string;
  /** The URL's path: never its query or fragment. */
  path: string;
  /** The HTTP status; absent when no response came (`error`). */
  status?: number;
  /** No response, or the body broke off: `aborted` (the caller's timeout) or `network`. */
  error?: "aborted" | "network";
  /** The request body's bytes. */
  bytes_up: number;
  /** The response body's bytes, as far as the caller read it. */
  bytes_down: number;
  /** From the request leaving to its response body ending (or the failure). */
  duration_ms: number;
}

/** The bound on a record's host and path (UTF-8 bytes), as nest-proxy's audit bounds them. */
export const OUTBOUND_HOST_MAX = 256;
export const OUTBOUND_PATH_MAX = 1024;

/** The parts of a record the fetch knows; the caller adds `via` and `name`. */
export type Metered = Omit<OutboundRecord, "type" | "via" | "name">;

/** Statuses whose response has no body (a `Response` with one can't be built). */
const NULL_BODY = new Set([101, 204, 205, 304]);

function bodyBytes(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  // A stream or form: not sent by any caller today; its size isn't known up front.
  return 0;
}

/** Where a request went, without its query: host and path, bounded. */
export function whereOf(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: clip(u.host, OUTBOUND_HOST_MAX), path: clip(redactText(u.pathname), OUTBOUND_PATH_MAX) };
  } catch {
    return { host: "", path: "" };
  }
}

/**
 * `fetchFn` that reports each request once (`emit`): when its response body ends, is cancelled or breaks
 * off, or when no response comes. Every caller here reads or cancels the body, so each request is
 * reported; a body dropped unread would not be. The response is otherwise the one `fetchFn` gave.
 */
export function meteredFetch(emit: (m: Metered) => void, fetchFn: typeof fetch = fetch, now: () => number = Date.now): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const base = { method: clip(method, 16), ...whereOf(url), bytes_up: bodyBytes(init?.body) };
    const started = now();
    let reported = false;
    const report = (m: { status?: number; error?: Metered["error"]; bytes_down: number }) => {
      if (reported) return;
      reported = true;
      try {
        emit({ ...base, ...m, duration_ms: Math.max(0, now() - started) });
      } catch (e) {
        console.warn("outbound: recording a request failed", e);
      }
    };
    const failure = (): Metered["error"] => (init?.signal?.aborted ? "aborted" : "network");
    let res: Response;
    try {
      // Called as a plain function: the platform's fetch as a method of another object throws in workerd.
      res = await fetchFn(input, init);
    } catch (e) {
      report({ error: failure(), bytes_down: 0 });
      throw e;
    }
    const status = res.status;
    if (!res.body || NULL_BODY.has(status)) {
      report({ status, bytes_down: 0 });
      return res;
    }
    const reader = res.body.getReader();
    let down = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (e) {
          report({ status, error: failure(), bytes_down: down });
          throw e;
        }
        if (r.done) {
          report({ status, bytes_down: down });
          c.close();
          return;
        }
        down += r.value.byteLength;
        c.enqueue(r.value);
      },
      cancel(reason) {
        report({ status, bytes_down: down });
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
