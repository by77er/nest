// A switcher for a parent (the nest-ui-design skill's Navigation): its button names the current one, and
// opens a searchable list, keyboard first (type to filter, arrows, Enter, Escape). The list's highlight
// and its current item are quiet, like the rows. The feature gives the items and what picking does.

import { Combobox, Group, Text, useCombobox } from "@mantine/core";
import { IconSelector } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { icon, weight } from "../theme";
import { SwitcherTarget } from "./Nav";
import classes from "./Nav.module.css";

export interface SwitcherItem {
  value: string;
  label: string;
  /** What the search also matches (a repo). */
  keywords?: string;
  /** At the item's end: its badge. */
  end?: ReactNode;
  /** Its accessible name, when the end says something (a count). */
  ariaLabel?: string;
}

export interface SwitcherProps {
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  /** The current one's name, and its end (a badge). */
  current: { label: string; end?: ReactNode; ariaLabel: string };
  /** First, always listed unless the search excludes it ("All projects"). */
  items: SwitcherItem[];
  active?: string;
  searchLabel: string;
  empty: (search: string) => ReactNode;
  onPick: (value: string) => void;
}

export function Switcher({ icon: Icon, current, items, active, searchLabel, empty, onPick }: SwitcherProps) {
  const [search, setSearch] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
    onDropdownOpen: () => combobox.focusSearchInput(),
  });
  const q = search.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || (i.keywords ?? "").toLowerCase().includes(q));

  // The first match is the one Enter picks.
  useEffect(() => {
    if (combobox.dropdownOpened) combobox.selectFirstOption();
  }, [q, combobox.dropdownOpened]); // `combobox` is stable across renders

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(v) => {
        combobox.closeDropdown();
        onPick(v);
      }}
      position="bottom-start"
      width="target"
      withinPortal={false}
      shadow="overlay"
      classNames={{ option: classes.option }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <SwitcherTarget
          icon={Icon}
          label={current.label}
          end={
            <Group gap="xs" wrap="nowrap">
              {current.end}
              <Text component="span" c="dimmed" display="inline-flex">
                <IconSelector size={icon.sm} aria-hidden />
              </Text>
            </Group>
          }
          aria-haspopup="listbox"
          aria-expanded={combobox.dropdownOpened}
          aria-label={current.ariaLabel}
          onClick={() => combobox.toggleDropdown()}
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder={searchLabel} aria-label={searchLabel} />
        <Combobox.Options aria-label={searchLabel}>
          {shown.map((i) => (
            <Combobox.Option key={i.value} value={i.value} active={i.value === active} aria-label={i.ariaLabel}>
              <Group gap="sm" justify="space-between" wrap="nowrap">
                <Text component="span" fz="md" fw={i.value === active ? weight.bold : weight.regular}>
                  {i.label}
                </Text>
                {i.end}
              </Group>
            </Combobox.Option>
          ))}
          {shown.length === 0 && <Combobox.Empty>{empty(search.trim())}</Combobox.Empty>}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
