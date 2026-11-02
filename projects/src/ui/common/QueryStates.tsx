// The loading and error states every view shows the same way.

import { Alert, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";

export function Loading({ label }: { label: string }) {
  return (
    <Center py="xl" role="status" aria-live="polite">
      <Group gap="sm">
        <Loader size="sm" color="gray" />
        <Text c="dimmed" size="sm">{label}</Text>
      </Group>
    </Center>
  );
}

export function LoadError({ what, error, onRetry }: { what: string; error: Error; onRetry?: () => void }) {
  return (
    <Alert color="danger" variant="light" title={`${what} couldn't be loaded`} role="alert">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{error.message}</Text>
        {onRetry && (
          <Button size="xs" variant="default" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
