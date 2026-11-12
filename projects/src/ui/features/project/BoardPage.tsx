// A project's board page, its focal element the board at the content's full width: what its agents are
// waiting on ("Needs you") above it, and the drawer of the task named in the URL (`?task=`).

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useAttention, useLocalAttention, useTasks } from "../../api/queries";
import { LoadingState, Stack } from "../../layout";
import { NeedsYou } from "../attention/NeedsYou";
import { Board } from "../board/Board";
import { TaskDrawer } from "../task/TaskDrawer";
import { ProjectFrame } from "./ProjectFrame";

/**
 * How long a cold load waits for "Needs you"'s first full read (nest's asks) with the board, as one loading
 * state, so the board doesn't jump down when the asks come. Past it, the board shows with the panel saying
 * the asks are being read.
 */
export const COLD_BUDGET_MS = 1_000;

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
          <BoardAndAsks key={projectId} projectId={projectId} repo={p.repo} tasksHeading={tasksHeading} />
          <TaskDrawer projectId={projectId} repo={p.repo} taskId={task} onClose={() => void navigate({ search: {} })} />
        </>
      )}
    </ProjectFrame>
  );
}

/**
 * "Needs you" and the board, shown together once both are read, or the board with the asks still coming
 * after COLD_BUDGET_MS. Both are mounted from the start (hidden until then), so their reads start at once
 * and nothing reads again when they show.
 */
function BoardAndAsks({ projectId, repo, tasksHeading }: { projectId: string; repo: string; tasksHeading: RefObject<HTMLHeadingElement | null> }) {
  const attention = useAttention(projectId);
  // The app's own items, read without nest (what "Needs you" lists until the asks are in).
  const local = useLocalAttention(projectId, attention.data === undefined);
  const tasks = useTasks(projectId);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), COLD_BUDGET_MS);
    return () => clearTimeout(t);
  }, []);
  const asksIn = attention.data !== undefined || attention.isError;
  const tasksIn = tasks.data !== undefined || tasks.isError;
  const localIn = local.data !== undefined || local.isError;
  // The asks read, or (they failed, or the budget's spent) the app's own items read, so the list shows whole either way.
  const shown = tasksIn && (attention.data !== undefined || ((attention.isError || waited) && localIn));
  // Whether the page showed before the asks were read (decided once, when it shows).
  const early = useRef<boolean | null>(null);
  if (shown && early.current === null) early.current = !asksIn;
  return (
    <>
      {!shown && <LoadingState label="Loading the board" />}
      <Stack gap="2xl" display={shown ? undefined : "none"} aria-hidden={!shown || undefined} data-board-page>
        <NeedsYou projectId={projectId} after={tasksHeading} shownBeforeAsks={early.current ?? false} />
        <Board projectId={projectId} repo={repo} headingRef={tasksHeading} />
      </Stack>
    </>
  );
}
