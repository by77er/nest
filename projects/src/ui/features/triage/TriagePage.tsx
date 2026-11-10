// Triage (README.md#triage): the repo's issues waiting for the owner, oldest first. Each shows its title,
// author, age and link, and its body as plain text (anyone can file an issue: nothing in it is rendered
// as markup, and no agent sees it until it's accepted), its first lines with "Show more" for the rest.
// Accept makes a draft task of it, linked back, of the text as the owner read it (one edited since is
// shown again, to accept again); Decline takes it out, with an optional reason. A one-off import brings
// the repo's open issues. The tasks routines proposed wait here too, under the issues, when there are any
// (`ProposalsSection`, the Routines page's).

import { Button, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconExternalLink, IconInbox } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useAcceptIssue, useDeclineIssue, useImportIssues, useIssues, useProject, useProposals } from "../../api/queries";
import { ApiError } from "../../api/client";
import type { Issue, Settings } from "../../api/types";
import { issuesFromWho, names } from "./words";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Notice, Panel, Prose, Row, Section, Stack, weight } from "../../layout";
import { AnchorLink } from "../../common/links";
import { MAX_UNTRIAGED_ISSUES } from "../../../issues";
import { ProjectFrame } from "../project/ProjectFrame";
import { ProposalsSection } from "../routines/ProposalsSection";

/** A body's preview: its first lines, and at most this much of them (about five lines on a wide card). */
export const PREVIEW_LINES = 5;
export const PREVIEW_CHARS = 400;

/** The body's first lines, or null when it's short enough to show whole. */
export function preview(body: string): string | null {
  const lines = body.split("\n");
  let out = lines.slice(0, PREVIEW_LINES).join("\n");
  if (out.length > PREVIEW_CHARS) out = out.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "");
  return out.length < body.length ? `${out.trimEnd()}…` : null;
}

