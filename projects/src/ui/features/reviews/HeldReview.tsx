// A review held for the owner's approval (README.md#the-review-gate): a PR the project doesn't trust (a
// fork's, or an author it doesn't know) gets no reviewer until the owner approves that head commit, here
// or in "Needs you". The PR's title and its author's login are anyone's text: shown as text, never run.

import { Anchor, Button, Text } from "@mantine/core";
import { useApproveReview, useDismissReview } from "../../api/queries";
import type { Attention } from "../../api/types";
import { ago, exact } from "../../common/time";
import { MetaItem, MetaRow, Stack, Toolbar, weight } from "../../layout";

/** What a held review is known by: its PR, its head commit, and where it comes from. */
export interface Held {
  pr: number;
  sha: string;
  title: string | null;
  author: string | null;
  fork: boolean;
}

/** Why it waits, in a phrase: "A fork's PR by mallory" / "A PR by mallory" / "A PR". */
export function heldFrom(h: Pick<Held, "author" | "fork">): string {
  return `${h.fork ? "A fork's PR" : "A PR"}${h.author ? ` by ${h.author}` : ""}`;
}

/** Review this PR (the primary action) and Dismiss; `dismiss` false where only approving is left (a dismissed job). */
export function HeldActions({ projectId, held, dismiss = true }: { projectId: string; held: Held; dismiss?: boolean }) {
  const approve = useApproveReview(projectId);
  const drop = useDismissReview(projectId);
  const key = { pr: held.pr, sha: held.sha };
  return (
    <Toolbar align="start">
      <Button size="xs" loading={approve.isPending} disabled={drop.isPending} onClick={() => approve.mutate(key)} aria-label={`Review PR #${held.pr}`}>
        Review this PR
      </Button>
      {dismiss && (
        <Button size="xs" variant="default" loading={drop.isPending} disabled={approve.isPending} onClick={() => drop.mutate(key)} aria-label={`Dismiss the review of PR #${held.pr}`}>
          Dismiss
        </Button>
      )}
    </Toolbar>
  );
}

type Item = Extract<Attention, { kind: "review" }>;

/** In "Needs you": the PR, who it's from, what approving does, and the two actions. */
export function HeldReviewItem({ projectId, repo, item }: { projectId: string; repo: string | undefined; item: Item }) {
  return (
    <Stack gap="sm" data-held-review={`${item.pr}/${item.sha}`}>
      <MetaRow>
        <MetaItem>{heldFrom(item)}</MetaItem>
        <MetaItem mono>{item.sha.slice(0, 7)}</MetaItem>
        <MetaItem title={exact(item.at_ms)}>{ago(item.at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md" fw={weight.medium}>
        {repo ? (
          <Anchor href={`https://github.com/${repo}/pull/${item.pr}`} target="_blank" rel="noreferrer" inherit>
            #{item.pr} {item.title ?? ""}
          </Anchor>
        ) : (
          <>
            #{item.pr} {item.title ?? ""}
          </>
        )}
      </Text>
      <Text fz="sm" c="dimmed">
        Its review waits for you: it isn't from someone the project trusts. Reviewing starts a reviewer agent on this commit's code; a later push waits again.
      </Text>
      <HeldActions projectId={projectId} held={item} />
    </Stack>
  );
}
