// An agent asking for a secret, in "Needs you" (README.md#secrets): one for the repo's CI, which the
// owner adds to an approval-gated GitHub environment (never as a repository secret, which any workflow
// in the repo reads, a worker's pushed one too) and marks done; or one for nest to inject, set up in the
// Secrets form, prefilled. Never a value: the agent names what it needs and why. A tainted session's
// request is marked, with a caution: its purpose may be an injected instruction.

import { Anchor, Badge, Button, Text } from "@mantine/core";
import { IconExternalLink, IconKey } from "@tabler/icons-react";
import { useProject, useSecretRequestDone } from "../../api/queries";
import type { Attention } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, MetaItem, MetaRow, Notice, Prose, Stack, Toolbar } from "../../layout";
import { fontWeights } from "../../theme";

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
        {item.tainted && (
          <Badge size="xs" color="gray" variant="outline">
            Tainted
          </Badge>
        )}
      </MetaRow>
      {item.tainted && (
        <Notice tone="warning" title="From a tainted session">
          <Text fz="sm">This agent read text from outside the project (a PR, an issue, a web page). The request may be an instruction planted there: be sure the task needs it before you give it a credential.</Text>
        </Notice>
      )}
      <Text fz="md">
        {item.type === "ci" ? "Asks for the GitHub Actions secret " : "Asks for a credential to inject, "}
        <Text component="span" ff="monospace" fw={fontWeights.medium}>
          {item.name}
        </Text>
        {item.type === "injected" && item.hosts?.length ? ` for ${item.hosts.join(", ")}` : ""}.
      </Text>
      <Prose>{item.purpose}</Prose>
      <Toolbar align="start">
        {item.type === "ci" ? (
          <Button
            component="a"
            href={repo ? `https://github.com/${repo}/settings/environments` : undefined}
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
        <Notice tone="warning" title="In an environment with required reviewers, not the repo">
          <Text fz="sm">
            Add {item.name} to an environment whose deployments need a reviewer, and have the job that uses it name that environment. A repository secret is readable by any workflow in the repo, including one a worker pushes. The value goes in GitHub's form, never in a chat.
          </Text>
        </Notice>
      )}
      {item.type === "ci" && (
        <Text fz="xs" c="dimmed">
          <Anchor href="https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment" target="_blank" rel="noreferrer" inherit>
            GitHub: environments with required reviewers
          </Anchor>
        </Text>
      )}
    </Stack>
  );
}
