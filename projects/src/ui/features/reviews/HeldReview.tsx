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

/** Whose PR, and why it waits: "A fork's PR by mallory" (the fork is the reason), or "A PR by mallory, who isn't someone the project trusts". */
export function heldFrom(h: Pick<Held, "author" | "fork">): string {
  if (h.fork) return `A fork's PR${h.author ? ` by ${h.author}` : ""}`;
  return h.author ? `A PR by ${h.author}, who isn't someone the project trusts` : "A PR whose author the project doesn't know";
}

/**
 * Review this PR and Dismiss. Review is the filled action only where the review waits on the owner now
 * (`primary`); on a row the owner already dismissed, or one waiting its turn, it is a default button.
 */
export function HeldActions({ projectId, held, dismiss = true, primary = true }: { projectId: string; held: Held; dismiss?: boolean; primary?: boolean }) {
  const approve = useApproveReview(projectId);
  const drop = useDismissReview(projectId);
  const key = { pr: held.pr, sha: held.sha };
  return (
    <Toolbar align="start">
      <Button size="xs" variant={primary ? "filled" : "default"} loading={approve.isPending} disabled={drop.isPending} onClick={() => approve.mutate(key)} aria-label={`Review PR #${held.pr}`}>
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

/** In "Needs you": the PR, who it's from, what approving does (in full on the first held review shown, short after), and the two actions. */
export function HeldReviewItem({ projectId, repo, item, full = true }: { projectId: string; repo: string | undefined; item: Item; full?: boolean }) {
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
        {full ? "Its review waits for your approval. Reviewing starts a reviewer agent on this commit's code; a later push waits again." : "Its review waits for your approval."}
      </Text>
      <HeldActions projectId={projectId} held={item} />
    </Stack>
  );
}
