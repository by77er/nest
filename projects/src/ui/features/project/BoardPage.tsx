// A project's board page, its focal element the board at the content's full width: what its agents are
// waiting on above it, and the drawer of the task named in the URL (`?task=`).

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { MetaItem } from "../../layout";
import { AsksPanel } from "../asks/AsksPanel";
import { Board } from "../board/Board";
import { TaskDrawer } from "../task/TaskDrawer";
import { ProjectFrame } from "./ProjectFrame";

export function BoardPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/board" });
  const { task } = useSearch({ from: "/projects/$projectId/board" });
  const navigate = useNavigate({ from: "/projects/$projectId/board" });
  return (
    <ProjectFrame
      projectId={projectId}
      title="Board"
      meta={(p) => (
        <>
          <MetaItem>Auto-assign {p.settings.auto_assign ? "on" : "off"}</MetaItem>
          <MetaItem>
            Up to {p.settings.max_workers} {p.settings.max_workers === 1 ? "worker" : "workers"}
          </MetaItem>
        </>
      )}
    >
      {(p) => (
        <>
          <AsksPanel projectId={projectId} />
          <Board projectId={projectId} repo={p.repo} />
          <TaskDrawer projectId={projectId} repo={p.repo} taskId={task} onClose={() => void navigate({ search: {} })} />
        </>
      )}
    </ProjectFrame>
  );
}
