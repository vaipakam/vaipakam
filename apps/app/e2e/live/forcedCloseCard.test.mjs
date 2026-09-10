import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };

import {
  forcedCloseCoverage,
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
  // A held, Active, unlocked position whose card mounted and settled —
  // the shape in which every invariant is actually checkable. Round 1
  // added `saleLocked`, `settled` and `bodyText`, and each defaults to
  // the permissive value HERE so the pre-existing cases keep asserting
  // what they were written to assert.
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    confirmText: null,
  };

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

describe('forcedCloseVerdict — round 1 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    confirmText: null,
    text: FORCED_CLOSE.readyInKind,
  };

  it('BLOCKS rather than failing when an absent card sits on a sale-locked position', () => {
    // `PositionDetails` unmounts the card while an accepted sale awaits
    // completion — closing out would strand the buyer's funds. Calling
    // that a defect is the false-positive direction, and a check that
    // cries wolf gets switched off.
    const v = forcedCloseVerdict({ ...held, mounted: false, text: null, saleLocked: true }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/sale lock/);
  });

  it('still FAILS an absent card when no sale lock can explain it', () => {
    const v = forcedCloseVerdict({ ...held, mounted: false, text: null, saleLocked: false }, copy);
    expect(v.verdict).toBe('fail');
  });

  it('FAILS a card whose body is empty even though the heading has text', () => {
    // The rendered-shell case: whole-card emptiness passes it, because
    // the heading is text. This is the very state the module claims to
    // detect.
    const v = forcedCloseVerdict({ ...held, text: 'This loan is overdue', bodyText: '  ' }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/explanatory body/);
  });

  it('BLOCKS an unsettled card rather than passing it', () => {
    // Visible and explaining itself, so invariant 2 holds — but the
    // settled copy an amount would appear in was never rendered, so
    // invariant 1 went unchecked. A pass would bank coverage the run
    // did not obtain.
    const v = forcedCloseVerdict({ ...held, settled: false, text: FORCED_CLOSE.unknown }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/never scanned|check running/i);
    expect(v.checkRunning).toBe(true);
  });

  it('scans the CONFIRMATION text too, and fails on an amount there', () => {
    // The spec puts the pre-sign confirmation on this same surface. An
    // invented figure there was previously unreachable.
    const v = forcedCloseVerdict(
      { ...held, submitDisabled: false, confirmText: 'You receive 1.5 cbETH' },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.amounts).toHaveLength(1);
  });

  it('records whether the confirmation was scanned on a pass', () => {
    expect(
      forcedCloseVerdict({ ...held, submitDisabled: false, confirmText: 'Nothing numeric' }, copy)
        .confirmScanned,
    ).toBe(true);
    expect(forcedCloseVerdict({ ...held }, copy).confirmScanned).toBe(false);
  });
});

describe('forcedCloseCoverage', () => {
  const v = (verdict) => ({ forcedCloseVerdict: { verdict } });

  it('returns a reason when every observation was blocked', () => {
    // The all-FallbackPending chain: nine blocked verdicts, "routes
    // clean", exit 0, and an advertised assertion that never ran.
    expect(forcedCloseCoverage([v('blocked'), v('blocked')])).toMatch(/never observed/);
  });

  it('is satisfied by a single real observation', () => {
    expect(forcedCloseCoverage([v('blocked'), v('pass')])).toBeNull();
    expect(forcedCloseCoverage([v('blocked'), v('fail')])).toBeNull();
  });

  it('says nothing when no verdict was advertised at all (borrower runs)', () => {
    expect(forcedCloseCoverage([{ path: '/positions/1' }, {}])).toBeNull();
    expect(forcedCloseCoverage([])).toBeNull();
    expect(forcedCloseCoverage(null)).toBeNull();
  });
});

