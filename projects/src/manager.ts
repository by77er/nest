// The manager's status as the owner reads it (the Manager page's header), from the project's own record
// and nest's agent record (`GET /v1/agents/:agent`): pure, so its table is tested on its own.

/** Where the manager is: before nest has it (the repo attaching, the start owed), then nest's lifecycle. */
export type ManagerPhase = "attaching" | "attach_failed" | "starting" | "waiting_for_host" | "running" | "errored" | "ended" | "unknown";

export interface ManagerStatus {
  phase: ManagerPhase;
  agent: string | null;
  /** nest's `state` when it has one (`working`, `idle`, `waiting_input`, …): what a running manager is doing. */
  state: string | null;
  host: string | null;
  /** Why it isn't running: the attach's error, the start's, or nest's answer. */
  error: string | null;
}

/** What the status needs of the project's settings (src/do/project.ts `Settings`). */
export interface ManagerOf {
  attached: boolean;
  attach_error: string | null;
  manager: string | null;
  manager_error: string | null;
  /** A start of the manager is owed (false: none is, and none will be until the owner restarts it). */
  manager_start_owed?: boolean;
}

/** What the status reads of nest's agent record; nest sends more. */
export interface AgentRecord {
  state?: string;
  host?: string | null;
  /** How often the start has waited for brain capacity (no host had room). */
  capacity_waits?: number;
  ended?: { reason?: string | null } | null;
}

/** `record`: nest's record; `gone`: nest doesn't know the agent (404); `failed`: nest couldn't be asked. */
export type Lookup = { record: AgentRecord } | { gone: true } | { failed: string };

export function managerStatus(s: ManagerOf, lookup: Lookup | null): ManagerStatus {
  const base = { agent: s.manager, state: null, host: null };
  if (!s.attached) return { ...base, phase: s.attach_error ? "attach_failed" : "attaching", error: s.attach_error };
  // Ended and not started again by itself (README.md#the-manager-lifecycle): waits for the owner's Restart.
  if (!s.manager && s.manager_start_owed === false) return { ...base, phase: "ended", error: s.manager_error ?? "the manager ended" };
  if (!s.manager || !lookup) return { ...base, phase: "starting", error: s.manager_error };
  if ("gone" in lookup) return { ...base, phase: "ended", error: "nest no longer has this agent" };
  if ("failed" in lookup) return { ...base, phase: "unknown", error: lookup.failed };
  const r = lookup.record;
  const host = r.host ?? null;
  const state = r.state ?? null;
  if (r.ended || state === "ended") return { ...base, phase: "ended", state, host, error: r.ended?.reason ?? null };
  if (state === "starting" || state === "detached") {
    const waiting = !host && (r.capacity_waits ?? 0) > 0;
    return { ...base, phase: waiting ? "waiting_for_host" : "starting", state, host, error: null };
  }
  if (state === "errored") return { ...base, phase: "errored", state, host, error: null };
  if (state === null) return { ...base, phase: "unknown", state, host, error: null };
  return { ...base, phase: "running", state, host, error: null };
}

// --- the manager's lifecycle (README.md#the-manager-lifecycle) ------------------------------------------

/** Automatic restarts of a manager that ended, at most this many in a window; past it, the owner restarts it. */
export const MANAGER_RESTARTS = 3;
export const MANAGER_RESTART_WINDOW_MS = 3_600_000;

/**
 * The manager's lifecycle as ProjectDO keeps it: its agent (null while one is owed, or ended for good),
 * when a start is due (null: none owed), the recent automatic restarts, and why it isn't running.
 */
export interface ManagerLife {
  manager: string | null;
  next_ms: number | null;
  restarts: number[];
  error: string | null;
}

/**
 * - `ended`: the manager `agent` ended (nest's `agent.exited`, nest no longer having it, or its brief
 *   refused for good). One that isn't the current manager changes nothing.
 * - `restart`: the owner's Restart: the current one (if any) goes, a new one starts now.
 * - `converge`: the manager `agent` runs on nest's repos (README.md#converging-onto-the-apps-own-access): it goes,
 *   and one on the app's own access starts now. Not one of the automatic restarts it counts. One that isn't the
 *   current manager changes nothing.
 */
export type ManagerEvent = { kind: "ended"; agent: string; reason: string } | { kind: "restart" } | { kind: "converge"; agent: string };

/** Where `event` takes the manager's lifecycle at `now`, and the agent to stop (its sandbox destroyed), if any. */
export function managerStep(l: ManagerLife, e: ManagerEvent, now: number, backoff: (n: number) => number): { life: ManagerLife; stop: string | null; changed: boolean } {
  if (e.kind === "ended") {
    if (l.manager !== e.agent) return { life: l, stop: null, changed: false };
    const recent = l.restarts.filter((t) => t > now - MANAGER_RESTART_WINDOW_MS);
    if (recent.length < MANAGER_RESTARTS) {
      return {
        life: { manager: null, next_ms: now + backoff(recent.length + 1), restarts: [...recent, now], error: `The manager ended (${e.reason}): a new one is starting.` },
        stop: e.agent, changed: true,
      };
    }
    return {
      life: { manager: null, next_ms: null, restarts: recent, error: `The manager ended (${e.reason}), ${recent.length + 1} times within an hour: restart it when you're ready.` },
      stop: e.agent, changed: true,
    };
  }
  if (e.kind === "converge") {
    if (l.manager !== e.agent) return { life: l, stop: null, changed: false };
    return { life: { manager: null, next_ms: now, restarts: l.restarts, error: null }, stop: e.agent, changed: true };
  }
  // A restart while one is already starting changes nothing: asking twice starts one.
  if (l.manager === null && l.next_ms !== null && l.error === null) return { life: l, stop: null, changed: false };
  return { life: { manager: null, next_ms: now, restarts: [], error: null }, stop: l.manager, changed: true };
}
