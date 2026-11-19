// The Manager chat's composer (README.md#the-manager-chat), on its own so that typing renders it alone and
// never the log: the field and its draft (kept per project in the browser, saved a moment after typing
// stops and at once on sending, leaving, switching project or hiding the page), and the bar under it (the
// keys' hint or the reply the manager waits for, a down manager's Restart on a phone, Stop, Send). The log
// reaches in through its handle: a quote, a starter.

import { ActionIcon, Button, Text, Textarea, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowUp, IconHourglass, IconPlayerStop } from "@tabler/icons-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { human } from "../../../waits";
import { useInterruptManager, useRestartManager, useWaits } from "../../api/queries";
import { exact } from "../../common/time";
import { ComposerBox, icon, Row, usePhone } from "../../layout";
import { loadDraft, quote, saveDraft } from "./model";

/** How long after the last keystroke the draft is saved (it's saved at once on send, leaving, or hiding the page). */
export const DRAFT_SAVE_MS = 300;

export interface ComposerHandle {
  /** Puts `text` quoted at the composer's start, focus and the caret at its end. */
  quote(text: string): void;
  /** Fills the composer with a starter and focuses it (the caret at its end). */
  fill(text: string): void;
  focus(): void;
}

interface Props {
  projectId: string;
  /** A turn is running: Stop is offered. */
  running: boolean;
  /** The manager ended or errored. */
  down: boolean;
  /** A message is being posted: Send waits. */
  sending: boolean;
  /** Sends the trimmed text; false if it wasn't taken (empty, or one still being posted), and the composer keeps it. */
  onSend: (text: string) => boolean;
}

/** Give it `key={projectId}`: each project's draft is its own, and leaving one saves its draft. */
export const Composer = memo(
  forwardRef<ComposerHandle, Props>(function Composer({ projectId, running, down, sending, onSend }, ref) {
    const coarse = useMediaQuery("(pointer: coarse)") ?? false;
    const interrupt = useInterruptManager(projectId);
    const restart = useRestartManager(projectId);
    const phone = usePhone();
    const waits = useWaits(projectId);
    const replyWait = waits.data?.pending.find((w) => w.kind === "reply");
    // The time left on the owner's reply counts down by the minute.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      if (!replyWait) return;
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 60_000);
      return () => clearInterval(t);
    }, [replyWait?.id]);

    const [text, setTextState] = useState(() => loadDraft(projectId));
    const textRef = useRef(text);
    const field = useRef<HTMLTextAreaElement>(null);

    // The draft as last typed, until it's saved.
    const unsaved = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const flush = useCallback(() => {
      clearTimeout(timer.current);
      if (unsaved.current === null) return;
      saveDraft(projectId, unsaved.current);
      unsaved.current = null;
    }, [projectId]);
    const setText = useCallback(
      (next: string, now = false) => {
        textRef.current = next;
        setTextState(next);
        unsaved.current = next;
        clearTimeout(timer.current);
        if (now) flush();
        else timer.current = setTimeout(flush, DRAFT_SAVE_MS);
      },
      [flush],
    );
    // Nothing typed is lost: leaving the page or hiding it saves it, as does unmounting (another project).
    useEffect(() => {
      const hidden = () => {
        if (document.visibilityState === "hidden") flush();
      };
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", hidden);
      return () => {
        window.removeEventListener("pagehide", flush);
        document.removeEventListener("visibilitychange", hidden);
        flush();
      };
    }, [flush]);

    useImperativeHandle(
      ref,
      () => ({
        // Quoting puts the quote at the composer's start and the caret at its end, once the menu has closed
        // (it returns focus to its button first).
        quote(t) {
          const next = quote(t) + textRef.current;
          setText(next);
          setTimeout(() => {
            const c = field.current;
            if (!c) return;
            c.focus();
            c.setSelectionRange(next.length, next.length);
          }, 0);
        },
        // A starter fills the composer and focuses it at once (setting the value puts the caret at its end),
        // so typing straight after the click continues it.
        fill(t) {
          setText(t);
          field.current?.focus();
        },
        focus() {
          field.current?.focus();
        },
      }),
      [setText],
    );

    const send = () => {
      if (onSend(textRef.current.trim())) setText("", true);
    };

    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <ComposerBox
          bar={
            <>
              {down && phone ? (
                <Row gap="xs" wrap="nowrap" data-slot="manager-down">
                  <Text fz="xs" c="warning">
                    The manager isn&apos;t running
                  </Text>
                  <Button variant="subtle" size="compact-sm" loading={restart.isPending} onClick={() => restart.mutate()}>
                    Restart manager
                  </Button>
                </Row>
              ) : replyWait && !down ? (
                <Row gap="xs" wrap="nowrap" data-slot="reply-wait">
                  <Text component="span" c="dimmed" display="inline-flex">
                    <IconHourglass size={icon.sm} aria-hidden />
                  </Text>
                  <Text fz="xs" c="dimmed" title={`Times out ${exact(replyWait.deadline_ms)}`}>
                    Waiting for your reply · {replyWait.deadline_ms > now ? `${human(replyWait.deadline_ms - now)} left` : "timing out"}
                  </Text>
                </Row>
              ) : (
                !coarse && (
                  <Text fz="xs" c="dimmed">
                    Enter to send · Shift+Enter for a new line
                  </Text>
                )
              )}
              <Row gap="sm" wrap="nowrap">
                {running && (
                  <Button variant="default" size="compact-sm" leftSection={<IconPlayerStop size={icon.sm} />} loading={interrupt.isPending} onClick={() => interrupt.mutate()}>
                    Stop
                  </Button>
                )}
                <Tooltip label="Send" withArrow disabled={coarse}>
                  <ActionIcon type="submit" size="lg" aria-label="Send" disabled={!text.trim() || sending}>
                    <IconArrowUp size={icon.md} />
                  </ActionIcon>
                </Tooltip>
              </Row>
            </>
          }
        >
          <Textarea
            ref={field}
            aria-label="Message to the manager"
            placeholder="Message the manager"
            variant="unstyled"
            autosize
            minRows={1}
            maxRows={10}
            maxLength={20000}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              // On touch, Enter is a new line (a phone's keyboard has no Shift+Enter); Send sends.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse) {
                e.preventDefault();
                send();
              }
            }}
          />
        </ComposerBox>
      </form>
    );
  }),
);
