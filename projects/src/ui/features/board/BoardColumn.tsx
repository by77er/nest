// One column of the board. Its cards reorder within it (dnd-kit), and the new order is the moved card's
// `ord`, written at once and shown before the Worker answers.

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Badge, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { Task } from "../../api/types";
import type { Column } from "../../status";
import { ordForMove } from "./order";
import { TaskCard } from "./TaskCard";

export interface BoardColumnProps {
  column: Column;
  tasks: Task[];
  projectId: string;
  repo: string;
  pendingAsks: ReadonlyMap<string, number>;
  onMove: (task: string, ord: number) => void;
  onDragging: (dragging: boolean) => void;
}

export function BoardColumn({ column, tasks, projectId, repo, pendingAsks, onMove, onDragging }: BoardColumnProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const headingId = `column-${column.id}`;

  const onDragEnd = (e: DragEndEvent) => {
    onDragging(false);
    if (!e.over) return;
    const from = tasks.findIndex((t) => t.id === e.active.id);
    const to = tasks.findIndex((t) => t.id === e.over!.id);
    const ord = ordForMove(tasks, from, to);
    if (ord !== null) onMove(String(e.active.id), ord);
  };

  return (
    <Paper component="section" aria-labelledby={headingId} bg="gray.0" withBorder p={6} miw={0} style={{ scrollSnapAlign: "start" }}>
      <Group justify="space-between" mb="xs" px={4} gap={4} wrap="nowrap">
        <Title order={3} size="sm" id={headingId}>
          {column.title}
        </Title>
        <Badge size="sm" variant="default" aria-label={`${tasks.length} tasks`}>
          {tasks.length}
        </Badge>
      </Group>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={() => onDragging(true)}
        onDragCancel={() => onDragging(false)}
        onDragEnd={onDragEnd}
        accessibility={{ screenReaderInstructions: { draggable: "To move a task, press space, then the arrow keys, then space again to drop it, or escape to cancel." } }}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <Stack gap="xs" mih={48}>
            {tasks.length === 0 ? (
              <Text size="xs" c="dimmed" ta="center" py="sm">
                No tasks
              </Text>
            ) : (
              tasks.map((t) => (
                <TaskCard key={t.id} task={t} projectId={projectId} repo={repo} pendingAsks={pendingAsks.get(t.id) ?? 0} sortable={tasks.length > 1} />
              ))
            )}
          </Stack>
        </SortableContext>
      </DndContext>
    </Paper>
  );
}
