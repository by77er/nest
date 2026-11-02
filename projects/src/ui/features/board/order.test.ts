// Moving a card writes one `ord`: it must land the card exactly where it was dropped, at either end too.
import { describe, expect, it } from "vitest";
import { ordForMove } from "./order";

/** The column's order after giving the task at `from` the new `ord` (the board sorts by ord). */
function after(ords: number[], from: number, to: number): number[] {
  const ord = ordForMove(ords.map((o) => ({ ord: o })), from, to);
  if (ord === null) return ords;
  return ords.map((o, i) => ({ o: i === from ? ord : o, i })).sort((a, b) => a.o - b.o).map((x) => ords[x.i]!);
}

/** What dnd-kit's arrayMove shows while dragging. */
function arrayMove<T>(xs: T[], from: number, to: number): T[] {
  const out = [...xs];
  out.splice(to, 0, out.splice(from, 1)[0]!);
  return out;
}

describe("ordForMove", () => {
  const ords = [1, 2, 3.5, 7];

  it("puts the card where it was dropped, for every move in a column", () => {
    for (let from = 0; from < ords.length; from++) {
      for (let to = 0; to < ords.length; to++) {
        expect(after(ords, from, to), `${from} → ${to}`).toEqual(arrayMove(ords, from, to));
      }
    }
  });

  it("keeps working after many moves into the same gap", () => {
    let col = [1, 2, 3];
    for (let i = 0; i < 40; i++) {
      // The last card, dropped between the first two, again and again.
      const ord = ordForMove(col.map((o) => ({ ord: o })), 2, 1)!;
      col = [col[0]!, ord, col[1]!];
      expect(col[0]! < col[1]! && col[1]! < col[2]!, `move ${i}`).toBe(true);
    }
  });

  it("is null when nothing moves", () => {
    expect(ordForMove([{ ord: 1 }, { ord: 2 }], 1, 1)).toBeNull();
    expect(ordForMove([{ ord: 1 }], 0, 3)).toBeNull();
  });
});
