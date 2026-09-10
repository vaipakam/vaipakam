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

  it('passes every shipped forced-close string, INCLUDING the nested receipts', () => {
    // The strongest available calibration: the real copy, all of it. If
    // this ever fails, either the scanner regressed or somebody put an
    // amount in the card — and the two are told apart by reading the
    // named string.
    //
    // ROUND 7 P2 — RECURSES. `receipt` and `rentalReceipt` are nested
    // OBJECTS, so a top-level `typeof value !== 'string'` skipped every
    // one of their strings while this case claimed to cover "every
    // shipped string". Those are the CONFIRMATION lines — the panel the
    // drive now opens and scans, and the copy most likely to carry a
    // figure, since it is the part that describes what the lender
    // receives. The calibration was blind to exactly the surface it
    // most needed to cover.
    const walk = function* (node, path) {
      if (typeof node === 'string') {
        yield [path, node];
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) yield* walk(v, `${path}.${k}`);
      }
    };
    let checked = 0;
    for (const [key, value] of walk(FORCED_CLOSE, 'forcedClose')) {
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
    // And the nested receipts really were reached — the whole point of
    // the recursion. A named assertion, because a walk that silently
    // stopped recursing would still clear the floor above.
    const reached = [...walk(FORCED_CLOSE, 'forcedClose')].map(([k]) => k);
    expect(reached).toContain('forcedClose.receipt.youReceive');
    expect(reached).toContain('forcedClose.rentalReceipt.youReceive');
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
    bodyPresent: true,
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
    bodyPresent: true,
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
    // Round 9 unified the mounted and absent sale-locked arms into one
    // applicability rule, so the wording moved; the verdict did not.
    expect(v.why).toMatch(/accepted sale/);
  });

  it('still FAILS an absent card when no sale lock can explain it', () => {
    const v = forcedCloseVerdict({ ...held, mounted: false, text: null, saleLocked: false }, copy);
    expect(v.verdict).toBe('fail');
  });

  it('FAILS a card whose body is empty even though the heading has text', () => {
    // The rendered-shell case: whole-card emptiness passes it, because
    // the heading is text. This is the very state the module claims to
    // detect.
    //
    // `bodyPresent: true` is load-bearing since round 7: the element
    // EXISTS and its text is blank. An undefined `bodyPresent` now means
    // the card vanished mid-scrape, and a blank read taken from a card
    // that is no longer there is not evidence of anything.
    const v = forcedCloseVerdict(
      { ...held, text: 'This loan is overdue', bodyPresent: true, bodyText: '  ' },
      copy,
    );
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
    bodyPresent: true,
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

describe('round 4 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('BLOCKS when the body element is present but unreadable', () => {
    // The card can unmount between its own text read and the body read.
    // Coercing that null to "" reported a product defect over a scrape
    // that never happened.
    const v = forcedCloseVerdict({ ...base, bodyPresent: true, bodyText: null }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });

  it('FAILS when no body element rendered at all', () => {
    // ROUND 5 P2 — the third state. Round 4 collapsed this into the
    // one above by treating element-existence as a successful read, so
    // a genuine heading-only shell blocked instead of failing.
    const v = forcedCloseVerdict({ ...base, bodyPresent: false, bodyText: null }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/no explanatory body element/);
  });

  it('still FAILS a body that was read and is genuinely blank', () => {
    // The other half — this is the state the check exists for, and it
    // must survive the fix for its neighbour.
    const v = forcedCloseVerdict({ ...base, bodyPresent: true, bodyText: '   ' }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/explanatory body/);
  });

  it('BLOCKS an observation that carries no bodyPresent at all', () => {
    // ROUND 8 changed what `undefined` MEANS, and this case with it.
    // Round 7 used it as "not stated, judge as before"; round 8 showed
    // that let a vanished card exit clean, so it now means "the card
    // went before its body could be checked" — incomplete. The driver
    // emits it only in that case, so no real observation is affected,
    // but every FIXTURE describing a fully observed card must now say
    // `bodyPresent: true` rather than rely on the field's absence.
    const v = forcedCloseVerdict({ ...base, bodyPresent: undefined }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });
});

describe('round 5 review findings', () => {
  it('catches a ticker behind an identifier word', () => {
    // Second instance of one mistake: an exemption that `continue`s
    // before inspecting what follows. Round 3 was `1m USDC` (unit);
    // this is `Loan 100 USDC` (identifier).
    expect(monetaryAmountsIn('Loan 100 USDC principal')).toHaveLength(1);
    expect(monetaryAmountsIn('token 5 WETH')).toHaveLength(1);
    expect(monetaryAmountsIn('#250 USDC')).toHaveLength(1);
  });

  it('still exempts a genuine identifier with nothing token-shaped after it', () => {
    expect(monetaryAmountsIn('Loan 21 is overdue.')).toEqual([]);
    expect(monetaryAmountsIn('position 4')).toEqual([]);
    expect(monetaryAmountsIn('Loan #21 is overdue.')).toEqual([]);
  });
});

describe('round 6 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('BLOCKS when the card was visible but its text could not be read', () => {
    // `text: null` is not empty text. The card can unmount, or the read
    // time out, after the visibility wait — and coercing that to ''
    // reported an empty-card defect over an observation that never
    // happened.
    const v = forcedCloseVerdict({ ...base, text: null }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });

  it('reports an amount in the CARD text even when the body read failed', () => {
    // The definite finding outranks the uncertain one. Blocking here
    // says "we could not check" about something that was checked.
    const v = forcedCloseVerdict(
      {
        ...base,
        text: `${FORCED_CLOSE.readyInKind} You will receive 1.5 WETH.`,
        bodyPresent: true,
        bodyText: null,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.amounts).toHaveLength(1);
  });

  it('still blocks on the failed body read when the card text is clean', () => {
    // The other half — the reordering must not disable the arm it now
    // sits above.
    const v = forcedCloseVerdict({ ...base, bodyPresent: true, bodyText: null }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });

  it('reports an amount in the CONFIRMATION even when the body read failed', () => {
    const v = forcedCloseVerdict(
      { ...base, confirmText: 'You receive 250 USDC', bodyPresent: true, bodyText: null },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });
});

describe('round 7 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    // `readyNeedsRoute` deliberately excluded — see below.
    readyCopy: [
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: false,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('FAILS a card that says a check is running AND claims unavailability', () => {
    // The module named this invariant in its header and never enforced
    // it. Narrow by construction: it fires only on the contradiction,
    // never on copy that merely says a route is unavailable.
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: true, text: `${FORCED_CLOSE.unknown} This is not available.` },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/opposite claims/);
  });

  it('does NOT fire on a settled card that legitimately reports unavailability', () => {
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: true, text: 'This route is not available for this loan.' },
      copy,
    );
    expect(v.verdict).toBe('pass');
  });

  it('FAILS a READY route that offers no usable action', () => {
    // `pass` labelled every present non-submittable card the valid
    // withheld-but-explained state. That is right for `unknown` and
    // `notYet`; it is wrong for a route the spec says is offered
    // directly.
    for (const ready of copy.readyCopy) {
      const v = forcedCloseVerdict({ ...base, submitDisabled: true, text: ready }, copy);
      expect(v.verdict, ready.slice(0, 40)).toBe('fail');
      expect(v.why).toMatch(/READY route/);
    }
  });

  it('PASSES readyNeedsRoute with no button — it is ready AND correctly unactionable', () => {
    // Caught by RUNNING the check, not by writing it: including this
    // route in `readyCopy` fired on a live position within a minute.
    // The spec is explicit that this route offers no button, because
    // "presenting an action that is certain to be refused is worse than
    // presenting none: the user pays a network fee for the refusal".
    //
    // My own tests had missed it because the loop sliced the first
    // three entries — a slice that was itself a tell.
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: true, text: FORCED_CLOSE.readyNeedsRoute },
      copy,
    );
    expect(v.verdict).toBe('pass');
  });

  it('still PASSES a withheld card whose copy is genuinely a waiting state', () => {
    for (const waiting of [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.blockedPaused]) {
      expect(
        forcedCloseVerdict({ ...base, submitDisabled: true, text: waiting }, copy).verdict,
        waiting.slice(0, 40),
      ).toBe('pass');
    }
  });

  it('BLOCKS when the confirmation shell opened but its receipt did not render', () => {
    // Back proves the panel mounted; the scrape is of the whole card,
    // which still carries the heading and body. Without the receipt's
    // own line, nothing was observed about what it claims.
    const v = forcedCloseVerdict(
      { ...base, confirmExpected: true, confirmText: `${FORCED_CLOSE.readyInKind} Back Confirm` },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/receipt content/);
  });

  it('PASSES when the receipt content is actually present', () => {
    const v = forcedCloseVerdict(
      {
        ...base,
        confirmExpected: true,
        confirmText: `${FORCED_CLOSE.readyInKind}\n${FORCED_CLOSE.receipt.youReceive}`,
      },
      copy,
    );
    expect(v.verdict).toBe('pass');
    expect(v.confirmScanned).toBe(true);
  });

  it('BLOCKS on an undefined bodyPresent — the card vanished with it', () => {
    // ROUND 8 corrected this case. Round 7 introduced `undefined` to
    // stop a vanished card being reported as the heading-only shell,
    // and then asserted it PASSES — so a run could exit clean having
    // never established that the required body existed. Not observed
    // is not the same as observed to be fine, which is the distinction
    // this whole harness is built on, and my own case had it backwards.
    const v = forcedCloseVerdict({ ...base, bodyPresent: undefined, bodyText: null }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });
});

