import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };

import {
  forcedCloseVerdict,
  monetaryAmountsIn,
  saysCheckRunning,
} from './forcedCloseCard.mjs';

const FORCED_CLOSE = enBundle.copy.forcedClose;

/**
 * Why this file exists, in the same terms `jumpability.test.mjs` states
 * its own case: a predicate that runs only inside a live drive is a
 * predicate nothing has executed. The live chain currently carries no
 * forced-close position that is both held and Active — every observed
 * lender loan is past its due date — so a drive consuming this module
 * could report "clean" for weeks without once reaching the branch that
 * decides a FAIL.
 *
 * The amount scanner in particular has to be right in BOTH directions,
 * and the two failures cost differently. A false negative misses an
 * invented figure on a funds-moving surface. A false positive fires on
 * correct copy — the grace window the card is explicitly allowed to
 * show — and the likeliest response to a check that cries wolf is to
 * stop running it, which loses the true positives too.
 */
describe('monetaryAmountsIn', () => {
  it('finds a figure with a token ticker after it', () => {
    expect(monetaryAmountsIn('You will receive 1.5 WETH.')).toHaveLength(1);
    expect(monetaryAmountsIn('Returns 250 USDC to your vault.')).toHaveLength(1);
  });

  it('finds a figure with a ticker before it', () => {
    expect(monetaryAmountsIn('Recovers USDC 250 on settlement.')).toHaveLength(1);
  });

  it('finds a fiat figure', () => {
    expect(monetaryAmountsIn('Worth about $1,240 today.')).toHaveLength(1);
    expect(monetaryAmountsIn('Worth about 1.240,50 € today.')).toHaveLength(1);
  });

  it('does NOT fire on a duration, which the card may show', () => {
    // The spec explicitly permits the grace window: "may show the grace
    // window to explain a wait". A scanner that failed here would be
    // switched off, taking the real check with it.
    expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
    expect(monetaryAmountsIn('Closing out unlocks in 72 hours.')).toEqual([]);
    expect(monetaryAmountsIn('Roughly 30 minutes remain.')).toEqual([]);
    expect(monetaryAmountsIn('Settles within 5 blocks.')).toEqual([]);
  });

  it('does NOT fire on a proportion', () => {
    expect(monetaryAmountsIn('A 2% treasury share is deducted.')).toEqual([]);
    expect(monetaryAmountsIn('Set to 200 bps by governance.')).toEqual([]);
  });

  it('does NOT fire on an identifier', () => {
    expect(monetaryAmountsIn('Loan #21 is overdue.')).toEqual([]);
  });

  it('handles empty and non-string input without throwing', () => {
    expect(monetaryAmountsIn('')).toEqual([]);
    expect(monetaryAmountsIn(null)).toEqual([]);
    expect(monetaryAmountsIn(undefined)).toEqual([]);
    expect(monetaryAmountsIn(42)).toEqual([]);
  });

  it('passes every shipped forced-close string', () => {
    // The strongest available calibration: the real copy, all of it. If
    // this ever fails, either the scanner regressed or somebody put an
    // amount in the card — and the two are told apart by reading the
    // named string.
    let checked = 0;
    for (const [key, value] of Object.entries(FORCED_CLOSE)) {
      if (typeof value !== 'string') continue;
      expect(monetaryAmountsIn(value), `${key}: ${value}`).toEqual([]);
      checked += 1;
    }
    // The loop must not be allowed to go vacuous. A `for` over an empty
    // set passes exactly as loudly as one over the real copy — the same
    // shape as the empty-snapshot bug this session spent a round on —
    // so the count is asserted rather than assumed. A floor, not an
    // equality: adding copy should not fail this, removing most of it
    // should.
    expect(checked).toBeGreaterThanOrEqual(30);
  });
});

describe('saysCheckRunning', () => {
  it('recognises the shipped unresolved sentence', () => {
    expect(saysCheckRunning(FORCED_CLOSE.unknown, FORCED_CLOSE.unknown)).toBe(true);
  });

  it('recognises it with later sentences appended', () => {
    expect(
      saysCheckRunning(`${FORCED_CLOSE.unknown} Something else too.`, FORCED_CLOSE.unknown),
    ).toBe(true);
  });

  it('does not claim it for a different state', () => {
    expect(saysCheckRunning(FORCED_CLOSE.readyInKind, FORCED_CLOSE.unknown)).toBe(false);
  });

  it('is false rather than throwing on missing input', () => {
    expect(saysCheckRunning(null, FORCED_CLOSE.unknown)).toBe(false);
    expect(saysCheckRunning('text', undefined)).toBe(false);
  });
});

describe('forcedCloseVerdict', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = { lenderHoldsActive: true, mounted: true, submitDisabled: true };

  it('FAILS on an absent card over a held Active position', () => {
    // Round 65's P2, as a live check. Absence is the strongest claim
    // the surface can make — the capability does not apply — and it was
    // being made on the one read that had not happened.
    const v = forcedCloseVerdict({ ...held, mounted: false, text: null }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/absent/);
  });

  it('PASSES a present, non-submittable card', () => {
    // Withholding the action while a check runs is the design. Only
    // withholding the EXPLANATION with it is the defect.
    const v = forcedCloseVerdict({ ...held, text: FORCED_CLOSE.unknown }, copy);
    expect(v.verdict).toBe('pass');
    expect(v.checkRunning).toBe(true);
  });

  it('PASSES a present, submittable card', () => {
    const v = forcedCloseVerdict(
      { ...held, submitDisabled: false, text: FORCED_CLOSE.readyInKind },
      copy,
    );
    expect(v.verdict).toBe('pass');
    expect(v.checkRunning).toBe(false);
  });

  it('FAILS a card that mounted with no text', () => {
    expect(forcedCloseVerdict({ ...held, text: '   ' }, copy).verdict).toBe('fail');
  });

  it('FAILS a card that states an amount', () => {
    const v = forcedCloseVerdict(
      { ...held, text: `${FORCED_CLOSE.readyInKind} You will receive 1.5 WETH.` },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.amounts).toHaveLength(1);
  });

  it('BLOCKS rather than passing when the position is not a held Active one', () => {
    // The distinction this harness insists on everywhere: nothing was
    // learned is not the same as nothing was wrong. A card correctly
    // absent on an ineligible position must never bank as evidence.
    const v = forcedCloseVerdict({ ...held, lenderHoldsActive: false, mounted: false }, copy);
    expect(v.verdict).toBe('blocked');
  });

  it('BLOCKS on a missing observation instead of throwing', () => {
    expect(forcedCloseVerdict(null, copy).verdict).toBe('blocked');
    expect(forcedCloseVerdict(undefined, copy).verdict).toBe('blocked');
  });
});
