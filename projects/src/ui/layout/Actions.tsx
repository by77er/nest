// Actions in a section or a row (the nest-ui-design skill's Placement): a picker for adding something
// (a default Button opening a searchable list, keyboard first), a row's own action (at least 36 px, 44 px
// on touch), a badge that opens its details on hover or focus, and what fills a row before its actions.

import { Badge, type BadgeProps, Box, Button, type ButtonProps, Combobox, Group, Loader, Text, useCombobox } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
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
  /** Shown, but not pickable (and never preselected): why, in `caption`. */
  disabled?: boolean;
  /** A muted line under the label: why it can't be picked, or what it is. */
  caption?: ReactNode;
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
  /** The button, to move focus to it (after a row it added is gone). */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/** A section's "add" action: a default Button with an icon, opening a searchable list. */
export function Picker({ label, icon: Icon, items, searchLabel, empty, fromSearch, onPick, onOpen, loading, error, onRetry, busy, buttonRef }: PickerProps) {
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
      // In place, as the switcher's: a list portaled out of a drawer was placed off screen on a phone.
      withinPortal={false}
      middlewares={{ flip: true, shift: { padding: 16 } }}
      shadow="overlay"
      classNames={{ option: classes.option }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          ref={buttonRef}
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
                <Box className={classes.grow}>
                  <Text component="span" fz="sm" display="block">
                    {i.label}
                  </Text>
                  {i.caption && (
                    <Text component="span" fz="xs" c="dimmed" display="block">
                      {i.caption}
                    </Text>
                  )}
                </Box>
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

export interface TriggerBadgeProps extends Pick<BadgeProps, "size" | "color" | "variant" | "leftSection" | "children"> {
  "data-marker"?: string;
  "aria-label"?: string;
  /**
   * On touch, a plain badge: no target, no tooltip. For a board card, whose title opens the drawer with
   * the same details, so the card keeps one rhythm on a phone instead of growing 44 px lines.
   */
  plainOnTouch?: boolean;
}

/**
 * A badge whose details open on hover or focus (a Tooltip's child): focusable, with the theme's ring,
 * and on touch a 44 px target that reserves its space. The tooltip's handlers go on the wrapper, which
 * is the target.
 */
export const TriggerBadge = forwardRef<HTMLSpanElement, TriggerBadgeProps & React.HTMLAttributes<HTMLSpanElement>>(function TriggerBadge(
  { size, color, variant, leftSection, children, "data-marker": marker, "aria-label": label, plainOnTouch = false, ...target },
  ref,
) {
  const touch = useMediaQuery("(pointer: coarse)");
  if (plainOnTouch && touch) {
    // The Tooltip's handlers are dropped: on a phone the card's title is the way to its details.
    return (
      <Badge ref={ref as React.Ref<HTMLDivElement>} size={size} color={color} variant={variant} leftSection={leftSection} data-marker={marker}>
        {children}
      </Badge>
    );
  }
  return (
    // The Tooltip's own props (handlers, its className) first, then ours merged in: never replaced.
    <Box component="span" {...target} ref={ref} tabIndex={0} aria-label={label} data-marker={marker} className={[classes.trigger, target.className].filter(Boolean).join(" ")}>
      <Badge size={size} color={color} variant={variant} leftSection={leftSection}>
        {children}
      </Badge>
    </Box>
  );
});

/**
 * A line of badges that may hold a TriggerBadge: on touch it reserves the trigger's 44 px pitch whether
 * or not it has one, so every row of a list (a task's PRs) keeps one rhythm.
 */
export function BadgeLine({ children }: { children: ReactNode }) {
  return (
    <Group gap="xs" wrap="wrap" className={classes.badgeLine}>
      {children}
    </Group>
  );
}

/**
 * A list row's head that may end in a RowAction: one line, the action kept at the right; on touch it
 * reserves the action's 44 px whether or not this row has one, so rows with and without align.
 */
export function ActionLine({ children }: { children: ReactNode }) {
  return (
    <Group gap="sm" wrap="nowrap" className={classes.badgeLine}>
      {children}
    </Group>
  );
}

/** What fills a row's free width, wrapping before the row's actions give way. */
export function Grow({ children }: { children: ReactNode }) {
  return <Box className={classes.grow}>{children}</Box>;
}
