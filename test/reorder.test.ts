/**
 * Reorder geometry tests. These pin the drop rules that the pointer handler
 * relies on, including the no-op cases that stop a stray drag from shuffling
 * the chain.
 */
import { describe, expect, it } from 'vitest';
import { END_ANCHOR, dropIndex, dropTargetAt, markerTop, type RowRect } from '../src/lib/reorder';

function rows(heights: number[]): RowRect[] {
  let top = 100;
  return heights.map((h, i) => {
    const rect = { top, bottom: top + h, left: 40, right: 800, height: h };
    top += h + 26; // 26px gap, mirroring `.row { padding-bottom: 26px }`
    return { id: `t${i + 1}`, rect };
  });
}

describe('dropTargetAt', () => {
  const list = rows([60, 60, 60]);

  it('picks the first row when the pointer is above every midpoint', () => {
    expect(dropTargetAt(list, 110)).toBe('t1');
  });

  it('moves to the next row once its midpoint is crossed', () => {
    // Row 1 spans 100..160 (mid 130); row 2 spans 186..246 (mid 216);
    // row 3 spans 272..332 (mid 302).
    expect(dropTargetAt(list, 140)).toBe('t2');
    expect(dropTargetAt(list, 200)).toBe('t2');
    expect(dropTargetAt(list, 240)).toBe('t3');
  });

  it('falls through to the end anchor below the last midpoint', () => {
    expect(dropTargetAt(list, 9999)).toBe(END_ANCHOR);
  });

  it('reports nothing for an empty chain', () => {
    expect(dropTargetAt([], 50)).toBeNull();
  });
});

describe('markerTop', () => {
  it('sits 13px above the row it would insert before', () => {
    const list = rows([60, 60]);
    expect(markerTop(list, 110, 0)).toBe(87);
    expect(markerTop(list, 110, 50)).toBe(37);
  });

  it('sits just below the last row when appending', () => {
    const list = rows([60, 60]);
    const last = list[1]!.rect;
    expect(markerTop(list, 9999, 0)).toBe(last.bottom + 4);
  });
});

describe('dropIndex', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('returns the anchor index for a real move', () => {
    expect(dropIndex(3, 'a', ids, ids.length)).toBe(0);
    expect(dropIndex(0, 'c', ids, ids.length)).toBe(2);
  });

  it('appends when the anchor is the end marker', () => {
    expect(dropIndex(0, END_ANCHOR, ids, ids.length)).toBe(4);
  });

  it('is a no-op when dropped on itself or the row just below', () => {
    expect(dropIndex(1, 'b', ids, ids.length)).toBeNull();
    expect(dropIndex(1, 'c', ids, ids.length)).toBeNull();
  });

  it('is a no-op for unknown ids', () => {
    expect(dropIndex(-1, 'a', ids, ids.length)).toBeNull();
    expect(dropIndex(0, 'zz', ids, ids.length)).toBeNull();
  });
});
