// What needs the owner first: everything wrong or stuck, errors first, each with why and a way to its
// row in the tables below.

import { Anchor, Group, Text } from "@mantine/core";
import type { AttentionItem } from "../fleet";
import { EmptyState, ItemList, Panel, RoleIcon, Section, StatusBadge, Target } from "../layout";
import { Id } from "./common";

/** Scroll to a row and put the focus on it (it takes focus: tabIndex -1). */
export function showRow(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

export function Attention({ items, checking }: { items: AttentionItem[]; checking: boolean }) {
  return (
    <Section id="attention" title="Needs attention" count={items.length}>
      <Panel padding={items.length ? "flush" : "default"} aria-label="Needs attention">
        {items.length === 0 ? (
          <EmptyState title={checking ? "Nothing so far" : "Nothing needs attention"}>
            {checking ? "Still reading what is left lying around." : "No errors, nothing stuck or left lying around, every live host healthy."}
          </EmptyState>
        ) : (
          <ItemList label="Needs attention">
            {items.map((i) => <Item key={i.key} item={i} />)}
          </ItemList>
        )}
      </Panel>
    </Section>
  );
}

function Item({ item }: { item: AttentionItem }) {
  return (
    <Group component="li" justify="space-between" wrap="nowrap" gap="lg" px="lg" py="sm" align="center">
      <Group gap="sm" wrap="wrap" align="center">
        <StatusBadge role={item.role} icon={<RoleIcon role={item.role} />}>{item.label}</StatusBadge>
        <Text size="sm" fw={500}>
          {item.noun}
          {item.subject && <> <Id id={item.subject} /></>}
        </Text>
        <Text size="sm" c="dimmed">{item.reason}</Text>
      </Group>
      {item.target && (
        <Target>
          <Anchor component="button" type="button" size="sm" onClick={() => showRow(item.target!)} aria-label={`Show ${item.noun.toLowerCase()} ${item.subject ?? ""}`}>
            Show
          </Anchor>
        </Target>
      )}
    </Group>
  );
}
