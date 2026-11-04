// What the manager waits for (README.md#waiting), in the Manager page's context column under "Waiting
// for": each pending wait in a line, soonest deadline first, "Add search by tag to be In review or Done ·
// 45 min left", "#12 to merge · 2 h left", "The owner's reply · 26 h left". A task by its title (a link
// to its drawer), its states by the board's labels, a PR by its number (a link to it on GitHub). Then
// what resolved in the last half hour, "#12 merged · met 3 min ago", a timeout in the warning tone.
// Nothing when there's neither.

import { Anchor, Text } from "@mantine/core";
import { IconHourglass } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { TaskState } from "../../../tasks";
import { human, type PrUntil, type Wait } from "../../../waits";
import { useProject, useTasks, useWaits } from "../../api/queries";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, Row, Section, Stack } from "../../layout";
import { STATE_LABEL } from "../../status";

/** How long a resolved wait still shows. */
const RECENT_MS = 30 * 60_000;
const RECENT_SHOWN = 3;

const UNTIL: Record<PrUntil, { pending: string; met: string }> = {
  merged: { pending: "to merge", met: "merged" },
  review_done: { pending: "to finish its review", met: "reviewed" },
  closed: { pending: "to close", met: "closed" },
};

const OUTCOME: Record<NonNullable<Wait["outcome"]>, { label: string; warning?: boolean }> = {
  met: { label: "met" },
  ended: { label: "ended without it" },
  timed_out: { label: "timed out", warning: true },
  cancelled: { label: "cancelled" },
};

function Subject({ projectId, repo, w, titles }: { projectId: string; repo: string | undefined; w: Wait; titles: Map<string, string> }) {
  if (w.kind === "task") {
    // A sentence's link: the inline exception on touch.
    return (
      <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: w.target! }} inherit lh="lg" data-inline>
        {titles.get(w.target!) ?? "a task"}
      </AnchorLink>
    );
  }
  if (w.kind === "pr") {
    return repo ? (
      <Anchor href={`https://github.com/${repo}/pull/${w.target}`} target="_blank" rel="noreferrer" inherit lh="lg" data-inline>
        #{w.target}
      </Anchor>
    ) : (
      <>#{w.target}</>
    );
  }
  return <>The owner&apos;s reply</>;
}

const labels = (w: Wait) => (w.want as TaskState[]).map((s) => STATE_LABEL[s]).join(" or ");

/** What it waits for, after its subject: "to be In review or Done", "to merge"; nothing for a reply. */
function condition(w: Wait): string {
  if (w.kind === "task") return ` to be ${labels(w)}`;
  if (w.kind === "pr") return ` ${UNTIL[w.want as PrUntil].pending}`;
  return "";
}

/** What was met, for a resolved wait: "merged", "In review"; nothing otherwise. */
function met(w: Wait): string {
  if (w.outcome !== "met") return "";
  if (w.kind === "task") return ` ${labels(w)}`;
  if (w.kind === "pr") return ` ${UNTIL[w.want as PrUntil].met}`;
  return "";
}

function Line({ children, title, warning = false, slot }: { children: ReactNode; title: string; warning?: boolean; slot: string }) {
  return (
    <Row role="listitem" gap="xs" wrap="nowrap" align="flex-start" data-slot={slot} title={title}>
      <Text component="span" c="dimmed" lh="lg" display="inline-flex">
        <IconHourglass size={icon.sm} aria-hidden />
      </Text>
      {/* A sentence (a <p>, its links inline on a 24 px line: the touch rule's exception). */}
      <Text component="p" fz="sm" lh="lg" c={warning ? "warning" : undefined} data-tone={warning ? "warning" : undefined}>
        {children}
      </Text>
    </Row>
  );
}

export function ManagerWaits({ projectId, now = Date.now() }: { projectId: string; now?: number }) {
  const waits = useWaits(projectId);
  const tasks = useTasks(projectId).data ?? [];
  const repo = useProject(projectId).data?.repo;
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const pending = [...(waits.data?.pending ?? [])].sort((a, b) => a.deadline_ms - b.deadline_ms);
  const recent = (waits.data?.recent ?? []).filter((w) => w.resolved_ms !== null && now - w.resolved_ms < RECENT_MS).slice(0, RECENT_SHOWN);
  if (pending.length === 0 && recent.length === 0) return null;
  return (
    <Section title="Waiting for" dense count={pending.length} region={false}>
      <Stack gap="xs">
        {pending.length > 0 && (
          <Stack gap="xs" role="list" aria-label="The manager's waits" data-slot="waits">
            {pending.map((w) => (
              <Line key={w.id} slot="wait" title={`Times out ${exact(w.deadline_ms)}`}>
                <Subject projectId={projectId} repo={repo} w={w} titles={titles} />
                {condition(w)} · {w.deadline_ms > now ? `${human(w.deadline_ms - now)} left` : "timing out"}
              </Line>
            ))}
          </Stack>
        )}
        {recent.length > 0 && (
          <Stack gap="xs" role="list" aria-label="The manager's resolved waits" data-slot="recent-waits">
            {recent.map((w) => (
              <Line key={w.id} slot="resolved" title={exact(w.resolved_ms!)} warning={OUTCOME[w.outcome!].warning}>
                <Subject projectId={projectId} repo={repo} w={w} titles={titles} />
                {met(w)} · {OUTCOME[w.outcome!].label} {ago(w.resolved_ms!, now)}
              </Line>
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}
