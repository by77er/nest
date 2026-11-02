// The socket behind a trace view: connect to the app's trace route, fold what comes into the state, keep
// it alive, and after a drop reconnect with a backoff from the last seq received, until the agent ends.

import { useEffect, useReducer } from "react";
import { initialTrace, PING_EVERY_MS, reconnectDelay, type TraceState, traceReducer, traceUrl } from "./model";

export function useTrace(agent: string | null): TraceState {
  const [state, dispatch] = useReducer(traceReducer, undefined, initialTrace);

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

  return state;
}
