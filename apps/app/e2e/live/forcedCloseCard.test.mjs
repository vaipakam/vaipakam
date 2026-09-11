import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };
import { canSubmitFromApp } from '../../src/data/forcedClose.ts';

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
    // ROUND 33 P2 — PER BUNDLE, not one pooled total.
    //
    // A single `checked > 30` floor is cleared by the English bundle
    // alone, so nine of the ten shipped translations could have dropped
    // out of this loop — a key renamed, a file emptied during a merge —
    // and the case would still have passed while covering exactly the one
    // locale the drive already runs. That is the same vacuous-loop shape
    // this file guards against two cases up, one level out: the guard was
    // on the aggregate rather than on each member of it.
    //
    // The finding that prompted this asserted the calibration was
    // English-only. It is not, and has not been since round 11 — but the
    // floor was weak enough that it could have BECOME English-only
    // without failing, which is the defensible half of the concern.
    const perBundle = new Map();
    for (const [file, fc] of bundles) {
      let here = 0;
      for (const [key, value] of walk(fc, 'forcedClose')) {
        expect(monetaryAmountsIn(value), `${file} ${key}: ${value}`).toEqual([]);
        here += 1;
        checked += 1;
      }
      perBundle.set(file, here);
    }
    for (const [file, here] of perBundle) {
      expect(here, `${file} contributed only ${here} strings`).toBeGreaterThanOrEqual(30);
    }
    expect(checked).toBeGreaterThan(30 * bundles.length);
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

describe('round 26 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  // A card that is otherwise entirely clean, so every assertion below
  // isolates the duplicate-control rule rather than riding on some
  // other defect in the fixture.
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    saleLocked: false,
    settled: true,
    visibleCards: 1,
    bodyPresent: true,
    bodyVisible: true,
    bodyText: 'an explanation',
    text: FORCED_CLOSE.unknown,
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
  };

  it('FAILS when one card shows two submit controls', () => {
    const v = forcedCloseVerdict({ ...held, visibleSubmits: 2 }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/2 forced-close submit controls/);
  });

  it('passes a card offering exactly one control', () => {
    expect(
      forcedCloseVerdict({ ...held, visibleSubmits: 1 }, copy).verdict,
    ).toBe('pass');
  });

  it('passes a card offering none — a withheld action is not a duplicate', () => {
    expect(
      forcedCloseVerdict(
        { ...held, visibleSubmits: 0, submitVisible: false },
        copy,
      ).verdict,
    ).toBe('pass');
  });

  it('invents no finding when the control count was not observed', () => {
    // Records predating the field must not start failing. Same rule the
    // duplicate-CARD arm follows, and the reason both are `typeof`
    // guarded rather than truthiness tests.
    expect(forcedCloseVerdict({ ...held }, copy).verdict).toBe('pass');
  });

  it('outranks the content scan, which only ever clicked the first control', () => {
    // The danger of the duplicate is precisely that the drive interacted
    // with one of them; a clean content verdict over a partly
    // interrogated surface is the misleading outcome.
    const v = forcedCloseVerdict(
      { ...held, visibleSubmits: 2, text: 'You receive 1.5 WETH' },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/submit controls/);
  });

  it('reports the duplicate control even when an action is genuinely offered', () => {
    // `submitDisabled: false` means the visible set contains an enabled
    // control, so the actionability flags would answer "action offered"
    // — correctly, and while concealing that it is offered twice. The
    // arm exists so that answer does not stand alone.
    const v = forcedCloseVerdict(
      { ...held, visibleSubmits: 2, submitDisabled: false },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });
});

describe('round 27 review findings', () => {
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
    bodyText: 'an explanation',
    text: FORCED_CLOSE.unknown,
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
  };

  it('reports the control count on a pass, so a dropped field is visible', () => {
    // The point of this assertion is NOT the number. Twice now the
    // count has failed to survive the projection from the DOM pass and
    // arrived here as `undefined`, which silently disarms the duplicate
    // arm for every input. Surfacing it on the pass verdict is what
    // makes that state legible in a run instead of invisible until
    // someone reads the projection.
    const v = forcedCloseVerdict({ ...held, visibleSubmits: 1 }, copy);
    expect(v.verdict).toBe('pass');
    expect(v.visibleSubmits).toBe(1);
  });

  it('passes the missing count through as undefined rather than inventing 0', () => {
    // `0` would read as "observed, none visible" — a different and
    // stronger claim than "never observed". The drive prints whichever
    // it got, so the two must not be conflated here.
    const v = forcedCloseVerdict({ ...held }, copy);
    expect(v.verdict).toBe('pass');
    expect(v.visibleSubmits).toBeUndefined();
  });
});

