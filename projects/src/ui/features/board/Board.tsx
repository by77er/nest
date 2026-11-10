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
import { lazy, Suspense, useMemo, useState } from "react";
import { useAsks, useReorderTask, useTasks } from "../../api/queries";
import type { Task } from "../../api/types";
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
export function groupTasks(tasks: readonly Task[], columns: readonly Column[]): { column: Column; tasks: Task[] }[] {
  return columns.map((column) => ({ column, tasks: tasks.filter((t) => column.states.includes(t.state)) })).filter((g) => g.tasks.length > 0);
}

/** One stage's rows: they reorder within it (dnd-kit), the moved row's new `ord` written at once. */
function BoardGroup({ column, tasks, open, onToggle, projectId, repo, pendingAsks, onMove, onDragging }: {
  column: Column;
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
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
  const onDragEnd = (e: DragEndEvent) => {
    onDragging(false);
    if (!e.over) return;
    const from = tasks.findIndex((t) => t.id === e.active.id);
    const to = tasks.findIndex((t) => t.id === e.over!.id);
    const ord = ordForMove(tasks, from, to);
    if (ord !== null) onMove(String(e.active.id), ord);
  };
  return (
    <TaskGroup title={column.title} count={tasks.length} open={open} onToggle={onToggle} glyph={<TaskStateGlyph state={column.states[column.states.length - 1]!} />}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={() => onDragging(true)}
        onDragCancel={() => onDragging(false)}
        onDragEnd={onDragEnd}
        accessibility={{ screenReaderInstructions: { draggable: "To move a task within its group, press space, then the arrow keys, then space again to drop it, or escape to cancel." } }}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div>
            {tasks.map((t) => (
              <TaskListRow key={t.id} task={t} projectId={projectId} repo={repo} pendingAsks={pendingAsks.get(t.id) ?? 0} sortable={tasks.length > 1} group={column.title} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </TaskGroup>
  );
}

export function Board({ projectId, repo }: { projectId: string; repo: string }) {
  const [dragging, setDragging] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(projectId));
  const [creating, { open, close }] = useDisclosure(false);
  const tasks = useTasks(projectId, { paused: dragging });
  const asks = useAsks(projectId);
  const reorder = useReorderTask(projectId);

  const pendingAsks = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of asks.data ?? []) if (a.answered_ms === null && a.task) m.set(a.task, (m.get(a.task) ?? 0) + 1);
    return m;
  }, [asks.data]);

  const columns = showCancelled ? [...COLUMNS, CANCELLED_COLUMN] : COLUMNS;
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      saveCollapsed(projectId, next);
      return next;
    });

  return (
    <Section
      title="Tasks"
      count={tasks.data?.length}
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
          {groupTasks(tasks.data, columns).map(({ column, tasks: rows }) => (
            <BoardGroup
              key={column.id}
              column={column}
              tasks={rows}
              open={!collapsed.has(column.id)}
              onToggle={() => toggle(column.id)}
              projectId={projectId}
              repo={repo}
              pendingAsks={pendingAsks}
              onMove={(task, ord) => reorder.mutate({ task, ord })}
              onDragging={setDragging}
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
