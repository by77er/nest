// The tasks routines proposed, waiting for the owner (README.md#routines): each with its title, its
// routine, run and when, and its body as plain text (an agent wrote it after reading anyone's text, so
// nothing in it is rendered as markup or followed), its first lines with "Show more" for the rest, as
// Triage shows an issue. Accept makes a draft task on the board; Decline, at the right edge as on Triage,
// drops it with an optional reason.

import { Button, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconInbox } from "@tabler/icons-react";
import { useId, useRef, useState } from "react";
import { useProposals, useTriageProposal } from "../../api/queries";
import type { Proposal } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, LoadingState, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, weight } from "../../layout";
import { preview } from "../triage/TriagePage";
import { UntrustedBadge } from "./Untrusted";

function ProposalCard({ projectId, p }: { projectId: string; p: Proposal }) {
  const triage = useTriageProposal(projectId);
  const pending = triage.isPending ? triage.variables?.accept : undefined;
  const reason = useRef("");
  const [more, setMore] = useState(false);
  const bodyId = useId();
  const body = p.body.trim();
  const short = preview(body);
  const confirmDecline = () => {
    reason.current = "";
    modals.openConfirmModal({
      title: `Decline “${p.title}”?`,
      children: (
        <Stack gap="sm">
          <Text fz="md">It leaves the queue; no task is made.</Text>
          <TextInput label="Reason" description="Optional, kept with it." maxLength={500} onChange={(e) => (reason.current = e.currentTarget.value)} data-autofocus />
        </Stack>
      ),
      labels: { confirm: "Decline", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default" },
      onConfirm: () => triage.mutate({ proposal: p.id, accept: false, reason: reason.current.trim() }),
    });
  };
  return (
    <Panel data-proposal={p.id} role="listitem">
      <Stack gap="sm">
        <Text fz="md" fw={weight.medium}>
          {p.title}
        </Text>
        <MetaRow>
          <UntrustedBadge what={`the proposed task “${p.title}”`} />
          <MetaItem>From the routine {p.routine_name} (run {p.run})</MetaItem>
          <MetaItem title={exact(p.created_ms)}>{ago(p.created_ms)}</MetaItem>
        </MetaRow>
        {body && (
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
        )}
        <Row justify="space-between">
          <Button loading={pending === true} disabled={triage.isPending} onClick={() => triage.mutate({ proposal: p.id, accept: true })} aria-label={`Accept “${p.title}” as a draft`}>
            Accept as draft
          </Button>
          <Button variant="subtle" color="danger" loading={pending === false} disabled={triage.isPending} onClick={confirmDecline} aria-label={`Decline “${p.title}”`}>
            Decline
          </Button>
        </Row>
      </Stack>
    </Panel>
  );
}

/** Proposals shown before "Show all": the oldest first, as Triage lists issues. */
export const PROPOSALS_SHOWN = 10;

export function ProposalsSection({ projectId }: { projectId: string }) {
  const proposals = useProposals(projectId);
  const [all, setAll] = useState(false);
  const list = proposals.data ?? [];
  const shown = all ? list : list.slice(0, PROPOSALS_SHOWN);
  return (
    <Section title="Proposed tasks" count={proposals.data?.length}>
      {proposals.isPending ? (
        <LoadingState label="Loading the proposed tasks" />
      ) : proposals.isError ? (
        <ErrorState title="The proposed tasks couldn't be loaded" error={proposals.error} onRetry={() => void proposals.refetch()} />
      ) : proposals.data.length === 0 ? (
        <Panel>
          <EmptyState icon={IconInbox} title="Nothing proposed" description="Tasks a routine proposes wait here for you to accept or decline." />
        </Panel>
      ) : (
        <Stack gap="md">
          <Text fz="sm" c="dimmed">
            Routines propose these from what their agents read. Check each before you accept it: accepted, it's a draft on the board for you or the manager to spec.
          </Text>
          <Stack gap="md" role="list" aria-label="Proposed tasks">
            {shown.map((p) => (
              <ProposalCard key={p.id} projectId={projectId} p={p} />
            ))}
          </Stack>
          {list.length > PROPOSALS_SHOWN && (
            <Row>
              <Button variant="default" onClick={() => setAll((x) => !x)} aria-expanded={all}>
                {all ? "Show the first 10" : `Show all (${list.length})`}
              </Button>
            </Row>
          )}
        </Stack>
      )}
    </Section>
  );
}