describe('round 31 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    saleLocked: false,
    settled: true,
    visibleCards: 1,
    visibleSubmits: 1,
    bodyPresent: true,
    bodyVisible: true,
    bodyText: 'an explanation',
    text: FORCED_CLOSE.unknown,
    confirmText: null,
    confirmExpected: false,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
  };

  it('FAILS on an amount seen only in a render the readiness poll superseded', () => {
    // The settled copy is clean. The card nonetheless stated a figure
    // while its readiness reads were outstanding, and a lender loading
    // the page in that window saw it. Scanning only the final render
    // reported this as a pass.
    const v = forcedCloseVerdict(
      { ...held, seenTexts: ['You receive 1.5 WETH', FORCED_CLOSE.unknown] },
      copy,
    );
    expect(v.verdict).toBe('fail');
  });

  it('still passes when every remembered render is clean', () => {
    const v = forcedCloseVerdict(
      { ...held, seenTexts: [FORCED_CLOSE.unknown, 'an explanation'] },
      copy,
    );
    expect(v.verdict).toBe('pass');
  });

  it('ignores the field entirely when it is absent or not an array', () => {
    // Records predating the field, and every path that never polls,
    // must not change verdict — the same rule the control-count arm
    // follows.
    expect(forcedCloseVerdict({ ...held }, copy).verdict).toBe('pass');
    expect(
      forcedCloseVerdict({ ...held, seenTexts: null }, copy).verdict,
    ).toBe('pass');
    expect(
      forcedCloseVerdict({ ...held, seenTexts: 'You receive 1 USDC' }, copy)
        .verdict,
    ).toBe('pass');
  });
});

