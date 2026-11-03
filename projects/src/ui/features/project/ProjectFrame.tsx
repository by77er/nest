// A project page's frame: the page, its header (the breadcrumb to the project, the page's h1, the repo
// on the caption line), and the project's loading and error states, the same on every project page.

import { Anchor, Text } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useProject } from "../../api/queries";
import type { Project } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ErrorState, LoadingState, MetaItem, MetaRow, Page, PageHeader } from "../../layout";

export interface ProjectFrameProps {
  projectId: string;
  /** The page's name, its h1 ("Board", "Manager"). */
  title: string;
  /** More of the caption line, after the repo. */
  meta?: (p: Project) => ReactNode;
  actions?: (p: Project) => ReactNode;
  /** Keep the content to a measure: `reading` for a conversation, `form` for settings. */
  measure?: "reading" | "form";
  children: (p: Project) => ReactNode;
}

export function ProjectFrame({ projectId, title, meta, actions, measure, children }: ProjectFrameProps) {
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
    <Page measure={measure}>
      <PageHeader
        breadcrumbs={[
          <AnchorLink key="projects" to="/projects" c="dimmed">
            Projects
          </AnchorLink>,
          <Text key="this" fz="sm">
            {p.name}
          </Text>,
        ]}
        title={title}
        meta={
          <MetaRow>
            <MetaItem icon={IconBrandGithub}>
              <Anchor href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" inherit c="dimmed">
                {p.repo}
              </Anchor>
            </MetaItem>
            {meta?.(p)}
          </MetaRow>
        }
        actions={actions?.(p)}
      />
      {children(p)}
    </Page>
  );
}
