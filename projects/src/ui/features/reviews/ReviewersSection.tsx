// The project's reviewers (README.md#reviewers), on the Reviews page under its reviews: how they run, said
// once; a warning when none is on (PRs then aren't reviewed, and the required check passes without a review);
// each reviewer as a Panel, as the Routines page shows a routine (its name, "Off", "Tainted", its dimensions
// and instructions, "By the manager" when the manager last wrote it; Edit at the top right); "Add reviewer"
// (the built-in Code review in one click while the project doesn't have it, or a custom one); the editor in
// a Sheet, its Delete last, set apart and confirmed.

import { Badge, Button, Menu, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconChevronDown, IconPlus, IconShieldCheck } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { type RefObject, useId, useState } from "react";
import { MAX_REVIEWERS, REVIEWER_PRESET_IDS } from "../../../requests";
import { useAddReviewerPreset, useDeleteReviewer } from "../../api/queries";
import type { Reviewer } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Notice, Panel, Row, Section, SectionGrid, Sheet, Stack } from "../../layout";
import { sourceText, UntrustedBadge } from "../routines/Untrusted";
import { ReviewerForm } from "./ReviewerForm";

const BUILT_IN = REVIEWER_PRESET_IDS.code;

/** What no reviewer on means: said in the section, and at the top of the page while reviews push it down. */
export const NONE_ON = "PRs aren't reviewed, and the required check passes without a review.";

function AddReviewer({ projectId, reviewers, full, describedBy, onCustom }: { projectId: string; reviewers: Reviewer[]; full: boolean; describedBy?: string; onCustom: () => void }) {
  const add = useAddReviewerPreset(projectId);
  const button = (props: object) => (
    <Button leftSection={<IconPlus size={icon.md} />} disabled={full} aria-describedby={describedBy} loading={add.isPending} {...props}>
      Add reviewer
    </Button>
  );
  // With the built-in there, a custom reviewer is the only choice: no menu of one.
  if (full || reviewers.some((r) => r.id === BUILT_IN.id)) return button({ onClick: onCustom });
  return (
    <Menu position="bottom-end" shadow="overlay">
      <Menu.Target>{button({ rightSection: <IconChevronDown size={icon.sm} /> })}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconShieldCheck size={icon.md} />} onClick={() => add.mutate("code")}>
          {BUILT_IN.name}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item leftSection={<IconPlus size={icon.md} />} onClick={onCustom}>
          Custom reviewer…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function ReviewerCard({ r, onEdit }: { r: Reviewer; onEdit: () => void }) {
  return (
    <Panel data-reviewer={r.id}>
      <Stack gap="sm">
        <Row justify="space-between" wrap="nowrap" align="flex-start">
          <Row gap="sm">
            <Title order={4}>{r.name}</Title>
            {!r.enabled && (
              <Badge size="sm" variant="outline" color="gray" data-slot="status">
                Off
              </Badge>
            )}
            {r.tainted && <UntrustedBadge what={`the reviewer ${r.name}`} />}
          </Row>
          <Button variant="subtle" color="gray" size="xs" onClick={onEdit} aria-label={`Edit ${r.name}`}>
            Edit
          </Button>
        </Row>
        <Text fz="sm" data-slot="dimensions">
          {r.dimensions.join(" · ")}
        </Text>
        <Text fz="sm" c="dimmed" lineClamp={2} data-slot="instructions">
          {r.instructions}
        </Text>
        <MetaRow>
          {/* Only the manager's: an owner-written reviewer says nothing of who wrote it. */}
          {r.source === "manager" && <MetaItem>By {sourceText(r.source)}</MetaItem>}
          <MetaItem title={exact(r.updated_ms)}>Updated {ago(r.updated_ms)}</MetaItem>
        </MetaRow>
      </Stack>
    </Panel>
  );
}

/** `reviewers`: the page's `useReviewers`, which its own warning reads too. */
export function ReviewersSection({ projectId, reviewers, headingRef }: { projectId: string; reviewers: UseQueryResult<Reviewer[]>; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  const del = useDeleteReviewer(projectId);
  const [editing, setEditing] = useState<Reviewer | "new" | null>(null);
  const fullId = useId();
  const list = reviewers.data ?? [];
  const full = list.length >= MAX_REVIEWERS;
  const on = list.filter((r) => r.enabled);
  const close = () => setEditing(null);
  const editingReviewer = editing && editing !== "new" ? list.find((r) => r.id === editing.id) ?? editing : undefined;

  const confirmDelete = (r: Reviewer) =>
    modals.openConfirmModal({
      title: `Delete ${r.name}?`,
      children: (
        <Text fz="md">
          Reviews already under way keep it; no PR head after this gets its review.
          {r.enabled && on.length === 1 ? ` It's the only reviewer on: without it, PRs aren't reviewed, and the required check passes without a review.` : ""}
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => del.mutate(r.id, { onSuccess: close }),
    });

  return (
    <Section
      title="Reviewers"
      count={reviewers.data?.length}
      headingRef={headingRef}
      actions={reviewers.data && <AddReviewer projectId={projectId} reviewers={list} full={full} describedBy={full ? fullId : undefined} onCustom={() => setEditing("new")} />}
    >
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          Every reviewer that's on reviews each PR head, one after another; the review check passes only if all of them pass.
        </Text>
        {full && (
          <Text fz="sm" c="dimmed" id={fullId} data-slot="full">
            A project holds at most {MAX_REVIEWERS} reviewers: delete one to add another.
          </Text>
        )}
        {reviewers.data && on.length === 0 && (
          <Notice tone="warning" title="No reviewer is on" role="status">
            {NONE_ON}
          </Notice>
        )}
        {reviewers.isPending ? (
          <LoadingState label="Loading the reviewers" />
        ) : reviewers.isError ? (
          <ErrorState title="The reviewers couldn't be loaded" error={reviewers.error} onRetry={() => void reviewers.refetch()} />
        ) : list.length === 0 ? (
          <Panel>
            <EmptyState icon={IconShieldCheck} title="No reviewers" description={`Add the built-in ${BUILT_IN.name}, which judges correctness, quality and architectural cohesiveness, or a reviewer of your own.`} />
          </Panel>
        ) : (
          <SectionGrid>
            {list.map((r) => (
              <ReviewerCard key={r.id} r={r} onEdit={() => setEditing(r)} />
            ))}
          </SectionGrid>
        )}
      </Stack>
      <Sheet opened={editing !== null} onClose={close} title={editingReviewer ? `Edit ${editingReviewer.name}` : "New reviewer"} closeOnEscape>
        {editing !== null && (
          <Stack gap="2xl">
            <ReviewerForm key={editingReviewer?.id ?? "new"} projectId={projectId} editing={editingReviewer} onDone={close} />
            {editingReviewer && (
              <Section title="Delete" order={4} region={false}>
                <Stack gap="sm">
                  <Text fz="sm" c="dimmed">
                    Reviews already under way keep it.
                  </Text>
                  <Row>
                    <Button variant="default" color="danger" onClick={() => confirmDelete(editingReviewer)}>
                      Delete reviewer
                    </Button>
                  </Row>
                </Stack>
              </Section>
            )}
          </Stack>
        )}
      </Sheet>
    </Section>
  );
}
