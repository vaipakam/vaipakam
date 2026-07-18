import { describe, expect, it } from 'vitest';
import {
  coalesceByTx,
  humanizeKind,
  labelForKind,
  ACTIVITY_LABELS,
} from './activityView';
import { copySource } from '../content/copy';
import type { IndexedActivityEvent } from '../data/indexer';

function ev(p: Partial<IndexedActivityEvent>): IndexedActivityEvent {
  return {
    chainId: 84532,
    blockNumber: 1,
    logIndex: 0,
    txHash: '0xtx',
    kind: 'LoanInitiated',
    loanId: null,
    offerId: null,
    actor: null,
    args: {},
    blockAt: 1_700_000_000,
    ...p,
  };
}

describe('humanizeKind', () => {
  it('splits camelCase', () => {
    expect(humanizeKind('LoanRepaid')).toBe('Loan Repaid');
  });
  it('keeps ALL-CAPS acronyms intact (the "Nftminted" bug)', () => {
    expect(humanizeKind('NFTMinted')).toBe('NFT Minted');
    expect(humanizeKind('VPFIDeposited')).toBe('VPFI Deposited');
    expect(humanizeKind('LTVUpdated')).toBe('LTV Updated');
  });
  it('handles a trailing acronym and digits', () => {
    expect(humanizeKind('SwapTo0x')).toContain('Swap');
  });
  it('falls back for empty input', () => {
    expect(humanizeKind('')).toBe('Protocol event');
  });
});

describe('labelForKind', () => {
  it('prefers the mapped label', () => {
    expect(labelForKind('OfferCanceled')).toBe('Offer cancelled');
  });
  it('normalizes the cancelled/canceled spelling drift', () => {
    // Both the offer and signed-offer cancel events read "cancelled".
    expect(ACTIVITY_LABELS.OfferCanceled.label).toContain('cancelled');
    expect(ACTIVITY_LABELS.SignedOfferCancelled.label).toContain('cancelled');
  });
  it('humanizes an unmapped kind', () => {
    expect(labelForKind('SomeNewEvent')).toBe('Some New Event');
  });
  it('maps the internal-match + prepay-listing event family (Codex #1171 r1)', () => {
    // Every kind the indexer's log.eventName handlers emit should have
    // an explicit label, not a title-cased raw name.
    for (const kind of [
      'InternalMatchExecuted',
      'PrepayListingPosted',
      'PrepayListingMatched',
      'PrepayListingUpdated',
      'PrepayListingCanceled',
      'PrepayCollateralSaleSettled',
    ]) {
      expect(ACTIVITY_LABELS[kind]).toBeDefined();
    }
  });
});

describe('activity feed labels are translatable (extraction guard)', () => {
  // The Activity page renders copy.activity.labels[kind] (translatable),
  // falling back to this pure module only for an unmapped kind. If a new
  // event kind is added to ACTIVITY_LABELS but not to the catalog, its
  // row would silently render English in every locale — this guard fails
  // the build instead, mirroring the ACTIVITY_LABELS ↔ catalog contract.
  it('every mapped kind has a matching catalog label', () => {
    const catalog = copySource.activity.labels;
    for (const [kind, meta] of Object.entries(ACTIVITY_LABELS)) {
      expect(catalog[kind], `missing catalog label for ${kind}`).toBe(
        meta.label,
      );
    }
  });

  it('the catalog adds no stale label for a kind the module dropped', () => {
    for (const kind of Object.keys(copySource.activity.labels)) {
      expect(ACTIVITY_LABELS[kind], `stale catalog label for ${kind}`).toBeDefined();
    }
  });
});

describe('coalesceByTx', () => {
  it('collapses one transaction to its highest-priority event', () => {
    // A loan-start tx emits LoanInitiated (90) + LoanInitiatedDetails
    // (10) + Transfer (5): one row, labelled by the real action.
    const rows = coalesceByTx([
      ev({ kind: 'Transfer', logIndex: 2 }),
      ev({ kind: 'LoanInitiatedDetails', logIndex: 1 }),
      ev({ kind: 'LoanInitiated', logIndex: 0, loanId: 7 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Loan started');
    expect(rows[0].event.loanId).toBe(7);
    expect(rows[0].hiddenCount).toBe(2);
  });

  it('keeps events from different transactions separate', () => {
    const rows = coalesceByTx([
      ev({ txHash: '0xa', kind: 'OfferCreated', blockNumber: 2 }),
      ev({ txHash: '0xb', kind: 'LoanRepaid', blockNumber: 3 }),
    ]);
    expect(rows).toHaveLength(2);
    // Newest (higher block) first.
    expect(rows[0].event.blockNumber).toBe(3);
    expect(rows[1].event.blockNumber).toBe(2);
  });

  it('breaks priority ties by earliest logIndex', () => {
    const rows = coalesceByTx([
      ev({ kind: 'OfferMatched', logIndex: 3 }),
      ev({ kind: 'OfferAccepted', logIndex: 1 }), // same priority (80)
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event.logIndex).toBe(1);
  });

  it('never merges events that lack a txHash', () => {
    const rows = coalesceByTx([
      ev({ txHash: '', kind: 'LoanRepaid', logIndex: 0, blockNumber: 5 }),
      ev({ txHash: '', kind: 'LoanRepaid', logIndex: 1, blockNumber: 5 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('lets a claim outrank the LoanSettled in the same tx (Codex #1171 r2)', () => {
    // ClaimFacet emits {Lender,Borrower}FundsClaimed THEN LoanSettled in
    // one transaction; the indexer inserts both. The user's own claim,
    // not the book-keeping settle, must be the representative row.
    const lender = coalesceByTx([
      ev({ kind: 'LoanSettled', logIndex: 1, loanId: 4 }),
      ev({ kind: 'LenderFundsClaimed', logIndex: 0, loanId: 4 }),
    ]);
    expect(lender).toHaveLength(1);
    expect(lender[0].label).toBe('Funds claimed');
    expect(lender[0].hiddenCount).toBe(1);

    const borrower = coalesceByTx([
      ev({ kind: 'LoanSettled', logIndex: 1, loanId: 9 }),
      ev({ kind: 'BorrowerFundsClaimed', logIndex: 0, loanId: 9 }),
    ]);
    expect(borrower).toHaveLength(1);
    expect(borrower[0].label).toBe('Collateral claimed');
  });
});
