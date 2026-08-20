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

  it('still returns all-null for a genuinely unmapped event', () => {
    // Guards the assertion above from passing for the wrong reason: if the
    // default branch ever started guessing a loanId, the first test would pass
    // with no `case` at all.
    expect(
      pluckActivityRefs('SomeEventNobodyMapped', { loanId: 99n }),
    ).toEqual({ actor: null, loanId: null, offerId: null });
  });
});
