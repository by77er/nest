// The three states besides content, centred in their container, with at most one action. A spinner
// shows only once loading has taken 300 ms, so a fast answer never flashes one.

import { Button, Center, EmptyState as MantineEmptyState, Loader, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { icon, motion } from "../theme";

/** `terminal`: inside a trace's terminal, in its muted tone (AA on that surface, where `dimmed` isn't). */
export function LoadingState({ label, terminal = false }: { label: string; terminal?: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), motion.spinnerDelay);
    return () => clearTimeout(t);
  }, []);
  return (
    <Center py="xl" mih="var(--nest-section-head)" role="status" aria-live="polite" aria-label={label} data-ds="loading">
      {shown && (
        <Center style={{ gap: "var(--mantine-spacing-sm)" }}>
          <Loader size="sm" color="gray" />
          <Text c={terminal ? undefined : "dimmed"} size="sm" style={terminal ? { color: "var(--nest-term-muted)" } : undefined}>
            {label}
          </Text>
        </Center>
      )}
    </Center>
  );
}

/** What couldn't be loaded and why, with a retry. */
export function ErrorState({ title, error, onRetry }: { title: string; error: Error | string; onRetry?: () => void }) {
  return (
    <MantineEmptyState
      role="alert"
      aria-label={title}
      py="xl"
      variant="light"
      color="danger"
      icon={<IconAlertTriangle size={icon.lg} />}
      title={title}
      description={typeof error === "string" ? error : error.message}
      data-ds="error"
    >
      {onRetry && (
        <MantineEmptyState.Actions>
          <Button variant="default" onClick={onRetry}>
            Try again
          </Button>
        </MantineEmptyState.Actions>
      )}
    </MantineEmptyState>
  );
}

/** Nothing here yet: what this place is for, and the one action that fills it. */
export function EmptyState({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ size?: number }>; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <MantineEmptyState py="2xl" icon={<Icon size={icon.xl} />} withIndicatorBackground title={title} description={description} data-ds="empty">
      {action && <MantineEmptyState.Actions>{action}</MantineEmptyState.Actions>}
    </MantineEmptyState>
  );
}
