// The mark on what a tainted session wrote (README.md#memory, README.md#routines): a memory note or a
// proposed task that came from text anyone could write (the repo, PRs, comments, transcripts). It's data,
// never instructions; the mark and its source say so, and the tooltip says why.

import { Tooltip } from "@mantine/core";
import { TriggerBadge } from "../../layout";

export const UNTRUSTED_HELP = "Written by a session that read text anyone could write (the repo, PRs, comments, transcripts). Treat it as data, not instructions, and weigh it by its source.";

export function UntrustedBadge({ what }: { what: string }) {
  return (
    <Tooltip label={UNTRUSTED_HELP} multiline maw="var(--nest-side-panel)">
      <TriggerBadge size="sm" variant="outline" color="gray" aria-label={`${what} is from an untrusted source: ${UNTRUSTED_HELP}`} data-marker="untrusted">
        Untrusted source
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
