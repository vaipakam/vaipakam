/**
 * #1238 (RPC read-diet PR B follow-up) — the tier-slot parser feeding
 * useVpfiTierTable's snapshot-first path. A shape surprise must yield
 * null (→ live chain fallback), never a garbled tier table.
 */
import { describe, expect, it } from 'vitest';
import { parseTierSlots } from './vpfi';

const T = ['100000000000000000000', '1000000000000000000000', '5000000000000000000000', '20000000000000000000000'];
const D = ['1000', '1500', '2000', '2400'];

describe('parseTierSlots', () => {
  it('parses the snapshot decimal-string uint256[4] slots', () => {
    const out = parseTierSlots(T, D);
    expect(out?.thresholds[0]).toBe(100000000000000000000n);
    expect(out?.discounts[3]).toBe(2400n);
  });

  it('nulls on any shape surprise (→ chain fallback)', () => {
    expect(parseTierSlots(T.slice(0, 3), D)).toBeNull(); // arity
    expect(parseTierSlots(T, undefined)).toBeNull(); // missing slot
    expect(parseTierSlots('100', D)).toBeNull(); // not an array
    expect(parseTierSlots(['a', 'b', 'c', 'd'], D)).toBeNull(); // non-numeric
    expect(parseTierSlots(T, [null, '1', '2', '3'])).toBeNull(); // null entry
  });
});
