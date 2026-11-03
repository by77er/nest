// One task on the board: its title (a link that opens its drawer), then its status badges with the
// grip at the right, then a caption line of who and which PR. The grip drags it, by pointer or keyboard
// (space, arrows).

import { Anchor } from "@mantine/core";
import type { Task } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { SortablePanel, weight } from "../../layout";
import { TaskCardBody } from "./TaskCardBody";

export interface TaskCardProps {
  task: Task;
  projectId: string;
  repo: string;
  /** Open asks from this task's worker. */
  pendingAsks: number;
  /** Whether cards in its column can be dragged. */
  sortable: boolean;
}

export function TaskCard({ task, projectId, repo, pendingAsks, sortable }: TaskCardProps) {
  return (
    <SortablePanel id={task.id} disabled={!sortable} gripLabel={`Move ${task.title}`} dense component="article" aria-label={task.title} data-task={task.id}>
      {(grip) => (
        <TaskCardBody
          task={task}
          pendingAsks={pendingAsks}
          end={grip}
          title={
            <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: task.id }} c="bright" fw={weight.medium} fz="sm">
              {task.title}
            </AnchorLink>
          }
          pr={(n) => (
            <Anchor href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" inherit>
              #{n}
            </Anchor>
          )}
        />
      )}
    </SortablePanel>
  );
}
