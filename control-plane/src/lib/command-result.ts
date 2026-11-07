// A host command's result and the follow-ups it owes (docs/control-plane/durable-objects/fleet/, "Command results";
// verification/tla/sandbox-lease/SlotFollowups.tla: `Recv`, `Finish`, `Rerun`). Pure.
//
// FleetDO records a result and, in the same synchronous step, that its follow-ups are owed (a durable
// flag on the command's row). Each follow-up is a call to another Durable Object (SandboxDO's
// `attachResult`, `checkpointResult`, `commandFailed`; AgentDO's `startFailed`), which can fail, or be
// cut by a reset of FleetDO between the record and the call. So the flag stays until every follow-up has
// run, and a redelivered result or FleetDO's own deadline runs them again. Each receiver is idempotent
// for the same command (`attachResult` and `checkpointResult` by `cmd`, `commandFailed` by `cmd` since
// this change, `startFailed` by epoch and its intent).

/** A follow-up a result owes, named by its receiver's method. */
export type Followup = "attach_result" | "checkpoint_result" | "command_failed" | "start_failed";

/** What a command's row says about it, for deciding its follow-ups. */
export interface ResultRow {
  type: string;
  sandbox: string | null;
  agent: string | null;
  epoch: number | null;
  /** FleetDO's own purpose for the command (`stonith_fence`: handled in its own step, owing nothing). */
  purpose: string | null;
}

export type ResultOutcome = { status: "ok" } | { status: "error" };

/**
 * The follow-ups a result owes, in the order they run. A STONITH fence's result is FleetDO's own
 * business, done in the step that records it, so it owes none here.
 */
export function resultFollowups(row: ResultRow, outcome: ResultOutcome): Followup[] {
  if (row.purpose === "stonith_fence") return [];
  const out: Followup[] = [];
  if (row.type === "agent_attach" && row.sandbox && row.epoch !== null && row.agent) out.push("attach_result");
  if (row.type === "sandbox_checkpoint" && row.sandbox && row.epoch !== null) out.push("checkpoint_result");
  if (outcome.status === "error") {
    if (row.sandbox && row.epoch !== null && row.type !== "sandbox_checkpoint") out.push("command_failed");
    if (row.agent && row.type === "agent_start") out.push("start_failed");
  }
  return out;
}

/** What a command's row holds when a result for it arrives. */
export interface StoredResult {
  host: string;
  /** Recorded already (this is a redelivery). */
  recorded: boolean;
  /** Follow-ups recorded as owed and not yet all run. */
  owed: boolean;
}

/**
 * A result from `host` arriving for a command: `record` it (the first time: the result and whether its
 * follow-ups are owed, in one step, then run them), `rerun` the follow-ups still owed (a redelivery after
 * a reset or a failed call), or `ignore` it (unknown, another host's, or recorded with nothing owed).
 */
export function resultStep(stored: StoredResult | undefined, host: string): "record" | "rerun" | "ignore" {
  if (!stored || stored.host !== host) return "ignore";
  if (!stored.recorded) return "record";
  return stored.owed ? "rerun" : "ignore";
}

/** When owed follow-ups are tried again after a failure: 5 s doubling, at most 5 min. */
export const followupBackoff = (attempts: number): number => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
