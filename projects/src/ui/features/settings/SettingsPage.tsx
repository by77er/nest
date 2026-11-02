// A project's settings, a page of its own (it was a modal): one form, at the form measure.

import { useParams } from "@tanstack/react-router";
import { Panel } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";
import { SettingsForm } from "./SettingsForm";

export function SettingsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/settings" });
  return (
    <ProjectFrame projectId={projectId} title="Settings" measure="form">
      {(p) => (
        <Panel>
          <SettingsForm key={`${p.settings.auto_assign}/${p.settings.max_workers}`} projectId={projectId} settings={p.settings} />
        </Panel>
      )}
    </ProjectFrame>
  );
}