describe('round 33 review findings', () => {
  const LOCALES_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/i18n/locales',
  );

  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };

  // ---- the amount scan no longer depends on the card surviving -------
  describe('an amount seen mid-poll survives the card vanishing', () => {
    // The drive polls a card until it settles, and both of that loop's
    // early exits used to drop the accumulated renders. So a card that
    // stated a figure while its readiness reads were outstanding, and
    // then vanished, had the one piece of evidence this drive exists to
    // collect thrown away — and if an accepted sale explained the
    // disappearance, the verdict went on to report `inapplicable`.
    const vanished = {
      lenderHoldsActive: true,
      mounted: false,
      attached: false,
      saleLocked: false,
      settled: false,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      confirmText: null,
      confirmExpected: false,
      seenTexts: [`${FORCED_CLOSE.readyInKind} You will receive 1.5 WETH.`],
    };

    it('FAILS on the amount even though the card is gone', () => {
      const v = forcedCloseVerdict(vanished, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/amount it cannot know/);
      expect(v.amounts).toHaveLength(1);
    });

    // The case that made this a P2 rather than a tidy-up: eligibility
    // legitimately explains an ABSENCE, and it was being allowed to
    // suppress a POSITIVE observation as well. This file says at length
    // that the two are different.
    it('FAILS on the amount even when an accepted sale explains the absence', () => {
      const v = forcedCloseVerdict({ ...vanished, saleLocked: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/amount it cannot know/);
    });

    it('FAILS on the amount even on a position that is no longer the lender’s', () => {
      const v = forcedCloseVerdict({ ...vanished, lenderHoldsActive: false }, copy);
      expect(v.verdict).toBe('fail');
    });

    // And the scan must not have become a hair trigger: an unmounted
    // record that saw nothing is still an ordinary absence question.
    it('does not invent a finding from an unmounted record with no texts', () => {
      const v = forcedCloseVerdict({ ...vanished, seenTexts: [] }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/absent/);
    });
  });

  // ---- a vanished card is classified as absence, not as incomplete ---
  describe('a card that vanishes mid-poll reaches the eligibility rules', () => {
    // It used to report `mounted: true, attached: true` for a DOM pass
    // that found nothing, so the verdict took the mounted branch, hit
    // `text: null`, and returned blocked/incomplete before eligibility
    // was consulted at all — `forcedCloseCoverage` then exited 2 for a
    // loan going terminal while the drive was looking.
    const vanished = {
      lenderHoldsActive: true,
      mounted: false,
      attached: false,
      saleLocked: false,
      settled: false,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      confirmText: null,
      confirmExpected: false,
      seenTexts: [],
    };

    it('reports an explained disappearance as INAPPLICABLE', () => {
      const v = forcedCloseVerdict({ ...vanished, saleLocked: true }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });

    it('still FAILS a confirmed absence on an eligible position', () => {
      const v = forcedCloseVerdict(vanished, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/absent/);
    });

    // `attached` had to move with `mounted`, and this is why: section 3
    // reads it, and `true` would have produced a confidently wrong
    // sentence about a card that is not in the DOM at all.
    it('does not describe the vanished card as present-but-hidden', () => {
      const v = forcedCloseVerdict(vanished, copy);
      expect(v.why).not.toMatch(/in the DOM/);
    });

    it('reports an unconfirmed absence as INCOMPLETE, not as a FAIL', () => {
      const v = forcedCloseVerdict({ ...vanished, absenceUnconfirmed: true }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });
  });

  // ---- two readiness states at once ---------------------------------
  describe('the body states exactly one recognised readiness state', () => {
    // A READY card with its action OFFERED. The first draft of these
    // fixtures left the control disabled, and round 7's
    // ready-without-action arm fired before any of this — a reminder that
    // these records are only meaningful as whole states, not as the one
    // field a case happens to be about.
    const base = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      confirmText: null,
      confirmExpected: false,
      visibleCards: 1,
    };

    it('PASSES a body in exactly one state', () => {
      const v = forcedCloseVerdict(
        { ...base, bodyText: FORCED_CLOSE.readyInKind, text: FORCED_CLOSE.readyInKind },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    // The nine states are alternatives — `ForcedCloseCard` maps one
    // readiness to one body string — so two together is the surface
    // telling a lender two different things about the same decision.
    it('FAILS a body carrying two of them', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          bodyText: `${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.readyInternalMatch}`,
          text: FORCED_CLOSE.readyInKind,
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/two different things|recognised readiness states at once/);
    });

    it('still reports UNRECOGNISED copy as a gap rather than a defect', () => {
      const v = forcedCloseVerdict(
        { ...base, bodyText: 'Something went wrong.', text: 'Something went wrong.' },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    // THE FALSE-FAIL GUARD, and the reason this arm is safe to make a
    // FAIL at all. It can only misfire if one shipped state's sentence
    // is a substring of another's, so that is pinned directly — in every
    // translated bundle, not only in the one the drive happens to run.
    it('no shipped readiness state contains another, in any locale', () => {
      const STATES = [
        'unknown',
        'notYet',
        'blockedPaused',
        'blockedSequencer',
        'blockedNoConsent',
        'readyInKind',
        'readyInternalMatch',
        'readyRental',
        'readyNeedsRoute',
      ];
      const bundles = fs
        .readdirSync(LOCALES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => [f, JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'))])
        .map(([f, json]) => [f, json?.copy?.forcedClose])
        .filter(([, fc]) => fc && typeof fc === 'object');
      expect(bundles.length).toBeGreaterThan(1);
      let compared = 0;
      for (const [file, fc] of bundles) {
        for (const a of STATES) {
          for (const b of STATES) {
            if (a === b) continue;
            const sa = fc[a];
            const sb = fc[b];
            if (typeof sa !== 'string' || typeof sb !== 'string' || !sa || !sb) continue;
            expect(sb.includes(sa), `${file}: ${b} contains ${a}`).toBe(false);
            compared += 1;
          }
        }
      }
      // Not vacuous: nine states, ordered pairs, across every bundle.
      expect(compared).toBeGreaterThan(bundles.length * 50);
    });
  });
});

describe('round 35 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };

  // ---- one render must not lend its context to another ---------------
  describe('captured renders are scanned separately, never joined', () => {
    // The `\n` join added in round 31 let a render ENDING in an
    // identifier word supply the lead for the next render's opening
    // digits. Every exemption in the scanner is a context test, so an
    // adjacency that never existed on screen could exempt a figure that
    // was.
    it('finds a bare figure that a previous render would have exempted', () => {
      const obs = {
        lenderHoldsActive: true,
        mounted: false,
        attached: false,
        saleLocked: false,
        settled: false,
        text: null,
        bodyText: null,
        bodyPresent: undefined,
        confirmText: null,
        confirmExpected: false,
        seenTexts: ['Closing out Loan', '1.5 will be returned'],
      };
      const v = forcedCloseVerdict(obs, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/amount it cannot know/);
    });

    // The control: the same two strings joined DO exempt it, which is
    // what the code used to do. Asserted directly so the case above is
    // shown to be about the join rather than about the scanner.
    it('and the join really was what suppressed it', () => {
      expect(monetaryAmountsIn('1.5 will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Closing out Loan\n1.5 will be returned')).toEqual([]);
    });

    // The legitimate direction still holds: a real identifier inside ONE
    // render is still an identifier. Widening this to "scan everything
    // separately" must not turn `Loan 21` into a finding.
    it('still exempts an identifier within a single render', () => {
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
    });
  });

  // ---- every currency sign, not five of them -------------------------
  describe('the scanner recognises every Unicode currency sign', () => {
    // These are the inputs that made it a P2: the sign was unrecognised,
    // so `hugsCurrency` was false, so the IDENTIFIER exemption fired and
    // the figure was read as a loan number rather than an amount. Won is
    // the currency of a shipped locale.
    it('flags a figure after an identifier word when the sign is not ASCII', () => {
      expect(monetaryAmountsIn('Loan 100 ₽')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 ₩')).toHaveLength(1);
      expect(monetaryAmountsIn('Token 5 ₺')).toHaveLength(1);
      expect(monetaryAmountsIn('Offer 9 ฿')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 3 ₪')).toHaveLength(1);
      expect(monetaryAmountsIn('Item 7 ￥')).toHaveLength(1);
    });

    it('still flags the signs that already worked', () => {
      for (const s of ['$', '€', '£', '¥', '₹']) {
        expect(monetaryAmountsIn(`Loan 100 ${s}`), s).toHaveLength(1);
      }
    });

    it('does not fire on a bare identifier with no sign at all', () => {
      expect(monetaryAmountsIn('Loan 100 is overdue.')).toEqual([]);
    });
  });

  // ---- a duplicate seen and then gone --------------------------------
  describe('a duplicate card counted on any tick is a finding', () => {
    const base = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyText: FORCED_CLOSE.readyInKind,
      text: FORCED_CLOSE.readyInKind,
      confirmText: null,
      confirmExpected: false,
      visibleCards: 1,
    };

    it('PASSES when only one card was ever seen', () => {
      expect(forcedCloseVerdict({ ...base, visibleCardsPeak: 1 }, copy).verdict).toBe('pass');
    });

    // The settled render is clean, so the round-19 arm cannot see this.
    // Only the peak can, and the drive read just the first card — so a
    // surface it could not vouch for reached the lender.
    it('FAILS on a duplicate that vanished before the card settled', () => {
      const v = forcedCloseVerdict({ ...base, visibleCardsPeak: 2 }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/during the readiness wait/);
    });

    it('FAILS on a transient duplicate even when the card is gone entirely', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          mounted: false,
          attached: false,
          text: null,
          bodyText: null,
          bodyPresent: undefined,
          visibleCards: 0,
          visibleCardsPeak: 2,
          seenTexts: [],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/now gone|during the readiness wait/);
    });

    // A record predating the field must not manufacture a finding — the
    // same `typeof` discipline every other added field here uses.
    it('says nothing about a record that carries no peak', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });

    // The settled-render sentence and the transient one must stay
    // distinguishable: an operator told "2 cards are visible" about a
    // page now showing one goes looking for something that is not there.
    it('names which situation it saw', () => {
      const now = forcedCloseVerdict({ ...base, visibleCards: 2, visibleCardsPeak: 2 }, copy);
      expect(now.why).toMatch(/are visible at once/);
      expect(now.why).not.toMatch(/during the readiness wait/);
    });
  });
});

describe('round 35 self-review: the currency test reaches past punctuation', () => {
  // Found by PROBING the `\p{Sc}` widening's edges rather than by
  // reading it, and it turned out the sign set was only half of why
  // `Loan 100 ₽` escaped. The other half was a two-character window, so
  // anything between the figure and its sign — a second space, a
  // bracket, a colon — put the sign out of reach, and the figure then
  // left through the IDENTIFIER exemption as a loan number.
  //
  // Round 11 fixed exactly this for TICKERS and named
  // `Loan 100: USDC principal` in its comment. The currency branch was
  // left on the old window; these are the same sentences with a sign.
  it('flags a figure whose sign is a space, a bracket or a colon away', () => {
    expect(monetaryAmountsIn('Loan 100  ₽')).toHaveLength(1);
    expect(monetaryAmountsIn('Loan 100  $')).toHaveLength(1);
    expect(monetaryAmountsIn('Loan 100 ($)')).toHaveLength(1);
    expect(monetaryAmountsIn('Loan 100: ₽')).toHaveLength(1);
  });

  it('reads a sign BEFORE the figure past the same separators', () => {
    expect(monetaryAmountsIn('₽ 100')).toHaveLength(1);
    expect(monetaryAmountsIn('(₽) 100')).toHaveLength(1);
  });

  // THE REASON THIS IS A SEPARATOR RUN AND NOT `hasTickerNear`'s CLAUSE
  // SCAN, pinned so nobody "unifies" the two later. `hugsCurrency`
  // short-circuits to a HIT above the duration check, so admitting a
  // sign anywhere in the clause would report the `3` here — a false FAIL
  // on the grace window the card is explicitly allowed to show, which is
  // the direction that gets a check switched off.
  it('does NOT let an unrelated sign later in the sentence cancel a duration', () => {
    expect(monetaryAmountsIn('Wait 3 days and fees are paid in $')).toEqual([]);
  });

  it('leaves every other exemption intact', () => {
    expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
    expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
    expect(monetaryAmountsIn('A 2% treasury share is deducted.')).toEqual([]);
    expect(monetaryAmountsIn('Settles within 5 blocks.')).toEqual([]);
    expect(monetaryAmountsIn('Loan 100 is overdue.')).toEqual([]);
  });
});

describe('round 36: the product and this drive agree on which states are submittable', () => {
  // WHY THIS EXISTS — it is the premise of a refutation, made into a
  // guard. Round 36 reported that a transiently-observed pairing of
  // WITHHELD copy with a VISIBLE ENABLED submit control is discarded by
  // the readiness poll, since only the texts are carried across ticks.
  //
  // That pairing is not producible. `ForcedCloseCard` derives the body
  // copy and the control from ONE `readiness` value in one render — the
  // copy from the `PRESENTATION` table, the control from
  // `canSubmitFromApp(readiness)` — and the drive reads both in a single
  // `page.evaluate` (round 9 P2), so it cannot see a torn pair either.
  // The control is not merely disabled on a withheld state; it is not
  // rendered at all.
  //
  // But that argument rests entirely on the two classifications agreeing
  // about the nine states, and they are maintained independently: one in
  // `src/data/forcedClose.ts`, the other in this drive's `withheldCopy`
  // / `readyCopy` lists. If they ever disagree the pairing becomes real,
  // and it would then be a live-run surprise rather than a test failure.
  // So the premise is asserted rather than believed.
  const READY = ['ready-in-kind', 'ready-internal-match', 'ready-rental'];
  const WITHHELD = [
    'unknown',
    'not-yet',
    'blocked-paused',
    'blocked-sequencer',
    'blocked-no-consent',
    'ready-needs-route',
  ];

  it('offers the control on exactly the states this drive calls ready', () => {
    for (const r of READY) {
      expect(canSubmitFromApp(r), `${r} should be submittable`).toBe(true);
    }
  });

  it('offers NO control on any state this drive calls withheld', () => {
    // `ready-needs-route` is the one worth naming: it is READY and
    // correctly unactionable — the spec's "offers no button it cannot
    // honour" — which is why it sits in `withheldCopy` rather than
    // `readyCopy`, and why it must not be submittable.
    for (const r of WITHHELD) {
      expect(canSubmitFromApp(r), `${r} must not be submittable`).toBe(false);
    }
  });

  it('covers every readiness state the card can be in', () => {
    // Not vacuous, and not drifting: the nine states here are the nine
    // in `recognisedCopy`. A tenth state added to the product without
    // being classified here would leave this suite quietly describing an
    // incomplete set.
    expect(new Set([...READY, ...WITHHELD]).size).toBe(9);
  });
});

describe('round 36 self-review: the peak is reported, not just consumed', () => {
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
    visibleCards: 1,
    visibleSubmits: 0,
    text: FORCED_CLOSE.unknown,
  };

  // `visibleCardsPeak` is added to the record by hand at three exits,
  // OUTSIDE the snapshot spread — the arrangement that silently lost
  // `visibleSubmits` twice. The spread cannot protect a value it does
  // not carry, so the remedy is round 27's: make the carriage visible in
  // the run output. That only works if the verdict forwards it.
  it('forwards the peak on a pass so the run can print it', () => {
    const v = forcedCloseVerdict({ ...base, visibleCardsPeak: 1 }, copy);
    expect(v.verdict).toBe('pass');
    expect(v.visibleCardsPeak).toBe(1);
  });

  // Absent must stay absent rather than being coerced to 0 — a confident
  // `peak=0` over a field that never arrived is exactly the silence this
  // is meant to break.
  it('passes absence through rather than reporting a confident zero', () => {
    const v = forcedCloseVerdict(base, copy);
    expect(v.verdict).toBe('pass');
    expect(v.visibleCardsPeak).toBeUndefined();
  });
});

describe('round 37 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };

  describe('a currency sign reached across a typographic separator', () => {
    it('flags a figure separated from its sign by a dash or a comma', () => {
      expect(monetaryAmountsIn('Loan 100 — ₽')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 100 – ₽')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 100, ₽')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 — $')).toHaveLength(1);
    });

    // WHY THIS IS SAFE, and why it is a deliberate asymmetry with
    // `hasTickerNear`, which treats these same characters as clause
    // BOUNDARIES. A ticker is a word and can appear in unrelated prose
    // after a dash (round 23 found exactly that). A currency sign is not
    // a word — it does not occur as a standalone token in a sentence —
    // so one sitting immediately after the figure belongs to it.
    //
    // The bound is that no WORD may intervene, and that is what stops
    // the comma reaching into a following clause.
    it('does not reach across a clause into unrelated prose', () => {
      expect(monetaryAmountsIn('Loan 100, fees are paid in ₽')).toEqual([]);
      expect(monetaryAmountsIn('Loan 100 — the borrower repays in $')).toEqual([]);
      expect(monetaryAmountsIn('Wait 3 days, fees are paid in $')).toEqual([]);
    });

    it('still leaves a sentence end alone', () => {
      expect(monetaryAmountsIn('Closing out Loan 21. Fees apply.')).toEqual([]);
    });
  });

  describe('the check-running / refusal contradiction is judged per render', () => {
    // The invariant is ABOUT the unresolved state, and it was reading
    // only the render the poll settled on — so a card that said both
    // things WHILE its checks ran and then reached clean copy had the
    // contradiction overwritten, and the arm could not fire on the one
    // moment it exists for.
    const base = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      visibleCards: 1,
      visibleCardsPeak: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyText: FORCED_CLOSE.readyInKind,
      text: FORCED_CLOSE.readyInKind,
      confirmText: null,
      confirmExpected: false,
    };

    it('FAILS on a contradiction that only a superseded render carried', () => {
      const v = forcedCloseVerdict(
        { ...base, seenTexts: [`${FORCED_CLOSE.unknown} This loan is not available for closing out.`] },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/check still running AND claims unavailability/);
    });

    // THE PAIRING MUST BE WITHIN ONE RENDER. A card that said "still
    // checking" and later said something unavailable is a card that
    // RESOLVED — pairing those across renders would manufacture a FAIL
    // out of an ordinary transition, which is the false-FAIL direction.
    it('does NOT pair a check-running render with a later unavailable one', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          seenTexts: [FORCED_CLOSE.unknown, 'This sale route is not available.'],
        },
        copy,
      );
      expect(v.verdict).not.toBe('fail');
    });

    it('still passes the shipped unresolved copy, whose refusal is negated', () => {
      const v = forcedCloseVerdict(
        { ...base, seenTexts: [FORCED_CLOSE.unknown] },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    it('still FAILS the settled-render contradiction it already caught', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          settled: false,
          text: `${FORCED_CLOSE.unknown} This loan is not available for closing out.`,
          bodyText: FORCED_CLOSE.unknown,
          seenTexts: [],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
    });
  });
});