function IssueItem({ projectId, issue }: { projectId: string; issue: Issue }) {
  const accept = useAcceptIssue(projectId);
  const decline = useDeclineIssue(projectId);
  const reason = useRef("");
  const [more, setMore] = useState(false);
  const bodyId = useId();
  const body = issue.body.trim();
  const short = preview(body);
  // Accept's refusal, shown here: the issue edited since it was read, or any other.
  const failed = accept.error;
  const changed = failed instanceof ApiError && failed.status === 409 && /changed since/.test(failed.message);
  const confirmDecline = () => {
    reason.current = "";
    modals.openConfirmModal({
      title: `Decline issue #${issue.number}?`,
      children: (
        <Stack gap="sm">
          <Text fz="md">It leaves triage. Nothing changes on GitHub: close the issue there if you want to.</Text>
          <TextInput label="Reason" description="Optional, kept with it." maxLength={500} onChange={(e) => (reason.current = e.currentTarget.value)} data-autofocus />
        </Stack>
      ),
      labels: { confirm: "Decline", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default" },
      onConfirm: () => decline.mutate({ n: issue.number, reason: reason.current.trim() }),
    });
  };
  return (
    <Panel data-issue={issue.number} role="listitem">
      <Stack gap="sm">
        <Text fz="md" fw={weight.medium}>
          {issue.title || `Issue #${issue.number}`}
        </Text>
        <MetaRow>
          <MetaItem>#{issue.number}</MetaItem>
          {issue.author && <MetaItem mono>{issue.author}</MetaItem>}
          <MetaItem title={exact(issue.opened_ms)}>{ago(issue.opened_ms)}</MetaItem>
        </MetaRow>
        {body ? (
          <Stack gap="xs" align="flex-start">
            <div id={bodyId}>
              <Prose size="sm">{short !== null && !more ? short : body}</Prose>
            </div>
            {short !== null && (
              <Button variant="subtle" color="gray" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-controls={bodyId}>
                {more ? "Show less" : "Show more"}
              </Button>
            )}
          </Stack>
        ) : (
          <Text fz="sm" c="dimmed">
            No description.
          </Text>
        )}
        {failed &&
          (changed ? (
            <Notice tone="warning" title="It changed since you read it" role="status">
              The issue was edited on GitHub. What's shown now is the new text: read it, then accept it again.
            </Notice>
          ) : (
            <Notice tone="danger" title="It wasn't accepted" role="alert">
              {failed.message}
            </Notice>
          ))}
        <Row justify="space-between">
          <Row gap="sm">
            <Button
              loading={accept.isPending}
              onClick={() =>
                accept.mutate(
                  { n: issue.number, updated_ms: issue.updated_ms },
                  {
                    // Plain text: a notification renders outside the router, so it holds no link.
                    onSuccess: (t) => notifications.show({ color: "success", message: `Issue #${issue.number} is a draft task now: "${t.title}", on the board.` }),
                  },
                )}
              aria-label={`Accept issue #${issue.number}`}
            >
              Accept
            </Button>
            <Button variant="default" component="a" href={issue.url} target="_blank" rel="noreferrer" leftSection={<IconExternalLink size={icon.md} />} aria-label={`Issue #${issue.number} on GitHub`}>
              On GitHub
            </Button>
          </Row>
          <Button variant="subtle" color="danger" loading={decline.isPending} onClick={confirmDecline} aria-label={`Decline issue #${issue.number}`}>
            Decline
          </Button>
        </Row>
      </Stack>
    </Panel>
  );
}

const issuesN = (n: number) => `${n} issue${n === 1 ? "" : "s"}`;

/** What an import did, in a sentence: what came in, and what it left out (others' issues, past the cap). */
export function importText(r: { imported: number; ignored: number; dropped: number }): string {
  const parts = [r.imported ? `${issuesN(r.imported)} brought into triage` : "No open issues to bring in"];
  if (r.ignored) parts.push(`${issuesN(r.ignored)} opened by others left out`);
  if (r.dropped) parts.push(`${issuesN(r.dropped)} past the ${MAX_UNTRIAGED_ISSUES} waiting left out`);
  return `${parts.join("; ")}.`;
}

/** Whose issues come in, by name (README.md#triage), as the page's caption says it. */
export function issuesCaption(s: Settings | null): string {
  if (!s || s.issues_from === "anyone") return "The repo's issues, anyone's, as they're opened: accept each as a draft task, or decline it.";
  const who = issuesFromWho(s);
  // No one counts yet: said in a Notice beside it (`NoOneYet`), with the way to Settings.
  if (!who.length) return "Issues opened by the PR comments user or the repo's owner, as they're opened: accept each as a draft task, or decline it.";
  return `Issues opened by ${names(who)}, as they're opened: accept each as a draft task, or decline it.`;
}

/**
 * No one's issues come in (an organization's repo with no PR comments user): as loud as Settings says it,
 * with the way there (its Triage panel).
 */
function NoOneYet({ projectId }: { projectId: string }) {
  return (
    <Notice tone="warning" title="No one's issues come in yet" role="status">
      <Stack gap="sm" align="flex-start">
        <Text fz="sm">
          Only issues opened by the PR comments user or the repo&apos;s owner come in, and no PR comments user is set and the repo&apos;s owner isn&apos;t known as a person. Set the PR comments user, or choose Anyone under Issues from.
        </Text>
        <Button variant="default" renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/settings" params={{ projectId }} hash="triage" />}>
          Open Settings
        </Button>
      </Stack>
    </Notice>
  );
}

export function TriagePage() {
  const { projectId } = useParams({ from: "/projects/$projectId/triage" });
  const issues = useIssues(projectId);
  const settings = useProject(projectId).data?.settings ?? null;
  const dropped = settings?.issues_dropped ?? null;
  // Proposals waiting (README.md#triage): then no issues is a quiet line, not the whole page's empty state.
  const proposalsWaiting = (useProposals(projectId).data?.length ?? 0) > 0;
  const importOpen = useImportIssues(projectId);
  const doImport = () =>
    importOpen.mutate(undefined, {
      onSuccess: (r) => notifications.show({ color: "success", message: importText(r) }),
    });
  return (
    <ProjectFrame projectId={projectId}>
      {() => (
        <Stack gap="2xl">
          <Section
            title="Issues"
            count={issues.data?.length}
            actions={
              <Button variant="default" leftSection={<IconDownload size={icon.md} />} loading={importOpen.isPending} onClick={doImport}>
                Import open issues
              </Button>
            }
          >
            <Stack gap="lg">
              <Text fz="sm" c="dimmed">
                {issuesCaption(settings)} Their text is shown as it is, and no agent reads it until you accept it.
              </Text>
              {settings && settings.issues_from !== "anyone" && !issuesFromWho(settings).length && <NoOneYet projectId={projectId} />}
              {dropped && (
                <Notice tone="warning" title={`${dropped.count === 1 ? "1 issue" : `${dropped.count} issues`} left out`} role="status">
                  Triage holds at most {MAX_UNTRIAGED_ISSUES} issues waiting, so {dropped.count === 1 ? "it wasn't" : "they weren't"} brought in (the last {ago(dropped.last_ms)}). Accept or decline some, then Import open issues to bring the rest in.
                </Notice>
              )}
              {issues.isPending ? (
                <LoadingState label="Loading the issues" />
              ) : issues.isError ? (
                <ErrorState title="The issues couldn't be loaded" error={issues.error} onRetry={() => void issues.refetch()} />
              ) : issues.data.length === 0 && proposalsWaiting ? (
                <Text fz="sm" c="dimmed" data-slot="no-issues">
                  No issues to triage.
                </Text>
              ) : issues.data.length === 0 ? (
                <Panel>
                  <EmptyState
                    icon={IconInbox}
                    title="Nothing to triage"
                    description="Issues opened on the repo come here. Ones opened before the app was set up come in with Import open issues."
                  />
                </Panel>
              ) : (
                <Stack gap="md" role="list" aria-label="Issues to triage">
                  {issues.data.map((i) => (
                    <IssueItem key={i.number} projectId={projectId} issue={i} />
                  ))}
                </Stack>
              )}
            </Stack>
          </Section>
          <ProposalsSection projectId={projectId} quietWhenEmpty />
        </Stack>
      )}
    </ProjectFrame>
  );
}
