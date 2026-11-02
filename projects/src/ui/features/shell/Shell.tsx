// The app's frame: its name and its two places in the header, the page below; and the pages for a path
// that matches nothing and for a page that threw.

import { IconCompass } from "@tabler/icons-react";
import { type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { AnchorLink } from "../../common/links";
// From the primitives' own modules, not the index: the frame is in the first chunk, and the board's
// (dnd-kit, the chat) stay in theirs.
import { AppFrame } from "../../layout/AppFrame";
import { Page } from "../../layout/Page";
import { EmptyState, ErrorState } from "../../layout/States";

export function Shell() {
  return (
    <AppFrame
      brand={
        <AnchorLink to="/" underline="never" c="bright" fw="bold" fz="lg" aria-label="nest projects: all projects">
          nest projects
        </AnchorLink>
      }
      nav={
        <>
          <AnchorLink to="/" c="dimmed" fz="sm" fw="medium" activeOptions={{ exact: true }} activeProps={{ c: "bright" }}>
            Projects
          </AnchorLink>
          <AnchorLink to="/admin" c="dimmed" fz="sm" fw="medium" activeProps={{ c: "bright" }}>
            Admin
          </AnchorLink>
        </>
      }
    >
      <Outlet />
    </AppFrame>
  );
}

export function NotFound() {
  return (
    <Page>
      <EmptyState icon={IconCompass} title="Nothing is here" description="The address doesn't match a page." action={<AnchorLink to="/">All projects</AnchorLink>} />
    </Page>
  );
}

/** A page that threw while rendering: what went wrong, and a way to try again. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <Page>
      <ErrorState title="This page hit an error" error={error instanceof Error ? error : String(error)} onRetry={reset} />
    </Page>
  );
}
