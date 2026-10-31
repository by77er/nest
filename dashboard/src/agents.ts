// The agents table's detail, read by the Worker: for each agent the fleet view lists on a host
// (`HostView.agents`, the brains FleetDO indexes), `GET /v1/agents/:agent` (AgentDO `info()`),
// narrowed to what the page shows. That route is not in the admin view contract
// (protocol/admin/view.ts), so nothing checks these fields against the control plane: each is read
// as optional and shown as unknown when absent. The narrowing also keeps the rest of the record
// (prompts, rules, parameters) out of the browser.

/** The part of `GET /v1/agents/:agent` the page reads (the control plane's `AgentView`). */
export interface AgentInfoResponse {
  agent?: string;
  template?: string;
  /** AgentDO's own part of `state`. */
  lifecycle?: string;
  /** The runner's last report; null since the brain started, counts only while `ready`. */
  activity?: string | null;
  /** Derived from `lifecycle` and `activity`, for the previous release's readers. */
  state?: string;
  current_turn?: string | null;
  brain?: { host: string; phase: string; since_ms: number } | null;
  hands?: { sandbox: string } | null;
}

/** One agent as the page shows it; null where the control plane did not say. */
export interface AgentSummary {
  agent: string;
  template: string | null;
  lifecycle: string | null;
  activity: string | null;
  state: string | null;
  current_turn: string | null;
  /** Where the brain runs, its phase there, and since when (`brain.since_ms`). */
  brain: { host: string; phase: string; since_ms: number } | null;
  sandbox: string | null;
}

/** An agent the fleet lists, with its detail or why it could not be read (e.g. `404: unknown agent`). */
export interface AgentRow {
  agent: string;
  info: AgentSummary | null;
  error: string | null;
}

/** What `GET /api/agents` answers: a row per listed agent, and how many were left out past the cap. */
export interface AgentsResponse {
  agents: AgentRow[];
  omitted: number;
}

/** At most this many agents are read per request, this many at a time. */
export const MAX_AGENTS = 100;
export const AGENT_CONCURRENCY = 4;

const AGENT_ID = /^agt_[0-9a-z]+$/;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The distinct agent ids the fleet view lists on its hosts, sorted; anything not an agent id is dropped. */
export function listedAgents(fleet: { hosts?: { agents?: unknown }[] }): string[] {
  const ids = new Set<string>();
  for (const h of fleet.hosts ?? []) {
    for (const a of Array.isArray(h.agents) ? h.agents : []) if (typeof a === "string" && AGENT_ID.test(a)) ids.add(a);
  }
  return [...ids].sort();
}

/** `info()` narrowed to the page's fields. */
export function summarizeAgent(agent: string, raw: AgentInfoResponse): AgentSummary {
  const b = raw.brain;
  return {
    agent: str(raw.agent) ?? agent,
    template: str(raw.template),
    lifecycle: str(raw.lifecycle),
    activity: str(raw.activity),
    state: str(raw.state),
    current_turn: str(raw.current_turn),
    brain: b && typeof b.host === "string" && typeof b.phase === "string" && typeof b.since_ms === "number"
      ? { host: b.host, phase: b.phase, since_ms: b.since_ms } : null,
    sandbox: str(raw.hands?.sandbox),
  };
}

/** The control plane's error message in a failed response's body, else the body's start. */
export function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string | { message?: string } };
    const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (m) return m;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

/** `fn` over `items`, at most `limit` at once, results in order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}
