// Each project's repo binding (README.md#the-repos-binding): the repo by the name the project calls it,
// its GitHub id and how it was learned, a rename GitHub told and whether it's applied yet, and why the last
// read didn't bind it. Re-read reads it from GitHub again (never typed in): it binds a project that has no
// id and confirms one that matches; when GitHub's repo for the name is another, nothing changes, both are
// shown side by side, and only "Bind to this repo", confirmed, binds that one. A table from `sm`, a card
// per binding below it. A failed re-read is said in its row, which offers Retry.

import { Badge, Button, Divider, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconGitBranch, IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { useBindings, useRereadBinding } from "../../api/queries";
import type { BindingMismatch, RepoBinding, RereadBinding } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Row, Section, Stack, TableFrame, Token, usePhone, weight } from "../../layout";

/** How the id was learned, in a line. */
function boundText(b: RepoBinding): { text: string; title?: string } {
  if (b.repo_id === null) return { text: "Found by its name until it's read from GitHub" };
  const when = b.bound_ms === null ? "" : ` ${ago(b.bound_ms)}`;
  const title = b.bound_ms === null ? undefined : exact(b.bound_ms);
  return b.bound === "github" ? { text: `Read from GitHub${when}`, title } : { text: `From its first event${when}, not read from GitHub yet`, title };
}

/** What a re-read that bound or confirmed did, in a sentence (a mismatch is shown in its row instead). */
export function rereadText(name: string, r: Extract<RereadBinding, { changed: boolean }>): { tone: "success" | "warning"; message: string } {
  const parts = [r.changed ? `${name} is bound to GitHub's repo ${r.binding.repo_id}${r.previous_id === null ? "" : ` (was ${r.previous_id})`}.` : `${name}'s binding is as GitHub says.`];
  if (r.rename && "applied" in r.rename) parts.push(`It's called ${r.rename.applied} now.`);
  if (r.rename && "blocked" in r.rename) parts.push(`Renamed on GitHub to ${r.binding.renamed_to}, not applied: ${r.rename.blocked}.`);
  return { tone: r.rename && "blocked" in r.rename ? "warning" : "success", message: parts.join(" ") };
}

/** The App installation events must come from, once nest has named it (README.md#the-repos-binding). */
const installationText = (b: RepoBinding) =>
  b.installation_id === null ? "App installation not known yet: events from any installation are accepted" : `App installation ${b.installation_id}`;

/** Events refused for another App installation, and what to do about it (README.md#the-repos-binding). */
export function refusedText(b: RepoBinding, r: NonNullable<RepoBinding["refused"]>): string {
  const n = r.count === 1 ? "1 event" : `${r.count} events`;
  const from = r.installation === null ? "naming no App installation" : `from App installation ${r.installation}`;
  return `${n} refused, ${from}, not the project's (${b.installation_id ?? "none"}); the last ${ago(r.last_ms)}. If the App was reinstalled, Re-read to take its new installation. If it wasn't, nothing reached the project: no action needed.`;
}

const ownerText = (o: { id: number; login: string } | null) => (o ? `${o.login} (${o.id})` : "not known: learned from an event");

/** One side of the comparison: a repo's name, id and owner. */
function RepoSide({ label, r, slot }: { label: string; r: { full_name: string; id: number | null; owner: { id: number; login: string } | null }; slot: string }) {
  return (
    <Stack gap="2xs" flex={1} data-slot={slot}>
      <Text fz="sm" fw={weight.medium}>
        {label}
      </Text>
      <Text fz="sm" ff="monospace">
        {r.full_name}
      </Text>
      <MetaRow>
        <MetaItem mono>repo {r.id ?? "none"}</MetaItem>
        <MetaItem>owner {ownerText(r.owner)}</MetaItem>
      </MetaRow>
    </Stack>
  );
}

/** The choice a mismatch offers: quiet (light), since binding another repo is the exception the copy warns against. */
function BindButton({ b, m, busy, onBind }: { b: RepoBinding; m: BindingMismatch; busy: boolean; onBind: () => void }) {
  return (
    <Button variant="light" color="danger" loading={busy} onClick={onBind} aria-label={`Bind ${b.name} to ${m.github.full_name} (repo ${m.github.id})`}>
      Bind to this repo
    </Button>
  );
}

/**
 * The bound repo and GitHub's repo for its name, which differ: nothing changed until the operator chooses.
 * Side by side in the table; one above the other in a card, whose Bind comes last, after Re-read.
 */
