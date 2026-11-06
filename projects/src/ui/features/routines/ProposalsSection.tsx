// The tasks routines proposed, waiting for the owner (README.md#routines): each with its title, its
// routine and when, and its body as plain text (an agent wrote it after reading anyone's text, so nothing
// in it is rendered as markup or followed). Accept makes a draft task on the board; Decline drops it, with
// an optional reason (as an issue in triage is declined).

import { Badge, Button, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconInbox } from "@tabler/icons-react";
import { useRef } from "react";
import { useProposals, useTriageProposal } from "../../api/queries";
import type { Proposal } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, LoadingState, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, Toolbar } from "../../layout";

/** A proposal's body shown at most this long; the rest is in the task once accepted. */
const BODY_SHOWN = 1500;

function ProposalCard({ projectId, p }: { projectId: string; p: Proposal }) {
  const triage = useTriageProposal(projectId);
  const pending = triage.isPending ? triage.variables?.accept : undefined;
  const reason = useRef("");
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
    <Panel data-proposal={p.id}>
      <Stack gap="sm">
        <Row gap="sm">
          <Title order={4}>{p.title}</Title>
          <Badge size="sm" variant="outline" color="gray">
            Tainted
          </Badge>
        </Row>
        <MetaRow>
          <MetaItem>From {p.routine_name}</MetaItem>
          <MetaItem title={exact(p.created_ms)}>{ago(p.created_ms)}</MetaItem>
        </MetaRow>
        {p.body.trim() && <Prose size="sm">{p.body.length > BODY_SHOWN ? `${p.body.slice(0, BODY_SHOWN)}…` : p.body}</Prose>}
        <Toolbar aria-label={`Triage ${p.title}`}>
          <Button variant="default" size="xs" loading={pending === false} disabled={triage.isPending} onClick={confirmDecline}>
            Decline
          </Button>
          <Button size="xs" loading={pending === true} disabled={triage.isPending} onClick={() => triage.mutate({ proposal: p.id, accept: true })}>
            Accept as draft
          </Button>
        </Toolbar>
      </Stack>
    </Panel>
  );
}

export function ProposalsSection({ projectId }: { projectId: string }) {
  const proposals = useProposals(projectId);
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
          {proposals.data.map((p) => (
            <ProposalCard key={p.id} projectId={projectId} p={p} />
          ))}
        </Stack>
      )}
      {proposals.data && proposals.data.length > 0 && (
        <Text fz="xs" c="dimmed">
          Accepted, a proposal is a draft on the board for you or the manager to spec.
        </Text>
      )}
    </Section>
  );
}
