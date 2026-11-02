// What is left lying around (docs/control-plane/dashboard/#abandoned), as pure classifications:
// FleetDO's `lifetimes` reads the registry's sandboxes and the agents they lead to, and these decide
// what each one is. For the operator's view only: nothing acts on them.
import type { AgentLifetimeKind, SandboxLifetimeKind } from "../../../protocol/admin/view";
import type { SandboxState } from "../protocol/model";
import { destroyAtMs, dormant } from "./lifetimes";

/** An agent with no turn for this long, and nothing running or wanted, is `quiet` (the default `quiet_ms`). */
export const DEFAULT_QUIET_MS = 86_400_000;
/** An end whose steps haven't finished this long after it is `ending` (stuck): its retries run every minute. */
export const ENDING_STUCK_MS = 3_600_000;

/** What AgentDO's `lifetimeFacts` answers. */
export interface AgentFacts {
  agent: string;
  template: string | null;
  owner: string | null;
  sandbox: string | null;
  brain: boolean;
  /** A start is wanted (`intent`). */
  starting: boolean;
  current_turn: boolean;
  queued: number;
  last_turn_ms: number | null;
  stopped_by_operator: boolean;
  live_children: string[];
  subscriptions: number;
  ended: { ms: number; reason: string; done_ms: number | null } | null;
}

/** An agent as read: its facts, or gone (`unknown_agent`: its records pruned), or an error. */
export type AgentRead = { facts: AgentFacts } | { gone: true } | { error: string };

export function classifyAgent(r: AgentRead, now: number, quietMs: number): AgentLifetimeKind {
  if ("gone" in r) return "gone";
  if ("error" in r) return "unreadable";
  const f = r.facts;
  if (f.ended) return f.ended.done_ms === null && now - f.ended.ms > ENDING_STUCK_MS ? "ending" : "ended";
  if (f.brain || f.starting || f.current_turn || f.queued > 0) return "active";
  return f.last_turn_ms !== null && now - f.last_turn_ms < quietMs ? "recent" : "quiet";
}

/** Agent kinds that hold no claim on a sandbox: nobody will use it through them. */
const NOT_HOLDING: readonly AgentLifetimeKind[] = ["quiet", "ending", "ended", "gone"];

/** The part of SandboxDO's info the classification reads. */
export interface SandboxFacts {
  state: SandboxState;
  host: string | null;
  placing: number | null;
  attached: readonly string[];
  idle_ttl_ms?: number;
  dormant_since_ms?: number;
  expiry_notice_ms?: number;
  expiry_checked_ms?: number;
}

export interface SandboxClass {
  kind: SandboxLifetimeKind;
  /** The TTL that applies, and when it would destroy the sandbox (dormant only; null: its clock hasn't started). */
  ttl: number;
  destroy_at: number | null;
}

/**
 * A sandbox by its own record and its attached agents' kinds (`agentKind`; undefined: not read, over
 * the cap). Dormant is SandboxDO's own rule. One attached only to agents that will never use it is
 * `held`: never dormant, so its TTL never runs.
 */
export function classifySandbox(s: SandboxFacts, agentKind: (agent: string) => AgentLifetimeKind | undefined, now: number, cellTtl: number): SandboxClass {
  const ttl = s.idle_ttl_ms ?? cellTtl;
  if (s.state === "destroyed") return { kind: "destroyed", ttl, destroy_at: null };
  if (dormant(s)) {
    const destroy_at = destroyAtMs({
      ttl, now, ...(s.dormant_since_ms !== undefined ? { since: s.dormant_since_ms } : {}),
      ...(s.expiry_notice_ms !== undefined ? { noticed: s.expiry_notice_ms } : {}),
      ...(s.expiry_checked_ms !== undefined ? { checked: s.expiry_checked_ms } : {}),
    });
    return { kind: "dormant", ttl, destroy_at };
  }
  if (s.attached.length === 0) return { kind: "in_use", ttl, destroy_at: null };
  const kinds = s.attached.map(agentKind);
  if (kinds.some((k) => k === "active" || k === "recent")) return { kind: "in_use", ttl, destroy_at: null };
  if (kinds.every((k) => k !== undefined && NOT_HOLDING.includes(k))) return { kind: "held", ttl, destroy_at: null };
  return { kind: "unknown", ttl, destroy_at: null };
}

/**
 * The view's page cursor: the sandbox registry's pages first (after this row: `registered_ms`, then
 * `sandbox`), then the agent registry's (`a`: its start; `a.<ms>.<agent>`: after that row).
 */
export type LifetimesCursor =
  | { phase: "sandboxes"; registered_ms: number; sandbox: string }
  | { phase: "agents"; registered_ms: number; agent: string };

export const cursorOf = (r: { registered_ms: number; sandbox: string }) => `${r.registered_ms}.${r.sandbox}`;
export const AGENTS_CURSOR = "a";
export const agentCursorOf = (r: { registered_ms: number; agent: string }) => `a.${r.registered_ms}.${r.agent}`;

export function parseCursor(c: string): LifetimesCursor | null {
  if (c === AGENTS_CURSOR) return { phase: "agents", registered_ms: -1, agent: "" };
  const s = /^(\d{1,16})\.(sbx_[A-Za-z0-9]+)$/.exec(c);
  if (s) return { phase: "sandboxes", registered_ms: Number(s[1]), sandbox: s[2]! };
  const a = /^a\.(\d{1,16})\.(agt_[A-Za-z0-9]+)$/.exec(c);
  return a ? { phase: "agents", registered_ms: Number(a[1]), agent: a[2]! } : null;
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
