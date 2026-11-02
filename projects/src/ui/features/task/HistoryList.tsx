// A task's history, oldest first: a sentence per entry (what happened, and the gist of it), who did it,
// when, and whether the session was tainted. The raw details are behind a disclosure.

import { Anchor, Badge, Code, Text, Timeline } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { HistoryRow } from "../../api/types";
import { ago, exact } from "../../common/time";
import { MetaItem, MetaRow, Row, Stack } from "../../layout";
import { actorLabel, detailOf, summarize } from "./history";

function Entry({ h }: { h: HistoryRow }) {
  const [open, { toggle }] = useDisclosure(false);
  const d = detailOf(h);
  // A short text detail is already the summary's; anything else is there on request.
  const raw = d !== null && (typeof d !== "string" || d.length > 120);
  return (
    <Stack gap="xs">
      <Row gap="sm">
        <Text fz="md" fw="medium">
          {summarize(h)}
        </Text>
        {h.tainted && (
          <Badge size="xs" color="gray" variant="outline">
            Tainted
          </Badge>
        )}
      </Row>
      <MetaRow>
        <MetaItem mono={h.actor.startsWith("agt_")}>{actorLabel(h.actor)}</MetaItem>
        <MetaItem title={exact(h.at_ms)}>{ago(h.at_ms)}</MetaItem>
        {raw && (
          <Anchor component="button" type="button" fz="xs" c="dimmed" underline="always" onClick={toggle} aria-expanded={open}>
            {open ? "Hide details" : "Details"}
          </Anchor>
        )}
      </MetaRow>
      {raw && open && (
        <Code block fz="xs">
          {typeof d === "string" ? d : JSON.stringify(d, null, 2)}
        </Code>
      )}
    </Stack>
  );
}

export function HistoryList({ history }: { history: HistoryRow[] }) {
  if (history.length === 0) {
    return (
      <Text fz="md" c="dimmed">
        No history.
      </Text>
    );
  }
  return (
    <Timeline color="gray" active={history.length - 1}>
      {history.map((h, i) => (
        <Timeline.Item key={i}>
          <Entry h={h} />
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
