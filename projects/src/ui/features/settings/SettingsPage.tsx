// A project's settings: what can be changed (Workers, Auto-merge) in one row, saved together by the
// Save right under it; then what's read-only (the project's name and repo, its secrets) in a row of its
// own. Each Panel is as tall as its content.

import { Anchor, Text } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { MetaItem, Panel, Section, SectionGrid, Stack } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { SettingsForm } from "./SettingsForm";

export function SettingsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/settings" });
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <Section title="Settings">
          <Stack gap="2xl">
            <SettingsForm
              key={[p.settings.auto_assign, p.settings.max_workers, p.settings.auto_merge, p.settings.merge_method].join("/")}
              projectId={projectId}
              settings={p.settings}
            />
            <SectionGrid>
              <Panel data-slot="project">
                <Section title="Project" order={4} region={false}>
                  <Stack gap="sm">
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
              <Panel data-slot="secrets">
                <Section title="Secrets" order={4} region={false}>
                  <Text fz="sm" c="dimmed">
                    The project's secrets (for its CI and its workers) will be set here.
                  </Text>
                </Section>
              </Panel>
            </SectionGrid>
          </Stack>
        </Section>
      )}
    </ProjectFrame>
  );
}
