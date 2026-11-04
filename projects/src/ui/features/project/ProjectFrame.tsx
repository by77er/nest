// A project page's frame: the page, its header (the project's name is the one h1, with the repo,
// auto-assign and the worker cap on its caption line), and the project's loading and error states, the
// same on every view. The view itself is named by the sidebar's active row, not a second h1; the switcher
// says which project, so there is no breadcrumb.

import { Anchor } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useProject } from "../../api/queries";
import type { Project } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ErrorState, LoadingState, MetaItem, MetaRow, Page, PageHeader } from "../../layout";

export interface ProjectFrameProps {
  projectId: string;
  actions?: (p: Project) => ReactNode;
  children: (p: Project) => ReactNode;
}

export function ProjectFrame({ projectId, actions, children }: ProjectFrameProps) {
  const project = useProject(projectId);
  if (project.isPending) {
    return (
      <Page>
        <LoadingState label="Loading the project" />
      </Page>
    );
  }
  if (project.isError) {
    return (
      <Page>
        <ErrorState title="The project couldn't be loaded" error={project.error} onRetry={() => void project.refetch()} />
        <AnchorLink to="/projects">All projects</AnchorLink>
      </Page>
    );
  }
  const p = project.data;
  return (
    <Page>
      <PageHeader
        title={p.name}
        meta={
          <MetaRow>
            <MetaItem icon={IconBrandGithub}>
              <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" inherit c="dimmed">
                {p.repo}
              </Anchor>
            </MetaItem>
            <MetaItem>Auto-assign {p.settings.auto_assign ? "on" : "off"}</MetaItem>
            <MetaItem>
              Up to {p.settings.max_workers} {p.settings.max_workers === 1 ? "worker" : "workers"}
            </MetaItem>
          </MetaRow>
        }
        actions={actions?.(p)}
      />
      {children(p)}
    </Page>
  );
}
