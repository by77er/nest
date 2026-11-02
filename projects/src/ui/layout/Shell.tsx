// The frame around every page: a white header with the app's name and its two places, and the page on
// the near-white background.

import { Alert, AppShell, Button, Container, Group, Stack, Text } from "@mantine/core";
import { type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { AnchorLink } from "../common/links";
import { PAGE_BG } from "../theme";

export function Shell() {
  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <AnchorLink to="/" underline="never" c="dark" fw={700} aria-label="nest projects: all projects">
            nest projects
          </AnchorLink>
          <Group gap="lg" component="nav" aria-label="Main">
            <AnchorLink to="/" c="dimmed" size="sm" activeOptions={{ exact: true }} activeProps={{ c: "dark", fw: 600 }}>
              Projects
            </AnchorLink>
            <AnchorLink to="/admin" c="dimmed" size="sm" activeProps={{ c: "dark", fw: 600 }}>
              Admin
            </AnchorLink>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main bg={PAGE_BG}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

export function NotFound() {
  return (
    <Text c="dimmed" ta="center" py="xl">
      Nothing is here. <AnchorLink to="/">All projects</AnchorLink>
    </Text>
  );
}

/** A page that threw while rendering: what went wrong, and a way to try again. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <Container size="sm" py="xl">
      <Alert color="danger" variant="light" title="This page hit an error" role="alert">
        <Stack gap="xs" align="flex-start">
          <Text size="sm">{error instanceof Error ? error.message : String(error)}</Text>
          <Button size="xs" variant="default" onClick={reset}>
            Try again
          </Button>
        </Stack>
      </Alert>
    </Container>
  );
}
