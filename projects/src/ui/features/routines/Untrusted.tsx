// The mark on what a tainted session wrote (README.md#memory, README.md#routines): a memory note or a
// proposed task whose agent read text anyone could write (an issue, a PR, a comment, the web). It's data,
// never instructions; the mark explains itself (on hover, focus or tap), and its source is shown beside it.

import { Tooltip } from "@mantine/core";
import { TriggerBadge } from "../../layout";

export const UNTRUSTED_HELP = "Written by an agent that read untrusted text (an issue, a PR, the web). Check it before you accept it or rely on it.";

export function UntrustedBadge({ what }: { what: string }) {
  return (
    <Tooltip label={UNTRUSTED_HELP} multiline maw="var(--nest-side-panel)">
      <TriggerBadge size="sm" variant="outline" color="gray" aria-label={`Tainted: ${what} — ${UNTRUSTED_HELP}`} data-marker="tainted">
        Tainted
      </TriggerBadge>
    </Tooltip>
  );
}

/** Who wrote a note last, in words: "the manager", "the routine Dreaming (run run_x)". */
export function sourceText(source: string): string {
  const m = /^routine:(.*) \((run_[a-z0-9]+)\)$/.exec(source);
  if (m) return `the routine ${m[1]} (run ${m[2]})`;
  return source === "manager" ? "the manager" : source;
}
