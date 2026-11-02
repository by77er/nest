// The sandbox templates, and how many live sandboxes on a host run each.

import { Badge, Group, Table } from "@mantine/core";
import type { Images, SandboxRow } from "../../api";
import { DataTable, EmptyState, ErrorState, LoadingState, Panel, Section } from "../layout";
import { Mono } from "./common";

export function TemplatesSection({ images, error, onRetry, sandboxes }: {
  images: Images | undefined;
  error: string | null;
  onRetry: () => void;
  /** Sandboxes on a host; undefined before the fleet view is read. */
  sandboxes: SandboxRow[] | undefined;
}) {
  return (
    <Section id="templates" title="Templates" count={images?.templates.length}>
      {!images ? (error ? <ErrorState title="Couldn't read the templates" error={error} onRetry={onRetry} /> : <Panel><LoadingState label="Reading the templates" /></Panel>)
        : images.templates.length === 0 ? <Panel><EmptyState title="No templates" /></Panel>
        : (
          <DataTable label="Templates" head={<><Table.Th>Template</Table.Th><Table.Th ta="right">Live sandboxes</Table.Th></>}>
            {images.templates.map((t) => (
              <Table.Tr key={t.name}>
                <Table.Td>
                  <Group gap="sm" wrap="nowrap"><Mono value={t.name} />{t.default && <Badge color="gray">default</Badge>}</Group>
                </Table.Td>
                <Table.Td ta="right">{sandboxes ? sandboxes.filter((s) => s.image === t.name).length : "—"}</Table.Td>
              </Table.Tr>
            ))}
          </DataTable>
        )}
    </Section>
  );
}
