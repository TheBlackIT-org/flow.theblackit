/**
 * Reorder geometry — pure functions, no DOM.
 *
 * Extracted from the pointer handler in `app.ts` so the drop-target rules can
 * be tested directly. A "row" is the minimum the maths needs: the task id and
 * the row's viewport rectangle.
 */

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

export interface RowRect {
  id: string;
  rect: Rect;
}

/** The anchor that means "drop past the last row". */
export const END_ANCHOR = '__end__';

/** The row whose midpoint the pointer has not yet crossed, or the end anchor. */
export function dropTargetAt(rows: RowRect[], y: number): string | null {
  for (const row of rows) {
    if (y < row.rect.top + row.rect.height / 2) return row.id;
  }
  return rows.length ? END_ANCHOR : null;
}

/** Vertical offset of the drop marker, relative to the chain container. */
export function markerTop(rows: RowRect[], y: number, containerTop: number): number {
  for (const row of rows) {
    if (y < row.rect.top + row.rect.height / 2) return row.rect.top - 13 - containerTop;
  }
  const last = rows[rows.length - 1];
  return last ? last.rect.bottom + 4 - containerTop : 0;
}

/**
 * Where the moved task lands, or null when the drop is a no-op. `from` is the
 * current index, `anchor` the drop target, and `count` the list length.
 *
 * Dropping onto itself or onto the row immediately after itself changes
 * nothing, which is what stops a drag from reordering on a stray click.
 */
export function dropIndex(from: number, anchor: string, ids: string[], count: number): number | null {
  const to = anchor === END_ANCHOR ? count : ids.indexOf(anchor);
  if (from < 0 || to < 0 || to === from || to === from + 1) return null;
  return to;
}
