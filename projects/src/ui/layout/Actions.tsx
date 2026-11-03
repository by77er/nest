// Actions in a section or a row (the nest-ui-design skill's Placement): a picker for adding something
// (a default Button opening a searchable list, keyboard first), a row's own action (at least 36 px, 44 px
// on touch), a badge that opens its details on hover or focus, and what fills a row before its actions.

import { Badge, type BadgeProps, Box, Button, type ButtonProps, Combobox, Group, Loader, Text, useCombobox } from "@mantine/core";
import { forwardRef, type ReactNode, useEffect, useState } from "react";
import { icon } from "../theme";
import classes from "./Actions.module.css";

export interface PickerItem {
  value: string;
  label: string;
  /** What the search also matches (an id, a branch). */
  keywords?: string;
  /** At the option's end: its state. */
  end?: ReactNode;
  /** Shown, but not pickable (and never preselected): why, in `end`. */
  disabled?: boolean;
}

export interface PickerProps {
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  items: PickerItem[];
  searchLabel: string;
  empty: (search: string) => ReactNode;
  /** An option made of the search itself (a PR's number typed), first when there is one. */
  fromSearch?: (search: string) => PickerItem | null;
  onPick: (value: string) => void;
  /** Called when the list opens (to load its items). */
  onOpen?: () => void;
  loading?: boolean;
  /** The items couldn't be loaded: said, with a retry, instead of "nothing". */
  error?: string | null;
  onRetry?: () => void;
  busy?: boolean;
}

/** A section's "add" action: a default Button with an icon, opening a searchable list. */
export function Picker({ label, icon: Icon, items, searchLabel, empty, fromSearch, onPick, onOpen, loading, error, onRetry, busy }: PickerProps) {
  const [search, setSearch] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
    onDropdownOpen: () => {
      onOpen?.();
      combobox.focusSearchInput();
    },
  });
  const q = search.trim().toLowerCase();
  const typed = fromSearch?.(search.trim()) ?? null;
  const shown = [...(typed ? [typed] : []), ...items.filter((i) => i.value !== typed?.value && (!q || i.label.toLowerCase().includes(q) || (i.keywords ?? "").toLowerCase().includes(q)))];

  // The first pickable match is the one Enter sends; again once the items arrive.
  useEffect(() => {
    if (combobox.dropdownOpened) combobox.selectFirstOption();
  }, [q, combobox.dropdownOpened, items.length, typed?.value]); // `combobox` is stable across renders

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(v) => {
        combobox.closeDropdown();
        onPick(v);
      }}
      position="bottom-end"
      width={320}
      withinPortal
      shadow="overlay"
      classNames={{ option: classes.option }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          variant="default"
          leftSection={<Icon size={icon.md} aria-hidden />}
          className={classes.action}
          loading={busy}
          aria-haspopup="listbox"
          aria-expanded={combobox.dropdownOpened}
          onClick={() => combobox.toggleDropdown()}
        >
          {label}
        </Button>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder={searchLabel} aria-label={searchLabel} />
        <Combobox.Options aria-label={searchLabel} aria-busy={loading || undefined}>
          {shown.map((i) => (
            <Combobox.Option key={i.value} value={i.value} disabled={i.disabled} aria-label={i.label}>
              <Group gap="sm" justify="space-between" wrap="nowrap">
                <Text component="span" fz="sm" className={classes.grow}>
                  {i.label}
                </Text>
                {i.end}
              </Group>
            </Combobox.Option>
          ))}
          {shown.length === 0 &&
            (error ? (
              <Combobox.Empty>
                <Group gap="sm" justify="space-between" wrap="nowrap">
                  <Text component="span" fz="sm" c="danger">
                    {error}
                  </Text>
                  {onRetry && (
                    <Button size="xs" variant="default" onClick={onRetry}>
                      Retry
                    </Button>
                  )}
                </Group>
              </Combobox.Empty>
            ) : loading ? (
              <Combobox.Empty>
                <Group gap="sm" justify="center">
                  <Loader size="xs" />
                  <Text component="span" fz="sm" c="dimmed">
                    Loading
                  </Text>
                </Group>
              </Combobox.Empty>
            ) : (
              <Combobox.Empty>{empty(search.trim())}</Combobox.Empty>
            ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

/** A row's own action (Detach, Remove): at least 36 px with a pointer, 44 px on touch. */
export const RowAction = forwardRef<HTMLButtonElement, ButtonProps & { onClick?: () => void; "aria-label"?: string }>(function RowAction(props, ref) {
  return <Button ref={ref} size="sm" {...props} className={classes.action} />;
});

/** A badge whose details open on hover or focus: focusable, with the theme's ring and a touch target. */
export const TriggerBadge = forwardRef<HTMLDivElement, BadgeProps & { [k: `data-${string}`]: string | undefined }>(function TriggerBadge(props, ref) {
  return <Badge ref={ref} tabIndex={0} {...props} className={classes.trigger} />;
});

/** What fills a row's free width, wrapping before the row's actions give way. */
export function Grow({ children }: { children: ReactNode }) {
  return <Box className={classes.grow}>{children}</Box>;
}
