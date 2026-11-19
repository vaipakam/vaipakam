/**
 * K1 (#3810) — the keeper page offers only the actions a keeper can still
 * take, and a save never carries the retired bits forward.
 */
import { describe, expect, it } from 'vitest';
import { EXPOSED_ACTIONS_MASK, KEEPER_ACTIONS, RETIRED_ACTIONS_MASK, preservedOutsideBits } from './keepers';

describe('keeper actions after K1', () => {
  it('no longer offers early close or offset completion', () => {
    const bits = KEEPER_ACTIONS().map((a) => a.bit);
    expect(bits).not.toContain(0x08);
    expect(bits).not.toContain(0x02);
    expect(EXPOSED_ACTIONS_MASK & RETIRED_ACTIONS_MASK).toBe(0);
  });

  it('drops retired bits on save and keeps live advanced ones', () => {
    expect(preservedOutsideBits(0x08 | 0x02)).toBe(0);
    expect(preservedOutsideBits(0x40 | 0x08 | 0x20)).toBe(0x40);
  });
});
