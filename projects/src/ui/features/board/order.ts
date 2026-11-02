// Board order is each task's `ord` (lower first). Moving a card gives it an `ord` between its new
// neighbours', so only the moved task is written.

/** An `ord` between `before` and `after`; either may be missing (the column's start or end). */
export function ordBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/**
 * The `ord` that moves the task at `from` to `to` in `column` (in board order), or null when it
 * doesn't move.
 */
export function ordForMove(column: readonly { ord: number }[], from: number, to: number): number | null {
  if (from === to || from < 0 || to < 0 || from >= column.length || to >= column.length) return null;
  const rest = column.filter((_, i) => i !== from);
  return ordBetween(rest[to - 1]?.ord, rest[to]?.ord);
}
