/**
 * RPC read-diet PR D — the hint collector's truncation-honest contract,
 * pinned: a hint may only claim completeness when every row-mutating
 * log in the scan contributed an extractable id.
 */
import { describe, expect, it } from 'vitest';
import { collectPushHints, HINT_CAP } from '../src/pushHints';

const log = (eventName: string, args: Record<string, unknown>) => ({ eventName, args });

describe('collectPushHints', () => {
  it('extracts loan/offer ids incl. the internal-match triple', () => {
    const h = collectPushHints([
      log('LoanRepaid', { loanId: 7n }),
      log('InternalMatchExecuted', { loanIdA: 1n, loanIdB: 2n, loanIdC: 3n }),
      log('OfferCanceled', { offerId: 9n }),
    ]);
    expect(h.loanIds.sort()).toEqual([1, 2, 3, 7]);
    expect(h.offerIds).toEqual([9]);
    expect(h.truncated).toBe(false);
  });

  it('builds causative links for creations', () => {
    const h = collectPushHints([
      log('LoanInitiated', {
        loanId: 5n,
        offerId: 11n,
        lender: '0x00000000000000000000000000000000000000AA',
        borrower: '0x00000000000000000000000000000000000000bb',
      }),
    ]);
    expect(h.links).toEqual([
      {
        loanId: 5,
        offerId: 11,
        lender: '0x00000000000000000000000000000000000000aa',
        borrower: '0x00000000000000000000000000000000000000bb',
      },
    ]);
  });

  it('forces truncated on unmappable row events (Transfer, signed lifecycle)', () => {
    for (const name of ['Transfer', 'SignedOfferFilled', 'SignedOfferCancelled']) {
      expect(collectPushHints([log(name, { tokenId: 43n })]).truncated).toBe(true);
    }
  });

  it('forces truncated when a handled event carries no recognised id', () => {
    const h = collectPushHints([log('SomeFutureEvent', { widget: 1n })]);
    expect(h.truncated).toBe(true);
  });

  it('caps id lists and marks truncated past HINT_CAP', () => {
    const logs = Array.from({ length: HINT_CAP + 1 }, (_, i) =>
      log('LoanRepaid', { loanId: BigInt(i) }),
    );
    const h = collectPushHints(logs);
    expect(h.truncated).toBe(true);
    expect(h.loanIds).toHaveLength(HINT_CAP);
  });
});
