// A form's fields in one column, `lg` apart, labels above (the theme sets every input so), and its
// actions bottom-right: the dismiss first, the submit rightmost.

import { Stack } from "@mantine/core";
import type { ReactNode } from "react";
import { Toolbar } from "./Toolbar";

export function FieldGroup({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <Stack gap="lg" data-ds="field-group">
      {children}
      {actions && (
        <Stack pt="sm" data-slot="actions">
          <Toolbar>{actions}</Toolbar>
        </Stack>
      )}
    </Stack>
  );
}
