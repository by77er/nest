// A project's secrets (README.md#secrets): what each is, the variable that holds its placeholder, where
// nest's proxy injects it and for which roles, when it was last handed to a sandbox; added and edited in
// a Sheet, deleted with a confirmation naming the agents that lose it. A table, or below `sm` a card per
// secret. A change reaches live agents of its roles (reviewers too) through their sandbox's client layer,
// each shown applied, pending or failed. Values are never here: they go to nest when saved.

import { Badge, Button, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconKey, IconPlus } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useDeleteSecret, useSecrets } from "../../api/queries";
import type { SecretLocation, SecretsAnswer, SecretView } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Notice, Panel, Row, Section, Sheet, Stack, TableFrame, Token, usePhone, weight } from "../../layout";
import { LiveAgents } from "../project/LiveAgents";
import { ProjectFrame } from "../project/ProjectFrame";
import { SecretForm } from "./SecretForm";

const ROLE_LABEL: Record<string, string> = { worker: "Workers", manager: "Manager", reviewer: "Reviewers" };
const formatOf = (l: SecretLocation) => (l.type === "authorization_bearer" ? "Bearer" : l.type === "authorization_basic_password" ? "Basic password" : `${l.name} header`);
const list = (h: { agent: string; role: string }[]) => h.map((x) => `${x.agent} (${x.role})`).join(", ");
/** Who loses a secret: every holder's live layer, at once (reviewers' too). */
const holdersText = (h: { agent: string; role: string }[]) =>
  h.length === 0 ? "No live agent has it." : `It leaves ${list(h)} now, with its variable.`;

type Row_ = SecretsAnswer["secrets"][number];

function SecretName({ s }: { s: Row_ }) {
  return (
    <Stack gap="2xs">
      <Text fz="sm" ff="monospace" fw={weight.medium}>
        {s.name}
      </Text>
      <Token slot="env">${s.env}</Token>
      {s.description && (
        <Text fz="xs" c="dimmed">
          {s.description}
        </Text>
      )}
    </Stack>
  );
}

function SecretHosts({ s }: { s: Row_ }) {
  return (
    <Stack gap="2xs">
      {s.hosts.map((h) => (
        <Token key={h} mono={false} dimmed={false} size="sm">
          {h}
        </Token>
      ))}
      {s.outside_hosts.length > 0 && (
        <Row>
          <Badge size="sm" color="warning" variant="light" data-slot="outside">
            Outside the grant
          </Badge>
        </Row>
      )}
    </Stack>
  );
}

function Roles({ s }: { s: Row_ }) {
  return (
    <Row gap="xs">
      {s.roles.map((r) => (
        <Badge key={r} size="sm" color="gray" variant="light">
          {ROLE_LABEL[r]}
        </Badge>
      ))}
    </Row>
  );
}

/** Edit and Delete; in a card (`apart`), Delete at the far edge, away from Edit. */
function SecretActions({ s, onEdit, onDelete, apart = false }: { s: Row_; onEdit: () => void; onDelete: () => void; apart?: boolean }) {
  return (
    <Row gap="xs" wrap="nowrap" justify={apart ? "space-between" : undefined}>
      <Button size="xs" variant="default" onClick={onEdit} aria-label={`Edit ${s.name}`}>
        Edit
      </Button>
      <Button size="xs" variant="subtle" color="danger" onClick={onDelete} aria-label={`Delete ${s.name}`}>
        Delete
      </Button>
    </Row>
  );
}