describe('monetaryAmountsIn — absolute since round 2', () => {
  it('fires on a BARE figure with no unit at all', () => {
    // The spec says "Nothing on this surface states an amount", not
    // "no unit-bearing amount". The first version advertised the
    // absolute rule and implemented the narrow one.
    expect(monetaryAmountsIn('You will receive 1.5')).toHaveLength(1);
    expect(monetaryAmountsIn('about 12 things')).toHaveLength(1);
  });

  it('still excludes identifiers spelled out, not only the # form', () => {
    // The comment claimed `loan 21` was covered when only `#21` was.
    // Harmless while a ticker was required to fire; a false positive the
    // moment the rule became absolute.
    expect(monetaryAmountsIn('Loan 21 is overdue.')).toEqual([]);
    expect(monetaryAmountsIn('Loan #21 is overdue.')).toEqual([]);
    expect(monetaryAmountsIn('position 4')).toEqual([]);
    expect(monetaryAmountsIn('token 9')).toEqual([]);
  });

  it('still excludes durations and proportions', () => {
    // Re-asserted HERE as well as above, because the absolute arm is
    // what would break them and these are the cases that make a
    // cried-wolf scanner get switched off.
    expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
    expect(monetaryAmountsIn('A 2% treasury share is deducted.')).toEqual([]);
    expect(monetaryAmountsIn('Set to 200 bps by governance.')).toEqual([]);
  });
});

describe('forcedCloseVerdict — round 2 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    text: FORCED_CLOSE.readyInKind,
  };

  it('BLOCKS when the confirmation was expected but could not be read', () => {
    // The click can be refused and the read can time out; both leave
    // confirmText null. Accepting that silently exits 0 having scanned
    // half the surface.
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: false, confirmExpected: true, confirmText: null },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/confirmation/);
  });

  it('PASSES when no confirmation was expected in the first place', () => {
    // A non-submittable card offers no confirmation, so its absence is
    // not a gap in the scan.
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: true, confirmExpected: false, confirmText: null },
      copy,
    );
    expect(v.verdict).toBe('pass');
  });
});

describe('round 3 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('catches a magnitude abbreviation followed by a ticker', () => {
    // `1m USDC` read `m` as minutes, exempted the figure and never
    // looked at the ticker — the scanner missing the promise it exists
    // for, on the shortest way of writing a large one.
    expect(monetaryAmountsIn('You receive 1m USDC')).toHaveLength(1);
    expect(monetaryAmountsIn('1k WETH')).toHaveLength(1);
    // ...without breaking the genuine duration exemption.
    expect(monetaryAmountsIn('30 minutes remain')).toEqual([]);
    expect(monetaryAmountsIn('in 3 days')).toEqual([]);
  });

  it('judges a scraped content defect BEFORE eligibility', () => {
    // The DOM is scraped before the chain reads, so a loan going
    // terminal in between must not discard an amount already observed.
    // Eligibility qualifies an ABSENCE; it does not suppress a finding.
    const v = forcedCloseVerdict(
      { ...base, lenderHoldsActive: false, text: `${FORCED_CLOSE.readyInKind} You get 1.5 WETH.` },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });

  it('still blocks an ABSENT card on an ineligible position', () => {
    // The other half: with nothing scraped there is no finding to
    // preserve, and eligibility rightly decides.
    const v = forcedCloseVerdict(
      { ...base, lenderHoldsActive: false, mounted: false, attached: false, text: null },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('inapplicable');
  });

  it('FAILS a card that is attached but not visible, and says which', () => {
    const v = forcedCloseVerdict({ ...base, mounted: false, attached: true, text: null }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/not visible/);
  });

  it('labels the two kinds of blocked', () => {
    expect(
      forcedCloseVerdict({ ...base, settled: false, text: FORCED_CLOSE.unknown }, copy).blockedKind,
    ).toBe('incomplete');
    expect(
      forcedCloseVerdict({ ...base, mounted: false, attached: false, text: null, saleLocked: true }, copy)
        .blockedKind,
    ).toBe('inapplicable');
  });
});

describe('forcedCloseCoverage — round 3', () => {
  const v = (verdict, blockedKind, path = '/positions/1') => ({
    path,
    forcedCloseVerdict: { verdict, blockedKind, why: 'because' },
  });

  it('reports an INCOMPLETE position even when another one passed', () => {
    // The correction: returning null as soon as anything passed let an
    // unscanned copy path ride out on its neighbour's success.
    const why = forcedCloseCoverage([v('pass'), v('blocked', 'incomplete', '/positions/2')]);
    expect(why).toMatch(/INCOMPLETE/);
    expect(why).toMatch(/positions\/2/);
  });

  it('stays silent when the only blocked positions were inapplicable', () => {
    expect(forcedCloseCoverage([v('pass'), v('blocked', 'inapplicable')])).toBeNull();
  });

  it('still reports an all-inapplicable run', () => {
    expect(forcedCloseCoverage([v('blocked', 'inapplicable')])).toMatch(/never observed/);
  });
});
