// A project's settings: its sections as Panels in a two-column grid within the frame (General,
// Workers, Auto-merge, Secrets), saved together; not one long narrow form.

import { Anchor, Text } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { MetaItem, Panel, Section, Stack } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { SettingsForm } from "./SettingsForm";

export function SettingsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/settings" });
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <Section title="Settings">
          <SettingsForm
            key={[p.settings.auto_assign, p.settings.max_workers, p.settings.auto_merge, p.settings.merge_method].join("/")}
            projectId={projectId}
            settings={p.settings}
            before={
              <Panel>
                <Section title="General" region={false}>
                  <Stack gap="sm">
                    <Text fz="md" fw="medium">
                      {p.name}
                    </Text>
                    <MetaItem icon={IconBrandGithub}>
                      <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" inherit c="dimmed">
                        {p.repo}
                      </Anchor>
                    </MetaItem>
                    <Text fz="sm" c="dimmed">
                      A project is one repo; its name and repo are set when it's created.
                    </Text>
                  </Stack>
                </Section>
              </Panel>
            }
            after={
              <Panel data-slot="secrets">
                <Section title="Secrets" region={false}>
                  <Text fz="sm" c="dimmed">
                    The project's secrets (for its CI and its workers) will be set here.
                  </Text>
                </Section>
              </Panel>
            }
          />
        </Section>
      )}
    </ProjectFrame>
  );
}
