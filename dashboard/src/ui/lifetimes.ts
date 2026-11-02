// "Left lying around": the control plane's lifetimes view (docs/control-plane/dashboard/#abandoned).
// The control plane decides what each thing is; the page sorts by age, says when the idle TTL will
// destroy a sandbox, and shows the API call an operator would make, as text. It acts on nothing.

import type { LifetimeAgent, LifetimeSandbox, SandboxLifetimeKind } from "../api";
import { span } from "./format";

/** Why a sandbox is listed, as its kind's tooltip and the attention item's reason. */
export const SANDBOX_WHY: Record<SandboxLifetimeKind, string> = {
  dormant: "no agent attached and no VM up: its idle TTL runs",
  held: "attached only to agents nobody uses: never dormant, so no TTL takes it",
  unknown: "an attached agent could not be read",
  in_use: "in use",
  destroyed: "SandboxDO says destroyed; the registry still lists it",
  unreadable: "SandboxDO did not answer",
};

/** When the idle TTL takes it, as the page says it. */
export function destroyIn(s: Pick<LifetimeSandbox, "kind" | "destroy_at_ms">, now: number): string {
  if (s.kind !== "dormant") return "never (not dormant)";
  if (s.destroy_at_ms === null) return "clock not started";
  return s.destroy_at_ms <= now ? "due now" : `in ${span(s.destroy_at_ms - now)}`;
}

/** Since when nobody has used it: its dormancy, else its agents' latest turn, else its registration. */
export function idleSince(s: LifetimeSandbox, agents: ReadonlyMap<string, LifetimeAgent>): number {
  if (s.dormant_since_ms !== null) return s.dormant_since_ms;
  const turns = s.attached.map((a) => agents.get(a)?.last_turn_ms ?? null).filter((t): t is number => t !== null);
  return turns.length ? Math.max(...turns) : s.registered_ms;
}

/** The API call an operator would make about it (text only: the page acts on nothing). */
export function operatorCall(s: LifetimeSandbox): string {
  if (s.kind === "dormant") return `PUT /v1/sandboxes/${s.sandbox}/lifetime (keep) · DELETE /v1/sandboxes/${s.sandbox} (now)`;
  if (s.kind === "held") return `end its agents: POST /v1/agents/<id>/stop {"end": true}`;
  return `GET /v1/sandboxes/${s.sandbox}`;
}

export const agentCall = (a: LifetimeAgent) =>
  a.kind === "quiet" ? `POST /v1/agents/${a.agent}/stop {"end": true${a.sandbox ? `, "destroy_sandbox": true` : ""}}` : `GET /v1/agents/${a.agent}`;

/** Oldest first; an agent that never had a turn first of all. */
export const byAge = <T,>(rows: readonly T[], at: (r: T) => number | null) =>
  [...rows].sort((a, b) => (at(a) ?? -Infinity) - (at(b) ?? -Infinity));

export const total = (counts: Record<string, number> | undefined) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
