import { describe, it, expect } from 'vitest';
import { D1_MAX_BOUND_PARAMETERS, chunkD1InList, maxD1InListWidth } from './d1Binds.js';

describe('chunkD1InList', () => {
  it('issues no statement for an empty list', () => {
    // `IN ()` is not valid SQL, so "nothing to look up" must mean "no
    // statement", never "one empty statement".
    expect(chunkD1InList([], { before: [1] })).toEqual([]);
  });

  it('keeps every chunk at or under D1 100-bind cap, counting the fixed binds', () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    for (const fixed of [0, 1, 2, 7, 99]) {
      const before = Array.from({ length: fixed }, () => 'x');
      for (const c of chunkD1InList(items, { before })) {
        expect(c.binds.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      }
    }
  });

  it('counts binds on BOTH sides of the list', () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const chunks = chunkD1InList(items, { before: ['a', 'b'], after: ['c'] });
    for (const c of chunks) {
      expect(c.binds.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
    // 100 - 3 = 97 per statement, so 300 ids need four.
    expect(chunks).toHaveLength(4);
    expect(chunks[0].items).toHaveLength(97);
  });

  it('uses as few statements as the cap allows', () => {
    // A margin on top of the exact arithmetic would show up here as an extra
    // statement, which is the cost this module declines to pay.
    expect(chunkD1InList(Array.from({ length: 99 }, (_, i) => i), { before: [1] })).toHaveLength(1);
    expect(chunkD1InList(Array.from({ length: 100 }, (_, i) => i), { before: [1] })).toHaveLength(2);
  });

  it('puts the binds in statement order: before, then the list, then after', () => {
    const [chunk] = chunkD1InList([7, 8], { before: ['L'], after: ['R'] });
    expect(chunk.binds).toEqual(['L', 7, 8, 'R']);
    expect(chunk.placeholders).toBe('?, ?');
    expect(chunk.items).toEqual([7, 8]);
  });

  it('covers every item exactly once, in order', () => {
    const items = Array.from({ length: 421 }, (_, i) => i * 3);
    const flat = chunkD1InList(items, { before: [1, 2] }).flatMap((c) => c.items);
    expect(flat).toEqual(items);
  });

  it('emits one placeholder per item', () => {
    for (const c of chunkD1InList(Array.from({ length: 250 }, (_, i) => i), { before: [1] })) {
      expect(c.placeholders.split(',')).toHaveLength(c.items.length);
    }
  });

  it('refuses an over-capacity statement even when the list is EMPTY', () => {
    // Deliberate, and the opposite of what #2235 r1 P3 proposed: returning []
    // first would make the complaint depend on whether there was anything to
    // look up, so a caller whose statement can never run passes on a quiet
    // tick and fails on a busy one — the data-dependent failure this module
    // exists to remove.
    const before = Array.from({ length: D1_MAX_BOUND_PARAMETERS }, () => 'x');
    expect(() => chunkD1InList([], { before })).toThrow(RangeError);
    // ...while an empty list under a SANE statement is still a clean no-op.
    expect(chunkD1InList([], { before: ['a', 'b'] })).toEqual([]);
  });

  it('refuses a statement whose fixed binds leave no room for one item', () => {
    // Returning zero-width chunks instead would loop forever; this is a
    // statement that cannot run at ANY list length, so it is a bug in the
    // caller rather than a condition to degrade around.
    const before = Array.from({ length: D1_MAX_BOUND_PARAMETERS }, () => 'x');
    expect(() => chunkD1InList([1], { before })).toThrow(RangeError);
  });
});

describe('maxD1InListWidth', () => {
  it('is the cap minus the statement own binds', () => {
    expect(maxD1InListWidth(0)).toBe(D1_MAX_BOUND_PARAMETERS);
    expect(maxD1InListWidth(1)).toBe(D1_MAX_BOUND_PARAMETERS - 1);
  });

  it('never reports a negative width', () => {
    expect(maxD1InListWidth(D1_MAX_BOUND_PARAMETERS + 5)).toBe(0);
  });
});

describe('the cap itself', () => {
  it('is D1 documented 100, not a tuning knob', () => {
    // Pinned because raising it is a claim about D1 that this repository
    // cannot make on its own — a reviewer should have to delete this test to
    // change it.
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100);
  });
});
