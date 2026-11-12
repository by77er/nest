// A project's board page, its focal element the board at the content's full width: what its agents are
// waiting on ("Needs you") above it, and the drawer of the task named in the URL (`?task=`).

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useRef } from "react";
import { NeedsYou } from "../attention/NeedsYou";
import { Board } from "../board/Board";
import { TaskDrawer } from "../task/TaskDrawer";
import { ProjectFrame } from "./ProjectFrame";

export function BoardPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/board" });
  const { task } = useSearch({ from: "/projects/$projectId/board" });
  const navigate = useNavigate({ from: "/projects/$projectId/board" });
  // The board's heading: where focus goes once "Needs you" has nothing left to hold it.
  const tasksHeading = useRef<HTMLHeadingElement>(null);
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <>
          <NeedsYou projectId={projectId} after={tasksHeading} />
          <Board projectId={projectId} repo={p.repo} headingRef={tasksHeading} />
          <TaskDrawer projectId={projectId} repo={p.repo} taskId={task} onClose={() => void navigate({ search: {} })} />
        </>
      )}
    </ProjectFrame>
  );
}
