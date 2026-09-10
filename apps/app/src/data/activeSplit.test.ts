/**
 * `resolveActiveSplit` — and specifically that the three answers stay
 * three answers.
 *
 * The bug this pins: the page used `Math.max(0, active - erc20 - nft)`,
 * which is right that a negative count must not be rendered and wrong
 * about what to do instead. It folds "the endpoint contradicted itself"
 * into "there is no residual", so three mutually inconsistent counters
 * were shown side by side with nothing on the page acknowledging that
 * they do not add up. Every `contradiction` case below is guarding
 * against that collapse coming back.
 */
import { describe, expect, it } from 'vitest';
import { resolveActiveSplit } from './activeSplit';

describe('resolveActiveSplit — reconciled', () => {
  it('reports the untyped remainder', () => {
    expect(
      resolveActiveSplit({
        active: 10,
        erc20ActiveLoans: 6,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'reconciled', unclassified: 1 });
  });

  // The ordinary steady state once every active loan carries a typed
  // lending asset. It must stay DISTINCT from a contradiction, which is
  // the whole point — both used to render as nothing.
  it('reports zero when the subtotals exactly account for the total', () => {
    expect(
      resolveActiveSplit({
        active: 9,
        erc20ActiveLoans: 6,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'reconciled', unclassified: 0 });
  });

  it('handles an empty deployment', () => {
    expect(
      resolveActiveSplit({
        active: 0,
        erc20ActiveLoans: 0,
        nftRentalsActive: 0,
      }),
    ).toEqual({ kind: 'reconciled', unclassified: 0 });
  });
});

describe('resolveActiveSplit — contradiction', () => {
  // THE regression. `Math.max(0, …)` returned 0 for all of these, which
  // reads as "every active loan is typed" — the opposite of what the
  // numbers say.
  it('reports the excess when the subtotals overshoot by one', () => {
    expect(
      resolveActiveSplit({
        active: 5,
        erc20ActiveLoans: 4,
        nftRentalsActive: 2,
      }),
    ).toEqual({ kind: 'contradiction', excess: 1 });
  });

  it('reports a larger excess', () => {
    expect(
      resolveActiveSplit({
        active: 2,
        erc20ActiveLoans: 7,
        nftRentalsActive: 5,
      }),
    ).toEqual({ kind: 'contradiction', excess: 10 });
  });

  // The shape the indexer's own comment describes: a sale vehicle
  // counted into a typed subtotal but excluded from the total.
  it('catches a single sale vehicle inflating one subtotal', () => {
    expect(
      resolveActiveSplit({
        active: 12,
        erc20ActiveLoans: 13,
        nftRentalsActive: 0,
      }),
    ).toEqual({ kind: 'contradiction', excess: 1 });
  });
});

describe('resolveActiveSplit — unknown', () => {
  it('is unknown when the total is absent', () => {
    expect(
      resolveActiveSplit({
        active: undefined,
        erc20ActiveLoans: 6,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('is unknown when either subtotal is absent', () => {
    expect(
      resolveActiveSplit({
        active: 10,
        erc20ActiveLoans: undefined,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'unknown' });
    expect(
      resolveActiveSplit({
        active: 10,
        erc20ActiveLoans: 6,
        nftRentalsActive: undefined,
      }),
    ).toEqual({ kind: 'unknown' });
  });

  // NaN compares false against every bound, so an unguarded version
  // lands in `reconciled` carrying a NaN residual — which the page would
  // then try to render as a count.
  it('is unknown rather than reconciled when a counter is NaN', () => {
    const got = resolveActiveSplit({
      active: Number.NaN,
      erc20ActiveLoans: 6,
      nftRentalsActive: 3,
    });
    expect(got).toEqual({ kind: 'unknown' });
    expect(got.kind).not.toBe('reconciled');
  });

  it('is unknown when a counter is infinite', () => {
    expect(
      resolveActiveSplit({
        active: Number.POSITIVE_INFINITY,
        erc20ActiveLoans: 6,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'unknown' });
  });

  // A negative counter is not a count. Treating it as one would let
  // `active: -1, erc20: 0, nft: 0` resolve as a contradiction of 1,
  // which describes the wrong fault.
  it('is unknown when a counter is negative', () => {
    expect(
      resolveActiveSplit({
        active: -1,
        erc20ActiveLoans: 0,
        nftRentalsActive: 0,
      }),
    ).toEqual({ kind: 'unknown' });
  });

  // Round 54 P2 — this resolver now shares `isReportedCount` with the
  // tiles, so it inherits the fractional case too. It matters here for
  // its own reason: a fractional input yields a fractional residual, and
  // "0.5 active loans could not be typed" is not a sentence about
  // anything.
  it('is unknown when a counter is fractional', () => {
    expect(
      resolveActiveSplit({
        active: 10.5,
        erc20ActiveLoans: 6,
        nftRentalsActive: 3,
      }),
    ).toEqual({ kind: 'unknown' });
  });
});
