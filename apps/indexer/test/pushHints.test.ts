/**
 * RPC read-diet PR D — the hint collector's truncation-honest contract,
 * pinned: a hint may only claim completeness when every row-mutating
 * log in the scan contributed an extractable id.
 */
import { describe, expect, it } from 'vitest';
import { collectPushHints, pushHintStats, HINT_CAP } from '../src/pushHints';

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

  it('links creations/acquisitions to the party that cannot know the id yet', () => {
    const h = collectPushHints([
      log('OfferCreated', { offerId: 3n, creator: '0x00000000000000000000000000000000000000Cc' }),
      log('LoanSaleCompleted', {
        loanId: 8n,
        originalLender: '0x00000000000000000000000000000000000000aa',
        newLender: '0x00000000000000000000000000000000000000dd',
      }),
    ]);
    expect(h.links[0].creator).toBe('0x00000000000000000000000000000000000000cc');
    expect(h.links[1].newLender).toBe('0x00000000000000000000000000000000000000dd');
    expect(h.truncated).toBe(false);
  });

  it('extracts OfferMatched ids under their real arg names', () => {
    const h = collectPushHints([
      log('OfferMatched', { lenderOfferId: 4n, borrowerOfferId: 5n }),
    ]);
    expect(h.offerIds.sort()).toEqual([4, 5]);
    expect(h.truncated).toBe(false);
  });

  it('forces truncated on a link event with no readable party', () => {
    expect(collectPushHints([log('LoanSold', { loanId: 8n })]).truncated).toBe(true);
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

describe('pushHintStats (#1245 measurement rail)', () => {
  it('reports PRE-cap sizes past the cap that collectPushHints hides', () => {
    // collectPushHints slices to HINT_CAP; the retune needs the true
    // count to know how MUCH a bigger cap would capture.
    const logs = Array.from({ length: HINT_CAP + 25 }, (_, i) =>
      log('LoanRepaid', { loanId: BigInt(i) }),
    );
    const s = pushHintStats(logs);
    expect(s.loanIdCount).toBe(HINT_CAP + 25); // true size, un-sliced
    expect(s.truncated).toBe(true);
    expect(s.causes.loanCapExceeded).toBe(true);
    // Sanity: the wire collector still hides it at the cap.
    expect(collectPushHints(logs).loanIds).toHaveLength(HINT_CAP);
  });

  it('breaks truncation down by cause — a signed-lifecycle scan is unmappableEvent, not cap', () => {
    const s = pushHintStats([
      log('LoanRepaid', { loanId: 1n }),
      log('SignedOfferFilled', { orderHash: '0xabc' }),
    ]);
    expect(s.loanIdCount).toBe(1);
    expect(s.truncated).toBe(true);
    expect(s.causes.unmappableEvent).toBe(true);
    expect(s.causes.loanCapExceeded).toBe(false);
    expect(s.causes.offerCapExceeded).toBe(false);
  });

  it('a clean small scan is un-truncated with every cause false', () => {
    const s = pushHintStats([
      log('LoanRepaid', { loanId: 7n }),
      log('OfferCanceled', { offerId: 9n }),
    ]);
    expect(s).toMatchObject({
      loanIdCount: 1,
      offerIdCount: 1,
      linkCount: 0,
      truncated: false,
    });
    expect(Object.values(s.causes).every((v) => v === false)).toBe(true);
  });

  it('flags a link event with no readable party as linkNoParty', () => {
    const s = pushHintStats([log('LoanSold', { loanId: 8n })]);
    expect(s.linkCount).toBe(1);
    expect(s.causes.linkNoParty).toBe(true);
    expect(s.truncated).toBe(true);
  });

  it('an UNMAPPABLE-only scan has zero counts but truncated=true (the frames the emit guard must not drop — Codex #1289 r1)', () => {
    const s = pushHintStats([
      log('Transfer', { tokenId: 5n }),
      log('SignedOfferCancelled', { orderHash: '0xabc' }),
    ]);
    expect(s).toMatchObject({ loanIdCount: 0, offerIdCount: 0, linkCount: 0 });
    expect(s.truncated).toBe(true); // scan tail must still log this
    expect(s.causes.unmappableEvent).toBe(true);
  });

  it('counts links past the cap as linkCapExceeded (2 links per created loan)', () => {
    // Loan creation emits LoanInitiated + LoanInitiatedDetails — both
    // LINK_EVENTS — so HINT_CAP+1 creations overflow the link cap even
    // though the id counts are far lower.
    const logs = Array.from({ length: HINT_CAP + 1 }, (_, i) => [
      log('LoanInitiated', { loanId: BigInt(i), lender: '0x00000000000000000000000000000000000000aa' }),
      log('LoanInitiatedDetails', { loanId: BigInt(i), borrower: '0x00000000000000000000000000000000000000bb' }),
    ]).flat();
    const s = pushHintStats(logs);
    expect(s.linkCount).toBe((HINT_CAP + 1) * 2);
    expect(s.causes.linkCapExceeded).toBe(true);
    expect(s.truncated).toBe(true);
  });
});
