// A task's PRs (README.md#prs): each attached one, its number and title, then its state, latest review
// and auto-merge (details on hover or focus), detached by the owner while open, confirmed; and attaching
// one from the section's top right: a picker over the repo's open PRs, whose search also takes a PR's
// number or URL. A task is done once all of its attached PRs have merged.

import { Anchor, Badge, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconGitPullRequest } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { prNumberOf } from "../../../prs";
import { useAttachPr, useDetachPr, useOpenPrs, useReviews, useTasks } from "../../api/queries";
import type { Job, Task, TaskPr } from "../../api/types";
import { ago, exact } from "../../common/time";
import { Grow, MetaItem, MetaRow, Picker, Row, RowAction, Section, Stack, TriggerBadge, type PickerItem, weight } from "../../layout";
import { TERMINAL } from "../../../tasks";
import { JobState } from "../reviews/ReviewsPage";

/** The PR's newest review job, if it has one. */
const latestReview = (jobs: Job[] | undefined, pr: number) => (jobs ?? []).filter((j) => j.pr === pr).sort((a, b) => b.created_ms - a.created_ms)[0];

/** Its auto-merge: none once merged; its details (method, or GitHub's refusal) on hover or focus. */
function AutoMergeBadge({ pr }: { pr: TaskPr }) {
  const a = pr.auto_merge;
  if (!a || pr.state === "merged" || a.state === "disabled") return null;
  const failed = a.state === "failed";
  const label = failed ? "Auto-merge failed" : a.state === "enabled" ? "Auto-merge" : "Auto-merge pending";
  const details = failed ? a.error ?? "GitHub refused it" : a.state === "enabled" ? `Merges${a.method ? ` by ${a.method}` : ""} once its review and the branch's checks pass` : a.error ? `Retrying: ${a.error}` : "Being turned on";
  return (
    <Tooltip label={details} withArrow multiline maw="var(--nest-side-panel)" events={{ hover: true, focus: true, touch: true }}>
      <TriggerBadge size="sm" color={failed ? "warning" : a.state === "enabled" ? "success" : "gray"} variant="light" data-marker="auto-merge" aria-label={`${label}: ${details}`}>
        {label}
      </TriggerBadge>
    </Tooltip>
  );
}