function Mismatch({ b, m, busy, onBind, card }: { b: RepoBinding; m: BindingMismatch; busy: boolean; onBind: () => void; card: boolean }) {
  const owner =
    m.github.same_owner === null ? { text: "Its owner can't be compared: the bound repo's isn't known.", tone: undefined }
      : m.github.same_owner ? { text: "Same owner as the bound repo.", tone: undefined }
      : { text: "Another owner than the bound repo's: it may not be the project's repo at all.", tone: "danger" as const };
  return (
    <Stack gap="sm" data-slot="mismatch">
      <Text fz="sm" c="warning" data-tone="warning">
        GitHub&apos;s repo for this name isn&apos;t the bound one. Nothing changed: events still go to the bound repo.
      </Text>
      {card ? (
        <Stack gap="md">
          <RepoSide label="Bound" r={m.bound} slot="bound-repo" />
          <RepoSide label="GitHub now" r={m.github} slot="github-repo" />
        </Stack>
      ) : (
        <Row gap="xl" align="flex-start" wrap="nowrap">
          <RepoSide label="Bound" r={m.bound} slot="bound-repo" />
          <RepoSide label="GitHub now" r={m.github} slot="github-repo" />
        </Row>
      )}
      <Text fz="sm" c={owner.tone} data-tone={owner.tone}>
        {owner.text}
      </Text>
      {!card && (
        <Row>
          <BindButton b={b} m={m} busy={busy} onBind={onBind} />
        </Row>
      )}
    </Stack>
  );
}

/** What the last re-read of a binding left to show: a mismatch to choose on, or why it failed. */
interface Shown {
  mismatch: BindingMismatch | null;
  failure: string | null;
}

/**
 * The re-reads, and what each left to show, kept by the section: a row that remounts (the table and the
 * cards swap at `sm`) keeps them, and an answer that arrives meanwhile still lands.
 */
function useRereads() {
  const reread = useRereadBinding();
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const show = (project: string, s: Shown) => setShown((all) => ({ ...all, [project]: s }));
  const run = (b: RepoBinding, repo_id?: number) =>
    reread.mutate(
      { project: b.project, repo_id },
      {
        onSuccess: (r: RereadBinding) => {
          if ("mismatch" in r) {
            show(b.project, { mismatch: r.mismatch, failure: null });
            return;
          }
          show(b.project, { mismatch: null, failure: null });
          const t = rereadText(b.name, r);
          notifications.show({ color: t.tone, message: t.message });
        },
        onError: (e) => setShown((all) => ({ ...all, [b.project]: { mismatch: all[b.project]?.mismatch ?? null, failure: e.message } })),
      },
    );
  return { reread, shown, run };
}
type Rereads = ReturnType<typeof useRereads>;

