// What the page reads out of the fleet view, the agents' detail and the lifetimes view: what is live,
// and what needs the owner's attention. Pure, so the sections and their tests share one reading.

import type { AgentRow, AgentsResponse, Fleet, Host, LifetimesResponse, SandboxRow } from "../api";
import { age, short, span } from "./format";
import { destroyIn, idleSince, SANDBOX_WHY } from "./lifetimes";
import { AGENT_LIFETIME_ROLE, AGENT_STATE_ROLE, LIFECYCLE_ROLE, PHASE_ROLE, roleOf, SANDBOX_LIFETIME_ROLE, SANDBOX_STATE_ROLE } from "./status";

/** A host is live when it is active and connected; everything else is history. */
export const isLive = (h: Host) => h.status === "active" && h.connected;

/**
 * Not live but not history either: active yet disconnected, or its leases expired awaiting STONITH.
 * (Draining takes no placements on purpose; expired holds nothing; dead is gone.)
 */
export const isUnhealthy = (h: Host) => (h.status === "active" && !h.connected) || h.status === "stonith_pending";

export interface LiveAgent {
  agent: string;
  /** The first live host that indexes its brain (one being replaced may be on two). */
  host: string;
  /** Its detail, read by the Worker; absent until read. */
  row: AgentRow | undefined;
}

export interface Live {
  hosts: Host[];
  agents: LiveAgent[];
  /** Sandboxes on a host; one parked in S3 is counted, not listed. */
  sandboxes: SandboxRow[];
  /** Off any host: suspended or archived in S3, waiting for a host, or another state (failed, fenced, unreadable). */
  parked: number;
  waiting: number;
  other: number;
}

export function live(fleet: Fleet | undefined, info: AgentsResponse | undefined): Live {
  const hosts = (fleet?.hosts ?? []).filter(isLive);
  const on = new Map<string, string>();
  for (const h of hosts) for (const a of h.agents) if (!on.has(a)) on.set(a, h.host);
  const rows = new Map((info?.agents ?? []).map((r) => [r.agent, r]));
  const agents = [...on].sort(([a], [b]) => a.localeCompare(b)).map(([agent, host]) => ({ agent, host, row: rows.get(agent) }));
  const all = fleet?.sandboxes ?? [];
  const unplaced = all.filter((s) => !s.host);
  const parked = unplaced.filter((s) => s.sandbox_state === "suspended" || s.sandbox_state === "archived").length;
  const waiting = unplaced.filter((s) => s.sandbox_state === "creating" || s.sandbox_state === "restoring").length;
  return { hosts, agents, sandboxes: all.filter((s) => s.host), parked, waiting, other: unplaced.length - parked - waiting };
}

/** A row's id in the page, for an attention item to take the reader to it. */
export const rowId = (table: "agent" | "sandbox" | "host" | "lifetime", id: string) => `${table}-${id}`;

export interface AttentionItem {
  key: string;
  role: "danger" | "warning";
  /** What it is: an agent, a sandbox, a host, the cell's launches of an instance type, or a read of the control plane. */
  noun: "Agent" | "Sandbox" | "Host" | "Launches" | "Read";
  /** Its status, as its badge says it. */
  label: string;
  subject: string | null;
  /** The subject is a name to show whole (an instance type), not an id to shorten. */
  subjectWhole?: boolean;
  reason: string;
  /** The row it is detailed in, if the page lists it. */
  target: string | null;
}

export interface AttentionInput {
  fleet: Fleet | undefined;
  agents: AgentsResponse | undefined;
  agentsError: string | null;
  lifetimes: LifetimesResponse | undefined;
  lifetimesError: string | null;
  now: number;
}

const flagged = (r: string) => r === "danger" || r === "warning";

/**
 * Everything wrong or stuck the page can see, errors first: reads that failed, unhealthy hosts, agents
 * errored, waiting or condemned, failed sandboxes, and what the lifetimes view lists as left lying
 * around (oldest first, as its tables sort).
 */
