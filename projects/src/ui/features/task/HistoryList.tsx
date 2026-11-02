// A task's history, oldest first: who did what, when, and whether the session was tainted.

import { Badge, Code, Group, Spoiler, Text, Timeline } from "@mantine/core";
import type { HistoryRow } from "../../api/types";
import { ago, exact } from "../../common/time";

/** `owner`, `app:<what>` or an agent's id, as a person reads it. */
export function actorLabel(actor: string): string {
  if (actor === "owner") return "You";
  if (actor.startsWith("app:")) return `The app (${actor.slice(4)})`;
  return actor;
}

function Detail({ detail }: { detail: string }) {
  let parsed: unknown = detail;
  try {
    parsed = JSON.parse(detail);
  } catch {
    // plain text
  }
  return (
    <Spoiler maxHeight={72} showLabel="More" hideLabel="Less">
      {typeof parsed === "string" ? (
        <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {parsed}
        </Text>
      ) : (
        <Code block fz="xs">
          {JSON.stringify(parsed, null, 2)}
        </Code>
      )}
    </Spoiler>
  );
}

export function HistoryList({ history }: { history: HistoryRow[] }) {
  if (history.length === 0) return <Text size="sm" c="dimmed">No history.</Text>;
  return (
    <Timeline bulletSize={12} lineWidth={2} color="gray" active={history.length - 1}>
      {history.map((h, i) => (
        <Timeline.Item
          key={i}
          title={
            <Group gap={6}>
              <Text size="sm" fw={500}>
                {h.action.replace(/_/g, " ")}
              </Text>
              {h.tainted && (
                <Badge size="xs" color="gray" variant="outline">
                  Tainted
                </Badge>
              )}
            </Group>
          }
        >
          <Text size="xs" c="dimmed">
            {actorLabel(h.actor)} · <span title={exact(h.at_ms)}>{ago(h.at_ms)}</span>
          </Text>
          {h.detail && <Detail detail={h.detail} />}
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
