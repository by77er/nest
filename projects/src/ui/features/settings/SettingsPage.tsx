// A project's settings: what can be changed (Workers, Auto-merge, CI workflows) in one row, saved together by the
// Save right under it; then what's read-only (the project's name and repo, and the way to its Secrets
// page) in a row of its own. Each Panel is as tall as its content.

import { Anchor, Button, Text } from "@mantine/core";
import { IconBrandGithub, IconKey } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { AnchorLink } from "../../common/links";
import { icon, MetaItem, Panel, Row, Section, SectionGrid, Stack } from "../../layout";
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
                  <Stack gap="sm">
                    <Text fz="sm" c="dimmed">
                      The credentials its agents use: write-only, injected by nest's proxy, never in a sandbox. CI secrets go in the repo's environments on GitHub.
                    </Text>
                    <Row>
                      <Button variant="default" renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/secrets" params={{ projectId }} />} leftSection={<IconKey size={icon.md} />}>
                        Open Secrets
                      </Button>
                    </Row>
                  </Stack>
                </Section>
              </Panel>
            </SectionGrid>
          </Stack>
        </Section>
      )}
    </ProjectFrame>
  );
}
