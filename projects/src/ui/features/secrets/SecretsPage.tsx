// A project's secrets (README.md#secrets): what each is, where nest's proxy injects it and for which
// roles, when it was last handed to a sandbox; added and edited in a Sheet, deleted with a confirmation
// naming the agents that lose it. Values are never here: they go to nest when saved.

import { Badge, Button, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconKey, IconPlus } from "@tabler/icons-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useDeleteSecret, useSecrets } from "../../api/queries";
import type { SecretLocation, SecretView } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Row, Section, Sheet, Stack, TableFrame } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { SecretForm } from "./SecretForm";

const ROLE_LABEL: Record<string, string> = { worker: "Workers", manager: "Manager", reviewer: "Reviewers" };
const formatOf = (l: SecretLocation) => (l.type === "authorization_bearer" ? "Bearer" : l.type === "authorization_basic_password" ? "Basic password" : `${l.name} header`);
const holdersText = (h: { agent: string; role: string }[]) =>
  h.length === 0 ? "No live agent has it." : `${h.map((x) => `${x.agent} (${x.role})`).join(", ")} ${h.length === 1 ? "loses" : "lose"} it at the next refresh, within 15 minutes.`;

export function SecretsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/secrets" });
  const search = useSearch({ from: "/projects/$projectId/secrets" });
  const navigate = useNavigate({ from: "/projects/$projectId/secrets" });
  const secrets = useSecrets(projectId);
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
          <Text fz="md">nest deletes its value; agents started from now on don't get it.</Text>
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
            {secrets.data?.grant && (
              <MetaRow>
                <MetaItem>Injects into {secrets.data.grant.inject_hosts.join(", ") || "no hosts yet: the operator sets the grant's inject_hosts"}</MetaItem>
                <MetaItem>
                  {secrets.data.grant.used} of {secrets.data.grant.max_count} secrets used, across the app's projects
                </MetaItem>
                <MetaItem>Each up to {secrets.data.grant.max_bytes} bytes</MetaItem>
              </MetaRow>
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
                  description="Credentials never enter a sandbox: nest's proxy injects them into agents' requests to the hosts you name, and agents hold placeholders. CI secrets go in the repo's Actions secrets instead."
                  action={<Button onClick={() => setEditing("new")}>Add the first secret</Button>}
                />
              </Panel>
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
                        <Stack gap="2xs">
                          <Text fz="sm" ff="monospace" fw="medium">
                            {s.name}
                          </Text>
                          {s.description && (
                            <Text fz="xs" c="dimmed">
                              {s.description}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text fz="sm">{s.hosts.join(", ")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text fz="sm">{s.locations.map(formatOf).join(", ")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Row gap="xs">
                          {s.roles.map((r) => (
                            <Badge key={r} size="sm" color="gray" variant="light">
                              {ROLE_LABEL[r]}
                            </Badge>
                          ))}
                        </Row>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text fz="sm" c="dimmed" title={exact(s.updated_ms)}>
                          {ago(s.updated_ms)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text fz="sm" c="dimmed" title={s.last_injected_ms ? exact(s.last_injected_ms) : undefined}>
                          {s.last_injected_ms ? ago(s.last_injected_ms) : "Not yet"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Row gap="xs" wrap="nowrap">
                          <Button size="xs" variant="default" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                            Edit
                          </Button>
                          <Button size="xs" variant="subtle" color="danger" onClick={() => confirmDelete(s)} aria-label={`Delete ${s.name}`}>
                            Delete
                          </Button>
                        </Row>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </TableFrame>
            )}
          </Stack>
          <Sheet opened={open} onClose={close} title={editing && editing !== "new" ? `Edit ${editing.name}` : "Add a secret"}>
            {open && (
              <SecretForm
                key={editing && editing !== "new" ? editing.name : `new-${search.add ?? ""}`}
                projectId={projectId}
                grant={secrets.data?.grant ?? null}
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
