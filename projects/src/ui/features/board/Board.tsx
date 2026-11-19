// The board, as a list (the owner, 2026-11-10: "more closely resemble linear, particularly in its
// minimalism and vertical layout or rather a table layout instead of a column layout"): one full-width
// list grouped by stage of a task's life, in the order the columns were, cancelled behind a switch and
// empty stages left out. Each group's header collapses it (remembered per project in the browser). Rows
// keep their manual order and drag within their group by pointer or keyboard (the dragged row lifted, `raised`);
// a row whose state isn't its group's name (Assigned, in In progress) says its state in a muted word; a task changes stage only
// through its drawer's actions, as before. It polls while the tab is visible, except while a row is dragged.

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Modal, Switch } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLayoutList, IconPlus } from "@tabler/icons-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setBoardDragging, useAsks, useReorderTask, useTasks } from "../../api/queries";
import type { TaskSummary } from "../../api/types";
import { EmptyState, ErrorState, icon, LoadingState, Panel, Section, TaskGroup, TaskList, Toolbar } from "../../layout";
import { CANCELLED_COLUMN, type Column, COLUMNS } from "../../status";
import { ordForMove } from "./order";
import { TaskListRow, TaskStateGlyph } from "./TaskListRow";
// The editor (Tiptap) is loaded only when a task is created: fetched ahead when the pointer or focus
// reaches "New task".
const loadCreateForm = () => import("./CreateTaskForm");
const CreateTaskForm = lazy(() => loadCreateForm().then((m) => ({ default: m.CreateTaskForm })));

/** The groups a project's owner collapsed, kept per project in this browser. */
const COLLAPSED_KEY = (projectId: string) => `nest-projects:board-collapsed:${projectId}`;
function loadCollapsed(projectId: string): Set<string> {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY(projectId)) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveCollapsed(projectId: string, ids: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY(projectId), JSON.stringify([...ids]));
  } catch {
    // Storage refused (private mode): the groups open again next time.
  }
}

/** The tasks of each stage, in board order, leaving out a stage with none. */
export function groupTasks(tasks: readonly TaskSummary[], columns: readonly Column[]): { column: Column; tasks: TaskSummary[] }[] {
  return columns.map((column) => ({ column, tasks: tasks.filter((t) => column.states.includes(t.state)) })).filter((g) => g.tasks.length > 0);
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `groupTasks`, memoized on the tasks' answer: a group whose tasks are the same ones in the same order
 * keeps its array from the last answer, so its rows (and its sortable list) aren't touched by a poll
 * that changed another group's task. The query's structural sharing keeps an unchanged task's object.
 */
function useGroups(tasks: readonly TaskSummary[] | undefined, columns: readonly Column[]) {
  const last = useRef(new Map<string, TaskSummary[]>());
  return useMemo(() => {
    if (!tasks) return [];
    const groups = groupTasks(tasks, columns).map((g) => {
      const before = last.current.get(g.column.id);
      return before && sameItems(before, g.tasks) ? { column: g.column, tasks: before } : g;
    });
    for (const g of groups) last.current.set(g.column.id, g.tasks);
    return groups;
  }, [tasks, columns]);
}

const MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];
const ACCESSIBILITY = { screenReaderInstructions: { draggable: "To move a task within its group, press space, then the arrow keys, then space again to drop it, or escape to cancel." } };
const NO_ASKS = 0;

