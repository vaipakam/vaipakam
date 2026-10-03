/**
 * #1238 (RPC read-diet PR B follow-up) — the tier-slot parser feeding
 * useVpfiTierTable's snapshot-first path. A shape surprise must yield
 * null (→ live chain fallback), never a garbled tier table.
 */
import { describe, expect, it } from 'vitest';
import { parseTierSlots, tierBandRows } from './vpfi';

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
    // Codex #1240 r1 — BigInt() would silently coerce these, but a
    // JSON-number threshold has already lost precision and a boolean
    // is a schema regression: strict decimal-string only.
    expect(parseTierSlots([1e20, 1e21, 5e21, 2e22] as unknown[], D)).toBeNull();
    expect(parseTierSlots(T, [true, '1', '2', '3'])).toBeNull();
    expect(parseTierSlots(T, ['', '1', '2', '3'])).toBeNull();
    expect(parseTierSlots(T, ['-1', '1', '2', '3'])).toBeNull();
  });
});

describe('tierBandRows — the contract boundary rules (UX3-002)', () => {
  const slots = parseTierSlots(T, D)!;
  const rows = tierBandRows(slots);

  it('labels Tiers 1 and 2 as excluding their upper threshold', () => {
    expect(rows[0].held).toBe('100 to under 1,000 VPFI');
    expect(rows[1].held).toBe('1,000 to under 5,000 VPFI');
  });

  // The live defect: the table read "5,000 – <20,000" and "20,000+", so a
  // holder of exactly 20,000 VPFI was told 24% while the contract applies
  // Tier 3's 20% (Tier 4 starts strictly ABOVE the threshold).
  it('labels Tier 3 as INCLUDING its upper threshold and Tier 4 as strictly above it', () => {
    expect(rows[2]).toEqual({ held: '5,000 to 20,000 VPFI', discount: '20%' });
    expect(rows[3]).toEqual({ held: 'More than 20,000 VPFI', discount: '24%' });
  });
});
