// Small pieces every section shows the same way.

import { Text } from "@mantine/core";
import { short } from "../format";
import { StatusBadge } from "../layout";
import { roleOf } from "../status";
import type { Role } from "../theme";

/** An id, shortened, in the mono face; the full one is its title. */
export function Id({ id, full }: { id: string | null | undefined; full?: boolean }) {
  if (!id) return <None />;
  return <Text span ff="monospace" inherit title={id}>{full ? id : short(id)}</Text>;
}

/** A value the control plane did not give. */
export const None = ({ children = "—" }: { children?: string }) => <Text span c="dimmed" inherit>{children}</Text>;

/** A mono value (a template, a state) or none. */
export const Mono = ({ value }: { value: string | null | undefined }) => (value ? <Text span ff="monospace" inherit>{value}</Text> : <None />);

/** A value as its role's badge; none when there is no value. */
export function Status({ table, value, title }: { table: Record<string, Role>; value: string | null | undefined; title?: string }) {
  if (!value) return <None />;
  return <StatusBadge role={roleOf(table, value)} title={title}>{value}</StatusBadge>;
}