export function attention({ fleet, agents, agentsError, lifetimes, lifetimesError, now }: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const add = (i: Omit<AttentionItem, "key">) => out.push({ ...i, key: `${i.noun}:${i.subject ?? i.reason}:${i.label}` });
  const l = live(fleet, agents);

  if (agentsError) add({ role: "danger", noun: "Read", label: "not checked", subject: null, reason: `The agents' detail could not be read: ${agentsError}`, target: null });
  if (lifetimesError) add({ role: "danger", noun: "Read", label: "not checked", subject: null, reason: `What is left lying around could not be read: ${lifetimesError}`, target: null });

  for (const h of fleet?.hosts ?? []) {
    if (isUnhealthy(h)) {
      add({
        role: h.status === "stonith_pending" ? "danger" : "warning", noun: "Host", label: h.status === "stonith_pending" ? "stonith pending" : "disconnected", subject: h.host,
        reason: h.status === "stonith_pending" ? "Its leases expired; awaiting STONITH" : `Active but not connected; last heard ${h.last_rx ? `${age(h.last_rx, now)} ago` : "never"}`,
        target: null,
      });
    }
  }
  // An instance type whose launches kept never enrolling isn't launched until its cool-down ends.
  for (const b of fleet?.enroll_breakers ?? []) {
    if (!b.open) continue;
    add({
      role: "warning", noun: "Launches", label: "paused", subject: b.type, subjectWhole: true,
      reason: `${b.failures} ${b.role} host launches in a row never enrolled; next try ${b.open_until_ms !== null ? `in ${span(Math.max(0, b.open_until_ms - now))}` : "at the next demand"}`,
      target: null,
    });
  }
  for (const h of l.hosts) {
    if (h.wedged_ms !== null) add({ role: "danger", noun: "Host", label: "wedged", subject: h.host, reason: `A brain did not exit after a kill, ${age(h.wedged_ms, now)} ago`, target: rowId("host", h.host) });
    if (h.tunnel_hostname && h.tunnel_state !== "connected") {
      add({ role: "warning", noun: "Host", label: `tunnel ${h.tunnel_state}`, subject: h.host, reason: "Its gateway is not reachable through its tunnel", target: rowId("host", h.host) });
    }
  }

  for (const { agent, row } of l.agents) {
    const target = rowId("agent", agent);
    if (row?.error) {
      add({ role: "danger", noun: "Agent", label: "unreadable", subject: agent, reason: row.error, target });
      continue;
    }
    const i = row?.info;
    if (!i) continue;
    const facts = [i.state && `state ${i.state}`, i.lifecycle && `lifecycle ${i.lifecycle}`, i.activity && `activity ${i.activity}`].filter(Boolean).join(", ");
    const stateRole = roleOf(AGENT_STATE_ROLE, i.state);
    if (i.state && stateRole && flagged(stateRole)) add({ role: stateRole as AttentionItem["role"], noun: "Agent", label: i.state, subject: agent, reason: facts, target });
    else if (i.lifecycle && roleOf(LIFECYCLE_ROLE, i.lifecycle) === "danger") add({ role: "danger", noun: "Agent", label: i.lifecycle, subject: agent, reason: facts, target });
    if (i.brain && roleOf(PHASE_ROLE, i.brain.phase) === "danger") {
      add({ role: "danger", noun: "Agent", label: `brain ${i.brain.phase}`, subject: agent, reason: `None of its brain's sessions is current, since ${age(i.brain.since_ms, now)} ago`, target });
    }
  }

  for (const s of l.sandboxes) {
    if (s.lease_state && SANDBOX_STATE_ROLE[s.lease_state] === "danger") {
      add({ role: "danger", noun: "Sandbox", label: s.lease_state, subject: s.sandbox, reason: `Its lease on ${short(s.host)} reports ${s.lease_state}`, target: rowId("sandbox", s.sandbox) });
    }
  }
  for (const s of fleet?.sandboxes ?? []) {
    if (s.host) continue;
    if (s.info_error) add({ role: "danger", noun: "Sandbox", label: "unreadable", subject: s.sandbox, reason: "Off any host, and SandboxDO did not answer", target: null });
    else if (s.sandbox_state && SANDBOX_STATE_ROLE[s.sandbox_state] === "danger") {
      add({ role: "danger", noun: "Sandbox", label: s.sandbox_state, subject: s.sandbox, reason: `Off any host, ${s.sandbox_state}`, target: null });
    }
  }

  if (lifetimes) {
    const byAgent = new Map(lifetimes.agents.map((a) => [a.agent, a]));
    const sandboxes = [...lifetimes.sandboxes].sort((a, b) => idleSince(a, byAgent) - idleSince(b, byAgent));
    for (const s of sandboxes) {
      const role = SANDBOX_LIFETIME_ROLE[s.kind];
      if (!flagged(role)) continue;
      const unused = `unused for ${span(now - idleSince(s, byAgent))}`;
      const reason = s.kind === "dormant" ? `Dormant, ${unused}: the idle TTL destroys it ${destroyIn(s, now)}`
        : s.kind === "held" ? `Held by ${s.attached.length === 1 ? "an agent" : `${s.attached.length} agents`} nobody uses, ${unused}: no TTL takes it`
        : s.error ?? SANDBOX_WHY[s.kind];
      add({ role: role as AttentionItem["role"], noun: "Sandbox", label: s.kind, subject: s.sandbox, reason, target: rowId("lifetime", s.sandbox) });
    }
    const agentRows = [...lifetimes.agents].sort((a, b) => (a.last_turn_ms ?? -Infinity) - (b.last_turn_ms ?? -Infinity));
    for (const a of agentRows) {
      const role = AGENT_LIFETIME_ROLE[a.kind];
      if (!flagged(role)) continue;
      const turn = a.last_turn_ms === null ? "never had a turn" : `no turn for ${span(now - a.last_turn_ms)}`;
      const reason = a.kind === "quiet" ? `Quiet: ${turn}${a.stopped_by_operator ? ", stopped by the operator" : ""}${a.sandbox ? `, holding ${short(a.sandbox)}` : ""}`
        : a.kind === "ending" ? "Ended, its end's steps still unfinished after an hour"
        : a.kind === "gone" ? "Its records are pruned, yet a sandbox still has it attached"
        : a.error ?? "AgentDO did not answer";
      add({ role: role as AttentionItem["role"], noun: "Agent", label: a.kind, subject: a.agent, reason, target: rowId("lifetime", a.agent) });
    }
  }

  // Errors first, then warnings; within each, in the order above.
  return [...out.filter((i) => i.role === "danger"), ...out.filter((i) => i.role === "warning")];
}
