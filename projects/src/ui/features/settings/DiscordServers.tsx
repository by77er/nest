// The Discord servers a project is linked to (README.md#linked-servers-discord), in Settings: the Discord bot's
// agents in a linked server read the project's board and propose tasks into triage, nothing else. Linking happens
// only here (behind Access), so nobody in Discord can widen what an agent sees. Each server by its id with when it
// was linked and Remove (confirmed, at its row's right); the add field below the list, its Link at its right.

import { Button, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { type FormEvent, useState } from "react";
import { GUILD } from "../../../requests";
import { ApiError } from "../../api/client";
import { useLink, useLinks, useUnlink } from "../../api/queries";
import { ago, exact } from "../../common/time";
import { ErrorState, FieldGroup, Grow, LoadingState, MetaItem, Panel, Row, RowAction, Section, Stack, Token } from "../../layout";

const NOT_AN_ID = "A server ID is its number: digits only, without a leading zero";

/** What's wrong with a typed server id, or null: the Worker's rule (`GUILD`), said in words. */
export function guildProblem(v: string): string | null {
  if (v === "") return "Enter the server's ID";
  return GUILD.test(v) ? null : NOT_AN_ID;
}

/**
 * The Worker's refusal of a link, said at the field in the page's words: a malformed id as the field's own rule
 * says it; the cap (409) plainly, the list read again (the hook's settling) so the cap's line takes the field's
 * place; anything else with the Worker's reason.
 */
export function linkRefusal(err: unknown): string {
  if (err instanceof ApiError && err.status === 400) return NOT_AN_ID;
  if (err instanceof ApiError && err.status === 409) return "This project is linked to as many servers as it can be: remove one first";
  return `The server wasn't linked: ${err instanceof Error ? err.message : "try again"}`;
}

export function DiscordServers({ projectId }: { projectId: string }) {
  const links = useLinks(projectId);
  const link = useLink(projectId);
  const unlink = useUnlink(projectId);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = links.data?.links ?? [];
  const full = links.data !== undefined && list.length >= links.data.max;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const guild = draft.trim();
    const problem = guildProblem(guild);
    if (problem) return setError(problem);
    setError(null);
    link.mutate(guild, {
      onSuccess: () => setDraft(""),
      onError: (err) => setError(linkRefusal(err)),
    });
  };
  const confirmRemove = (guild: string) =>
    modals.openConfirmModal({
      title: `Remove the Discord server ${guild}?`,
      children: <Text fz="md">Its agents stop seeing this project from their next call. Tasks they proposed stay in triage.</Text>,
      labels: { confirm: "Remove", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => unlink.mutate(guild),
    });

  return (
    <Panel data-slot="discord">
      <Section title="Discord servers" order={4} count={links.data ? list.length : undefined} region={false}>
        <Stack gap="lg">
          <Text fz="sm" c="dimmed">
            The Discord bot's agents in a linked server can read this project's board and propose tasks to your triage queue. Nothing else: they can't assign, start or change work.
          </Text>
          {/* The list, then the way to add one: further from each other than the list's rows are. */}
          <Stack gap="xl">
            {links.isPending ? (
              <LoadingState label="Loading the linked servers" />
            ) : links.isError ? (
              <ErrorState title="The linked servers couldn't be loaded" error={links.error} onRetry={() => void links.refetch()} />
            ) : list.length === 0 ? (
              <Text fz="sm" c="dimmed">
                No server linked
              </Text>
            ) : (
              // Each id with its date right under it, closer to it than to the next row's. Rows are two lines (38 px),
              // so `md` keeps their Removes 44 px apart on touch with no extra pitch.
              <Stack gap="md" role="list" aria-label="Linked Discord servers">
                {list.map((l) => (
                  <Row key={l.guild} gap="sm" wrap="nowrap" role="listitem" data-link={l.guild}>
                    <Grow>
                      <Stack gap="2xs">
                        <Token size="sm" dimmed={false}>{l.guild}</Token>
                        <MetaItem title={exact(l.created_ms)}>Linked {ago(l.created_ms)}</MetaItem>
                      </Stack>
                    </Grow>
                    <RowAction variant="subtle" color="danger" loading={unlink.isPending && unlink.variables === l.guild} onClick={() => confirmRemove(l.guild)} aria-label={`Remove the Discord server ${l.guild}`}>
                      Remove
                    </RowAction>
                  </Row>
                ))}
              </Stack>
            )}
            {links.data && full ? (
              // At the cap: said as a line of its own, not as a disabled field's hint (out of the tab order).
              <Text fz="sm" c="dimmed" data-slot="links-full">
                This project is linked to {links.data.max} servers, the most it can be: remove one to link another.
              </Text>
            ) : links.data && (
              <form onSubmit={submit} noValidate>
                <FieldGroup
                  actions={
                    <Button type="submit" variant="default" loading={link.isPending}>
                      Link server
                    </Button>
                  }
                >
                  <TextInput
                    label="Server ID"
                    description="In Discord, with Developer Mode on: right-click the server, then Copy Server ID."
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={25}
                    value={draft}
                    error={error}
                    onChange={(e) => {
                      setDraft(e.currentTarget.value);
                      if (error) setError(null);
                    }}
                  />
                </FieldGroup>
              </form>
            )}
          </Stack>
        </Stack>
      </Section>
    </Panel>
  );
}
