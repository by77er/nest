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
