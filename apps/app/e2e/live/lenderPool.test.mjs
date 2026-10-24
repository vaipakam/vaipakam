import { describe, expect, it } from 'vitest';

import { forcedCloseOnlyWhy, lenderVisitMode } from './lenderPool.mjs';

const base = { held: true, active: true, fallbackPending: false, rental: false, holderFlagged: false };
const mode = (over) => lenderVisitMode({ ...base, ...over });

describe('lenderVisitMode (#2094)', () => {
  it('visits a clean ERC-20 position in full, Active or FallbackPending', () => {
    expect(mode({})).toBe('full');
    expect(mode({ active: false, fallbackPending: true })).toBe('full');
  });

  it('visits an Active rental for the forced-close card only, whoever holds it', () => {
    for (const holderFlagged of [undefined, false, true]) {
      expect(mode({ rental: true, holderFlagged })).toBe('forced-close');
    }
    expect(forcedCloseOnlyWhy({ rental: true })).toBe('NFT rental');
  });

  it("visits a flagged holder's Active ERC-20 position for the forced-close card only", () => {
    expect(mode({ holderFlagged: true })).toBe('forced-close');
    expect(forcedCloseOnlyWhy({ rental: false, holderFlagged: true })).toBe('holder sanctions-flagged');
  });

  it('leaves out what neither card renders for', () => {
    // FallbackPending: the forced-close card is Active-only, and the
    // chooser excludes rentals and flagged holders.
    expect(mode({ active: false, fallbackPending: true, rental: true })).toBeNull();
    expect(mode({ active: false, fallbackPending: true, holderFlagged: true })).toBeNull();
    // Terminal, or a burned token.
    expect(mode({ active: false })).toBeNull();
    expect(mode({ held: false })).toBeNull();
    expect(mode({ held: false, rental: true })).toBeNull();
  });

  it('never visits an ERC-20 position whose holder status went unread', () => {
    // Unread is not clean: a full visit there could judge a suppressed card.
    expect(mode({ holderFlagged: undefined })).toBeNull();
  });
});
