// The trace viewer's mounts, one per place an agent's work is watched: the manager's (a "Trace" tab beside
// "Chat" on the Manager page), a task's worker's (the task drawer on the board), and a review job's
// reviewer's (the Reviews page, per job). Each connects only while it is shown, and owns no data of the
// page's: it is given the agent's id.

import type { Settings, Task } from "../../api/types";
import { TraceView } from "./TraceView";

/** The project's manager's trace. */
export function ManagerTrace({ settings }: { settings: Pick<Settings, "manager"> | undefined }) {
  return <TraceView title="Manager's trace" agent={settings?.manager ?? null} empty="The manager hasn't started yet." />;
}

/** A task's worker's trace (its assignee), in its drawer. */
export function TaskTraces({ task }: { task: Pick<Task, "assignee"> }) {
  return <TraceView key={task.assignee ?? ""} title="Worker's trace" agent={task.assignee} empty="No worker has started on this task yet." />;
}

/** A review job's reviewer's trace. */
export function ReviewTrace({ job }: { job: { pr: number; agent: string | null } }) {
  return <TraceView key={job.agent ?? ""} title={`Reviewer of #${job.pr}`} agent={job.agent} empty="No reviewer has started on this review yet." />;
}
