// A task's history, oldest first: a sentence per entry (what happened, and the gist of it), who did it,
// when, and whether the session was tainted. The raw details are behind a disclosure.

import { Anchor, Badge, Code, Group, Text, Timeline } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { HistoryRow } from "../../api/types";
import { ago, exact } from "../../common/time";
import { actorLabel, detailOf, summarize } from "./history";

function Entry({ h }: { h: HistoryRow }) {
  const [open, { toggle }] = useDisclosure(false);
  const d = detailOf(h);
  // A short text detail is already the summary's; anything else is there on request.
  const raw = d !== null && (typeof d !== "string" || d.length > 120);
  return (
    <>
      <Group gap={6} wrap="wrap">
        <Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>
          {summarize(h)}
        </Text>
        {h.tainted && (
          <Badge size="xs" color="gray" variant="outline">
            Tainted
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {actorLabel(h.actor)} · <span title={exact(h.at_ms)}>{ago(h.at_ms)}</span>
        {raw && (
          <>
            {" · "}
            <Anchor component="button" type="button" size="xs" c="dimmed" underline="always" onClick={toggle} aria-expanded={open}>
              {open ? "Hide details" : "Details"}
            </Anchor>
          </>
        )}
      </Text>
      {raw && open && (
        <Code block fz="xs" mt={4} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {typeof d === "string" ? d : JSON.stringify(d, null, 2)}
        </Code>
      )}
    </>
  );
}

export function HistoryList({ history }: { history: HistoryRow[] }) {
  if (history.length === 0) return <Text size="sm" c="dimmed">No history.</Text>;
  return (
    <Timeline bulletSize={12} lineWidth={2} color="gray" active={history.length - 1}>
      {history.map((h, i) => (
        <Timeline.Item key={i}>
          <Entry h={h} />
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
