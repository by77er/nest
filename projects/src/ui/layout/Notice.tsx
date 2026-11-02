// An inline message in a role's color, next to the panel or field it's about: an error, a warning, a
// result. Mantine's Alert, light, with its tone's icon.

import { Alert } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { icon } from "../theme";

export type NoticeTone = "danger" | "warning" | "success" | "info";

const ICON = { danger: IconAlertTriangle, warning: IconAlertTriangle, success: IconCircleCheck, info: IconInfoCircle } as const;

export function Notice({ tone, title, children, role }: { tone: NoticeTone; title?: ReactNode; children?: ReactNode; role?: "alert" | "status" }) {
  const Icon = ICON[tone];
  return (
    <Alert color={tone === "info" ? "primary" : tone} variant="light" icon={<Icon size={icon.lg} />} title={title} {...(role ? { role } : {})} p="md" data-ds="notice">
      {children}
    </Alert>
  );
}
