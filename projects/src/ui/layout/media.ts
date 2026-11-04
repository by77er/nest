// The layout's one breakpoint question for features: a phone, below Mantine's `sm` (48em), where wide
// content (a table, a split sheet) becomes a stack. Features ask this, never a raw media query.

import { useMediaQuery } from "@mantine/hooks";

export const PHONE_QUERY = "(max-width: 48em)";

/** Whether the viewport is phone-width (below `sm`). */
export const usePhone = (): boolean => useMediaQuery(PHONE_QUERY) ?? false;
