// What the owner can do to a task, offered only where the state machine (src/tasks.ts) allows it:
// assign (blue), mark done (green), cancel (red, with a reason), delete a draft (red).

import { Button, Modal, Text, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconCheck, IconPlayerPlay, IconTrash, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useAssignTask, useCancelTask, useDeleteTask, useMarkDone } from "../../api/queries";
import type { Task } from "../../api/types";
import { FieldGroup, icon, Toolbar } from "../../layout";
import { can } from "../../status";

/** Why Mark done isn't offered when it's only the open PRs (README.md#the-task-machine), or null. */
export function doneWaitsOnPrs(task: Pick<Task, "state" | "prs" | "worker_live">): string | null {
  const open = task.prs.filter((p) => p.state === "open").map((p) => `#${p.number}`);
  if (!open.length || can(task, "done") || !can({ ...task, prs: [] }, "done")) return null;
  const list = open.length === 1 ? `PR ${open[0]}` : `PRs ${open.slice(0, -1).join(", ")} and ${open.at(-1)}`;
  return `Done when ${list} ${open.length === 1 ? "merges" : "merge"}, or detach ${open.length === 1 ? "it" : "them"} to finish by hand.`;
}

export function TaskActions({ projectId, task, onDeleted }: { projectId: string; task: Task; onDeleted: () => void }) {
  const assign = useAssignTask(projectId);
  const done = useMarkDone(projectId);
  const del = useDeleteTask(projectId);
  const [cancelling, cancelModal] = useDisclosure(false);

  const confirmDone = () =>
    modals.openConfirmModal({
      title: "Mark this task done?",
      // Only a task with no PR and no live worker gets here (src/tasks.ts): one with a PR is done when it merges.
      children: <Text fz="md">For work that needs no PR, such as research or a spec. A done task can't be reopened.</Text>,
      labels: { confirm: "Mark done", cancel: "Not yet" },
      confirmProps: { color: "success" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => done.mutate({ task: task.id }),
    });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: "Delete this draft?",
      children: <Text fz="md">It and its history are gone for good.</Text>,
      labels: { confirm: "Delete", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => del.mutate({ task: task.id }, { onSuccess: onDeleted }),
    });

  const any = can(task, "assign") || can(task, "done") || can(task, "cancel") || task.state === "draft";
  const prsHold = doneWaitsOnPrs(task);
  if (!any) return null;

  return (
    <>
      <Toolbar
        align="start"
        aria-label="Task actions"
        danger={
          (can(task, "cancel") || task.state === "draft") && (
            <>
              {can(task, "cancel") && (
                <Button color="danger" variant="light" leftSection={<IconX size={icon.md} />} onClick={cancelModal.open}>
                  Cancel task
                </Button>
              )}
              {task.state === "draft" && (
                <Button color="danger" variant="subtle" leftSection={<IconTrash size={icon.md} />} loading={del.isPending} onClick={confirmDelete}>
                  Delete
                </Button>
              )}
            </>
          )
        }
      >
        {can(task, "assign") && (
          <>
            {/* Waiting on unfinished tasks, the Worker refuses it (README.md#dependencies): said, not offered. */}
            <Button
              leftSection={<IconPlayerPlay size={icon.md} />}
              loading={assign.isPending}
              disabled={task.waiting_on.length > 0}
              onClick={() => assign.mutate({ task: task.id })}
              aria-describedby={task.waiting_on.length > 0 ? `assign-why-${task.id}` : undefined}
            >
              {task.state === "stalled" ? "Reassign" : "Assign"}
            </Button>
            {task.waiting_on.length > 0 && (
              <Text fz="sm" c="dimmed" id={`assign-why-${task.id}`}>
                Waits on {task.waiting_on.length} {task.waiting_on.length === 1 ? "task" : "tasks"}
              </Text>
            )}
          </>
        )}
        {can(task, "done") && (
          <Button color="success" leftSection={<IconCheck size={icon.md} />} loading={done.isPending} onClick={confirmDone}>
            Mark done
          </Button>
        )}
        {/* Not offered while its PRs are open (the machine refuses it): said, as a dependency's wait is. */}
        {prsHold && (
          <Text fz="sm" c="dimmed" data-slot="done-waits">
            {prsHold}
          </Text>
        )}
      </Toolbar>
      <CancelTaskModal projectId={projectId} task={task} opened={cancelling} onClose={cancelModal.close} />
    </>
  );
}

/** Cancelling stops the task's worker: confirmed, with an optional reason kept in its history. */
function CancelTaskModal({ projectId, task, opened, onClose }: { projectId: string; task: Task; opened: boolean; onClose: () => void }) {
  const cancel = useCancelTask(projectId);
  const [reason, setReason] = useState("");
  return (
    <Modal opened={opened} onClose={onClose} title="Cancel this task?">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate({ task: task.id, reason: reason.trim() || undefined }, { onSuccess: () => { setReason(""); onClose(); } });
        }}
      >
        <FieldGroup
          actions={
            <>
              <Button variant="default" onClick={onClose} data-autofocus>
                Keep it
              </Button>
              <Button type="submit" color="danger" loading={cancel.isPending}>
                Cancel task
              </Button>
            </>
          }
        >
          <Text fz="md">{task.assignee ? "Its worker is stopped and its sandbox destroyed." : "It leaves the board; its history stays."}</Text>
          <Textarea label="Reason" description="Optional; kept in the task's history." maxLength={1000} autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </FieldGroup>
      </form>
    </Modal>
  );
}
