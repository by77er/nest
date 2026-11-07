// The project's memory (README.md#memory): a small keyed set of notes the manager and workers read, and
// the manager and routine runs write (the dreaming routine consolidates them). Pure: the limits, the key's
// shape, and who may write.

import type { Role } from "./tools";

/** Notes a project holds; a write past it is refused until notes are merged or deleted. */
export const MAX_NOTES = 100;
/** A note's text, at most. */
export const NOTE_MAX = 2000;
/** A key: lowercase words joined by `-`, `.` or `_`, like `conventions-testing`. */
export const NOTE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** How much of each note `memory_list` shows. */
export const PREVIEW_MAX = 160;

export interface Note {
  key: string;
  text: string;
  /** Who wrote it last: `manager`, `routine:<name>` (with its run), or the owner. */
  source: string;
  /** Whether the session that wrote it last was tainted (shown; it gates nothing). */
  tainted: boolean;
  created_ms: number;
  updated_ms: number;
}

/** The roles that may write memory: the manager and routine runs. Workers and reviewers only read it, or nothing. */
export const MEMORY_WRITERS: readonly Role[] = ["manager", "routine"];

export const mayWriteMemory = (role: Role): boolean => MEMORY_WRITERS.includes(role);

/** A note's first line, clipped, for a listing. */
export function preview(text: string): string {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
}
