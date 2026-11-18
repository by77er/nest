// Adding or editing one of the project's reviewers (README.md#reviewers), in a Sheet: its name, its
// instructions, its dimensions (1 to 6, each judged pass or fail) and whether it's on. Checked with the
// Worker's own schema before it's sent; the Worker's refusal is shown here. Every field is sent, so a save
// makes a tainted reviewer's text the owner's, as the notice at the top says.

import { ActionIcon, Button, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { NewReviewer, REVIEWER_LIMITS } from "../../../requests";
import { ApiError } from "../../api/client";
import { useCreateReviewer, useUpdateReviewer } from "../../api/queries";
import type { Reviewer } from "../../api/types";
import { FieldGroup, icon, Notice, Row, Section, Stack } from "../../layout";
import { taintedText } from "../routines/Untrusted";

interface Draft {
  name: string;
  instructions: string;
  /** Each with a key of its own, so a row removed or added keeps the others' (and focus can be put on one). */
  dimensions: { key: number; name: string }[];
  enabled: boolean;
}

let keys = 0;
const dimension = (name = "") => ({ key: ++keys, name });
const draftOf = (r?: Reviewer): Draft => ({ name: r?.name ?? "", instructions: r?.instructions ?? "", dimensions: r ? r.dimensions.map((x) => dimension(x)) : [dimension()], enabled: r?.enabled ?? true });
const bodyOf = (d: Draft) => ({ name: d.name, instructions: d.instructions, dimensions: d.dimensions.map((x) => x.name), enabled: d.enabled });

/**
 * What's wrong with a draft, by field, in the Worker's words: `name`, `instructions`, `dimension.<i>` for one
 * dimension (a repeated name on its second use), and `dimensions` for the list as a whole.
 */
function problems(d: Draft): Record<string, string> {
  const r = NewReviewer.safeParse(bodyOf(d));
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const [field, at] = i.path;
    const message = i.message.charAt(0).toUpperCase() + i.message.slice(1);
    if (field === "dimensions" && typeof at === "number") out[`dimension.${at}`] ??= message;
    else if (field === "dimensions") {
      const names = d.dimensions.map((x) => x.name.trim().toLowerCase());
      const again = names.findIndex((k, n) => k !== "" && names.indexOf(k) < n);
      out[again >= 0 ? `dimension.${again}` : "dimensions"] ??= message;
    } else out[String(field)] ??= message;
  }
  return out;
}

export function ReviewerForm({ projectId, editing, onDone }: { projectId: string; editing?: Reviewer; onDone: () => void }) {
  const create = useCreateReviewer(projectId);
  const update = useUpdateReviewer(projectId);
  const [d, setD] = useState<Draft>(() => draftOf(editing));
  const [tried, setTried] = useState(false);
  // The dimension to focus once it's rendered: one just added, or the neighbour of one just removed.
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const [focusOn, setFocusOn] = useState<number | null>(null);
  useEffect(() => {
    if (focusOn === null) return;
    inputs.current.get(focusOn)?.focus();
    setFocusOn(null);
  }, [focusOn]);
  const errs = tried ? problems(d) : {};
  const saving = create.isPending || update.isPending;
  const failed = create.error ?? update.error;
  const max = REVIEWER_LIMITS.dimensions;
  const setDimension = (key: number, name: string) => setD((x) => ({ ...x, dimensions: x.dimensions.map((y) => (y.key === key ? { key, name } : y)) }));
  const add = () => {
    const n = dimension();
    setD((x) => ({ ...x, dimensions: [...x.dimensions, n] }));
    setFocusOn(n.key);
  };
  const remove = (i: number) => {
    setFocusOn((d.dimensions[i + 1] ?? d.dimensions[i - 1])?.key ?? null);
    setD((x) => ({ ...x, dimensions: x.dimensions.filter((_, n) => n !== i) }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    // A refusal from an earlier save no longer stands beside what's wrong now.
    create.reset();
    update.reset();
    if (Object.keys(problems(d)).length) return;
    const body = bodyOf(d);
    if (editing) update.mutate({ reviewer: editing.id, ...body }, { onSuccess: onDone });
    else create.mutate(body, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="2xl">
        {editing?.tainted && (
          <Notice tone="warning" title="Tainted">
            {taintedText(editing.source, "name, instructions or dimensions")}
          </Notice>
        )}
        <Section title="Reviewer" order={4} region={false}>
          <FieldGroup>
            <TextInput label="Name" required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} error={errs.name} data-autofocus />
            <Textarea
              label="Instructions"
              description="What it judges and how. Its brief carries them; it reads the PR's diff and the repo."
              required
              autosize
              minRows={5}
              maxRows={16}
              value={d.instructions}
              onChange={(e) => setD({ ...d, instructions: e.currentTarget.value })}
              error={errs.instructions}
            />
            <Switch label="On" description="Off, it reviews no PR heads until it's on again." checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
          </FieldGroup>
        </Section>

        <Section title="Dimensions" order={4} region={false}>
          <FieldGroup
            actions={
              <>
                <Button variant="default" onClick={onDone}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {editing ? "Save" : "Add reviewer"}
                </Button>
              </>
            }
          >
            <Text fz="sm" c="dimmed">
              Each is judged pass or fail; the review passes only if all pass. 1 to {max}, each named differently.
            </Text>
            <Stack gap="sm" role="list" aria-label="Dimensions">
              {d.dimensions.map((x, i) => (
                <Row key={x.key} gap="xs" wrap="nowrap" align="flex-start" role="listitem">
                  <TextInput
                    flex={1}
                    ref={(el) => {
                      if (el) inputs.current.set(x.key, el);
                      else inputs.current.delete(x.key);
                    }}
                    aria-label={`Dimension ${i + 1}`}
                    value={x.name}
                    onChange={(e) => setDimension(x.key, e.currentTarget.value)}
                    error={errs[`dimension.${i}`]}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={`Remove dimension ${i + 1}${x.name.trim() ? ` (${x.name.trim()})` : ""}`}
                    disabled={d.dimensions.length === 1}
                    onClick={() => remove(i)}
                  >
                    <IconX size={icon.md} />
                  </ActionIcon>
                </Row>
              ))}
            </Stack>
            {errs.dimensions && (
              <Text fz="xs" c="danger" role="alert">
                {errs.dimensions}
              </Text>
            )}
            <Row gap="sm">
              <Button variant="default" size="xs" leftSection={<IconPlus size={icon.sm} />} disabled={d.dimensions.length >= max} onClick={add}>
                Add dimension
              </Button>
              {d.dimensions.length >= max && (
                <Text fz="xs" c="dimmed" data-slot="dimensions-full">
                  At most {max}: remove one to add another.
                </Text>
              )}
            </Row>
            {failed && (
              <Notice tone="danger" role="alert">
                {failed instanceof ApiError ? failed.message : String(failed)}
              </Notice>
            )}
          </FieldGroup>
        </Section>
      </Stack>
    </form>
  );
}