describe('round 8 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
    ],
    withheldCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('scans the BODY text for amounts, not only the card and confirmation', () => {
    // `bodyText` is captured independently, a moment after the card
    // read, so the card can update in between and the body can carry a
    // figure the card text does not. It was never scanned at all.
    const v = forcedCloseVerdict({ ...base, bodyText: 'You receive 250 USDC' }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.amounts).toHaveLength(1);
  });

  it('FAILS a NON-ACTIONABLE state that offers an enabled action', () => {
    // The inverse of the ready-without-action defect, and the more
    // expensive half: here the user pays a fee for a refusal.
    for (const withheld of copy.withheldCopy) {
      const v = forcedCloseVerdict({ ...base, submitDisabled: false, text: withheld }, copy);
      expect(v.verdict, withheld.slice(0, 40)).toBe('fail');
      expect(v.why).toMatch(/NON-ACTIONABLE/);
    }
    // ROUND 9 P2 — AND WITH `settled: false`, which is the only shape
    // the driver can actually produce for `unknown`. The round-8 case
    // above modelled it as settled, so the arm sat below the unsettled
    // return and could never fire on its own headline state while the
    // test reported it working.
    const v = forcedCloseVerdict(
      { ...base, submitDisabled: false, settled: false, text: FORCED_CLOSE.unknown },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/NON-ACTIONABLE/);
  });

  it('still PASSES an actionable state with an enabled action', () => {
    for (const ready of copy.readyCopy) {
      expect(
        forcedCloseVerdict({ ...base, submitDisabled: false, text: ready }, copy).verdict,
        ready.slice(0, 40),
      ).toBe('pass');
    }
  });

  it('keeps readyNeedsRoute passing when it withholds, and failing when it does not', () => {
    // The one route that appears in `withheldCopy` while reading as
    // ready. Both directions asserted together, because they are the
    // same fact and it is easy to fix one and break the other.
    expect(
      forcedCloseVerdict({ ...base, submitDisabled: true, text: FORCED_CLOSE.readyNeedsRoute }, copy)
        .verdict,
    ).toBe('pass');
    expect(
      forcedCloseVerdict(
        { ...base, submitDisabled: false, text: FORCED_CLOSE.readyNeedsRoute },
        copy,
      ).verdict,
    ).toBe('fail');
  });
});

describe('round 9 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.readyInKind,
  };

  it('BLOCKS a MOUNTED card on a sale-locked position rather than banking it', () => {
    // A sale accepted between the DOM scrape and the pinned snapshot
    // leaves a card that WAS mounted on a position now outside the
    // card's applicability. Banking that clean reading would satisfy
    // coverage with evidence from a state the card is not meant to be
    // in.
    const v = forcedCloseVerdict({ ...base, saleLocked: true }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('inapplicable');
  });

  it('still reports a definite content failure on a sale-locked position', () => {
    // Applicability refuses to BANK a clean reading; it does not erase
    // one that was positively observed. Round 3's rule, held.
    const v = forcedCloseVerdict(
      { ...base, saleLocked: true, text: `${FORCED_CLOSE.readyInKind} You get 1.5 WETH.` },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });
});
