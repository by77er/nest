// A task's PRs (README.md#prs): each attached one with its state, its latest review and its auto-merge,
// detached by the owner while open; and attaching one, from the repo's open PRs or by number or URL. A
// task is done once all of its attached PRs have merged.

import { Anchor, Badge, Button, Text, TextInput } from "@mantine/core";
import { IconGitPullRequest } from "@tabler/icons-react";
import { useState } from "react";
import { useAttachPr, useDetachPr, useOpenPrs, useReviews } from "../../api/queries";
import type { Job, Task, TaskPr } from "../../api/types";
import { ago, exact } from "../../common/time";
import { MetaItem, Notice, Row, Section, Stack } from "../../layout";
import { Switcher } from "../../layout/Switcher";
import { TERMINAL } from "../../../tasks";
import { JobState } from "../reviews/ReviewsPage";

/** The PR's newest review job, if it has one. */
const latestReview = (jobs: Job[] | undefined, pr: number) => (jobs ?? []).filter((j) => j.pr === pr).sort((a, b) => b.created_ms - a.created_ms)[0];

function AutoMergeBadge({ pr }: { pr: TaskPr }) {
  const a = pr.auto_merge;
  if (!a || a.state === "failed") return null;
  return (
    <Badge size="sm" color={a.state === "enabled" ? "success" : "gray"} variant="light" title={a.error ?? exact(a.at_ms)}>
      {a.state === "enabled" ? `Auto-merge${a.method ? ` (${a.method})` : ""}` : a.state === "pending" ? "Auto-merge pending" : "Auto-merge off"}
    </Badge>
  );
}

function PrRow({ projectId, repo, task, pr, review }: { projectId: string; repo: string; task: Task; pr: TaskPr; review: Job | undefined }) {
  const detach = useDetachPr(projectId);
  return (
    <Stack gap="xs" data-pr={pr.number}>
      <Row gap="sm" justify="space-between" wrap="nowrap">
        <Row gap="sm">
          <Anchor href={`https://github.com/${repo}/pull/${pr.number}`} target="_blank" rel="noreferrer" fz="sm" fw="medium">
            #{pr.number}
          </Anchor>
          {pr.title && (
            <Text fz="sm" lineClamp={1}>
              {pr.title}
            </Text>
          )}
        </Row>
        {pr.state === "open" && !TERMINAL.has(task.state) && (
          <Button size="xs" variant="subtle" color="danger" loading={detach.isPending} onClick={() => detach.mutate({ task: task.id, pr: pr.number })} aria-label={`Detach PR #${pr.number}`}>
            Detach
          </Button>
        )}
      </Row>
      <Row gap="xs">
        <Badge size="sm" variant="light" color={pr.state === "merged" ? "success" : "primary"}>
          {pr.state === "merged" ? "Merged" : "Open"}
        </Badge>
        {review && <JobState job={review} />}
        <AutoMergeBadge pr={pr} />
        {pr.fork && (
          <Badge size="sm" color="gray" variant="outline">
            Fork
          </Badge>
        )}
        <MetaItem title={exact(pr.attached_ms)}>
          Attached by {pr.attached_by === "owner" ? "you" : pr.attached_by.startsWith("app:") ? "its branch" : pr.attached_by} {ago(pr.attached_ms)}
        </MetaItem>
      </Row>
      {pr.auto_merge?.state === "failed" && (
        <Notice tone="warning" title="Auto-merge wasn't changed on this PR">
          {pr.auto_merge.error}
        </Notice>
      )}
    </Stack>
  );
}

function AttachPr({ projectId, task }: { projectId: string; task: Task }) {
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState("");
  const open = useOpenPrs(projectId, opened);
  const attach = useAttachPr(projectId);
  const mine = new Set(task.prs.map((p) => p.number));
  const items = (open.data ?? []).filter((p) => !mine.has(p.number)).map((p) => ({
    value: String(p.number),
    label: `#${p.number} ${p.title}`,
    keywords: p.head,
    end: p.task ? <Badge size="sm" color="gray" variant="outline">On {p.task}</Badge> : p.fork ? <Badge size="sm" color="gray" variant="outline">Fork</Badge> : undefined,
  }));
  return (
    <Stack gap="sm">
      <Row gap="sm" onFocusCapture={() => setOpened(true)} onPointerDownCapture={() => setOpened(true)}>
        <Switcher
          icon={IconGitPullRequest}
          current={{ label: "Attach an open PR", ariaLabel: "Attach an open PR" }}
          items={items}
          searchLabel="Search the repo's open PRs"
          empty={(q) => (open.isPending ? "Loading the open PRs" : q ? `No open PR matches "${q}"` : "No other open PRs")}
          onPick={(v) => attach.mutate({ task: task.id, pr: Number(v) })}
        />
      </Row>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) attach.mutate({ task: task.id, pr: text.trim() }, { onSuccess: () => setText("") });
        }}
      >
        <Row gap="sm" align="flex-end" wrap="nowrap">
          <TextInput flex={1} label="Or a PR's number or URL" value={text} onChange={(e) => setText(e.currentTarget.value)} maxLength={300} />
          <Button type="submit" variant="default" loading={attach.isPending} disabled={!text.trim()}>
            Attach
          </Button>
        </Row>
      </form>
    </Stack>
  );
}

export function TaskPrs({ projectId, repo, task }: { projectId: string; repo: string; task: Task }) {
  const reviews = useReviews(projectId);
  return (
    <Section title="Pull requests" count={task.prs.length} region={false}>
      <Stack gap="lg">
        {task.prs.length === 0 ? (
          <Text fz="sm" c="dimmed">
            None attached. Its worker's PR attaches itself; the task is done once all attached PRs have merged.
          </Text>
        ) : (
          task.prs.map((p) => <PrRow key={p.number} projectId={projectId} repo={repo} task={task} pr={p} review={latestReview(reviews.data, p.number)} />)
        )}
        {!TERMINAL.has(task.state) && <AttachPr projectId={projectId} task={task} />}
      </Stack>
    </Section>
  );
}
