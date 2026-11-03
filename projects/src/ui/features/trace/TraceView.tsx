// An agent's live trace: its turns as groups (the assistant's text, each tool call with its result's
// status, its input and result a click away), what it waits on, and whether the view is live. It follows
// the newest event only while scrolled to the bottom; otherwise "Jump to live" takes it there.

import { Badge, Button, Code, Collapse, Divider, Text, UnstyledButton } from "@mantine/core";
import { IconArrowDown, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ago, exact } from "../../common/time";
import { FadeIn, icon, LoadingState, Notice, Prose, Row, ScrollLog, Section, Stack, weight } from "../../layout";
import { groupTurns, lastState, type ToolItem, type TraceEvent, type TraceItem, type TraceState, type TraceStatus, type TurnGroup } from "./model";
import { useTrace } from "./useTrace";

/** Within this many px of the bottom counts as at the bottom (a fraction of a line). */
const NEAR_BOTTOM = 24;

const STATUS: Record<TraceStatus, { label: string; color: "success" | "gray" | "warning" }> = {
  live: { label: "Live", color: "success" },
  connecting: { label: "Connecting", color: "gray" },
  reconnecting: { label: "Reconnecting", color: "warning" },
  ended: { label: "Ended", color: "gray" },
};

const INPUT: Record<string, string> = { user: "Message", inbox: "Inbox", ask_answer: "Answer", recovery: "Recovery", event_batch: "Events" };

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** A tool's input as sent (compact JSON, perhaps cut short), indented when it parses. */
function pretty(input: unknown): string {
  const s = str(input);
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function ToolCall({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const r = item.result;
  const status = !r ? { label: "Running", color: "gray" as const } : r.is_error ? { label: "Error", color: "danger" as const } : { label: "Done", color: "success" as const };
  return (
    <Stack gap="xs" data-kind="tool" data-call={str(item.call.call_id)}>
      <Row gap="sm" wrap="nowrap">
        {/* On the log's left edge, like the text around it; a 32 px target. */}
        <UnstyledButton aria-expanded={open} onClick={() => setOpen((o) => !o)} mih="var(--nest-hit)">
          <Row gap="xs" wrap="nowrap">
            {open ? <IconChevronDown size={icon.sm} aria-hidden /> : <IconChevronRight size={icon.sm} aria-hidden />}
            <Text component="span" fz="sm" ff="monospace">
              {str(item.call.name)}
            </Text>
          </Row>
        </UnstyledButton>
        <Badge size="sm" variant="light" color={status.color} data-slot="status">
          {status.label}
        </Badge>
      </Row>
      <Collapse expanded={open}>
        <Stack gap="xs">
          <Text fz="xs" c="dimmed">
            Input
          </Text>
          <Code block>{pretty(item.call.input)}</Code>
          {r && (
            <>
              <Text fz="xs" c="dimmed">
                Result
              </Text>
              <Code block>{str(r.summary) || "No output"}</Code>
            </>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}

function Caption({ ev, children, tone }: { ev: TraceEvent; children: React.ReactNode; tone?: "warning" }) {
  return (
    <Text fz="xs" c={tone ?? "dimmed"} title={exact(ev.ts_ms)} data-kind={ev.type}>
      {children}
    </Text>
  );
}

function EventItem({ ev }: { ev: TraceEvent }) {
  switch (ev.type) {
    case "assistant_text":
      return (
        <div data-kind="text">
          <Prose size="sm">{str(ev.text)}</Prose>
        </div>
      );
    case "state":
      return <Caption ev={ev}>Now {str(ev.state).replace(/_/g, " ")}</Caption>;
    case "ask":
      return (
        <Notice tone="warning" title="Waiting for an answer">
          <Prose size="sm">{str(ev.question)}</Prose>
        </Notice>
      );
    case "ask_answered":
      return <Caption ev={ev}>Answered</Caption>;
    case "error":
      return (
        <Notice tone="danger" title={`Error: ${str(ev.code)}`}>
          <Prose size="sm">{str(ev.message)}</Prose>
        </Notice>
      );
    case "rate_limited":
      return (
        <Caption ev={ev} tone="warning">
          Rate limited: {str(ev.detail)}
        </Caption>
      );
    case "task_exited":
      return (
        <Caption ev={ev}>
          Background task {str(ev.task_id)} {str(ev.status).replace(/_/g, " ")}
          {ev.exit_code !== undefined ? ` (code ${str(ev.exit_code)})` : ""}
        </Caption>
      );
    case "ended":
      return <Caption ev={ev}>The agent ended ({str(ev.reason)})</Caption>;
    default:
      return null; // a type this page doesn't know
  }
}

function Item({ item }: { item: TraceItem }) {
  return item.kind === "tool" ? <ToolCall item={item} /> : <EventItem ev={item.event} />;
}

/** Visible items: an unknown event type renders nothing, so it gets no slot. */
const shown = (i: TraceItem) =>
  i.kind === "tool" || ["assistant_text", "state", "ask", "ask_answered", "error", "rate_limited", "task_exited", "ended"].includes(i.event.type);

function tokens(u: unknown): string | null {
  const x = u as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!x || typeof x.input_tokens !== "number" || typeof x.output_tokens !== "number") return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(x.input_tokens)} in · ${k(x.output_tokens)} out`;
}

function Turn({ g, animateAfter }: { g: TurnGroup; animateAfter: number }) {
  const items = g.items.filter(shown);
  const head = g.items[0];
  const at = g.started?.ts_ms ?? (head ? (head.kind === "tool" ? head.call.ts_ms : head.event.ts_ms) : null);
  const usage = g.completed ? tokens(g.completed.usage) : null;
  return (
    <Stack gap="sm" aria-label={g.turn ? "Turn" : "Between turns"} role="group" data-turn={g.turn ?? ""}>
      {g.turn && (
        <Row gap="sm" justify="space-between">
          <Row gap="sm">
            <Text fz="xs" fw={weight.medium}>
              {g.started ? `Turn · ${INPUT[str(g.started.input_kind)] ?? str(g.started.input_kind)}` : "Turn (started earlier)"}
            </Text>
            {at !== null && (
              <Text fz="xs" c="dimmed" title={exact(at)}>
                {ago(at)}
              </Text>
            )}
          </Row>
          <Row gap="sm">
            {usage && (
              <Text fz="xs" c="dimmed" ff="monospace">
                {usage}
              </Text>
            )}
            {g.completed ? (
              <Badge size="sm" variant="light" color="gray" title={str(g.completed.stop_reason)} data-slot="turn-status">
                Completed
              </Badge>
            ) : (
              <Badge size="sm" variant="light" color="primary" data-slot="turn-status">
                Working
              </Badge>
            )}
          </Row>
        </Row>
      )}
      {items.map((i) => (
        <FadeIn key={i.seq} animate={i.seq > animateAfter}>
          <Item item={i} />
        </FadeIn>
      ))}
    </Stack>
  );
}

/** The trace of a state, presented (separate from the socket, so tests can give a state directly). */
export function TraceLog({ title, state }: { title: string; state: TraceState }) {
  const groups = useMemo(() => groupTurns(state.events), [state.events]);
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const seen = useRef(state.last);

  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const onScroll = () => {
      const near = v.scrollHeight - v.scrollTop - v.clientHeight <= NEAR_BOTTOM;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setUnseen(0);
    };
    v.addEventListener("scroll", onScroll, { passive: true });
    return () => v.removeEventListener("scroll", onScroll);
  }, []);

  // New events: followed only while at the bottom; otherwise counted for "Jump to live".
  useLayoutEffect(() => {
    const added = state.events.filter((e) => e.seq > seen.current).length;
    seen.current = state.last;
    if (!added) return;
    const v = viewport.current;
    if (atBottomRef.current) v?.scrollTo({ top: v.scrollHeight });
    else setUnseen((n) => n + added);
  }, [state.events, state.last]);

  const jump = () => {
    const v = viewport.current;
    v?.scrollTo({ top: v.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  };

  const status = STATUS[state.status];
  const agentState = lastState(state.events);
  return (
    <Section
      title={title}
      region={false}
      actions={
        <>
          {agentState && (
            <Text fz="xs" c="dimmed" data-slot="agent-state">
              {agentState.replace(/_/g, " ")}
            </Text>
          )}
          <Badge variant="light" color={status.color} data-slot="trace-status" aria-live="polite">
            {status.label}
          </Badge>
        </>
      }
    >
      <Stack gap="md">
        {state.gap && (
          <Notice tone="info" title="Earlier events aren't in the live trace">
            <Text fz="xs">
              Events {state.gap.from}–{state.gap.to} are older than nest keeps for the live trace. This app has no transcript view yet.
            </Text>
          </Notice>
        )}
        {state.trimmed && (
          <Text fz="xs" c="dimmed">
            Older events are hidden to keep the page light.
          </Text>
        )}
        <ScrollLog viewportRef={viewport}>
          {state.events.length === 0 ? (
            state.status === "connecting" ? (
              <LoadingState label="Connecting to the trace" />
            ) : (
              <Text fz="sm" c="dimmed" ta="center" py="lg">
                {state.status === "ended" ? "The agent ended with nothing in its trace." : "Nothing yet. What the agent does shows here as it happens."}
              </Text>
            )
          ) : (
            <Stack gap="lg">
              {groups.map((g, n) => (
                <Stack key={g.key} gap="lg">
                  {n > 0 && <Divider />}
                  <Turn g={g} animateAfter={state.animateAfter} />
                </Stack>
              ))}
            </Stack>
          )}
        </ScrollLog>
        {!atBottom && (
          <Row justify="center">
            <Button variant="light" size="compact-sm" leftSection={<IconArrowDown size={icon.sm} />} onClick={jump}>
              {unseen > 0 ? `Jump to live (${unseen} new)` : "Jump to live"}
            </Button>
          </Row>
        )}
      </Stack>
    </Section>
  );
}

/** An agent's live trace, connected while shown; `empty` says why there's no agent yet. */
export function TraceView({ title, agent, empty = "No agent yet." }: { title: string; agent: string | null; empty?: string }) {
  const state = useTrace(agent);
  if (!agent) {
    return (
      <Section title={title} region={false}>
        <Text fz="sm" c="dimmed">
          {empty}
        </Text>
      </Section>
    );
  }
  return <TraceLog title={title} state={state} />;
}
