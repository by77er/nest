// An agent asking for a secret, in "Needs you" (README.md#secrets): one for the repo's CI, which the
// owner adds on GitHub and marks done; or one for nest to inject, set up in the Secrets form, prefilled.
// Never a value: the agent names what it needs and why.

import { Anchor, Button, Text } from "@mantine/core";
import { IconExternalLink, IconKey } from "@tabler/icons-react";
import { useProject, useSecretRequestDone } from "../../api/queries";
import type { Attention } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, MetaItem, MetaRow, Prose, Stack, Toolbar } from "../../layout";

type Item = Extract<Attention, { kind: "secret" }>;

export function SecretRequestItem({ projectId, item }: { projectId: string; item: Item }) {
  const project = useProject(projectId);
  const done = useSecretRequestDone(projectId);
  const repo = project.data?.repo;
  return (
    <Stack gap="sm" data-secret-request={item.id}>
      <MetaRow>
        <MetaItem>{item.role === "manager" ? "The manager" : item.role === "worker" ? "A worker" : "An agent"}</MetaItem>
        <MetaItem mono>{item.agent}</MetaItem>
        {item.task && (
          <MetaItem>
            on{" "}
            <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: item.task }} inherit ff="monospace">
              {item.task}
            </AnchorLink>
          </MetaItem>
        )}
        <MetaItem title={exact(item.at_ms)}>{ago(item.at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md">
        {item.type === "ci" ? "Asks for the GitHub Actions secret " : "Asks for a credential to inject, "}
        <Text component="span" ff="monospace" fw="medium">
          {item.name}
        </Text>
        {item.type === "injected" && item.hosts?.length ? ` for ${item.hosts.join(", ")}` : ""}.
      </Text>
      <Prose>{item.purpose}</Prose>
      <Toolbar align="start">
        {item.type === "ci" ? (
          <Button
            component="a"
            href={repo ? `https://github.com/${repo}/settings/secrets/actions/new` : undefined}
            target="_blank"
            rel="noreferrer"
            leftSection={<IconExternalLink size={icon.md} />}
            aria-label={`Add ${item.name} on GitHub`}
          >
            Add {item.name} on GitHub
          </Button>
        ) : (
          <Button
            renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/secrets" params={{ projectId }} search={{ add: item.name, hosts: (item.hosts ?? []).join(",") }} />}
            leftSection={<IconKey size={icon.md} />}
          >
            Set it up
          </Button>
        )}
        <Button variant="default" loading={done.isPending} onClick={() => done.mutate(item.id)}>
          {item.type === "ci" ? "Mark added" : "Dismiss"}
        </Button>
      </Toolbar>
      {item.type === "ci" && (
        <Text fz="xs" c="dimmed">
          GitHub's form: name it {item.name}. The value goes in there, never in a chat.{" "}
          <Anchor href="https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions" target="_blank" rel="noreferrer" inherit>
            About Actions secrets
          </Anchor>
        </Text>
      )}
    </Stack>
  );
}
