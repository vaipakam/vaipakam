import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };

import {
  confirmationReady,
  forcedCloseCoverage,
  forcedCloseVerdict,
  monetaryAmountsIn,
  reconcileEligibility,
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

describe('the calibration covers EVERY shipped locale, not only English', () => {
  // ROUND 11 P2. `FORCED_CLOSE` is the English bundle, so the case
  // named "passes every shipped forced-close string" was calibrating
  // one of the bundles a reader can actually be shown. The forced-close
  // card is translatable, its strings are funds copy, and a translator
  // introducing a figure — or a locale file carrying a stale English
  // draft with one in it — would have passed both the calibration and
  // the live drive, which is pinned to en-US.
  //
  // Read from disk rather than imported, so a locale added later is
  // covered without touching this file.
  const LOCALES_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/i18n/locales',
  );

  const walk = function* (node, prefix) {
    if (typeof node === 'string') {
      yield [prefix, node];
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) yield* walk(v, `${prefix}.${k}`);
    }
  };

  const bundles = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'))])
    .map(([f, json]) => [f, json?.copy?.forcedClose])
    .filter(([, fc]) => fc && typeof fc === 'object');

  it('finds forced-close copy in more than one bundle', () => {
    // Guards the guard: if the key moved or the read broke, the loop
    // below would pass over an empty set exactly as loudly.
    expect(bundles.length).toBeGreaterThan(1);
  });

  it('scans every translated forced-close string for an amount', () => {
    let checked = 0;
    for (const [file, fc] of bundles) {
      for (const [key, value] of walk(fc, 'forcedClose')) {
        expect(monetaryAmountsIn(value), `${file} ${key}: ${value}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('round 11 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.readyInKind,
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

  it('does NOT fire on the shipped unknown copy, which negates "refused"', () => {
    // `unknown` says "not what the protocol has refused" — the surface
    // being correct about the distinction. A matcher that fired here
    // would accuse the one string the rule exists to protect.
    // `bodyText` carries the state copy since round 12 — recognition
    // reads the BODY, because the card also carries history notes that
    // do not describe the current state.
    const v = forcedCloseVerdict(
      { ...base, text: FORCED_CLOSE.unknown, bodyText: FORCED_CLOSE.unknown },
      copy,
    );
    expect(v.verdict).toBe('pass');
  });

  it('FAILS an affirmative refusal claim that FOLLOWS the negated one', () => {
    // The first-match flaw: the legitimate negated occurrence inside
    // `unknown` was vouching for an affirmative claim later in the same
    // card. Every match is examined now.
    const v = forcedCloseVerdict(
      { ...base, text: `${FORCED_CLOSE.unknown} The protocol has refused this.` },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/opposite claims/);
  });

  it('catches a ticker behind punctuation', () => {
    expect(monetaryAmountsIn('You receive 1m (USDC)')).toHaveLength(1);
    expect(monetaryAmountsIn('Loan 100: USDC principal')).toHaveLength(1);
    expect(monetaryAmountsIn('Returns 250 — WETH')).toHaveLength(1);
  });

  it('BLOCKS a card whose copy matches no state this drive knows', () => {
    // A failed locale lookup or a generic error body renders non-empty,
    // carries no unresolved sentence, matches no readiness guard — and
    // was reported as the withheld-but-explained state. That establishes
    // only that SOMETHING was said.
    const v = forcedCloseVerdict({ ...base, text: 'Something went wrong.' }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });

  it('still PASSES every state the drive does know', () => {
    for (const known of copy.recognisedCopy) {
      const submitDisabled = known !== FORCED_CLOSE.readyInKind;
      expect(
        forcedCloseVerdict({ ...base, submitDisabled, text: known, bodyText: known }, copy)
          .verdict,
        known.slice(0, 40),
      ).toBe('pass');
    }
  });
});

describe('round 12 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyInKind],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: FORCED_CLOSE.notYet,
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    text: FORCED_CLOSE.notYet,
  };

  it('does NOT let a history note vouch for an unrecognised body', () => {
    // `lastOutcome` renders beside the current body, and the component's
    // own comment says it does not describe the current state. Matching
    // against the card text let it satisfy recognition for a body that
    // told the lender nothing about where the position stands now.
    const v = forcedCloseVerdict(
      {
        ...base,
        bodyText: 'Something went wrong.',
        text: `Something went wrong. ${FORCED_CLOSE.outcomeReverted}`,
      },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });

  it('BLOCKS as INCOMPLETE when the sale probe could not classify', () => {
    // `'unknown'` is a probe that did not answer. Reporting it as
    // inapplicable would print a confident accepted-sale explanation
    // that was never established — and inapplicable does not trip
    // coverage, so a missing card could be suppressed behind it.
    const v = forcedCloseVerdict({ ...base, saleLocked: 'unknown' }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    expect(v.why).toMatch(/unrecognised revert/);
  });

  it('still reports an established accepted sale as INAPPLICABLE', () => {
    const v = forcedCloseVerdict({ ...base, saleLocked: true }, copy);
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('inapplicable');
  });
});

describe('reconcileEligibility — folding the confirming re-read', () => {
  const eligible = { lenderHoldsActive: true, saleLocked: false };

  it('leaves the pinned snapshot alone when no confirmation was needed', () => {
    expect(reconcileEligibility(eligible, null)).toEqual(eligible);
  });

  // THE DEFECT THIS FUNCTION WAS EXTRACTED FOR. As an inline truthiness
  // test in the driver, `'unknown'` marked the position INELIGIBLE,
  // which the verdict reports as `inapplicable` — "nothing is wrong" —
  // for a card that was missing, on the strength of an accepted sale
  // that was never established. Round 12's finding, surviving in the
  // one branch whose job is deciding whether an absence is a FAIL.
  it('does not conclude ineligibility from a sale probe that could not classify', () => {
    const out = reconcileEligibility(eligible, {
      active: true,
      stillHeld: true,
      sale: 'unknown',
    });
    expect(out.lenderHoldsActive).toBe(true);
    expect(out.saleLocked).toBe('unknown');
  });

  it('reports an unclassifiable probe as an INCOMPLETE observation, which trips coverage', () => {
    const obs = {
      mounted: false,
      attached: false,
      text: null,
      bodyPresent: false,
      bodyText: null,
      confirmText: null,
      confirmExpected: false,
      submitDisabled: true,
      settled: true,
      ...reconcileEligibility(eligible, { active: true, stillHeld: true, sale: 'unknown' }),
    };
    const v = forcedCloseVerdict(obs, { unknownCopy: FORCED_CLOSE.unknown });
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    // The point of the kind: an incomplete observation is NOT allowed to
    // ride out on a neighbour's pass.
    expect(
      forcedCloseCoverage([
        { path: '/positions/1', forcedCloseVerdict: { verdict: 'pass' } },
        { path: '/positions/2', forcedCloseVerdict: v },
      ]),
    ).toMatch(/INCOMPLETE/);
  });

  it('an ESTABLISHED terminal or transfer outranks an unresolved sale probe', () => {
    // A known reason beats an unknown one: the position having left the
    // eligible set explains the absent card exactly, so it is reported
    // rather than the sale probe's silence.
    for (const later of [
      { active: false, stillHeld: true, sale: 'unknown' },
      { active: true, stillHeld: false, sale: 'unknown' },
    ]) {
      expect(reconcileEligibility(eligible, later).lenderHoldsActive).toBe(false);
    }
  });

  it('names an established accepted sale rather than generic ineligibility', () => {
    const out = reconcileEligibility(eligible, { active: true, stillHeld: true, sale: true });
    expect(out.lenderHoldsActive).toBe(true);
    expect(out.saleLocked).toBe(true);
    const v = forcedCloseVerdict(
      {
        mounted: false,
        attached: false,
        text: null,
        bodyPresent: false,
        bodyText: null,
        confirmText: null,
        confirmExpected: false,
        submitDisabled: true,
        settled: true,
        ...out,
      },
      { unknownCopy: FORCED_CLOSE.unknown },
    );
    expect(v.blockedKind).toBe('inapplicable');
    expect(v.why).toMatch(/accepted sale/);
  });

  it('a later clean probe does not retroactively resolve a pinned unknown', () => {
    // Different blocks. The head answering `false` says nothing about
    // whether the earlier probe answered, and silently upgrading it
    // would bank a pass on a reading that never happened.
    const out = reconcileEligibility(
      { lenderHoldsActive: true, saleLocked: 'unknown' },
      { active: true, stillHeld: true, sale: false },
    );
    expect(out.saleLocked).toBe('unknown');
  });
});

describe('round 13 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };

  // ── Proximity is not government ────────────────────────────────────
  // The old rule accepted any negation within 40 non-period characters,
  // so a `not` belonging to a DIFFERENT clause vouched for an
  // affirmative refusal claim — discarding the contradiction the check
  // exists to catch.
  it('still exempts the shipped negated refusal', () => {
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        saleLocked: false,
        settled: false,
        submitDisabled: true,
        bodyPresent: true,
        bodyText: FORCED_CLOSE.unknown,
        text: FORCED_CLOSE.unknown,
        confirmText: null,
        confirmExpected: false,
      },
      copy,
    );
    // Unsettled, not a refusal contradiction — the shipped sentence is
    // the surface being CORRECT about the distinction.
    expect(v.verdict).toBe('blocked');
    expect(v.why).not.toMatch(/refus/i);
  });

  it('catches an affirmative refusal whose nearest negation is another clause', () => {
    const text = `${FORCED_CLOSE.unknown} The check is not complete, but the protocol has refused this.`;
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        saleLocked: false,
        settled: false,
        submitDisabled: true,
        bodyPresent: true,
        bodyText: text,
        text,
        confirmText: null,
        confirmExpected: false,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/refused/i);
  });

  // ── Locale-native digits ───────────────────────────────────────────
  // `\d` is ASCII-only without the `u` flag, so these produced NO
  // numeric run and the scanner returned clean. Arabic and Hindi are
  // shipped locales, which made the all-locale calibration green for a
  // reason that was not coverage.
  it('finds an amount written in locale-native numerals', () => {
    expect(monetaryAmountsIn('١٫٥ USDC')).toHaveLength(1); // Arabic-Indic
    expect(monetaryAmountsIn('१.५ USDC')).toHaveLength(1); // Devanagari
    expect(monetaryAmountsIn('１２ USDC')).toHaveLength(1); // full-width
  });

  it('does not fire on a locale-native DURATION', () => {
    // The exemptions must survive the widened digit class, or the
    // scanner starts crying wolf in exactly the locales it just learned
    // to read.
    expect(monetaryAmountsIn('٣ days')).toEqual([]);
    expect(monetaryAmountsIn('३ days')).toEqual([]);
  });

  // ── An absence the confirmation never reached ──────────────────────
  it('does not accuse the product when no newer block ever arrived', () => {
    const out = reconcileEligibility(
      { lenderHoldsActive: true, saleLocked: false },
      { unconfirmed: true },
    );
    expect(out.absenceUnconfirmed).toBe(true);
    const v = forcedCloseVerdict(
      {
        ...out,
        mounted: false,
        attached: false,
        text: null,
        bodyPresent: false,
        bodyText: null,
        confirmText: null,
        confirmExpected: false,
        submitDisabled: true,
        settled: true,
      },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    // ROUND 23 changed this wording deliberately. The old sentence said
    // the observer "never advanced", which is only one of the ways the
    // confirmation can be unready and was FALSE for the other — a page
    // head that was never observed at all. With no specific reason
    // supplied, the fallback now states the general fact.
    expect(v.why).toMatch(/could not be shown to have caught up/);
  });

  it('outranks the hidden-card arm, which reads from the same unconfirmed DOM pass', () => {
    const v = forcedCloseVerdict(
      {
        ...reconcileEligibility(
          { lenderHoldsActive: true, saleLocked: false },
          { unconfirmed: true },
        ),
        mounted: false,
        attached: true,
        text: null,
        bodyPresent: false,
        bodyText: null,
        confirmText: null,
        confirmExpected: false,
        submitDisabled: true,
        settled: true,
      },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.why).not.toMatch(/not visible/);
  });

  it('a confirmed absence is still a FAIL — the gate did not become a mute', () => {
    const v = forcedCloseVerdict(
      {
        ...reconcileEligibility(
          { lenderHoldsActive: true, saleLocked: false },
          { active: true, stillHeld: true, sale: false },
        ),
        mounted: false,
        attached: false,
        text: null,
        bodyPresent: false,
        bodyText: null,
        confirmText: null,
        confirmExpected: false,
        submitDisabled: true,
        settled: true,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/absent/);
  });
});

describe('confirmationReady — round 14: caught up, not merely moved', () => {
  it('is satisfied when the observer passed what the page had announced', () => {
    expect(confirmationReady(12n, 10n, 11n)).toBe(true);
  });

  // ROUND 16 P2 — STRICTLY AHEAD, not level. `pageHead` is a lower bound
  // on what the page knows: it is the last height the page ANNOUNCED,
  // while the read that unmounted the card is an `eth_call` at `latest`,
  // which carries no block number on the wire. Matching that bound left
  // the page free to have evaluated one block above it.
  it('is NOT satisfied by merely drawing level with the page', () => {
    expect(confirmationReady(12n, 10n, 12n)).toBe(false);
  });

  // THE ROUND-14 DEFECT. Round 13 required only `head > pinned`, so a
  // page two blocks ahead could correctly drop the card for a
  // transition at N+2 while the confirmation re-read a still-eligible
  // position at N+1 — the same false FAIL, one block further along.
  it('is NOT satisfied by advancing one block behind the page', () => {
    expect(confirmationReady(11n, 10n, 12n)).toBe(false);
  });

  it('still requires the observer to have moved at all', () => {
    // Round 13's condition survives round 14's: a cached head equal to
    // the pinned block confirms nothing even when the page is level.
    expect(confirmationReady(10n, 10n, 10n)).toBe(false);
  });

  it('treats an UNOBSERVED page head as not ready, never as satisfied', () => {
    // Nothing is known about the relationship between the two views, so
    // an absence judged on it would be the accusation this gate exists
    // to withhold. Conservative and loud beats confidently wrong.
    expect(confirmationReady(99n, 10n, 0n)).toBe(false);
  });

  it('is false rather than throwing on non-bigint input', () => {
    expect(confirmationReady(12, 10n, 11n)).toBe(false);
    expect(confirmationReady(12n, 10n, undefined)).toBe(false);
    expect(confirmationReady(null, null, null)).toBe(false);
  });

  it('an unready confirmation reports the absence as incomplete, not as a defect', () => {
    const out = reconcileEligibility(
      { lenderHoldsActive: true, saleLocked: false },
      { unconfirmed: true },
    );
    const v = forcedCloseVerdict(
      {
        ...out,
        mounted: false,
        attached: false,
        text: null,
        bodyPresent: false,
        bodyText: null,
        confirmText: null,
        confirmExpected: false,
        submitDisabled: true,
        settled: true,
      },
      { unknownCopy: FORCED_CLOSE.unknown },
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
  });
});

describe('round 18 — a hidden control is not an offered action', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet],
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
  };

  // WITHHELD COPY + hidden-but-enabled control. The old predicate read
  // `!submitDisabled` as "an action is offered" and manufactured a FAIL
  // claiming the lender was offered a fee-paying transaction on a route
  // that deliberately offers none.
  it('does not accuse a withheld route because a hidden control is enabled', () => {
    const v = forcedCloseVerdict(
      {
        ...base,
        text: FORCED_CLOSE.notYet,
        bodyText: FORCED_CLOSE.notYet,
        submitVisible: false,
        submitDisabled: false,
      },
      copy,
    );
    expect(v.verdict).toBe('pass');
    expect(v.why).toMatch(/enabled but not visible/);
  });

  // READY COPY + hidden-but-enabled control. The lender is told the
  // close-out is available and has nothing to click. Previously the poll
  // settled on it and the run reported an incomplete confirmation, which
  // describes the harness rather than the defect.
  it('FAILS a ready route whose only control cannot be seen', () => {
    const v = forcedCloseVerdict(
      {
        ...base,
        text: FORCED_CLOSE.readyInKind,
        bodyText: FORCED_CLOSE.readyInKind,
        submitVisible: false,
        submitDisabled: false,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });

  it('still FAILS a withheld route that offers a genuinely usable control', () => {
    // The arm must not be blunted: visible AND enabled on withheld copy
    // is the original defect and stays a failure.
    const v = forcedCloseVerdict(
      {
        ...base,
        text: FORCED_CLOSE.notYet,
        bodyText: FORCED_CLOSE.notYet,
        submitVisible: true,
        submitDisabled: false,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });

  it('treats an observation predating the field as saying nothing about visibility', () => {
    // `submitVisible: undefined` must not invent a finding on records
    // written before the field existed.
    const v = forcedCloseVerdict(
      {
        ...base,
        text: FORCED_CLOSE.readyInKind,
        bodyText: FORCED_CLOSE.readyInKind,
        submitDisabled: false,
      },
      copy,
    );
    expect(v.verdict).toBe('pass');
    expect(v.why).toBe('card present and submittable');
  });
});

describe('round 19 — duplicate cards are a finding, not a choice', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: 'an explanation',
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
    text: FORCED_CLOSE.unknown,
  };

  it('FAILS when a second card is visible, even if the first is clean', () => {
    const v = forcedCloseVerdict({ ...held, visibleCards: 2 }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/2 forced-close cards/);
  });

  it('passes a single visible card', () => {
    expect(forcedCloseVerdict({ ...held, visibleCards: 1 }, copy).verdict).toBe('pass');
  });

  it('says nothing about duplicates when the count was not observed', () => {
    // Records predating the field must not invent a finding.
    expect(forcedCloseVerdict({ ...held }, copy).verdict).toBe('pass');
  });

  it('outranks the content scan, which only ever read the first card', () => {
    // A clean-looking content verdict for a surface that was never fully
    // read is the misleading outcome; the duplicate is reported instead.
    const v = forcedCloseVerdict(
      { ...held, visibleCards: 3, text: 'You receive 1.5 WETH' },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/3 forced-close cards/);
  });
});

describe('round 21 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    saleLocked: false,
    settled: true,
    visibleCards: 1,
    bodyPresent: true,
    bodyVisible: true,
    bodyText: FORCED_CLOSE.unknown,
    text: FORCED_CLOSE.unknown,
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
  };

  it('FAILS a body that is present and readable but not visible', () => {
    // `innerText` can still yield DOM text from a hidden node, so the
    // heading-only surface the lender actually sees was passing as
    // explained.
    const v = forcedCloseVerdict({ ...held, bodyVisible: false }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/not visible/);
  });

  it('says nothing about body visibility when it was not observed', () => {
    const { bodyVisible: _drop, ...noField } = held;
    expect(forcedCloseVerdict(noField, copy).verdict).toBe('pass');
  });

  it('still reports a MISSING body element distinctly from a hidden one', () => {
    const v = forcedCloseVerdict({ ...held, bodyPresent: false, bodyVisible: false }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/no explanatory body element/);
  });

  // The compact-amount hole: `m` read as minutes with no ticker to
  // cancel the exemption, so a promise of a million read as a wait.
  it('finds a bare compact amount with no ticker', () => {
    expect(monetaryAmountsIn('You receive 1m')).toHaveLength(1);
    expect(monetaryAmountsIn('Recovery: 1m')).toHaveLength(1);
  });

  it('still exempts a one-letter unit in genuine duration context', () => {
    expect(monetaryAmountsIn('unlocks in 30m')).toEqual([]);
    expect(monetaryAmountsIn('within 5m')).toEqual([]);
    // `about 2h remaining` was asserted clean here originally and is
    // NOT any more — round 23 removed both `about` (a quantity modifier)
    // and `remaining` (a quantity word) from the temporal markers, and
    // that phrase has nothing else establishing time. See the round-23
    // block for why the false hit is the affordable direction.
    expect(monetaryAmountsIn('after 2h')).toEqual([]);
  });
});

describe('round 22 — a duration lead has to establish time', () => {
  // The round-21 list swept in generic modifiers that read naturally in
  // front of an AMOUNT, so the compact-figure hole stayed open in the
  // phrasings a regression is most likely to use.
  it('finds a compact amount behind an ordinary modifier', () => {
    expect(monetaryAmountsIn('Sell for 1m')).toHaveLength(1);
    expect(monetaryAmountsIn('You receive about 1m')).toHaveLength(1);
    expect(monetaryAmountsIn('Worth over 1m')).toHaveLength(1);
  });

  it('still exempts a genuine wait, marked before OR after the figure', () => {
    // Real copy puts the temporal marker on either side, so dropping the
    // generic leads had to be paired with reading the trailing one.
    expect(monetaryAmountsIn('unlocks in 30m')).toEqual([]);
    expect(monetaryAmountsIn('wait 30m')).toEqual([]);
    expect(monetaryAmountsIn('48h of grace')).toEqual([]);
  });

  // ROUND 23 REVERSED TWO ASSERTIONS THIS CASE ORIGINALLY MADE.
  //
  // `2h remaining` and `30m left` were asserted clean one round earlier.
  // They are not: `remaining` and `left` describe a residual QUANTITY as
  // readily as a residual duration — `Balance: 1m remaining`, `Only 1m
  // left to claim` — so accepting them recreated the bare-amount hole on
  // the trailing side. The trailing markers are now only ones that
  // cannot measure money.
  //
  // The cost is a false hit on `2h remaining`, which is why this is
  // spelled out rather than quietly changed: no shipped string uses that
  // shape (they spell units out — `72 hours`, `3 days`, `30 minutes`),
  // and the all-locale calibration proves that rather than my judgement.
  it('reports an ambiguous unit whose only marker is a quantity word', () => {
    expect(monetaryAmountsIn('Balance: 1m remaining')).toHaveLength(1);
    expect(monetaryAmountsIn('Only 1m left to claim')).toHaveLength(1);
    expect(monetaryAmountsIn('2h remaining')).toHaveLength(1);
  });

  it('does not let a ticker in a LATER clause cancel an exemption', () => {
    // The lookahead is a character window, so it ran through the
    // sentence end into an unrelated ticker and reported correct copy
    // as an invented amount — the false-positive direction.
    expect(monetaryAmountsIn('Wait 3 days. USDC returns later')).toEqual([]);
    expect(monetaryAmountsIn('Loan 21. USDC is lent')).toEqual([]);
  });
});

describe('round 23 — the unready confirmation names its own cause', () => {
  const shape = (extra) => ({
    mounted: false,
    attached: false,
    text: null,
    bodyPresent: false,
    bodyVisible: false,
    bodyText: null,
    confirmText: null,
    confirmExpected: false,
    submitPresent: false,
    submitVisible: false,
    submitDisabled: true,
    settled: true,
    ...extra,
  });

  it('reports the specific condition the driver observed', () => {
    // The two causes send an operator to different places: a stale
    // OBSERVE_RPC, or page-head instrumentation that saw nothing.
    const out = reconcileEligibility(
      { lenderHoldsActive: true, saleLocked: false },
      { unconfirmed: true, why: 'the page never announced a head on the deployment endpoint' },
    );
    const v = forcedCloseVerdict(shape(out), { unknownCopy: FORCED_CLOSE.unknown });
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    expect(v.why).toBe('the page never announced a head on the deployment endpoint');
  });

  it('falls back to the general statement when no cause was supplied', () => {
    const out = reconcileEligibility(
      { lenderHoldsActive: true, saleLocked: false },
      { unconfirmed: true },
    );
    const v = forcedCloseVerdict(shape(out), { unknownCopy: FORCED_CLOSE.unknown });
    expect(v.why).toMatch(/could not be shown to have caught up/);
    // And it must NOT assert the one cause it cannot know.
    expect(v.why).not.toMatch(/never advanced/);
  });
});

describe('round 24 review findings', () => {
  it('reports a compact amount behind next/every', () => {
    // Third trim of this list for admitting a word that can precede an
    // amount. `The next 1m is claimable` and `Withdraw every 1m` are
    // quantities, not cadences.
    expect(monetaryAmountsIn('The next 1m is claimable')).toHaveLength(1);
    expect(monetaryAmountsIn('Withdraw every 1m')).toHaveLength(1);
  });

  it('does not let a ticker on the NEXT RENDERED LINE cancel an exemption', () => {
    // `innerText` inserts a newline between elements, so the boundary
    // real card markup produces is a line break, not punctuation.
    expect(monetaryAmountsIn('Wait 3 days\nUSDC later')).toEqual([]);
    expect(monetaryAmountsIn('Loan 21\nUSDC is lent')).toEqual([]);
  });

  it('treats ? and ! as sentence ends when scoping a negation', () => {
    // A negation in a QUESTION was suppressing a definite refusal claim
    // in the sentence after it, because the scope was sliced on `.`
    // alone.
    const text = `Is the check not ready? The protocol has refused this.`;
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        saleLocked: false,
        settled: false,
        visibleCards: 1,
        bodyPresent: true,
        bodyVisible: true,
        bodyText: `${FORCED_CLOSE.unknown} ${text}`,
        text: `${FORCED_CLOSE.unknown} ${text}`,
        confirmText: null,
        confirmExpected: false,
        submitPresent: true,
        submitVisible: true,
        submitDisabled: true,
      },
      { unknownCopy: FORCED_CLOSE.unknown },
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/refused/i);
  });

  it('still exempts the shipped negated refusal after the wider split', () => {
    // The tightening must not start failing the copy the exemption
    // exists to protect.
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        saleLocked: false,
        settled: false,
        visibleCards: 1,
        bodyPresent: true,
        bodyVisible: true,
        bodyText: FORCED_CLOSE.unknown,
        text: FORCED_CLOSE.unknown,
        confirmText: null,
        confirmExpected: false,
        submitPresent: true,
        submitVisible: true,
        submitDisabled: true,
      },
      { unknownCopy: FORCED_CLOSE.unknown },
    );
    expect(v.why).not.toMatch(/refus/i);
  });
});
