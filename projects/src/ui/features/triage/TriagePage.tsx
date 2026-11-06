// Triage (README.md#triage): the repo's issues waiting for the owner, oldest first. Each shows its title,
// author, age and link, and its body as plain text (anyone can file an issue: nothing in it is rendered
// as markup, and no agent sees it until it's accepted). Accept makes a draft task of it, linked back;
// Decline takes it out, with an optional reason. A one-off import brings the repo's open issues.

import { Button, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconExternalLink, IconInbox } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useRef } from "react";
import { useAcceptIssue, useDeclineIssue, useImportIssues, useIssues } from "../../api/queries";
import type { Issue } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Prose, Section, Stack, Toolbar, weight } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";

/** How much of a body shows here; the rest is on GitHub. */
export const BODY_SHOWN = 1500;

function IssueItem({ projectId, issue }: { projectId: string; issue: Issue }) {
  const accept = useAcceptIssue(projectId);
  const decline = useDeclineIssue(projectId);
  const reason = useRef("");
  const body = issue.body.trim();
  const cut = body.length > BODY_SHOWN;
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
        {body ? <Prose size="sm">{cut ? `${body.slice(0, BODY_SHOWN)}…` : body}</Prose> : <Text fz="sm" c="dimmed">No description.</Text>}
        <Toolbar align="start">
          <Button
            loading={accept.isPending}
            onClick={() =>
              accept.mutate(issue.number, {
                // Plain text: a notification renders outside the router, so it holds no link.
                onSuccess: (t) => notifications.show({ color: "success", message: `Issue #${issue.number} is a draft task now: "${t.title}", on the board.` }),
              })}
            aria-label={`Accept issue #${issue.number}`}
          >
            Accept
          </Button>
          <Button variant="default" component="a" href={issue.url} target="_blank" rel="noreferrer" leftSection={<IconExternalLink size={icon.md} />} aria-label={`Issue #${issue.number} on GitHub`}>
            {cut ? "Read it all on GitHub" : "On GitHub"}
          </Button>
          <Button variant="subtle" color="danger" loading={decline.isPending} onClick={confirmDecline} aria-label={`Decline issue #${issue.number}`}>
            Decline
          </Button>
        </Toolbar>
      </Stack>
    </Panel>
  );
}

export function TriagePage() {
  const { projectId } = useParams({ from: "/projects/$projectId/triage" });
  const issues = useIssues(projectId);
  const importOpen = useImportIssues(projectId);
  const doImport = () =>
    importOpen.mutate(undefined, {
      onSuccess: (r) => notifications.show({ color: "success", message: r.imported ? `${r.imported} open issue${r.imported === 1 ? "" : "s"} brought into triage` : "No open issues to bring in" }),
    });
  return (
    <ProjectFrame projectId={projectId}>
      {() => (
        <Section
          title="Triage"
          count={issues.data?.length}
          actions={
            <Button variant="default" leftSection={<IconDownload size={icon.md} />} loading={importOpen.isPending} onClick={doImport}>
              Import open issues
            </Button>
          }
        >
          <Stack gap="lg">
            <Text fz="sm" c="dimmed">
              The repo's issues, as they're opened: accept one as a draft task, or decline it. Their text is anyone's: it's shown as it is, and no agent reads it until you accept it.
            </Text>
            {issues.isPending ? (
              <LoadingState label="Loading the issues" />
            ) : issues.isError ? (
              <ErrorState title="The issues couldn't be loaded" error={issues.error} onRetry={() => void issues.refetch()} />
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
      )}
    </ProjectFrame>
  );
}
