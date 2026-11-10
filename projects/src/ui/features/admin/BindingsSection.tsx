// Each project's repo binding (README.md#the-repos-binding): the repo by the name the project calls it,
// its GitHub id and how it was learned, a rename GitHub told and whether it's applied yet, and why the last
// read didn't bind it. Re-read reads it from GitHub again (never typed in): the id, whatever was bound, and
// a rename applied once nest's grant names the new name.

import { Button, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconGitBranch, IconRefresh } from "@tabler/icons-react";
import { useBindings, useRereadBinding } from "../../api/queries";
import type { RepoBinding, RereadBinding } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, Section, Stack, TableFrame, Token } from "../../layout";

function bound(b: RepoBinding): { text: string; title?: string; dimmed: boolean } {
  if (b.repo_id === null) return { text: "Not bound yet: found by its name", dimmed: true };
  const when = b.bound_ms === null ? "" : ` ${ago(b.bound_ms)}`;
  const title = b.bound_ms === null ? undefined : exact(b.bound_ms);
  return b.bound === "github" ? { text: `Read from GitHub${when}`, title, dimmed: true } : { text: `From its first event${when}, not read from GitHub yet`, title, dimmed: true };
}

/** What a re-read did, in a sentence. */
export function rereadText(name: string, r: RereadBinding): { tone: "success" | "warning"; message: string } {
  const parts = [r.changed ? `${name} is bound to GitHub's repo ${r.binding.repo_id}${r.previous_id === null ? "" : ` (was ${r.previous_id})`}.` : `${name}'s binding is as GitHub says.`];
  if (r.rename && "applied" in r.rename) parts.push(`It's called ${r.rename.applied} now.`);
  if (r.rename && "blocked" in r.rename) parts.push(`Renamed on GitHub to ${r.binding.renamed_to}, not applied: ${r.rename.blocked}.`);
  return { tone: r.rename && "blocked" in r.rename ? "warning" : "success", message: parts.join(" ") };
}

function Row_({ b }: { b: RepoBinding }) {
  const reread = useRereadBinding();
  const how = bound(b);
  const run = () =>
    reread.mutate(b.project, {
      onSuccess: (r) => {
        const t = rereadText(b.name, r);
        notifications.show({ color: t.tone, message: t.message });
      },
      onError: (e) => notifications.show({ color: "danger", title: `${b.name} wasn't read again`, message: e.message }),
    });
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
        {/* An id is one token: never broken across lines. */}
        <Token size="sm" nowrap dimmed={b.repo_id === null}>
          {b.repo_id ?? "None"}
        </Token>
      </Table.Td>
      <Table.Td>
        <Stack gap="2xs">
          <Text fz="sm" c={how.dimmed ? "dimmed" : undefined} title={how.title}>
            {how.text}
          </Text>
          {b.renamed_to && (
            <Text fz="sm" c="warning" data-tone="warning">
              Renamed on GitHub to <Text component="span" ff="monospace" inherit>{b.renamed_to}</Text>: applied once nest&apos;s grant names it
            </Text>
          )}
          {b.error && (
            <Text fz="sm" c="danger" data-tone="danger">
              {b.error}
            </Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td ta="right">
        <Button variant="default" leftSection={<IconRefresh size={icon.md} />} loading={reread.isPending} onClick={run} aria-label={`Re-read ${b.name}'s repo from GitHub`}>
          Re-read
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

export function BindingsSection() {
  const bindings = useBindings();
  return (
    <Section title="Repository bindings" count={bindings.data?.length} order={4} region={false}>
      <Stack gap="lg">
        <Text fz="md" c="dimmed">
          GitHub&apos;s events reach a project by its repo&apos;s id, read from GitHub when the repo is attached (or by a catalog sync for a project from before). Re-read reads it again: after a repo is renamed, transferred or replaced.
        </Text>
        {bindings.isPending ? (
          <LoadingState label="Loading the bindings" />
        ) : bindings.isError ? (
          <ErrorState title="The bindings couldn't be loaded" error={bindings.error} onRetry={() => void bindings.refetch()} />
        ) : bindings.data.length === 0 ? (
          <EmptyState icon={IconGitBranch} title="No projects yet" description="A project's repo is bound when it's created." />
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
                <Row_ key={b.project} b={b} />
              ))}
            </Table.Tbody>
          </TableFrame>
        )}
      </Stack>
    </Section>
  );
}