describe('round 38 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };

  describe('an asset glyph is an amount, not an identifier', () => {
    // `Ξ` falls between the two tests that were supposed to catch it:
    // `isTicker` is ASCII-only and wants an internal uppercase run, and
    // `\p{Sc}` does not contain it — U+039E is a Greek capital LETTER.
    // With both false the identifier exemption fired, and an
    // ether-denominated figure is the commonest way an amount would
    // actually be written on this surface.
    it('flags a figure written with a token glyph after an identifier word', () => {
      expect(monetaryAmountsIn('Loan 100 Ξ')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 ◎')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 5 Ƀ')).toHaveLength(1);
      expect(monetaryAmountsIn('Token 9 (Ξ)')).toHaveLength(1);
    });

    // THE LIMIT OF THE RULE. The obvious generalisation — "any
    // non-ASCII character after a figure is a glyph" — is actively
    // harmful, so the list stays explicit.
    //
    // ⚠ THIS CASE PINS BEHAVIOUR THAT IS WRONG, deliberately. I wrote it
    // first as `toEqual([])` and it FAILED, which is how #2125 was
    // found: every exemption in this scanner tokenises with `[A-Za-z]`,
    // so a non-Latin duration cannot reach `NON_MONETARY_UNIT` at all
    // and falls through to the absolute bare-figure arm. A grace-window
    // sentence in ja/hi/ta/ko/zh is therefore reported as an invented
    // amount — the false-FAIL direction, on copy the spec explicitly
    // permits.
    //
    // It is LATENT: the all-locale calibration passes because no shipped
    // string currently writes a figure that way. That is luck, not a
    // guard.
    //
    // Pinned as-is rather than deleted or written as a wish. A test
    // asserting the wish goes green the day someone "fixes" the symptom
    // by weakening the scanner; this one fails loudly when #2125 is
    // genuinely fixed, which is the prompt to come back and update it.
    it('reports a non-Latin duration as an amount — WRONG, tracked in #2125', () => {
      expect(monetaryAmountsIn('猶予期間は 3 日です。')).toHaveLength(1);
      expect(monetaryAmountsIn('3 दिन शेष हैं।')).toHaveLength(1);
      // The English equivalent, for contrast: the exemption reaches it.
      expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
    });

    // What the glyph rule itself must NOT do: a CJK unit character is
    // not an asset glyph. Asserted on the difference the rule actually
    // controls — the identifier exemption — rather than on the bare
    // figure, which #2125 catches for an unrelated reason.
    it('does not treat a CJK unit character as an asset glyph', () => {
      // `Loan 100 Ξ` is flagged BY THE GLYPH RULE. `Loan 100 日` is not
      // reachable by it; if the rule ever widened to "any non-ASCII",
      // both would be, and the second would be wrong.
      expect(monetaryAmountsIn('Loan 100 Ξ')).toHaveLength(1);
    });

    it('leaves the plain identifier alone', () => {
      expect(monetaryAmountsIn('Loan 100 is overdue.')).toEqual([]);
    });
  });

  describe('two readiness states in a superseded render', () => {
    const base = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      visibleCards: 1,
      visibleCardsPeak: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyText: FORCED_CLOSE.readyInKind,
      text: FORCED_CLOSE.readyInKind,
      confirmText: null,
      confirmExpected: false,
    };

    // The settled render is clean, so the arm added last round cannot
    // see this. The lender was still shown two different recovery
    // outcomes at once, and the drive had the render in hand.
    it('FAILS on a contradiction only a superseded render carried', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          seenTexts: [`${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.readyInternalMatch}`],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/readiness states at once/);
    });

    // TWO STATES ACROSS TWO RENDERS IS A CARD RESOLVING, not a
    // contradiction. Joining the renders would report every ordinary
    // transition as a defect.
    it('does NOT pair one state in one render with another in the next', () => {
      const v = forcedCloseVerdict(
        { ...base, seenTexts: [FORCED_CLOSE.unknown, FORCED_CLOSE.readyInKind] },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    // A render matching NOTHING is not a finding here: an early render
    // can legitimately be empty or carry copy this drive cannot name,
    // which is why the unrecognised-copy arm applies to the settled
    // render alone.
    it('says nothing about a superseded render it does not recognise', () => {
      const v = forcedCloseVerdict({ ...base, seenTexts: ['', 'Loading…'] }, copy);
      expect(v.verdict).toBe('pass');
    });
  });
});

