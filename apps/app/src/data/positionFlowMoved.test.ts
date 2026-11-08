import { describe, expect, it } from 'vitest';
import { boundOfferMoved, flowMovedOf } from './positionFlowMoved';
import type { IndexedLoanFlows } from './indexer';

const flow = (offerId: number, kind: 'loanSale' | 'offset' | 'refinance', moved: boolean | null) => ({
  offerId,
  status: 'active',
  kind,
  side: kind === 'loanSale' ? ('lender' as const) : ('borrower' as const),
  loanId: 7,
  movedSinceOpened: moved,
});

describe('#3205 — the indexer verdict on a loan position flow', () => {
  it('maps the three-valued field and never rounds an unknown', () => {
    expect(flowMovedOf(true)).toBe('yes');
    expect(flowMovedOf(false)).toBe('no');
    expect(flowMovedOf(null)).toBe('unknown');
    expect(flowMovedOf(undefined)).toBe('unknown');
  });

  it('no answer, or an older indexer without the field, is unknown', () => {
    expect(boundOfferMoved(null, 'loanSale', '5')).toEqual({ moved: 'unknown', offerId: null });
    expect(boundOfferMoved({} as IndexedLoanFlows, 'offset', null)).toEqual({ moved: 'unknown', offerId: null });
  });

  it('a known offer id reads that offer; an unlisted one is unknown', () => {
    const flows: IndexedLoanFlows = { positionFlows: [flow(5, 'loanSale', true), flow(6, 'refinance', false)] };
    expect(boundOfferMoved(flows, 'loanSale', '5')).toEqual({ moved: 'yes', offerId: '5' });
    expect(boundOfferMoved(flows, 'refinance', '6')).toEqual({ moved: 'no', offerId: '6' });
    expect(boundOfferMoved(flows, 'loanSale', '9')).toEqual({ moved: 'unknown', offerId: null });
  });

  it('without an id, the one offer of the kind names the flow; several that disagree are unknown', () => {
    expect(boundOfferMoved({ positionFlows: [flow(5, 'offset', true)] }, 'offset', null)).toEqual({ moved: 'yes', offerId: '5' });
    expect(boundOfferMoved({ positionFlows: [] }, 'offset', null)).toEqual({ moved: 'unknown', offerId: null });
    expect(
      boundOfferMoved({ positionFlows: [flow(5, 'offset', true), flow(6, 'offset', false)] }, 'offset', null),
    ).toEqual({ moved: 'unknown', offerId: null });
    expect(
      boundOfferMoved({ positionFlows: [flow(5, 'offset', true), flow(6, 'offset', true)] }, 'offset', null),
    ).toEqual({ moved: 'yes', offerId: null });
  });
});