/** A binding's state, read again, and what the operator can do: shared by the row and the card. */
function useBinding(b: RepoBinding, r: Rereads) {
  const { mismatch, failure } = r.shown[b.project] ?? { mismatch: null, failure: null };
  const bind = (m: BindingMismatch) =>
    modals.openConfirmModal({
      title: `Bind ${b.name} to ${m.github.full_name}?`,
      children: (
        <Stack gap="sm">
          <Text fz="md">
            GitHub&apos;s events for repo {m.github.id} ({m.github.full_name}, owner {ownerText(m.github.owner)}) will reach this project: its tasks, reviews and auto-merge. Events for the bound repo {m.bound.id} won&apos;t.
          </Text>
          <Text fz="md">Only do this if it&apos;s the project&apos;s repo.</Text>
        </Stack>
      ),
      labels: { confirm: "Bind to this repo", cancel: "Keep the bound one" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => r.run(b, m.github.id!),
    });
  const busy = r.reread.isPending && r.reread.variables?.project === b.project;
  return { busy, mismatch, failure, reread: () => r.run(b), bind };
}

/** Every problem a binding has, as badges, the most urgent first. */
export function statusBadges(b: RepoBinding, mismatch: boolean): { label: string; color: "danger" | "warning" }[] {
  return [
    mismatch && { label: "Mismatch", color: "danger" as const },
    b.refused && { label: "Events refused", color: "danger" as const },
    b.repo_id === null && { label: "Not bound", color: "danger" as const },
    b.renamed_to && { label: "Rename pending", color: "warning" as const },
  ].filter((x): x is { label: string; color: "danger" | "warning" } => !!x);
}

function Status({ b, mismatch }: { b: RepoBinding; mismatch: boolean }) {
  return (
    <>
      {statusBadges(b, mismatch).map((s) => (
        <Badge key={s.label} size="sm" color={s.color} variant="light">
          {s.label}
        </Badge>
      ))}
    </>
  );
}

/** The Bound cell (the card's middle): how it was learned, a pending rename, why it didn't bind, a failed re-read, a mismatch. */
function BoundDetail({ b, s, card = false }: { b: RepoBinding; s: ReturnType<typeof useBinding>; card?: boolean }) {
  const how = boundText(b);
  return (
    <Stack gap="xs">
      <Row gap="sm" wrap="wrap">
        <Status b={b} mismatch={s.mismatch !== null} />
        <Text fz="sm" c="dimmed" title={how.title}>
          {how.text}
        </Text>
      </Row>
      {b.renamed_to && (
        <Text fz="sm" c="warning" data-tone="warning">
          Renamed on GitHub to{" "}
          <Text component="span" ff="monospace" inherit>
            {b.renamed_to}
          </Text>
          : applied once nest&apos;s grant names it
        </Text>
      )}
      {b.refused && (
        <Text fz="sm" c="danger" data-tone="danger" data-slot="refused" title={exact(b.refused.last_ms)}>
          {refusedText(b, b.refused)}
        </Text>
      )}
      {b.error && (
        <Text fz="sm" c="danger" data-tone="danger" data-slot="bind-error">
          {b.error}
        </Text>
      )}
      {s.failure && (
        <Text fz="sm" c="danger" data-tone="danger" data-slot="reread-error" role="alert">
          Re-read failed: {s.failure}
        </Text>
      )}
      {s.mismatch && <Mismatch b={b} m={s.mismatch} busy={s.busy} onBind={() => s.bind(s.mismatch!)} card={card} />}
    </Stack>
  );
}

function RereadButton({ b, s }: { b: RepoBinding; s: ReturnType<typeof useBinding> }) {
  return (
    <Button variant="default" leftSection={<IconRefresh size={icon.md} />} loading={s.busy} onClick={s.reread} aria-label={`${s.failure ? "Retry reading" : "Re-read"} ${b.name}'s repo from GitHub`}>
      {s.failure ? "Retry" : "Re-read"}
    </Button>
  );
}

function BindingRow({ b, rereads }: { b: RepoBinding; rereads: Rereads }) {
  const s = useBinding(b, rereads);
  return (
    <Table.Tr data-binding={b.project}>
      <Table.Td>
        <Stack gap="2xs">
          <Text fz="sm">{b.name}</Text>
          <Text fz="xs" ff="monospace" c="dimmed">
            {b.repo}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap="2xs">
          {/* An id is one token: never broken across lines. */}
          <Token size="sm" nowrap dimmed={b.repo_id === null}>
            {b.repo_id ?? "None"}
          </Token>
          <Text fz="xs" c="dimmed" data-slot="installation">
            {installationText(b)}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <BoundDetail b={b} s={s} />
      </Table.Td>
      <Table.Td ta="right">
        <RereadButton b={b} s={s} />
      </Table.Td>
    </Table.Tr>
  );
}

/** Below `sm`: a binding as a card, top to bottom, so nothing of it is off screen. */
function BindingCard({ b, rereads }: { b: RepoBinding; rereads: Rereads }) {
  const s = useBinding(b, rereads);
  return (
    <Panel dense>
      <Stack gap="sm" role="listitem" data-binding={b.project}>
        <Stack gap="2xs">
          <Text fz="md" fw={weight.medium}>
            {b.name}
          </Text>
          <Text fz="xs" ff="monospace" c="dimmed">
            {b.repo}
          </Text>
        </Stack>
        <MetaRow>
          <MetaItem mono>GitHub id {b.repo_id ?? "none"}</MetaItem>
          <MetaItem>
            <span data-slot="installation">{installationText(b)}</span>
          </MetaItem>
        </MetaRow>
        <BoundDetail b={b} s={s} card />
        <Row>
          <RereadButton b={b} s={s} />
        </Row>
        {s.mismatch && (
          <>
            {/* The exception comes last, set apart. */}
            <Divider />
            <Row>
              <BindButton b={b} m={s.mismatch} busy={s.busy} onBind={() => s.bind(s.mismatch!)} />
            </Row>
          </>
        )}
      </Stack>
    </Panel>
  );
}

export function BindingsSection() {
  const bindings = useBindings();
  const phone = usePhone();
  const rereads = useRereads();
  return (
    <Section title="Repository bindings" count={bindings.data?.length} order={4} region={false}>
      <Stack gap="lg">
        <Text fz="md" c="dimmed">
          GitHub&apos;s events reach a project by its repo&apos;s id, read from GitHub when the repo is attached (or by a catalog sync for a project from before). Re-read confirms it. If GitHub&apos;s repo for the name is another one, nothing changes: both are shown, and you choose.
        </Text>
        {bindings.isPending ? (
          <LoadingState label="Loading the bindings" />
        ) : bindings.isError ? (
          <ErrorState title="The bindings couldn't be loaded" error={bindings.error} onRetry={() => void bindings.refetch()} />
        ) : bindings.data.length === 0 ? (
          <EmptyState icon={IconGitBranch} title="No projects yet" description="A project's repo is bound when it's created." />
        ) : phone ? (
          <Stack gap="md" role="list" aria-label="Repository bindings">
            {bindings.data.map((b) => (
              <BindingCard key={b.project} b={b} rereads={rereads} />
            ))}
          </Stack>
        ) : (
          <TableFrame label="Repository bindings">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>GitHub id</Table.Th>
                <Table.Th>Bound</Table.Th>
                <Table.Th>
                  <Text component="span" fz="sm" c="dimmed">
                    Actions
                  </Text>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {bindings.data.map((b) => (
                <BindingRow key={b.project} b={b} rereads={rereads} />
              ))}
            </Table.Tbody>
          </TableFrame>
        )}
      </Stack>
    </Section>
  );
}
