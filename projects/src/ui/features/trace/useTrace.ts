// The socket behind a trace view: connect to the app's trace route, fold what comes into the state, keep
// it alive, and after a drop reconnect with a backoff from the last seq received, until the agent ends.
// And the history before the ring, a page each time the view asks (`loadOlder`): a trace view asks for the
// first as soon as nest offers it (a `history` or `gap` cursor), and each older one as its reader scrolls to
// the top. The chat, which reads only the turn in progress, asks for none.
//
// Messages are applied in batches, at most one per animation frame: a backlog of a thousand events is a
// handful of state changes, not a thousand. The batch is applied at once on `live` (the backlog is done),
// `ended`, a close and an unmount, so nothing is lost or reordered. Once live, a message that comes while
// nothing is waiting is applied at once if React has committed the last batch: live events are applied per
// commit, and batched per frame only when they come faster than React commits (a message from a later task
// before that commit waits for the next frame). Messages delivered in the task that applied the last batch
// go with it too: a browser delivers each socket message in a task of its own, so this is for a caller (a
// test) that delivers several synchronously (README.md#the-live-trace).

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { type HistoryPage, historyUrl, initialTrace, PING_EVERY_MS, reconnectDelay, type TraceState, traceReducer, traceUrl } from "./model";

/** Where frames don't come (a hidden tab), a batch waits at most this long. */
const FRAME_FALLBACK_MS = 100;

/** Run `cb` on the next animation frame (or after FRAME_FALLBACK_MS, whichever is first); returns its cancel. */
function nextFrame(cb: () => void): () => void {
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
  const run = () => {
    cancel();
    cb();
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(run);
  timer = setTimeout(run, FRAME_FALLBACK_MS);
  return cancel;
}

export function useTrace(agent: string | null): { state: TraceState; loadOlder: () => void } {
  const [state, dispatch] = useReducer(traceReducer, undefined, initialTrace);
  const current = useRef(state);
  current.current = state;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  // React has committed the last batch applied: a live message may then be applied at once. (A batch that
  // changes nothing commits nothing: the next live message then waits one frame.)
  const committed = useRef(true);
  useLayoutEffect(() => {
    committed.current = true;
  }, [state]);

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
    // Messages not applied yet, in order; the frame that will apply them; past this connection's backlog.
    let queue: unknown[] = [];
    let frame: (() => void) | null = null;
    let live = false;
    // A batch was applied in this task (until its microtasks run).
    let appliedThisTask = false;

    const flush = () => {
      frame?.();
      frame = null;
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      committed.current = false;
      if (!appliedThisTask) {
        appliedThisTask = true;
        queueMicrotask(() => {
          appliedThisTask = false;
        });
      }
      dispatch(batch.length === 1 ? { kind: "message", data: batch[0] } : { kind: "messages", data: batch });
    };

    const connect = () => {
      if (stopped) return;
      live = false;
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
        queue.push(data);
        if (data.type === "live") {
          // The backlog is done: a good connect, so the next drop's backoff starts over.
          failures = 0;
          live = true;
          flush();
        } else if (data.type === "ended" || (live && queue.length === 1 && (committed.current || appliedThisTask))) {
          // The end; or live, nothing else waiting, and the last batch committed (or applied in this task): at once.
          flush();
        } else if (!frame) {
          frame = nextFrame(() => {
            frame = null;
            flush();
          });
        }
      });
      sock.addEventListener("close", () => {
        clearInterval(ping);
        if (ws !== sock || stopped) return;
        flush();
        dispatch({ kind: "closed" });
        if (ended) return; // nothing more will come
        failures += 1;
        retry = setTimeout(connect, reconnectDelay(failures));
      });
    };
    connect();
    return () => {
      stopped = true;
      flush();
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close(1000, "closed by the page");
    };
  }, [agent]);

  return { state, loadOlder };
}
