/**
 * Codex #2675 r1 — which auto-linked vehicle an offer is comes from its own
 * offer type, the split the contract's two links make, never from who
 * created it.
 */
import { describe, expect, it } from 'vitest';
import { linkedOfferKind } from './linkedOfferKind';

describe('linkedOfferKind', () => {
  it('names a borrower-type linked offer a sale listing', () => {
    expect(linkedOfferKind(1)).toBe('sale');
    expect(linkedOfferKind(1n)).toBe('sale');
  });

  it('names a lender-type linked offer an offset', () => {
    expect(linkedOfferKind(0)).toBe('offset');
    expect(linkedOfferKind(0n)).toBe('offset');
  });
});
