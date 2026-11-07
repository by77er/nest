// Adding or editing a routine (README.md#routines), in a Sheet: its name, kind and instructions; its
// triggers (a timer, and the board's counters); its limits (cooldown, time and turn budget); and where its
// proposed tasks go. Checked with the Worker's own schema before it's sent.

import { Button, NumberInput, SegmentedControl, Select, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";
import { ROUTINE_KINDS, UpdateRoutine } from "../../../requests";
import { ApiError } from "../../api/client";
import { useCreateRoutine, useUpdateRoutine } from "../../api/queries";
import type { Routine, RoutineKind, Timer, UpdateRoutineBody } from "../../api/types";
import { FieldGroup, Notice, Section, Stack } from "../../layout";
import { WEEKDAYS } from "./describe";

const KIND_LABEL: Record<RoutineKind, string> = { review: "Review", dreaming: "Dreaming", custom: "Custom" };
type TimerKind = "none" | Timer["kind"];

/** The browser's time zone, the default for a new daily or weekly timer. */
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Every time zone the browser knows, UTC first. */
function zones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return [...new Set(["UTC", current, ...all])];
}

interface Draft {
  name: string;
  kind: RoutineKind;
  prompt: string;
  enabled: boolean;
  timer: TimerKind;
  minutes: number | string;
  time: string;
  day: string;
  tz: string;
  prs: number | string;
  tasks: number | string;
  cooldown_min: number | string;
  max_minutes: number | string;
  max_turns: number | string;
  proposals: "triage" | "draft";
}

function draftOf(r?: Routine): Draft {
  const t = r?.triggers.timer ?? null;
  return {
    name: r?.name ?? "", kind: r?.kind ?? "custom", prompt: r?.prompt ?? "", enabled: r?.enabled ?? true,
    timer: t?.kind ?? (r ? "none" : "daily"),
    minutes: t?.kind === "interval" ? t.minutes : 60,
    time: t && t.kind !== "interval" ? t.time : "09:00",
    day: String(t?.kind === "weekly" ? t.day : 1),
    tz: t && t.kind !== "interval" ? t.tz : localZone(),
    prs: r?.triggers.prs_merged ?? "", tasks: r?.triggers.tasks_done ?? "",
    cooldown_min: r?.cooldown_min ?? 60, max_minutes: r?.max_minutes ?? 30, max_turns: r?.max_turns ?? 3, proposals: r?.proposals ?? "triage",
  };
}

const num = (v: number | string) => (v === "" ? null : Number(v));

/** The request body a draft makes; zod (the Worker's schema) says what's wrong with it. */
function bodyOf(d: Draft): UpdateRoutineBody {
  const timer: Timer | null = d.timer === "none" ? null
    : d.timer === "interval" ? { kind: "interval", minutes: Number(d.minutes) }
    : d.timer === "daily" ? { kind: "daily", time: d.time, tz: d.tz }
    : { kind: "weekly", day: Number(d.day), time: d.time, tz: d.tz };
  return {
    name: d.name, kind: d.kind, prompt: d.prompt, enabled: d.enabled,
    triggers: { timer, prs_merged: num(d.prs), tasks_done: num(d.tasks) },
    cooldown_min: Number(d.cooldown_min), max_minutes: Number(d.max_minutes), max_turns: Number(d.max_turns), proposals: d.proposals,
  };
}

/** What's wrong with a draft, by field, in the Worker's words. */
function problems(d: Draft): Record<string, string> {
  const r = UpdateRoutine.safeParse(bodyOf(d));
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const path = i.path.join(".");
    const field = path.startsWith("triggers.timer.minutes") ? "minutes" : path.startsWith("triggers.timer.time") ? "time" : path.startsWith("triggers.timer.tz") ? "tz"
      : path === "triggers.prs_merged" ? "prs" : path === "triggers.tasks_done" ? "tasks" : path;
    out[field] ??= i.message;
  }
  return out;
}