/** One stage's rows: they reorder within it (dnd-kit), the moved row's new `ord` written at once. */
const BoardGroup = memo(function BoardGroup({ column, tasks, open, onToggle, projectId, repo, pendingAsks, onMove, onDragging }: {
  column: Column;
  tasks: TaskSummary[];
  open: boolean;
  onToggle: (column: string) => void;
  projectId: string;
  repo: string;
  pendingAsks: ReadonlyMap<string, number>;
  onMove: (task: string, ord: number) => void;
  onDragging: (dragging: boolean) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = useCallback((e: DragEndEvent) => {
    onDragging(false);
    if (!e.over) return;
    const from = tasks.findIndex((t) => t.id === e.active.id);
    const to = tasks.findIndex((t) => t.id === e.over!.id);
    const ord = ordForMove(tasks, from, to);
    if (ord !== null) onMove(String(e.active.id), ord);
  }, [tasks, onMove, onDragging]);
  const onDragStart = useCallback(() => onDragging(true), [onDragging]);
  const onDragCancel = useCallback(() => onDragging(false), [onDragging]);
  const toggle = useCallback(() => onToggle(column.id), [onToggle, column.id]);
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  return (
    <TaskGroup title={column.title} count={tasks.length} open={open} onToggle={toggle} glyph={<TaskStateGlyph state={column.states[column.states.length - 1]!} />}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragStart={onDragStart}
        onDragCancel={onDragCancel}
        onDragEnd={onDragEnd}
        accessibility={ACCESSIBILITY}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div>
            {tasks.map((t) => (
              <TaskListRow key={t.id} task={t} projectId={projectId} repo={repo} pendingAsks={pendingAsks.get(t.id) ?? NO_ASKS} sortable={tasks.length > 1} group={column.title} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </TaskGroup>
  );
});

export function Board({ projectId, repo, headingRef }: { projectId: string; repo: string; headingRef?: React.Ref<HTMLHeadingElement> }) {
  const [dragging, setDragging] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(projectId));
  const [creating, { open, close }] = useDisclosure(false);
  const tasks = useTasks(projectId, { paused: dragging });
  const asks = useAsks(projectId);
  const { mutate: reorder } = useReorderTask(projectId);

  const pendingAsks = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of asks.data ?? []) if (a.task) m.set(a.task, (m.get(a.task) ?? 0) + 1);
    return m;
  }, [asks.data]);

  const columns = useMemo(() => (showCancelled ? [...COLUMNS, CANCELLED_COLUMN] : COLUMNS), [showCancelled]);
  const groups = useGroups(tasks.data, columns);
  const toggle = useCallback((id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      saveCollapsed(projectId, next);
      return next;
    }), [projectId]);
  const onMove = useCallback((task: string, ord: number) => reorder({ task, ord }), [reorder]);
  // While a row is dragged, nothing polls the project's tasks (every observer reads this).
  const onDragging = useCallback((on: boolean) => {
    setDragging(on);
    setBoardDragging(projectId, on);
  }, [projectId]);
  useEffect(() => () => setBoardDragging(projectId, false), [projectId]);

  return (
    <Section
      title="Tasks"
      count={tasks.data?.length}
      headingRef={headingRef}
      actions={
        <Toolbar>
          <Switch label="Show cancelled" checked={showCancelled} onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
          <Button leftSection={<IconPlus size={icon.md} />} onClick={open} onPointerEnter={() => void loadCreateForm()} onFocus={() => void loadCreateForm()}>
            New task
          </Button>
        </Toolbar>
      }
    >
      {tasks.isPending ? (
        <LoadingState label="Loading the board" />
      ) : tasks.isError ? (
        <ErrorState title="The board couldn't be loaded" error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : tasks.data.length === 0 ? (
        <Panel>
          <EmptyState icon={IconLayoutList} title="No tasks yet" description="Create one, or ask the manager in the chat to plan some." action={<Button variant="default" onClick={open} onPointerEnter={() => void loadCreateForm()} onFocus={() => void loadCreateForm()}>Create a task</Button>} />
        </Panel>
      ) : (
        <TaskList label="Tasks by stage">
          {groups.map(({ column, tasks: rows }) => (
            <BoardGroup
              key={column.id}
              column={column}
              tasks={rows}
              open={!collapsed.has(column.id)}
              onToggle={toggle}
              projectId={projectId}
              repo={repo}
              pendingAsks={pendingAsks}
              onMove={onMove}
              onDragging={onDragging}
            />
          ))}
        </TaskList>
      )}

      <Modal opened={creating} onClose={close} title="New task" size="lg">
        <Suspense fallback={<LoadingState label="Loading the editor" />}>
          <CreateTaskForm projectId={projectId} onCancel={close} onCreated={close} />
        </Suspense>
      </Modal>
    </Section>
  );
}
