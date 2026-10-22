/**
 * `pluckActivityRefs` — the loan/offer reference mapping the activity ledger
 * denormalizes for filtering.
 *
 * #1782 round-1 P2: an event with no `case` here falls to the `default:` branch
 * and is stored with `loan_id = NULL`, so `/activity?loanId=N` and the
 * indexer-backed `LoanTimeline` silently exclude it. That is invisible in a
 * scan-level test — the row IS inserted, just unreachable by loan — which is
 * why this asserts the mapper directly.
 *
 * The `LoanStatusChanged` case matters most for the sale-vehicle temporary
 * loan: its transition is named by NO other event, so a null `loan_id` left
 * the loan-scoped view with no evidence of the transition at all.
 */
import { describe, expect, it } from 'vitest';
import { pluckActivityRefs } from '../src/chainIndexer';

describe('pluckActivityRefs — loan-scoped status events (#1782)', () => {
  it('indexes LoanStatusChanged under its loan id', () => {
    expect(
      pluckActivityRefs('LoanStatusChanged', {
        loanId: 42n,
        from: 0,
        to: 1,
      }),
    ).toEqual({ actor: null, loanId: 42, offerId: null });
  });

  it('carries no actor — a status edge has no address of its own', () => {
    const refs = pluckActivityRefs('LoanStatusChanged', {
      loanId: 7n,
      from: 4,
      to: 3,
    });
    // The actor belongs to whichever call produced the transition; that call's
    // own event row holds it. Inventing one here would attribute the edge to
    // the wrong party.
    expect(refs.actor).toBeNull();
    expect(refs.loanId).toBe(7);
  });

  it('returns all-null for an event the compiled ABI does not have', () => {
    // References are read by the event's own ABI shape (#1794), so a name the
    // ABI does not know has nothing to read from, whatever the bag holds.
    expect(
      pluckActivityRefs('SomeEventNobodyMapped', { loanId: 99n }),
    ).toEqual({ actor: null, loanId: null, offerId: null });
  });
});

describe('pluckActivityRefs — fee-tier exclusion (#2342)', () => {
  it('files TierExclusionUpdated under its loan and the charged vault owner', () => {
    expect(
      pluckActivityRefs('TierExclusionUpdated', {
        loanId: 11n,
        lenderSide: false,
        vaultOwner: '0x0000000000000000000000000000000000000B0b',
        excludedVpfi: 2000n * 10n ** 18n,
      }),
    ).toEqual({
      actor: '0x0000000000000000000000000000000000000b0b',
      loanId: 11,
      offerId: null,
    });
  });

  it('leaves the actor NULL when the side stops excluding (zero vault owner)', () => {
    // A cleared record names no wallet; filing it under 0x0 would put every
    // clear in one shared bucket. The loan timeline still finds it.
    expect(
      pluckActivityRefs('TierExclusionUpdated', {
        loanId: 11n,
        lenderSide: true,
        vaultOwner: '0x0000000000000000000000000000000000000000',
        excludedVpfi: 0n,
      }),
    ).toEqual({ actor: null, loanId: 11, offerId: null });
  });
});

describe('pluckActivityRefs — references read from the ABI by one rule (#1794)', () => {
  it('files an event that never had a case under its loan', () => {
    // CollateralAdded was one of the 45 events stored with loan_id NULL.
    const refs = pluckActivityRefs('CollateralAdded', {
      loanId: 31n,
      borrower: '0x0000000000000000000000000000000000000B0b',
      amountAdded: 5n,
      newCollateralAmount: 10n,
      newHf: 2n,
      newLtv: 1n,
    });
    expect(refs.loanId).toBe(31);
    expect(refs.offerId).toBeNull();
  });

  it('files a refinance under the loan it closes, per the recorded choice', () => {
    const refs = pluckActivityRefs('LoanRefinanced', {
      oldLoanId: 3n,
      newLoanId: 4n,
    });
    expect(refs.loanId).toBe(3);
  });

  it('files a slice match under the standing counterparty offer, per the recorded choice', () => {
    const refs = pluckActivityRefs('IntentMatched', {
      sliceOfferId: 70n,
      counterpartyOfferId: 12n,
      loanId: 9n,
    });
    expect(refs).toMatchObject({ loanId: 9, offerId: 12 });
  });

  it('leaves a companion payload unscoped, including a loan named inside its terms', () => {
    const refs = pluckActivityRefs('OfferCreatedDetails', {
      offerId: 5n,
      fields: { refinanceTargetLoanId: 8n },
    });
    expect(refs).toMatchObject({ loanId: null, offerId: null });
  });

  it('reads id 0 as "none", never as a loan 0', () => {
    // A treasury conversion's swap attempts carry the loanId sentinel 0.
    expect(pluckActivityRefs('SwapAdapterAttempted', { loanId: 0n, adapterIdx: 1n }).loanId).toBeNull();
  });

  it('leaves an event whose loanId input can hold an offer id unscoped', () => {
    expect(
      pluckActivityRefs('SanctionedProceedsLocked', {
        loanId: 4n,
        recipient: '0x0000000000000000000000000000000000000B0b',
        asset: '0x0000000000000000000000000000000000000C0c',
        amount: 1n,
      }).loanId,
    ).toBeNull();
  });

  it('reads NULL rather than a number when the decoded value is not an id', () => {
    expect(pluckActivityRefs('CollateralAdded', { loanId: 'not-a-number' }).loanId).toBeNull();
    expect(pluckActivityRefs('CollateralAdded', {}).loanId).toBeNull();
  });
});