function PrRow({ projectId, repo, task, pr, review, onDetached }: { projectId: string; repo: string; task: Task; pr: TaskPr; review: Job | undefined; onDetached: () => void }) {
  const detach = useDetachPr(projectId);
  const confirm = () =>
    modals.openConfirmModal({
      title: `Detach #${pr.number}?`,
      children: (
        <Text fz="md">
          {pr.auto_merge?.state === "enabled" || pr.auto_merge?.state === "pending" ? "Its auto-merge is turned off. " : ""}It stays open on GitHub; this task no longer waits for it to merge.
        </Text>
      ),
      labels: { confirm: "Detach", cancel: "Cancel" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      // Its row goes: focus moves to "Attach PR", not to nowhere.
      onConfirm: () => detach.mutate({ task: task.id, pr: pr.number }, { onSuccess: onDetached }),
    });
  return (
    // Its title row (the PR's link, Detach) and its badges row (auto-merge's details) are controls a
    // 44 px pitch apart on touch; the PRs themselves move apart to keep each one's lines a group.
    <Stack gap="xs" data-pr={pr.number} data-touch-pitch>
      <Row gap="sm" wrap="nowrap">
        <Anchor href={`https://github.com/${repo}/pull/${pr.number}`} target="_blank" rel="noreferrer" fz="sm" fw={weight.medium}>
          #{pr.number}
        </Anchor>
        <Grow>
          <Text fz="sm">
            {pr.title ?? ""}
          </Text>
        </Grow>
        {pr.state === "open" && !TERMINAL.has(task.state) && (
          <RowAction variant="subtle" color="danger" loading={detach.isPending} onClick={confirm} aria-label={`Detach PR #${pr.number}`}>
            Detach
          </RowAction>
        )}
      </Row>
      <Row gap="xs">
        <Badge size="sm" variant="light" color={pr.state === "merged" ? "success" : "primary"}>
          {pr.state === "merged" ? "Merged" : "Open"}
        </Badge>
        {review && <JobState job={review} size="sm" />}
        <AutoMergeBadge pr={pr} />
        {pr.fork && (
          <Badge size="sm" color="gray" variant="outline">
            Fork
          </Badge>
        )}
      </Row>
      {/* Three lines: its number and title, its badges, who attached it. */}
      <MetaRow>
        <MetaItem title={exact(pr.attached_ms)}>
          Attached by {pr.attached_by === "owner" ? "you" : pr.attached_by.startsWith("app:") ? "its branch" : pr.attached_by} {ago(pr.attached_ms)}
        </MetaItem>
      </MetaRow>
    </Stack>
  );
}

/** "Attach PR": the repo's open PRs (one on another task shown, not pickable), or a number or URL typed. */
function AttachPr({ projectId, repo, task, buttonRef }: { projectId: string; repo: string; task: Task; buttonRef: React.Ref<HTMLButtonElement> }) {
  const [opened, setOpened] = useState(false);
  const open = useOpenPrs(projectId, opened);
  const tasks = useTasks(projectId);
  const attach = useAttachPr(projectId);
  const mine = new Set(task.prs.map((p) => p.number));
  const titleOf = (id: string) => tasks.data?.find((t) => t.id === id)?.title ?? id;
  const items: PickerItem[] = (open.data ?? []).filter((p) => !mine.has(p.number)).map((p) => ({
    value: String(p.number),
    label: `#${p.number} ${p.title}`,
    keywords: p.head,
    disabled: p.task !== null,
    // Why it can't be picked, or what it is, as a quiet line under its label.
    caption: p.task ? `Attached to ${titleOf(p.task)}` : p.fork ? "From a fork" : undefined,
  }));
  // A number, #n or the PR's URL, typed: the listed PR if it is one, else offered as "Attach #n".
  const fromSearch = (s: string): PickerItem | null => {
    const n = s ? prNumberOf(s, repo) : null;
    if (n === null || mine.has(n)) return null;
    return items.find((i) => i.value === String(n)) ?? { value: String(n), label: `Attach #${n}` };
  };
  return (
    <Picker
      buttonRef={buttonRef}
      label="Attach PR"
      icon={IconGitPullRequest}
      items={items}
      searchLabel="An open PR, its number or its URL"
      fromSearch={fromSearch}
      onOpen={() => setOpened(true)}
      loading={open.isPending && opened}
      error={open.isError ? "The open PRs couldn't be loaded" : null}
      onRetry={() => void open.refetch()}
      busy={attach.isPending}
      empty={(q) => (q ? `No open PR matches "${q}": type its number or URL` : "No other open PRs: type a PR's number or URL")}
      onPick={(v) => attach.mutate({ task: task.id, pr: Number(v) })}
    />
  );
}

export function TaskPrs({ projectId, repo, task }: { projectId: string; repo: string; task: Task }) {
  const reviews = useReviews(projectId);
  const attach = useRef<HTMLButtonElement>(null);
  const focusAttach = () => requestAnimationFrame(() => attach.current?.focus());
  return (
    <Section title="Pull requests" count={task.prs.length} region={false} actions={!TERMINAL.has(task.state) && <AttachPr projectId={projectId} repo={repo} task={task} buttonRef={attach} />}>
      {/* Each PR's lines stay tight; PRs are 2xl apart, more than twice the gap within one, on touch too. */}
      <Stack gap="2xl" data-touch-group-gap>
        {task.prs.length === 0 ? (
          <Text fz="sm" c="dimmed">
            None attached. Its worker's PR attaches itself; the task is done once all attached PRs have merged.
          </Text>
        ) : (
          task.prs.map((p) => <PrRow key={p.number} projectId={projectId} repo={repo} task={task} pr={p} review={latestReview(reviews.data, p.number)} onDetached={focusAttach} />)
        )}
      </Stack>
    </Section>
  );
}
