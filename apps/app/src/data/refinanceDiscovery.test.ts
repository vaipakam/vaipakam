/** #2391 — refinance requests are found on chain, and an incomplete or
 *  failed scan is unknown, never "none". */
import { describe, expect, it } from 'vitest';
import { combineScans, pickRequest, type OfferFacts } from './refinanceDiscovery';

const HOLDER = '0x00000000000000000000000000000000000000Aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const req = (id: bigint, over: Partial<OfferFacts> = {}): OfferFacts => ({
  id,
  creator: HOLDER,
  accepted: false,
  refinanceTargetLoanId: 7n,
  ...over,
});

describe('pickRequest', () => {
  it('finds the newest request for the loan made by the current holder', () => {
    expect(pickRequest(7n, HOLDER.toLowerCase(), [req(3n), req(9n), req(5n)])).toBe(9n);
  });
  it('ignores other loans, accepted offers and other creators', () => {
    expect(
      pickRequest(7n, HOLDER, [
        req(1n, { refinanceTargetLoanId: 8n }),
        req(2n, { refinanceTargetLoanId: 0n }),
        req(3n, { accepted: true }),
        // A previous holder's request: the contract will not settle it.
        req(4n, { creator: OTHER }),
      ]),
    ).toBeNull();
  });
});

describe('combineScans', () => {
  const done = (offers: OfferFacts[]) => ({ offers, complete: true });
  it('prefers an open request, and reports it as open', () => {
    expect(combineScans(7n, HOLDER, done([req(4n)]), done([req(9n)]))).toEqual({
      kind: 'found',
      offerId: '4',
      open: true,
    });
  });
  it('returns an expired request when no open one exists, so it can be cancelled', () => {
    expect(combineScans(7n, HOLDER, done([]), done([req(9n)]))).toEqual({
      kind: 'found',
      offerId: '9',
      open: false,
    });
  });
  it('is none only when both scans are complete and empty of matches', () => {
    expect(combineScans(7n, HOLDER, done([req(1n, { refinanceTargetLoanId: 8n })]), done([]))).toEqual({
      kind: 'none',
    });
  });
  it('is unknown when the open scan failed or was cut short — never none', () => {
    expect(combineScans(7n, HOLDER, null, done([]))).toEqual({ kind: 'unknown' });
    expect(combineScans(7n, HOLDER, { offers: [], complete: false }, done([]))).toEqual({
      kind: 'unknown',
    });
  });
  it('is unknown when no open request was found but the expired scan is incomplete', () => {
    expect(combineScans(7n, HOLDER, done([]), null)).toEqual({ kind: 'unknown' });
  });
});
