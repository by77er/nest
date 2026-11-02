// The board: a column per stage of a task's life, cancelled ones behind a switch. It polls while the
// tab is visible, except while a card is being dragged.

import { Button, Modal, Switch } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLayoutKanban, IconPlus } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useAsks, useReorderTask, useTasks } from "../../api/queries";
import type { Task } from "../../api/types";
import { ColumnGrid, EmptyState, ErrorState, icon, LoadingState, Panel, Section, Toolbar } from "../../layout";
import { CANCELLED_COLUMN, COLUMNS } from "../../status";
import { BoardColumn } from "./BoardColumn";
import { CreateTaskForm } from "./CreateTaskForm";

export function Board({ projectId, repo }: { projectId: string; repo: string }) {
  const [dragging, setDragging] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
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
  const byColumn = (states: readonly string[], all: Task[]) => all.filter((t) => states.includes(t.state));

  return (
    <Section
      title="Board"
      actions={
        <Toolbar>
          <Switch label="Show cancelled" checked={showCancelled} onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
          <Button leftSection={<IconPlus size={icon.md} />} onClick={open}>
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
          <EmptyState icon={IconLayoutKanban} title="No tasks yet" description="Create one, or ask the manager in the chat to plan some." action={<Button onClick={open}>Create a task</Button>} />
        </Panel>
      ) : (
        <ColumnGrid columns={columns.length}>
          {columns.map((c) => (
            <BoardColumn
              key={c.id}
              column={c}
              tasks={byColumn(c.states, tasks.data)}
              projectId={projectId}
              repo={repo}
              pendingAsks={pendingAsks}
              onMove={(task, ord) => reorder.mutate({ task, ord })}
              onDragging={setDragging}
            />
          ))}
        </ColumnGrid>
      )}

      <Modal opened={creating} onClose={close} title="New task" size="lg">
        <CreateTaskForm projectId={projectId} onCancel={close} onCreated={close} />
      </Modal>
    </Section>
  );
}
