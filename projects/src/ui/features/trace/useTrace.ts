// The socket behind a trace view: connect to the app's trace route, fold what comes into the state, keep
// it alive, and after a drop reconnect with a backoff from the last seq received, until the agent ends.
// And the history before the ring: its first page as soon as nest offers it (a `history` or `gap` cursor),
// each older one when the view asks (`loadOlder`, as its reader scrolls to the top).

import { useCallback, useEffect, useReducer, useRef } from "react";
import { type HistoryPage, historyUrl, initialTrace, PING_EVERY_MS, reconnectDelay, type TraceState, traceReducer, traceUrl } from "./model";

export function useTrace(agent: string | null): { state: TraceState; loadOlder: () => void } {
  const [state, dispatch] = useReducer(traceReducer, undefined, initialTrace);
  const current = useRef(state);
  current.current = state;
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const loadOlder = useCallback(() => {
    const s = current.current;
    const a = agentRef.current;
    if (!a || typeof s.olderCursor !== "string" || s.olderState === "loading") return;
    const cursor = s.olderCursor;
    dispatch({ kind: "older_loading" });
    current.current = { ...s, olderState: "loading" };
    void (async () => {
      try {
        const res = await fetch(historyUrl(a, cursor), { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const page = (await res.json()) as HistoryPage;
        // The page is for the cursor asked with: one from before a reset (a gap since) is dropped.
        if (agentRef.current !== a || current.current.olderCursor !== cursor) return;
        dispatch({ kind: "older_loaded", page });
      } catch {
        if (agentRef.current === a) dispatch({ kind: "older_failed" });
      }
    })();
  }, []);

  // The first page as soon as there's a cursor and nothing older is shown yet (on open, and after a gap).
  useEffect(() => {
    if (typeof state.olderCursor === "string" && state.older.length === 0 && state.olderState === "idle") loadOlder();
  }, [state.olderCursor, state.older.length, state.olderState, loadOlder]);

  useEffect(() => {
    dispatch({ kind: "reset" });
    if (!agent) return;
    // The connection's own record of what came, so a reconnect never waits on a render.
    let last = 0;
    let ended = false;
    let stopped = false;
    let failures = 0;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(traceUrl(agent, last, window.location.href));
      ws = sock;
      sock.addEventListener("open", () => {
        dispatch({ kind: "open" });
        ping = setInterval(() => {
          try {
            sock.send("ping");
          } catch {
            // closing: its close handler reconnects
          }
        }, PING_EVERY_MS);
      });
      sock.addEventListener("message", (e) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        let data: { type?: unknown; seq?: unknown };
        try {
          data = JSON.parse(e.data) as typeof data;
        } catch {
          return;
        }
        if (typeof data.seq === "number" && data.seq > last) last = data.seq;
        if (data.type === "ended") ended = true;
        // The backlog is done: a good connect, so the next drop's backoff starts over.
        if (data.type === "live") failures = 0;
        dispatch({ kind: "message", data });
      });
      sock.addEventListener("close", () => {
        clearInterval(ping);
        if (ws !== sock || stopped) return;
        dispatch({ kind: "closed" });
        if (ended) return; // nothing more will come
        failures += 1;
        retry = setTimeout(connect, reconnectDelay(failures));
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close(1000, "closed by the page");
    };
  }, [agent]);

  return { state, loadOlder };
}
