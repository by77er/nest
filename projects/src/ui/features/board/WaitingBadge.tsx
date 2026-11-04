// "Waiting on N" (README.md#dependencies): a task's unfinished dependencies, on its card and in its
// drawer's header. Neutral (gray, light, with an hourglass), unlike Tainted's outline and Blocked's
// warning: nothing waits on the owner. Hover or focus lists each blocker and its state, one per line,
// below the badge so the card's title stays in view.

import { Text, Tooltip } from "@mantine/core";
import { IconHourglass } from "@tabler/icons-react";
import type { Task } from "../../api/types";
import { icon, Stack, TriggerBadge, weight } from "../../layout";
import { STATE_LABEL } from "../../status";

/** `plainOnTouch` on a card: plain status on a phone (the card opens the drawer, which lists them). */
export function WaitingBadge({ task, size = "sm", plainOnTouch = false }: { task: Task; size?: "sm" | "md"; plainOnTouch?: boolean }) {
  const waiting = task.blocked_by.filter((b) => task.waiting_on.includes(b.id));
  if (waiting.length === 0) return null;
  return (
    <Tooltip
      label={
        <Stack gap="2xs">
          <Text fz="xs" fw={weight.medium}>
            Waiting on
          </Text>
          {waiting.map((b) => (
            <Text key={b.id} fz="xs">
              {b.title}: {STATE_LABEL[b.state]}
            </Text>
          ))}
        </Stack>
      }
      position="bottom-start"
      withArrow
      multiline
      maw="var(--nest-side-panel)"
      events={{ hover: true, focus: true, touch: true }}
    >
      <TriggerBadge plainOnTouch={plainOnTouch} size={size} color="gray" variant="light" leftSection={<IconHourglass size={icon.sm} aria-hidden />} data-marker="waiting" aria-label={`Waiting on ${waiting.length}: ${waiting.map((b) => b.title).join(", ")}`}>
        Waiting on {waiting.length}
      </TriggerBadge>
    </Tooltip>
  );
}
