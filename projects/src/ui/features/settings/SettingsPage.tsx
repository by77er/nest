// A project's settings, a page of its own (it was a modal): one form, at the form measure.

import { useParams } from "@tanstack/react-router";
import { Panel, Section } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { SettingsForm } from "./SettingsForm";

export function SettingsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/settings" });
  return (
    <ProjectFrame projectId={projectId} measure="form">
      {(p) => (
        <Section title="Settings">
          <Panel>
            <SettingsForm key={[p.settings.auto_assign, p.settings.max_workers, p.settings.auto_merge, p.settings.merge_method].join("/")} projectId={projectId} settings={p.settings} />
          </Panel>
        </Section>
      )}
    </ProjectFrame>
  );
}
