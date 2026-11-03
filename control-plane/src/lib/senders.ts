// Who an inbox message says it is from (docs/control-plane/api/clients/#inbox-senders). The operator and
// nest itself name any sender; an API client names a label of its own, never one of nest's, and the
// message says which client sent it.
import { ErrorCodes } from "../protocol/model";
import { TIMER_SENDER } from "./timers";
import { NestError } from "./util";

/** The sender of the platform's own notes about an agent's work (not input: see `stop_quiet`). */
export const SYSTEM_SENDER = "system";
/** The operator's posts, when it names no sender. */
export const OPERATOR_SENDER = "user";

/** Senders only nest uses: its notes, a fired timer, and the operator's default. */
const NEST_SENDERS: readonly string[] = [SYSTEM_SENDER, TIMER_SENDER, OPERATOR_SENDER];
/**
 * A principal's id (an agent's, as a spawner's task names it, `<template>:<agt_…>`; a client's; a host's;
 * a sandbox's), anywhere in the label.
 */
const NEST_ID = /(agt|cli|hst|sbx)_/i;
/** A client's label: no `:`, brackets, parentheses or line breaks, so it can't forge a spawner's name or the `(via client …)` mark. */
const CLIENT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._/@+-]{0,63}$/;

/**
 * The sender an API client's post shows: its own id when it names none (or names itself), else its label
 * marked with its id. Refused: a malformed label (400), and a label naming one of nest's senders or a
 * principal (403).
 */
export function clientSender(from: string | undefined, client: string): string {
  if (from === undefined || from === client) return client;
  if (!CLIENT_LABEL.test(from)) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "from is 1-64 letters, digits, spaces and . _ / @ + -, starting with a letter or digit");
  }
  if (NEST_SENDERS.includes(from.toLowerCase()) || NEST_ID.test(from)) {
    throw new NestError(ErrorCodes.FORBIDDEN, `from ${JSON.stringify(from)} is one of nest's senders: name your own (it shows as "<from> (via client ${client})")`, 403);
  }
  return `${from} (via client ${client})`;
}
