// An attached agent's slot in its sandbox, and when a binding may be minted for it
// (docs/control-plane/durable-objects/sandbox/#attach-and-bindings; docs/verification/gateway-bindings
// P1-P6). A pure, synchronous core over SandboxDO's `info`, like lib/sandbox-lease.ts: each function
// mutates the fields it is given inside `update()` and returns what the shell sends next.
//
// A slot is attached (with its cwd), pending until the guest confirms the current placement's
// `agent_attach`, with at most one such command in flight; only the in-flight command's result counts.
import { gone, type Lease } from "./sandbox-lease";
import { NestError } from "./util";
import { ErrorCodes } from "../protocol/model";

export interface Slots {
  attached: string[];
  /** Each attached agent's slot cwd (null: the default), re-sent to every new placement. */
  attach_cwd: Record<string, string | null>;
  /** Agents whose `agent_attach` at the current placement has no `ok` yet: no binding for them. */
  attach_pending: string[];
  /** The `agent_attach` command in flight per agent; a result for any other command is stale. */
  attach_inflight: Record<string, string>;
  /** Failed attempts at the current placement, per agent (drives the retry backoff). */
  attach_attempts: Record<string, number>;
  /** Agents mid-turn: the sandbox may suspend only when none is. */
  working: string[];
}

/** A failed `agent_attach` is retried with this backoff (doubling), capped, for as long as the sandbox is placed. */
export const ATTACH_RETRY_MS = 2_000;
export const ATTACH_RETRY_MAX_MS = 30_000;

const without = (xs: string[], x: string) => xs.filter((y) => y !== x);

/** P1: record the agent (idempotent). True when an `agent_attach` goes out now: the sandbox is placed. */
export function attach(c: Slots, agent: string, cwd: string | null, placed: boolean): boolean {
  // Already attached and confirmed with this cwd: nothing to re-send, and no pending mark to re-set.
  if (c.attached.includes(agent) && !c.attach_pending.includes(agent) && c.attach_cwd[agent] === cwd) return false;
  if (!c.attached.includes(agent)) c.attached.push(agent);
  c.attach_cwd[agent] = cwd;
  c.attach_attempts[agent] = 0;
  if (placed && !c.attach_pending.includes(agent)) c.attach_pending.push(agent);
  return placed;
}

/** P5: the agent is gone from every collection (its bindings are refused from then on). */
export function detach(c: Slots, agent: string): void {
  c.attached = without(c.attached, agent);
  c.working = without(c.working, agent);
  c.attach_pending = without(c.attach_pending, agent);
  delete c.attach_cwd[agent];
  delete c.attach_inflight[agent];
  delete c.attach_attempts[agent];
}

/** P4: a new placement is a new guest: every slot is configured again, and pending until confirmed. */
export function newPlacement(c: Slots): string[] {
  c.attach_pending = [...c.attached];
  c.attach_inflight = {};
  c.attach_attempts = Object.fromEntries(c.attached.map((a) => [a, 0]));
  return [...c.attached];
}

/** The `agent_attach` commands just issued (in `agents`' order), as each still-attached agent's one in flight. */
export function sent(c: Slots, agents: string[], cmds: string[]): void {
  agents.forEach((a, n) => {
    if (c.attached.includes(a)) c.attach_inflight[a] = cmds[n]!;
  });
}

/** Pending agents with no command in flight (after a failure, or a guest coming up: `fresh` resets their backoff). */
export function due(c: Slots, fresh: boolean): string[] {
  if (fresh) for (const a of c.attach_pending) c.attach_attempts[a] = 0;
  return c.attach_pending.filter((a) => !(a in c.attach_inflight));
}

/**
 * P2/P3: the result of `cmd` for `agent` (from the holder at the current epoch). `ok` confirms the
 * slot; a retryable error is retried with the doubling backoff; any other waits for the next
 * `running`. A result for a command no longer in flight is stale.
 */
export function attachResult(
  c: Slots, agent: string, cmd: string, ok: boolean, retryable: boolean,
): { kind: "stale" | "confirmed" | "failed" } | { kind: "retry"; delayMs: number } {
  if (!c.attached.includes(agent) || c.attach_inflight[agent] !== cmd) return { kind: "stale" };
  delete c.attach_inflight[agent];
  if (ok) {
    c.attach_pending = without(c.attach_pending, agent);
    c.attach_attempts[agent] = 0;
    return { kind: "confirmed" };
  }
  const attempts = (c.attach_attempts[agent] ?? 0) + 1;
  c.attach_attempts[agent] = attempts;
  return retryable ? { kind: "retry", delayMs: Math.min(ATTACH_RETRY_MS * 2 ** (attempts - 1), ATTACH_RETRY_MAX_MS) } : { kind: "failed" };
}

/** An attached agent starts or stops working. `turnEnded`: it was working and stopped. */
export function setWorking(c: Slots, agent: string, working: boolean): { turnEnded: boolean } {
  const was = c.working.includes(agent);
  c.working = without(c.working, agent);
  if (working && c.attached.includes(agent)) c.working.push(agent);
  return { turnEnded: was && !working };
}

/**
 * P6 / gateway-bindings S7, the one readiness rule for a binding, checked before and after
 * `resolve`'s awaits: an attached agent with a confirmed slot on a running, placed sandbox whose
 * guest reported its version. Null when a binding may be minted; otherwise why not (not-ready errors
 * are retryable).
 */
export function unbindable(i: Slots & Pick<Lease, "state" | "host" | "placing" | "guest">, agent: string): NestError | null {
  const notReady = (why: string) => new NestError(ErrorCodes.SANDBOX_NOT_READY, why, 503, true);
  if (!i.attached.includes(agent)) return new NestError(ErrorCodes.NOT_BOUND, `${agent} is not attached to this sandbox`, 409);
  if (gone(i.state)) return new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${i.state}`, 409);
  if (!i.host || i.placing !== null) return notReady("sandbox is not placed yet");
  // nestd forgets a suspended sandbox's gateway entry and re-adds it before it reports `running`,
  // so a target minted during a resume would only ever be refused as `moved`.
  if (i.state !== "running") return notReady(`sandbox is ${i.state}`);
  if (i.attach_pending.includes(agent)) return notReady(`${agent}'s slot is not configured yet`);
  // The guest's version comes from the host's report; it is never guessed.
  if (!i.guest) return notReady("the guest has not reported its version yet");
  return null;
}
