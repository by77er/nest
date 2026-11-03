// What the manager waits for (README.md#waiting): each pending wait in a line, "Waiting for #12 to merge
// · 2 h left", soonest deadline first. Nothing when it waits for nothing. Self-contained, so it can sit
// in the Manager page's context column.

import { Text } from "@mantine/core";
import { IconHourglass } from "@tabler/icons-react";
import { describe, human } from "../../../waits";
import { useWaits } from "../../api/queries";
import { exact } from "../../common/time";
import { MetaItem, Section, Stack } from "../../layout";

export function ManagerWaits({ projectId, now = Date.now() }: { projectId: string; now?: number }) {
  const waits = useWaits(projectId);
  const pending = [...(waits.data?.pending ?? [])].sort((a, b) => a.deadline_ms - b.deadline_ms);
  if (pending.length === 0) return null;
  return (
    <Section title="Waiting for" dense count={pending.length} region={false}>
      <Stack gap="xs" role="list" aria-label="The manager's waits" data-slot="waits">
        {pending.map((w) => (
          <div role="listitem" key={w.id} data-wait={w.id}>
            <MetaItem icon={IconHourglass} title={`Times out ${exact(w.deadline_ms)}`}>
              <Text component="span" fz="sm">
                Waiting for {describe(w)}
              </Text>
              {" · "}
              {w.deadline_ms > now ? `${human(w.deadline_ms - now)} left` : "timing out"}
            </MetaItem>
          </div>
        ))}
      </Stack>
    </Section>
  );
}