describe('round 39 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };
  const held = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitDisabled: true,
    saleLocked: false,
    settled: true,
    bodyText: 'an explanation',
    bodyPresent: true,
    confirmText: null,
    text: FORCED_CLOSE.unknown,
    visibleCards: 1,
    visibleCardsPeak: 1,
    visibleSubmits: 0,
  };

  // ---- observed vs inferred -----------------------------------------
  //
  // The run ranks forced-close FAILs ahead of the route / WebSocket /
  // wrong-chain gates so a funds defect that was READ cannot be
  // downgraded to "nothing was learned". An ABSENCE must NOT get that
  // treatment: a transport failure or a page served by the wrong chain
  // removes the card while the product is blameless, and the observer's
  // own chain still reports the position eligible. Round 38 wrote that
  // distinction into a comment and then filtered on the bare verdict.
  describe('every failure says whether it was read or inferred', () => {
    it('tags a positively observed content defect as observed', () => {
      const v = forcedCloseVerdict(
        { ...held, text: `${FORCED_CLOSE.unknown} You will receive 1.5 WETH.` },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    it('tags an absent card as inferred', () => {
      const v = forcedCloseVerdict({ ...held, mounted: false, attached: false, text: null }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('inferred');
    });

    it('tags a present-but-invisible card as inferred too', () => {
      // Conservative on purpose: the nodes are there and none is
      // painted, which a stylesheet that failed to fetch produces just
      // as readily as a CSS regression. The cost is a real finding
      // reported one gate later, against a false accusation.
      const v = forcedCloseVerdict({ ...held, mounted: false, attached: true, text: null }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('inferred');
    });

    it('leaves every fail arm tagged — none inherits a default', () => {
      // A fail added later must STATE which kind it is. Asserted against
      // the source so an untagged arm fails here rather than silently
      // taking whichever default was in place.
      const src = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'forcedCloseCard.mjs'),
        'utf8',
      );
      const fails = src.split("verdict: 'fail',").length - 1;
      const tagged = src.split('failKind:').length - 1;
      expect(fails).toBeGreaterThan(10);
      expect(tagged).toBe(fails);
    });
  });

  // ---- the duplicate control, one level down from the card ----------
  describe('a duplicate submit control counted on any tick', () => {
    const ready = {
      ...held,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      text: FORCED_CLOSE.readyInKind,
      bodyText: FORCED_CLOSE.readyInKind,
      confirmExpected: false,
    };

    it('PASSES when only one control was ever seen', () => {
      const v = forcedCloseVerdict({ ...ready, visibleSubmitsPeak: 1 }, copy);
      expect(v.verdict).toBe('pass');
    });

    it('FAILS on a duplicate that vanished before the card settled', () => {
      const v = forcedCloseVerdict({ ...ready, visibleSubmitsPeak: 2 }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/during the readiness wait/);
    });

    it('says nothing about a record carrying no submit peak', () => {
      expect(forcedCloseVerdict(ready, copy).verdict).toBe('pass');
    });
  });
});

describe('round 40 review findings', () => {
  const copy = { unknownCopy: FORCED_CLOSE.unknown };

  // The submit peak got its mounted arm in round 39 and not its
  // unmounted twin, though the CARD peak has had one since round 35 —
  // the fourth time in this PR a fix landed on one of two parallel
  // sites. The consequence is the one that ordering exists to prevent:
  // both poll exits carry the peak and set `mounted: false`, so the
  // check was skipped, and an accepted sale found by the pinned snapshot
  // then returned `inapplicable`.
  describe('a duplicate control seen before the card vanished', () => {
    const gone = {
      lenderHoldsActive: true,
      mounted: false,
      attached: false,
      saleLocked: false,
      settled: false,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      confirmText: null,
      confirmExpected: false,
      seenTexts: [],
      visibleCards: 0,
      visibleCardsPeak: 1,
    };

    it('FAILS even though the card is gone', () => {
      const v = forcedCloseVerdict({ ...gone, visibleSubmitsPeak: 2 }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    // The case that makes it a P2 rather than a tidy-up: eligibility
    // qualifying an ABSENCE is correct, eligibility suppressing a
    // POSITIVE observation is not.
    it('FAILS even when an accepted sale explains the disappearance', () => {
      const v = forcedCloseVerdict({ ...gone, visibleSubmitsPeak: 2, saleLocked: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/offered the same fee-paying action twice/);
    });

    it('still reports an ordinary explained disappearance as inapplicable', () => {
      const v = forcedCloseVerdict({ ...gone, visibleSubmitsPeak: 1, saleLocked: true }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });
});

describe('round 41 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLead: FORCED_CLOSE.receipt.youReceive,
  };

  const gone = {
    lenderHoldsActive: true,
    mounted: false,
    attached: false,
    saleLocked: false,
    settled: false,
    text: null,
    bodyText: null,
    bodyPresent: undefined,
    confirmText: null,
    confirmExpected: false,
    seenTexts: [],
    visibleCards: 0,
    visibleCardsPeak: 1,
    visibleSubmitsPeak: 1,
  };

  // A scrape that THREW is not a card that is gone. The drive returned
  // the same `null` for both, so a helper error or a destroyed execution
  // context was judged as a vanished card — accusing an eligible product
  // of omitting the surface, or being explained away by an accepted
  // sale. Neither describes the page; nothing was observed.
  describe('a DOM pass that could not run', () => {
    it('is INCOMPLETE, not a missing card', () => {
      const v = forcedCloseVerdict({ ...gone, mounted: true, attached: true, scrapeFailed: true }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/could not be completed/);
    });

    it('is not explained away by an accepted sale either', () => {
      const v = forcedCloseVerdict(
        { ...gone, mounted: true, attached: true, scrapeFailed: true, saleLocked: true },
        copy,
      );
      expect(v.blockedKind).toBe('incomplete');
    });

    it('leaves a genuine absence reported as an absence', () => {
      const v = forcedCloseVerdict(gone, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/absent/);
    });
  });

  // Both of these judge what a render SAID and both sat after the
  // applicability exits, so an accepted sale discarded a contradiction
  // the lender had been shown. Amounts and duplicate counts were moved
  // ahead of that exit in rounds 33 and 40; these were left behind.
  describe('captured contradictions clear applicability', () => {
    it('FAILS a captured refusal contradiction even under an accepted sale', () => {
      const v = forcedCloseVerdict(
        {
          ...gone,
          saleLocked: true,
          seenTexts: [`${FORCED_CLOSE.unknown} This loan is not available for closing out.`],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    it('FAILS a captured two-state render even under an accepted sale', () => {
      const v = forcedCloseVerdict(
        {
          ...gone,
          saleLocked: true,
          seenTexts: [`${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.readyInternalMatch}`],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    it('still reports an ordinary explained disappearance as inapplicable', () => {
      const v = forcedCloseVerdict({ ...gone, saleLocked: true }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });

  // The heading-without-a-reason state is what the absence rule exists
  // for, and `remember` kept the texts and the counts while dropping it.
  describe('a body seen present and hidden', () => {
    it('FAILS even after the card vanished under an accepted sale', () => {
      const v = forcedCloseVerdict({ ...gone, saleLocked: true, bodyHiddenSeen: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/present but not visible/);
    });

    it('says nothing on a record predating the field', () => {
      const v = forcedCloseVerdict({ ...gone, saleLocked: true }, copy);
      expect(v.verdict).toBe('blocked');
    });
  });

  // "No verdicts" means two different things: on a BORROWER run the card
  // is not observed at all, on a LENDER run the advertised assertion
  // never reached a position. The same `null` was returned for both, so
  // an unwired observation exited 0 announcing routes clean.
  describe('coverage distinguishes a borrower run from a disabled assertion', () => {
    it('reports nothing for a borrower run with no verdicts', () => {
      expect(forcedCloseCoverage([{ path: '/positions/1' }], 'borrower')).toBeNull();
    });

    it('FAILS coverage for a LENDER run with no verdicts at all', () => {
      const gap = forcedCloseCoverage([{ path: '/positions/1' }], 'lender');
      expect(gap).toMatch(/did not run at all/);
    });

    it('stays permissive when no role is supplied', () => {
      // An older caller that passes nothing must not start failing. The
      // live caller does pass it — pinned separately.
      expect(forcedCloseCoverage([{ path: '/positions/1' }])).toBeNull();
    });

    it('is unaffected when verdicts ARE present', () => {
      expect(
        forcedCloseCoverage(
          [{ path: '/positions/1', forcedCloseVerdict: { verdict: 'pass' } }],
          'lender',
        ),
      ).toBeNull();
    });
  });
});