export function SecretsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/secrets" });
  const search = useSearch({ from: "/projects/$projectId/secrets" });
  const navigate = useNavigate({ from: "/projects/$projectId/secrets" });
  const secrets = useSecrets(projectId);
  // Below `sm`, a card per secret: a table's actions would sit a scroll away.
  const phone = usePhone();
  const del = useDeleteSecret(projectId);
  const [editing, setEditing] = useState<SecretView | "new" | null>(null);
  // An agent's request opens the form prefilled (`?add=…&hosts=…`).
  const fromRequest = search.add !== undefined;
  const open = editing !== null || fromRequest;
  const close = () => {
    setEditing(null);
    if (fromRequest) void navigate({ search: {}, replace: true });
  };
  const confirmDelete = (s: SecretView) =>
    modals.openConfirmModal({
      title: `Delete ${s.name}?`,
      children: (
        <Stack gap="sm">
          <Text fz="md">nest deletes its value, and agents started from now on don't get it.</Text>
          <Text fz="md">{holdersText(s.holders)}</Text>
        </Stack>
      ),
      labels: { confirm: "Delete", cancel: "Keep it" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => del.mutate(s.name),
    });

  return (
    <ProjectFrame projectId={projectId}>
      {() => (
        <Section
          title="Secrets"
          count={secrets.data?.secrets.length}
          actions={
            <Button leftSection={<IconPlus size={icon.md} />} onClick={() => setEditing("new")}>
              Add a secret
            </Button>
          }
        >
          <Stack gap="lg">
            <Text fz="sm" c="dimmed">
              Values are write-only: they go to nest when saved and can't be read back; agents see only a placeholder in their variable. A change reaches live agents of its roles, reviewers included, in a moment.
            </Text>
            {secrets.data?.grant && (
              <MetaRow>
                <MetaItem>Injects into {secrets.data.grant.inject_hosts.join(", ") || "no hosts yet: the operator sets the grant's inject_hosts"}</MetaItem>
                <MetaItem>
                  {secrets.data.grant.used} of {secrets.data.grant.max_count} secrets used, across the app's projects
                </MetaItem>
                <MetaItem>Each up to {secrets.data.grant.max_bytes} bytes</MetaItem>
              </MetaRow>
            )}
            {(secrets.data?.secrets.filter((x) => x.outside_hosts.length).length ?? 0) > 0 && (
              <Notice tone="warning" title="Some hosts are outside the grant">
                <Stack gap="2xs">
                  {secrets.data!.secrets.filter((x) => x.outside_hosts.length).map((x) => (
                    <Text key={x.name} fz="sm">
                      nest won't inject {x.name} on {x.outside_hosts.join(", ")}
                      {x.outside_hosts.length === x.hosts.length ? ", so no sandbox gets it" : ""}. The operator must widen the grant's inject_hosts, or you can remove those hosts.
                    </Text>
                  ))}
                </Stack>
              </Notice>
            )}
            {secrets.isPending ? (
              <LoadingState label="Loading the secrets" />
            ) : secrets.isError ? (
              <ErrorState title="The secrets couldn't be loaded" error={secrets.error} onRetry={() => void secrets.refetch()} />
            ) : secrets.data.secrets.length === 0 ? (
              <Panel>
                <EmptyState
                  icon={IconKey}
                  title="No secrets yet"
                  description="Credentials never enter a sandbox: nest's proxy injects them into agents' requests to the hosts you name, and agents' variables hold placeholders. CI secrets go in the repo's Actions secrets instead."
                  action={<Button onClick={() => setEditing("new")}>Add the first secret</Button>}
                />
              </Panel>
            ) : (
              phone ? (
                <Stack gap="sm" role="list" aria-label="Secrets">
                  {secrets.data.secrets.map((s) => (
                    <Panel key={s.name} dense>
                      <Stack gap="sm" role="listitem" data-secret={s.name}>
                        <SecretName s={s} />
                        <SecretHosts s={s} />
                        <Text fz="sm">Sent as {s.locations.map(formatOf).join(", ")}</Text>
                        <Roles s={s} />
                        <MetaRow>
                          <MetaItem title={exact(s.updated_ms)}>Updated {ago(s.updated_ms)}</MetaItem>
                          <MetaItem title={s.last_injected_ms ? exact(s.last_injected_ms) : undefined}>
                            {s.last_injected_ms ? `Last injected ${ago(s.last_injected_ms)}` : "Not injected yet"}
                          </MetaItem>
                        </MetaRow>
                        <SecretActions s={s} onEdit={() => setEditing(s)} onDelete={() => confirmDelete(s)} apart />
                      </Stack>
                    </Panel>
                  ))}
                </Stack>
              ) : (
              <TableFrame label="Secrets">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Hosts</Table.Th>
                    <Table.Th>Sent as</Table.Th>
                    <Table.Th>Given to</Table.Th>
                    <Table.Th ta="right">Updated</Table.Th>
                    <Table.Th ta="right">Last injected</Table.Th>
                    <Table.Th>
                      <Text component="span" fz="sm" c="dimmed">
                        Actions
                      </Text>
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {secrets.data.secrets.map((s) => (
                    <Table.Tr key={s.name} data-secret={s.name}>
                      <Table.Td>
                        <SecretName s={s} />
                      </Table.Td>
                      <Table.Td>
                        <SecretHosts s={s} />
                      </Table.Td>
                      <Table.Td>
                        <Text fz="sm">{s.locations.map(formatOf).join(", ")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Roles s={s} />
                      </Table.Td>
                      <Table.Td ta="right">
                        <Token mono={false} size="sm" nowrap title={exact(s.updated_ms)}>
                          {ago(s.updated_ms)}
                        </Token>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Token mono={false} size="sm" nowrap title={s.last_injected_ms ? exact(s.last_injected_ms) : undefined}>
                          {s.last_injected_ms ? ago(s.last_injected_ms) : "Not yet"}
                        </Token>
                      </Table.Td>
                      <Table.Td>
                        <SecretActions s={s} onEdit={() => setEditing(s)} onDelete={() => confirmDelete(s)} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </TableFrame>
              )
            )}
            {secrets.data && (
              <Section title="Live agents" dense count={secrets.data.agents.length} region={false}>
                <LiveAgents
                  agents={secrets.data.agents}
                  label="Live agents' secrets"
                  empty="No live agents. New ones get their role's secrets when their sandbox is made."
                  detail={(a) => {
                    const held = secrets.data.secrets.filter((x) => x.holders.some((h) => h.agent === a.agent));
                    if (!held.length) return "Has none";
                    return (
                      <>
                        Has{" "}
                        {held.map((x, i) => (
                          <Fragment key={x.name}>
                            {i > 0 && ", "}
                            <Token>${x.env}</Token>
                          </Fragment>
                        ))}
                      </>
                    );
                  }}
                />
              </Section>
            )}
          </Stack>
          <Sheet opened={open} onClose={close} title={editing && editing !== "new" ? `Edit ${editing.name}` : "Add a secret"}>
            {open && (
              <SecretForm
                key={editing && editing !== "new" ? editing.name : `new-${search.add ?? ""}`}
                projectId={projectId}
                grant={secrets.data?.grant ?? null}
                takenEnv={secrets.data?.secrets.filter((x) => editing === "new" || !editing || x.name !== editing.name).map((x) => x.env) ?? []}
                editing={editing && editing !== "new" ? editing : undefined}
                initial={fromRequest ? { name: search.add, hosts: search.hosts ? search.hosts.split(",").filter(Boolean) : undefined } : undefined}
                onDone={close}
              />
            )}
          </Sheet>
        </Section>
      )}
    </ProjectFrame>
  );
}