export function RoutineForm({ projectId, editing, onDone }: { projectId: string; editing?: Routine; onDone: () => void }) {
  const create = useCreateRoutine(projectId);
  const update = useUpdateRoutine(projectId);
  const [d, setD] = useState<Draft>(() => draftOf(editing));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const errs = tried ? problems(d) : {};
  const saving = create.isPending || update.isPending;
  const failed = create.error ?? update.error;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems(d)).length) return;
    const body = bodyOf(d);
    if (editing) update.mutate({ routine: editing.id, ...body }, { onSuccess: onDone });
    else create.mutate(body as Required<UpdateRoutineBody>, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="2xl">
        <Section title="Routine" order={4} region={false}>
          <FieldGroup>
            <TextInput label="Name" required value={d.name} onChange={(e) => set("name")(e.currentTarget.value)} error={errs.name} data-autofocus />
            <Select label="Kind" data={ROUTINE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} value={d.kind} allowDeselect={false} onChange={(v) => v && set("kind")(v as RoutineKind)} />
            <Textarea
              label="Instructions"
              description="What each run does. It reads the board, recent work and the repo, and may propose tasks and keep the project's memory."
              required
              autosize
              minRows={5}
              maxRows={16}
              value={d.prompt}
              onChange={(e) => set("prompt")(e.currentTarget.value)}
              error={errs.prompt}
            />
            <Switch label="On" description="Off, its triggers don't fire; Run now still does." checked={d.enabled} onChange={(e) => set("enabled")(e.currentTarget.checked)} />
          </FieldGroup>
        </Section>

        <Section title="When it runs" order={4} region={false}>
          <FieldGroup>
            <Text fz="sm" c="dimmed">
              Any of these starts a run, one at a time.
            </Text>
            <Select
              label="Timer"
              data={[
                { value: "none", label: "No timer" },
                { value: "interval", label: "Every few minutes or hours" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
              value={d.timer}
              allowDeselect={false}
              onChange={(v) => v && set("timer")(v as TimerKind)}
            />
            {d.timer === "interval" && (
              <NumberInput label="Every (minutes)" description="At least 15." min={15} max={10080} clampBehavior="none" allowDecimal={false} value={d.minutes} onChange={set("minutes")} error={errs.minutes} />
            )}
            {d.timer === "weekly" && (
              <Select label="Day" data={WEEKDAYS.map((w, i) => ({ value: String(i), label: w }))} value={d.day} allowDeselect={false} onChange={(v) => v && set("day")(v)} />
            )}
            {(d.timer === "daily" || d.timer === "weekly") && (
              <>
                <TextInput label="Time" type="time" value={d.time} onChange={(e) => set("time")(e.currentTarget.value)} error={errs.time} />
                <Select label="Time zone" searchable data={zones(d.tz)} value={d.tz} allowDeselect={false} onChange={(v) => v && set("tz")(v)} error={errs.tz} />
              </>
            )}
            <NumberInput
              label="After task PRs merged"
              description="This many task PRs merged since its last run. Empty: not a trigger."
              min={1}
              max={1000}
              allowDecimal={false}
              value={d.prs}
              onChange={set("prs")}
              error={errs.prs}
            />
            <NumberInput
              label="After tasks done"
              description="This many tasks done since its last run. Empty: not a trigger."
              min={1}
              max={1000}
              allowDecimal={false}
              value={d.tasks}
              onChange={set("tasks")}
              error={errs.tasks}
            />
          </FieldGroup>
        </Section>

        <Section title="Limits" order={4} region={false}>
          <FieldGroup>
            <NumberInput
              label="Cooldown (minutes)"
              description="At least this long between two runs' starts. Run now skips it."
              min={0}
              max={10080}
              allowDecimal={false}
              value={d.cooldown_min}
              onChange={set("cooldown_min")}
              error={errs.cooldown_min}
            />
            <NumberInput label="Time budget (minutes)" description="A run is stopped after this long." min={5} max={120} allowDecimal={false} value={d.max_minutes} onChange={set("max_minutes")} error={errs.max_minutes} />
            <NumberInput label="Turn budget" description="A run is stopped after this many turns." min={1} max={20} allowDecimal={false} value={d.max_turns} onChange={set("max_turns")} error={errs.max_turns} />
          </FieldGroup>
        </Section>

        <Section title="Proposed tasks" order={4} region={false}>
          <FieldGroup
            actions={
              <>
                <Button variant="default" onClick={onDone}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {editing ? "Save" : "Add routine"}
                </Button>
              </>
            }
          >
            <Stack gap="xs">
              <SegmentedControl
                aria-label="Where proposed tasks go"
                data={[
                  { value: "triage", label: "To you, for triage" },
                  { value: "draft", label: "Onto the board, as drafts" },
                ]}
                value={d.proposals}
                onChange={(v) => set("proposals")(v as Draft["proposals"])}
              />
              <Text fz="sm" c="dimmed">
                {d.proposals === "triage"
                  ? "You accept or decline each one; accepted, it's a draft on the board."
                  : "Drafts go straight onto the board. A routine never assigns or starts work."}
              </Text>
            </Stack>
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
