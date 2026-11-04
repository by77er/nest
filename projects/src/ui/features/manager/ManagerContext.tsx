// The Manager page's context column: the tasks under way (as the task cards a message shows, newest
// change first), what the manager waits for (its awaits, soonest deadline first; README.md#waiting) and
// the top things waiting on the owner, each linking to the Board's "Needs you", where
// it's answered. The manager's
// status is in the page's header, not here.

import { Text } from "@mantine/core";
import { useAttention, useTasks } from "../../api/queries";
import type { Attention } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { MetaItem, MetaRow, Section, Stack } from "../../layout";
import { approvalOf } from "../attention/AskItem";
import { SHOWN as ASKS_SHOWN } from "../attention/NeedsYou";
import { TaskCardList } from "../rich/TaskRefs";
import { ManagerWaits } from "./ManagerWaits";

/** The states a task is under way in: someone holds it. Drafts, ready and done aren't. */
export const ACTIVE = new Set(["assigned", "in_progress", "in_review", "stalled"]);
const SHOWN = 5;
const GIST = 120;

/** A line of what an ask or a block wants: its question, the call it holds, or the reason. */
export function gist(x: Attention): string {
  let text: string;
  if (x.kind === "ask") {
    const a = approvalOf(x);
    text = x.question ?? (a ? `Approve a call to ${a.name}` : "A question");
  } else text = x.question ?? x.reason;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > GIST ? `${line.slice(0, GIST - 1).trimEnd()}…` : line;
}

function More({ projectId, n }: { projectId: string; n: number }) {
  // A sentence with a link: on a 24 px line (the inline exception on touch).
  return (
    <Text fz="sm" lh="lg" c="dimmed">
      and{" "}
      <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{}} inherit lh="lg" data-inline>
        {n} more on the board
      </AnchorLink>
    </Text>
  );
}

export function ManagerContext({ projectId }: { projectId: string }) {
  const tasks = useTasks(projectId).data ?? [];
  const waiting = [...(useAttention(projectId).data ?? [])].sort((a, b) => a.at_ms - b.at_ms);
  const active = tasks.filter((t) => ACTIVE.has(t.state)).sort((a, b) => b.updated_ms - a.updated_ms);
  const on = active.slice(0, SHOWN);
  const asks = waiting.slice(0, ASKS_SHOWN);
  return (
    <Stack gap="xl" data-slot="manager-context">
      <Section title="Working on" count={active.length} dense region={false}>
        {on.length ? (
          <Stack gap="sm">
            <TaskCardList projectId={projectId} ids={on.map((t) => t.id)} />
            {active.length > on.length && <More projectId={projectId} n={active.length - on.length} />}
          </Stack>
        ) : (
          <Text fz="sm" c="dimmed">
            Nothing under way.
          </Text>
        )}
      </Section>
      <ManagerWaits projectId={projectId} />
      <Section title="Needs you" dense region={false}>
        {asks.length ? (
          <Stack gap="md" data-slot="top-asks">
            {asks.map((x) => (
              <Stack key={x.kind === "ask" ? x.ask : `blocked-${x.task}`} gap="xs">
                <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{}} fz="sm">
                  {gist(x)}
                </AnchorLink>
                <MetaRow>
                  <MetaItem>{x.kind === "blocked" ? `Blocks ${x.title}` : x.role === "manager" ? "The manager asks" : "A worker asks"}</MetaItem>
                  <MetaItem title={exact(x.at_ms)}>{ago(x.at_ms)}</MetaItem>
                </MetaRow>
              </Stack>
            ))}
            {waiting.length > asks.length && <More projectId={projectId} n={waiting.length - asks.length} />}
          </Stack>
        ) : (
          <Text fz="sm" c="dimmed">
            Nothing waits on you.
          </Text>
        )}
      </Section>
    </Stack>
  );
}
