import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };
import { canSubmitFromApp } from '../../src/data/forcedClose.ts';

import {
  cardSettled,
  confirmationReady,
  declaredStateConsistent,
  forcedCloseCoverage,
  forcedCloseVerdict,
  monetaryAmountsIn,
  reconcileEligibility,
  saysCheckRunning,
} from './forcedCloseCard.mjs';

const FORCED_CLOSE = enBundle.copy.forcedClose;

// #2098 / #2131 — the card DECLARES its state and the block its facts came
// from, and the drive reads both instead of inferring the state from prose.
describe('cardSettled', () => {
  it('reads settlement off the declared state where the card declares one', () => {
    // Copy still says "checking" but the attribute says resolved: the
    // attribute is the source. (The verdict reports that disagreement
    // separately; this only decides when to stop reading.)
    expect(cardSettled({ declaredState: 'not-yet', text: FORCED_CLOSE.unknown }, FORCED_CLOSE.unknown)).toBe(true);
    expect(cardSettled({ declaredState: 'unknown', text: FORCED_CLOSE.readyInKind }, FORCED_CLOSE.unknown)).toBe(false);
  });

  it('falls back to the painted copy on a bundle that declares nothing', () => {
    expect(cardSettled({ declaredState: null, text: FORCED_CLOSE.unknown }, FORCED_CLOSE.unknown)).toBe(false);
    expect(cardSettled({ text: FORCED_CLOSE.readyInKind }, FORCED_CLOSE.unknown)).toBe(true);
    // Painted text outranks raw text in the fallback, as it does everywhere.
    expect(
      cardSettled({ text: FORCED_CLOSE.unknown, visibleText: FORCED_CLOSE.readyInKind }, FORCED_CLOSE.unknown),
    ).toBe(true);
  });

  it('treats an unrecognised declaration as a declaration, not as unsettled', () => {
    // A newer bundle naming a state this drive does not know has still
    // settled; what to make of the name is the verdict's question.
    expect(cardSettled({ declaredState: 'ready-something-new', text: '' }, FORCED_CLOSE.unknown)).toBe(true);
  });
});

describe('declaredStateConsistent', () => {
  it('requires not-yet to mean the chain said not defaultable', () => {
    expect(declaredStateConsistent('not-yet', { defaultable: false })).toEqual({ judged: true, consistent: true });
    const v = declaredStateConsistent('not-yet', { defaultable: true });
    expect(v.judged).toBe(true);
    expect(v.consistent).toBe(false);
    expect(v.why).toMatch(/isLoanDefaultable to be false/);
  });

  it('requires every ready state to mean defaultable, and reads the match where the order implies it', () => {
    for (const state of ['ready-in-kind', 'ready-needs-route', 'ready-rental', 'blocked-no-consent']) {
      expect(declaredStateConsistent(state, { defaultable: true, internalMatch: false }).consistent).toBe(true);
      expect(declaredStateConsistent(state, { defaultable: true, internalMatch: true }).consistent).toBe(false);
      expect(declaredStateConsistent(state, { defaultable: false, internalMatch: false }).consistent).toBe(false);
    }
    expect(declaredStateConsistent('ready-internal-match', { defaultable: true, internalMatch: true }).consistent).toBe(true);
    expect(declaredStateConsistent('ready-internal-match', { defaultable: true, internalMatch: false }).consistent).toBe(false);
  });

  it('expects nothing of the match for a state resolved before that question', () => {
    // `blocked-sequencer` is resolved between the two questions, so a
    // candidate either way is consistent with it, and an unread match is
    // not a reason to leave it unjudged.
    expect(declaredStateConsistent('blocked-sequencer', { defaultable: true, internalMatch: true })).toEqual({ judged: true, consistent: true });
    expect(declaredStateConsistent('blocked-sequencer', { defaultable: true })).toEqual({ judged: true, consistent: true });
  });

  it('expects nothing of either fact for states resolved before both', () => {
    for (const state of ['blocked-paused', 'unknown', 'not-applicable']) {
      expect(declaredStateConsistent(state, {})).toEqual({ judged: true, consistent: true });
      expect(declaredStateConsistent(state, { defaultable: false, internalMatch: true })).toEqual({ judged: true, consistent: true });
    }
  });

  it('is unjudged, never contradicted, when an implied fact could not be read', () => {
    const v = declaredStateConsistent('ready-in-kind', { defaultable: true, internalMatch: undefined });
    expect(v.judged).toBe(false);
    expect(v.why).toMatch(/hasInternalMatchCandidate could not be read/);
    expect(declaredStateConsistent('not-yet', {}).judged).toBe(false);
    expect(declaredStateConsistent('not-yet', undefined).judged).toBe(false);
  });

  it('is unjudged on a state it does not know', () => {
    const v = declaredStateConsistent('ready-something-new', { defaultable: true });
    expect(v.judged).toBe(false);
    expect(v.why).toMatch(/does not recognise/);
    expect(declaredStateConsistent(undefined, { defaultable: true }).judged).toBe(false);
  });

  it('stops at the first contradiction and names it', () => {
    const v = declaredStateConsistent('ready-in-kind', { defaultable: false, internalMatch: true });
    expect(v.why).toMatch(/isLoanDefaultable/);
  });
});

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

  // ROUND 116 P2 — GENERATED TEXT THE DRIVE COULD NOT RESOLVE LEAVES THE
  // NO-AMOUNT CLAIM UNESTABLISHED.
  //
  // The walk reads the QUOTED parts of `::before` / `::after`. A content
  // value mixing a dynamic component with a literal unit —
  // `counter(balance) " USDC"` — yielded `USDC` with the number dropped,
  // so the scan saw no digits and certified a card that visibly states an
  // amount. That is the same false PASS the pseudo-element collection was
  // added to close, reopened by reading half of what is painted.
  it('does not certify the no-amount claim when generated text was unresolvable', () => {
    const v = forcedCloseVerdict(
      { ...held, text: FORCED_CLOSE.unknown, generatedUnresolved: true },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    expect(v.why).toMatch(/generated text/);
  });

  it('still reports an amount it DID read, unresolved content notwithstanding', () => {
    // Scoped to the case where nothing else was found: a card already
    // stating an amount is reported as stating one, and the unresolved
    // part adds nothing to that.
    const v = forcedCloseVerdict(
      {
        ...held,
        text: `${FORCED_CLOSE.unknown} You will receive 1.5 WETH.`,
        generatedUnresolved: true,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/states an amount/);
  });

  it('leaves a record without the field behaving as it did', () => {
    // `undefined` means a shape predating the field, which must keep the
    // old behaviour rather than being read as evidence either way.
    expect(forcedCloseVerdict({ ...held, text: FORCED_CLOSE.unknown }, copy).verdict).toBe('pass');
  });

  // #2098 / #2131 — THE DECLARED STATE AND BLOCK.
  describe('declared state and block', () => {
    // The recognising copy shape the other suites use: with
    // `recognisedCopy` present the verdict requires the settled text to
    // match a known state, so the fixtures paint one and set the body to
    // the same sentence.
    const declaredCopy = {
      unknownCopy: FORCED_CLOSE.unknown,
      readyCopy: [FORCED_CLOSE.readyInKind],
      withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet],
      recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyInKind],
      receiptLead: FORCED_CLOSE.receipt.youReceive,
    };
    const painting = (sentence) => ({ ...held, text: sentence, bodyText: sentence });
    const notYet = painting(FORCED_CLOSE.notYet);
    const checking = { ...painting(FORCED_CLOSE.unknown), settled: false };

    it('stamps every verdict with the exact-block status, undeclared on an older bundle', () => {
      const v = forcedCloseVerdict(notYet, declaredCopy);
      expect(v.verdict).toBe('pass');
      expect(v.declaredFacts).toBe('undeclared');
      // `null` is what `getAttribute` returns for an absent attribute.
      expect(forcedCloseVerdict({ ...notYet, declaredState: null }, declaredCopy).declaredFacts).toBe('undeclared');
      expect(forcedCloseVerdict(null, declaredCopy).declaredFacts).toBe('undeclared');
    });

    it('FAILS a card declaring a resolved state while painting the still-checking sentence', () => {
      const v = forcedCloseVerdict(
        { ...painting(FORCED_CLOSE.unknown), declaredState: 'not-yet', declaredBlock: '100' },
        declaredCopy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/declares the resolved state "not-yet"/);
      expect(v.declaredFacts).toBe('contradicted');
    });

    it('FAILS a card declaring unknown while painting a resolved state', () => {
      const v = forcedCloseVerdict({ ...notYet, declaredState: 'unknown', settled: false }, declaredCopy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/declares its state unknown/);
    });

    it('does not fault a declared unknown that paints the checking sentence — that is the honest pair', () => {
      const v = forcedCloseVerdict({ ...checking, declaredState: 'unknown' }, declaredCopy);
      expect(v.verdict).not.toBe('fail');
      expect(v.declaredFacts).toMatch(/^unjudged/);
    });

    it('FAILS a declared state the chain contradicts at the block the card named', () => {
      const v = forcedCloseVerdict(
        {
          ...notYet,
          declaredState: 'not-yet',
          declaredBlock: '100',
          declaredChain: { defaultable: true, internalMatch: false },
        },
        declaredCopy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/requires isLoanDefaultable to be false/);
      expect(v.declaredFacts).toBe('contradicted');
    });

    it('reports consistent when the chain at the named block agrees, and keeps the ordinary verdict', () => {
      const v = forcedCloseVerdict(
        {
          ...notYet,
          declaredState: 'not-yet',
          declaredBlock: '100',
          declaredChain: { defaultable: false, internalMatch: false },
        },
        declaredCopy,
      );
      expect(v.verdict).toBe('pass');
      expect(v.declaredFacts).toBe('consistent');
    });

    it('reports WHY the comparison did not run, rather than a bare unjudged', () => {
      const ahead = forcedCloseVerdict(
        {
          ...notYet,
          declaredState: 'not-yet',
          declaredBlock: '999',
          declaredChainWhy: "the card names block 999, ahead of this observer's 900",
        },
        declaredCopy,
      );
      expect(ahead.verdict).toBe('pass');
      expect(ahead.declaredFacts).toBe("unjudged (the card names block 999, ahead of this observer's 900)");
      const declined = forcedCloseVerdict(
        {
          ...notYet,
          declaredState: 'not-yet',
          declaredBlock: '100',
          declaredChain: { defaultable: undefined, internalMatch: false },
        },
        declaredCopy,
      );
      expect(declined.verdict).toBe('pass');
      expect(declined.declaredFacts).toMatch(/^unjudged \(isLoanDefaultable could not be read/);
      const silent = forcedCloseVerdict({ ...notYet, declaredState: 'not-yet' }, declaredCopy);
      expect(silent.declaredFacts).toBe('unjudged (no reason recorded)');
    });

    it('a contradiction outranks a merely incomplete observation', () => {
      // Definite before uncertain — the module's own ordering rule. A
      // confirmation that never opened would otherwise report "incomplete"
      // over a card the chain has already contradicted.
      const v = forcedCloseVerdict(
        {
          ...painting(FORCED_CLOSE.readyInKind),
          declaredState: 'ready-in-kind',
          declaredBlock: '100',
          submitDisabled: false,
          confirmExpected: true,
          confirmText: null,
          declaredChain: { defaultable: false, internalMatch: false },
        },
        declaredCopy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.declaredFacts).toBe('contradicted');
    });
  });

  it('the drive reads settlement through the one shared helper at both of its sites', () => {
    // GUARD: the poll's two settlement sites were a pair that drifted more
    // than once. Both now go through `cardSettled`; a re-inlined copy read
    // at one of them would re-open the seam this test pins shut.
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'live-position-observe.mjs'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/\bcardSettled\(/g)?.length).toBe(2);
    expect(code.match(/\bsaysCheckRunning\(/g)).toBeNull();
    // And what the DOM pass reads is what the card publishes.
    expect(code).toMatch(/getAttribute\('data-forced-close-state'\)/);
    expect(code).toMatch(/getAttribute\('data-forced-close-block'\)/);
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

  // ROUND 93 P2 — a SUBORDINATOR opens a new clause too, and the
  // negation must not reach across it.
  //
  // `not complete because the protocol has refused this` has its `not`
  // governing "complete"; the refusal after `because` is affirmative, so
  // the card is showing two states at once. With no break recognised the
  // negation reached across and the contradiction was discarded, leaving
  // the weaker "merely incomplete" verdict on the surface that most needs
  // the stronger one.
  it('FAILS a refusal in a clause the negation does not govern', () => {
    const v = forcedCloseVerdict(
      {
        ...base,
        text: `${FORCED_CLOSE.unknown} The check is not complete because the protocol has refused this.`,
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/opposite claims/);
  });

  // The other direction, which is what keeps the list conservative: a
  // genuine negation with no clause break still governs, and the shipped
  // `unknown` string is exactly that shape.
  it('still does not fire when the negation really does govern', () => {
    const v = forcedCloseVerdict(
      { ...base, text: FORCED_CLOSE.unknown, bodyText: FORCED_CLOSE.unknown },
      copy,
    );
    expect(v.verdict).toBe('pass');
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

  // ROUND 114 P2 — BUT A SOUND CEILING STANDS IN FOR THE MISSING SIGHTING.
  //
  // A page can issue Diamond `eth_call`s without ever emitting a
  // block-number reply: the endpoints are identified from the call traffic,
  // so the ceiling can be asked of every one of them while the sighting
  // stays `0n`. The ceiling bounds every block the card could have rendered
  // from, which is the entire question — refusing there reports a bound as
  // unestablished on a run that established it.
  it('confirms on a sound ceiling even when no page head was ever seen', () => {
    expect(confirmationReady(20n, 10n, 0n, { sound: true, head: 20n })).toBe(true);
    // And the ceiling still has to be reached and the snapshot still passed.
    expect(confirmationReady(19n, 10n, 0n, { sound: true, head: 20n })).toBe(false);
    expect(confirmationReady(20n, 20n, 0n, { sound: true, head: 20n })).toBe(false);
    // An UNSOUND ceiling stands in for nothing — that is the case the
    // zero-sighting rule is still for.
    expect(confirmationReady(20n, 10n, 0n, { sound: false, head: 20n })).toBe(false);
    expect(confirmationReady(20n, 10n, 0n, { sound: true, head: 0n })).toBe(false);
    expect(confirmationReady(20n, 10n, 0n, undefined)).toBe(false);
  });

  it('is false rather than throwing on non-bigint input', () => {
    expect(confirmationReady(12, 10n, 11n)).toBe(false);
    expect(confirmationReady(12n, 10n, undefined)).toBe(false);
    expect(confirmationReady(null, null, null)).toBe(false);
  });

  // ROUND 102 P2 — AND THE ASKED CEILING IS PART OF THE BAR.
  //
  // `pageHead` is the head this drive OVERHEARD. Round 101 established it
  // does not bound an unpinned read the page issues afterwards and added a
  // ceiling asked after the scrape — which only the stability arm consumed.
  // So a card correctly absent because the position went terminal ABOVE the
  // overheard head was re-read below it and reported as a failure.
  describe('the asked ceiling raises the bar (round 102)', () => {
    const sound = (head) => ({ sound: true, head });

    it('requires the observer to clear the ceiling, not just the overheard head', () => {
      // Overheard 11, asked ceiling 20: passing 12 is no longer enough.
      expect(confirmationReady(12n, 10n, 11n, sound(20n))).toBe(false);
      expect(confirmationReady(21n, 10n, 11n, sound(20n))).toBe(true);
    });

    // ROUND 103 P2 — REACHING the asked ceiling is enough; the two bounds
    // are not compared the same way and round 102 collapsing them into one
    // `bar` erased the difference.
    //
    // `pageHead` is a SIGHTING: the page announced it and can read at or
    // beyond it, so clearing it needs strictly more. The asked ceiling is a
    // BOUND sampled after the scrape, so an observer that has read that
    // block has covered every block the card could have rendered from, and
    // demanding one more blocks a conclusive run for nothing.
    it('accepts an observer that REACHES the sound ceiling exactly', () => {
      expect(confirmationReady(20n, 10n, 11n, sound(20n))).toBe(true);
      // And the overheard head keeps its strict comparison: level is not
      // caught up, which is round 14's rule and is not what changed.
      expect(confirmationReady(11n, 10n, 11n, sound(5n))).toBe(false);
    });

    // ROUND 104 P2 — AND THAT INCLUDES WHEN THE CEILING EQUALS THE SIGHTING,
    // which is the COMMON case: the ceiling is sampled from the same
    // endpoints that produced the sighting, so the two agree whenever
    // nothing moved in between. Round 103 kept both tests unconditionally,
    // so an observer at 20 with both bounds at 20 was rejected and the run
    // waited for 21 before reporting the absence unconfirmed.
    //
    // The sighting is strict only because it does not say how far PAST it
    // the page went; a sound ceiling answers exactly that, so where it
    // covers the sighting it replaces it.
    it('accepts the ceiling when it EQUALS the overheard sighting', () => {
      expect(confirmationReady(20n, 19n, 20n, sound(20n))).toBe(true);
      // Still strictly past the pinned block — that test is about this
      // observer having moved at all, and is untouched.
      expect(confirmationReady(20n, 20n, 20n, sound(20n))).toBe(false);
    });

    it('keeps the sighting strict where the ceiling does NOT cover it', () => {
      // Should not arise — heads do not go backwards and the ceiling is
      // sampled later — but it is not worth assuming away.
      expect(confirmationReady(11n, 9n, 11n, sound(5n))).toBe(false);
      expect(confirmationReady(12n, 9n, 11n, sound(5n))).toBe(true);
    });

    it('keeps the overheard head as the bar when it is the higher of the two', () => {
      expect(confirmationReady(12n, 10n, 11n, sound(5n))).toBe(true);
      expect(confirmationReady(11n, 10n, 11n, sound(5n))).toBe(false);
    });

    it('treats an UNSOUND ceiling as not ready, never as a fallback', () => {
      // A ceiling that could not be established is not a reason to trust
      // the lower number that happens to be available.
      expect(confirmationReady(99n, 10n, 11n, { sound: false, head: 0n })).toBe(false);
      expect(confirmationReady(99n, 10n, 11n, { sound: true, head: 0n })).toBe(false);
    });

    // A GRID, BECAUSE HAND-PICKED CASES KEPT MISSING THE BOUNDARY.
    //
    // Round 102 added the ceiling and its cases never exercised
    // exactly-at-the-ceiling; round 103 changed that comparison and its
    // cases never exercised ceiling-equals-sighting. Both corrections would
    // have shipped unguarded, and both were caught only by reverting the fix
    // by hand and re-running. That is not a method that scales past the
    // person remembering to do it.
    //
    // So the rules are written out INDEPENDENTLY here, from the prose above
    // rather than from the implementation — the same discipline the
    // functional specs use, and the reason this can catch the code rather
    // than agree with it — and compared across every combination in a small
    // window around the interesting values.
    it('matches the stated rules across every nearby combination', () => {
      /** The specification, written from the prose, not from the code. */
      const expected = (observer, pinned, sighting, ceiling) => {
        if (typeof observer !== 'bigint' || typeof pinned !== 'bigint') return false;
        if (typeof sighting !== 'bigint') return false;
        // This observer must have moved past the block it scraped at.
        if (observer <= pinned) return false;
        // No ceiling: the sighting is all there is, so it must exist, and it
        // is a sighting, so strictly past it. An unobserved sighting with
        // nothing to stand in for it establishes nothing (round 114 moved
        // this test here from the top, where it also refused runs that HAD
        // a sound ceiling).
        if (ceiling === undefined) return sighting > 0n && observer > sighting;
        // An unestablished ceiling is not a reason to trust a lower number.
        if (!ceiling.sound || typeof ceiling.head !== 'bigint' || ceiling.head === 0n) return false;
        // A sound ceiling bounds everything the card could have read, so it
        // replaces the sighting WHERE IT COVERS IT. Where it does not, the
        // sighting keeps its strict test.
        if (ceiling.head < sighting && observer <= sighting) return false;
        return observer >= ceiling.head;
      };

      const vals = [0n, 9n, 10n, 11n, 12n];
      const ceilings = [
        undefined,
        { sound: false, head: 10n },
        { sound: true, head: 0n },
        ...vals.map((h) => ({ sound: true, head: h })),
      ];
      let compared = 0;
      for (const observer of vals) {
        for (const pinned of vals) {
          for (const sighting of vals) {
            for (const ceiling of ceilings) {
              compared += 1;
              expect(
                confirmationReady(observer, pinned, sighting, ceiling),
                `observer=${observer} pinned=${pinned} sighting=${sighting} ceiling=${JSON.stringify(
                  ceiling,
                  (_k, v) => (typeof v === 'bigint' ? String(v) : v),
                )}`,
              ).toBe(expected(observer, pinned, sighting, ceiling));
            }
          }
        }
      }
      // Guards the guard: a grid that silently shrank to nothing would pass.
      expect(compared, 'the grid actually ran').toBe(vals.length ** 3 * ceilings.length);
    });

    it('leaves a caller that passes no ceiling behaving as it did', () => {
      // `undefined` means a caller predating the field, which every rule in
      // this project treats as "keep the old behaviour".
      expect(confirmationReady(12n, 10n, 11n)).toBe(true);
      expect(confirmationReady(12n, 10n, 11n, undefined)).toBe(true);
    });
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
    // FIGURE CHANGED IN ROUND 46, and the reason is worth keeping. The
    // original control used `1.5`, which the integral-identifier rule
    // now catches on its own — so the joined form stopped being clean
    // and the case no longer demonstrated anything about the join.
    //
    // That is the control being IMPROVED rather than relaxed: `1.5` was
    // suppressed by two mechanisms and I only knew about one, so the
    // case was weaker than it read. An integral figure isolates the
    // join exactly.
    it('and the join really was what suppressed it', () => {
      expect(monetaryAmountsIn('15 will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Closing out Loan\n15 will be returned')).toEqual([]);
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

    // THE LIMIT, and it is a correction to my own first version of this
    // fix. Unscoped, the latch fires on ANY tick of a ~30s poll, so a
    // body invisible for one frame and then painted correctly would fail
    // a card that ends up entirely right. Round 10 set the opposite
    // convention for the control — a transient intermediate state is
    // legitimate and the FAIL must PERSIST — and a stricter rule for the
    // body than the control would be an inconsistency with no argument
    // behind it.
    //
    // The settled arm already covers a mounted card, so nothing is lost.
    it('does NOT fail a mounted card whose body ended up visible', () => {
      const v = forcedCloseVerdict(
        {
          ...gone,
          mounted: true,
          attached: true,
          text: FORCED_CLOSE.unknown,
          // Recognised copy, not a placeholder: the unrecognised-copy
          // arm returns BLOCKED, which is neither the pass this case is
          // about nor the fail it is guarding against. My first fixture
          // used a placeholder and reported blocked — the assertion was
          // wrong, not the code.
          bodyText: FORCED_CLOSE.unknown,
          bodyPresent: true,
          bodyVisible: true,
          settled: true,
          submitDisabled: true,
          bodyHiddenSeen: true,
        },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    it('still fails a mounted card whose SETTLED body is hidden', () => {
      const v = forcedCloseVerdict(
        {
          ...gone,
          mounted: true,
          attached: true,
          text: FORCED_CLOSE.unknown,
          bodyText: FORCED_CLOSE.unknown,
          bodyPresent: true,
          bodyVisible: false,
          settled: true,
          submitDisabled: true,
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/not visible/);
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

    // FIXTURE GAINED `confirmScanned` IN ROUND 52, and the reason is the
    // rule rather than the case. A pass that does not say it scanned the
    // confirmation no longer proves coverage of it — absent is treated
    // as NOT scanned, deliberately, because a coverage gate must not
    // claim a surface it cannot show was observed. This case is about
    // the round-41 no-verdicts rule, so it now carries a verdict that
    // is complete in the way the round-41 rule assumes.
    it('is unaffected when verdicts ARE present', () => {
      expect(
        forcedCloseCoverage(
          [
            {
              path: '/positions/1',
              forcedCloseVerdict: { verdict: 'pass', confirmScanned: true },
            },
          ],
          'lender',
        ),
      ).toBeNull();
    });

    // ROUND 52 P2 — AN APPLICABLE VISIT IS NOT A SCANNED CONFIRMATION.
    //
    // A chain state where every eligible position renders a clean
    // non-submittable card produces `pass` on each and used to exit 0,
    // with the whole pre-sign receipt and its fee-paying control never
    // opened. "Routes clean" over a funds-facing surface nobody looked
    // at.
    it('reports a gap when no applicable visit opened the confirmation', () => {
      const gap = forcedCloseCoverage(
        [
          { path: '/positions/1', forcedCloseVerdict: { verdict: 'pass', confirmScanned: false } },
          { path: '/positions/2', forcedCloseVerdict: { verdict: 'pass', confirmScanned: false } },
        ],
        'lender',
      );
      expect(gap).toMatch(/confirmation was never opened/);
      expect(gap).toMatch(/2 applicable position/);
    });

    it('is satisfied by ONE scanned confirmation among many', () => {
      expect(
        forcedCloseCoverage(
          [
            { path: '/positions/1', forcedCloseVerdict: { verdict: 'pass', confirmScanned: false } },
            { path: '/positions/2', forcedCloseVerdict: { verdict: 'pass', confirmScanned: true } },
          ],
          'lender',
        ),
      ).toBeNull();
    });

    // A borrower run never advertises this surface, and an unknown role
    // stays permissive — the same leniency the rule above it carries,
    // for the same reason.
    it('does not ask a borrower run to scan a confirmation', () => {
      expect(
        forcedCloseCoverage(
          [{ path: '/positions/1', forcedCloseVerdict: { verdict: 'pass', confirmScanned: false } }],
          'borrower',
        ),
      ).toBeNull();
    });

    it('stays permissive about the scan when no role is supplied', () => {
      expect(
        forcedCloseCoverage([
          { path: '/positions/1', forcedCloseVerdict: { verdict: 'pass', confirmScanned: false } },
        ]),
      ).toBeNull();
    });
  });
});

describe('rounds 42–43 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  // I placed the scrape-failed arm FIRST when I added it, reasoning that
  // every arm below reasons from an observation. True of an INITIAL
  // failure, false of a mid-poll one: the loop's exit deliberately
  // carries the texts, both peaks and the hidden-body latch, so evidence
  // already collected was discarded and a confirmed funds defect became
  // exit 2 — the very downgrade rounds 38–39 existed to prevent.
  describe('a scrape that failed AFTER something was seen', () => {
    const failed = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      scrapeFailed: true,
      saleLocked: false,
      settled: false,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      confirmText: null,
      confirmExpected: false,
      seenTexts: [],
      visibleCards: 0,
    };

    it('reports an amount it had already read', () => {
      const v = forcedCloseVerdict(
        { ...failed, seenTexts: ['You will receive 1.5 WETH.'] },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    it('reports a duplicate control it had already counted', () => {
      const v = forcedCloseVerdict({ ...failed, visibleSubmitsPeak: 2 }, copy);
      expect(v.verdict).toBe('fail');
    });

    it('reports a hidden body it had already seen', () => {
      const v = forcedCloseVerdict({ ...failed, bodyHiddenSeen: true }, copy);
      expect(v.verdict).toBe('fail');
    });

    it('is INCOMPLETE when nothing had been seen', () => {
      const v = forcedCloseVerdict(failed, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('is still not turned into a missing-card FAIL', () => {
      expect(forcedCloseVerdict(failed, copy).why).not.toMatch(/absent/);
    });
  });

  describe('a lower-case denomination is an amount, not an identifier', () => {
    it('flags the denominations `isTicker` cannot reach', () => {
      expect(monetaryAmountsIn('Loan 100 eth')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 wei')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 5 gwei')).toHaveLength(1);
      expect(monetaryAmountsIn('Token 9 btc')).toHaveLength(1);
    });

    // The reason the list is short. `isTicker`'s uppercase-run rule is
    // what separates a ticker from prose; lower case has no such shape,
    // so only membership distinguishes `eth` from `is`. Reaching further
    // starts matching ordinary words.
    // ROUND 85 P2 — AND NO LENGTH CAP ON THE SYMBOL.
    //
    // `isTicker` carried a twelve-character bound, which is a guess about
    // other people's tokens: ERC-20 places no limit on `symbol()`. It
    // failed in the expensive direction — with the symbol unrecognised the
    // identifier exemption read the figure as a loan NUMBER and the
    // scanner certified an unsubstantiated amount as clean.
    it('recognises a symbol longer than any cap', () => {
      expect(monetaryAmountsIn('Loan 100 LONGTOKENABCDE principal')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 SUPERLONGSYMBOL')).toHaveLength(1);
      // The discriminator that does the work is the uppercase RUN, which
      // is why removing the cap does not start matching prose: these long
      // words have none.
      expect(monetaryAmountsIn('Loan 100 outstanding today')).toEqual([]);
      expect(monetaryAmountsIn('Position 2 Settlement')).toEqual([]);
    });

    // ROUND 109 P2 — AND NO FLOOR ON IT EITHER.
    //
    // Round 85 removed the cap and kept `two characters minimum`, which is
    // the same guess about other people's tokens at the other end:
    // `symbol()` has no minimum length. `Loan 100 A principal` failed both
    // tests and produced the identical false PASS, in the commit that
    // argued the length was never the discriminator.
    it('recognises a symbol shorter than any floor', () => {
      expect(monetaryAmountsIn('Loan 100 A principal')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 X')).toHaveLength(1);
      // A lone capital is as far from prose as an uppercase run is, and
      // the rule reaches no further than that: lower-case single letters
      // are words in several shipped locales and stay exempt.
      expect(monetaryAmountsIn('Loan 100 a principal')).toEqual([]);
      expect(monetaryAmountsIn('Position 2 y')).toEqual([]);
    });

    // ROUND 115 P2 — AN UNAMBIGUOUS UNIT KEEPS ITS EXEMPTION.
    //
    // Rounds 3 and 11 taught the scanner to consult a widened lookahead
    // when a unit is AMBIGUOUS: `m` might be minutes or millions, so
    // `1m USDC` is money. `days`, `%` and `bps` are not ambiguous, and
    // letting a ticker anywhere in the clause cancel them turned correct
    // copy into a product FAIL — on the two exemptions most likely to
    // appear in real sentences.
    it('keeps a duration or proportion exempt when the asset is named later', () => {
      expect(monetaryAmountsIn('Wait 3 days before USDC returns')).toEqual([]);
      expect(monetaryAmountsIn('Fee: 2% of USDC principal')).toEqual([]);
      expect(monetaryAmountsIn('Settles within 5 blocks once WETH is sold')).toEqual([]);
      expect(monetaryAmountsIn('A 50 bps cut of the USDC interest')).toEqual([]);
      // The ambiguous unit still reads the lookahead, which is rounds 3
      // and 11 and must survive this.
      expect(monetaryAmountsIn('You receive 1m USDC')).toHaveLength(1);
      expect(monetaryAmountsIn('You receive 1m (USDC)')).toHaveLength(1);
    });

    // ROUND 116 P2 — AND NOT ONLY IN ASCII.
    //
    // `symbol()` is an arbitrary string. The full-width forms are what a
    // locale or a paste produces, and they matched no ticker, no currency
    // mark, no glyph and no lower-case unit — so the identifier exemption
    // read the figure as a loan NUMBER and the scan came back clean on a
    // visible amount. The third guess about other people's tokens in the
    // same function, after the upper and lower length bounds.
    it('recognises a symbol outside ASCII', () => {
      expect(monetaryAmountsIn('Loan 100 ＵＳＤＣ principal')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 Ｘ')).toHaveLength(1);
      // The uppercase RUN is still the discriminator, so scripts with no
      // case do not read as tickers and ordinary words in them stay
      // exempt — the property that keeps this off the shipped locales.
      expect(monetaryAmountsIn('Loan 100 について')).toEqual([]);
      expect(monetaryAmountsIn('Loan 100 مفتوح')).toEqual([]);
      expect(monetaryAmountsIn('Loan 100 खुला')).toEqual([]);
    });

    it('does not fire on ordinary prose after a figure', () => {
      expect(monetaryAmountsIn('Loan 100 is overdue.')).toEqual([]);
      expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
      expect(monetaryAmountsIn('Settles within 5 blocks.')).toEqual([]);
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
    });

    // THE BOUNDARY, and my first version of this fix broke it. I read
    // the unit from `trailing`, whose `\s*` crosses a newline, and
    // case-folded it — so `Loan 21\nUSDC is lent` matched `usdc` and
    // cancelled the exemption on an unrelated next line. Round 24's
    // existing case caught it immediately.
    //
    // The rule now: a WORD may not be attached across a line break,
    // because it may be ordinary prose there. A SYMBOL may, because it
    // is never prose — which is why the currency and glyph tests
    // deliberately do cross one.
    it('does not attach a denomination across a rendered line break', () => {
      expect(monetaryAmountsIn('Loan 21\neth is lent')).toEqual([]);
      expect(monetaryAmountsIn('Loan 21\nUSDC is lent')).toEqual([]);
      expect(monetaryAmountsIn('Wait 3 days\nUSDC later')).toEqual([]);
    });

    it('still reaches a denomination past punctuation on the same line', () => {
      expect(monetaryAmountsIn('Loan 100 (eth)')).toHaveLength(1);
    });
  });

  describe('the rental confirmation has its own receipt lead', () => {
    const shown = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      visibleCards: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyText: FORCED_CLOSE.readyRental,
      text: FORCED_CLOSE.readyRental,
      confirmExpected: true,
    };

    // `ForcedCloseCard` renders `rentalReceipt` on `ready-rental`, and
    // its `youReceive` is an entirely different sentence. Supplying only
    // the ordinary lead reported a correct rental confirmation as
    // incomplete — a FALSE coverage gap on the one route already
    // recorded as uncovered, where nobody would have questioned it.
    it('accepts a confirmation carrying the RENTAL lead', () => {
      const v = forcedCloseVerdict(
        { ...shown, confirmText: `${FORCED_CLOSE.rentalReceipt.youReceive} …` },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    // AMENDED IN ROUND 53, and the reason matters more than the case.
    //
    // This pinned the ORDINARY lead as a pass on a RENTAL observation,
    // which round 43 accepted deliberately — the record carried no
    // readiness field, so the lead could not be chosen by route. That
    // reasoning was true of the RECORD and not of the VERDICT: the
    // readiness copy is matched here, so the route is known, and
    // accepting either let a confirmation describe a different
    // transaction from the one it confirms.
    //
    // The LEAD check still accepts either — it establishes only that a
    // receipt rendered at all — and the route binding is enforced by the
    // row-set rule, which needs the six rows to judge. So this case
    // keeps its original shape and the route rule is pinned separately
    // below, where the rows are supplied.
    it('still accepts the ordinary lead as EVIDENCE A RECEIPT RENDERED', () => {
      const v = forcedCloseVerdict(
        { ...shown, confirmText: `${FORCED_CLOSE.receipt.youReceive} …` },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    it('still BLOCKS a confirmation shell carrying neither', () => {
      const v = forcedCloseVerdict({ ...shown, confirmText: 'Back' }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('accepts the singular `receiptLead` from an older record', () => {
      const v = forcedCloseVerdict(
        { ...shown, confirmText: `${FORCED_CLOSE.receipt.youReceive} …` },
        { ...copy, receiptLeads: undefined, receiptLead: FORCED_CLOSE.receipt.youReceive },
      );
      expect(v.verdict).toBe('pass');
    });
  });
});

describe('round 45 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  // The drive clicked the outer submit, waited for Back and scanned the
  // six rows — and never looked at the button that would actually send
  // the transaction. A confirm control missing, hidden, blank or
  // permanently disabled strands the lender one click short while the
  // run reports the ACTIONABLE route as covered.
  describe('the confirmation must offer its own action', () => {
    const opened = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      visibleCards: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyText: FORCED_CLOSE.readyInKind,
      text: FORCED_CLOSE.readyInKind,
      confirmExpected: true,
      confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
    };
    const usable = { present: true, visible: true, enabled: true, labelled: true };

    it('PASSES when the action is present, visible, labelled and enabled', () => {
      expect(forcedCloseVerdict({ ...opened, confirmAction: usable }, copy).verdict).toBe('pass');
    });

    for (const [field, why] of [
      ['present', /no confirmation action was rendered/],
      ['visible', /not visible/],
      ['enabled', /disabled/],
      ['labelled', /no label/],
    ]) {
      it(`FAILS when the action is not ${field}`, () => {
        const v = forcedCloseVerdict(
          { ...opened, confirmAction: { ...usable, [field]: false } },
          copy,
        );
        expect(v.verdict).toBe('fail');
        expect(v.failKind).toBe('observed');
        expect(v.why).toMatch(why);
      });
    }

    // Silence is not a finding: an older record predates the field, and
    // inventing one from absence is the failure mode this module guards
    // against everywhere else.
    it('says nothing when the record carries no confirmAction', () => {
      expect(forcedCloseVerdict(opened, copy).verdict).toBe('pass');
    });

    // FIXTURE CORRECTED IN ROUND 46. This asserted that a record with
    // `confirmText: null` says nothing about the action — which encoded
    // exactly the defect round 46 found: a broken button plus one
    // unreadable receipt row suppressed the finding entirely.
    //
    // The intent survives; the fixture was wrong for it. "The panel
    // never opened" is a record with NO `confirmAction` at all, because
    // the receipt pass runs only after the Back control was seen — so
    // carrying that field IS the evidence the confirmation rendered.
    it('says nothing when the confirmation never opened', () => {
      const v = forcedCloseVerdict({ ...opened, confirmText: null }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });
  });
});

describe('round 60 review findings', () => {
  describe('spelled-out denominations are amounts', () => {
    // `Loan 100 ether will be returned` walked through the identifier
    // exemption: the trailing word IS a denomination, but it was not a
    // ticker and not on the lower-case unit list, so nothing objected
    // and an ordinary monetary phrase read as a reference number.
    it('flags a spelled-out denomination after an identifier word', () => {
      expect(monetaryAmountsIn('Loan 100 ether will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Token 5 bitcoins')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 satoshis remain')).toHaveLength(1);
    });

    it('leaves a bare identifier alone', () => {
      expect(monetaryAmountsIn('Loan 21 will be returned')).toEqual([]);
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
    });

    // The other vocabularies are untouched — this is a third list, not a
    // replacement for them.
    it('leaves the duration and percent exemptions alone', () => {
      expect(monetaryAmountsIn('Wait 3-day grace period')).toEqual([]);
      expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
      expect(monetaryAmountsIn('A 2% treasury share is deducted.')).toEqual([]);
    });
  });
});

describe('round 59 review findings', () => {
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
  const LABELS = [
    enBundle.copy.receipt.youReceive,
    enBundle.copy.receipt.youLock,
    enBundle.copy.receipt.youMayOwe,
    enBundle.copy.receipt.youCanLose,
    enBundle.copy.receipt.fees,
    enBundle.copy.receipt.whenThisEnds,
  ];
  const paired = (values) => values.map((v, i) => `${LABELS[i]}\n${v}`);
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    receiptRowLabels: LABELS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };
  const gone = { ...base, lenderHoldsActive: false };
  const sold = { ...base, saleLocked: true };

  // Round 49's rule, applied to the three arms rounds 53/54 left below
  // the applicability exits. The lender was already shown these; a loan
  // terminating, transferring or gaining an accepted sale a moment
  // later does not unshow them.
  describe('structural faults survive a lifecycle change', () => {
    it('reports a blank outer submit on a position that has gone', () => {
      const v = forcedCloseVerdict({ ...gone, submitLabelled: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/no label at all/);
    });

    it('reports an unpainted submit label on a position that has sold', () => {
      const v = forcedCloseVerdict({ ...sold, submitLabelPainted: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/reads as blank/);
    });

    it('reports a duplicated receipt row on a position that has gone', () => {
      const rows = paired(ROWS.standard);
      rows[5] = rows[0];
      const v = forcedCloseVerdict({ ...gone, confirmRowsText: rows }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/distinct one/);
    });

    it('reports the WRONG ROUTE receipt on a position that has gone', () => {
      const v = forcedCloseVerdict(
        {
          ...gone,
          bodyText: FORCED_CLOSE.readyRental,
          text: FORCED_CLOSE.readyRental,
          confirmRowsText: paired(ROWS.standard),
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/rental route and its confirmation shows the collateral receipt/);
    });

    // …and the UNRECOGNISED case deliberately does NOT survive: it is a
    // gap in this drive's vocabulary, and an inapplicable position is a
    // perfectly good reason not to have judged it.
    it('does NOT report unrecognised rows on a position that has gone', () => {
      const v = forcedCloseVerdict(
        { ...gone, confirmRowsText: ['a', 'b', 'c', 'd', 'e', 'f'] },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });

    it('still reports unrecognised rows on a LIVE position', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmRowsText: ['a', 'b', 'c', 'd', 'e', 'f'] },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/could not identify as either receipt/);
    });

    // A clean reading on an inapplicable position is still refused
    // rather than banked — round 9's rule, unchanged by any of this.
    it('still refuses to bank a clean reading once the position has gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmRowsText: paired(ROWS.standard) }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });
});

describe('round 56 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };
  const ready = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };
  // A CORRECT withheld card, as the drive actually records one:
  // `ForcedCloseCard` renders no submit when `submittable` is false, so
  // the DOM pass sees an empty visible-submit set and `some` over it
  // yields `false` for both label fields.
  const withheld = {
    ...ready,
    text: FORCED_CLOSE.notYet,
    bodyText: FORCED_CLOSE.notYet,
    submitPresent: false,
    submitVisible: false,
    submitDisabled: true,
    visibleSubmits: 0,
    confirmExpected: false,
    confirmText: null,
    submitLabelled: false,
    submitLabelPainted: false,
  };

  describe('label faults need a control to be offered', () => {
    // THE WORST FALSE FAIL ON THIS PR, and it is mine: every ordinary
    // non-actionable position — `not-yet`, paused, sequencer-blocked,
    // `ready-needs-route` — would have exited as a product failure
    // claiming a blank action the card never rendered.
    //
    // The live run could not catch it: the one fixture loan IS
    // submittable, so the only shape the drive exercises end to end is
    // the only shape the bug could not reach.
    it('passes a correct withheld card that renders no submit', () => {
      expect(forcedCloseVerdict(withheld, copy).verdict).toBe('pass');
    });

    it('passes the other withheld states too', () => {
      for (const state of [
        FORCED_CLOSE.blockedPaused,
        FORCED_CLOSE.blockedSequencer,
        FORCED_CLOSE.readyNeedsRoute,
      ]) {
        expect(
          forcedCloseVerdict({ ...withheld, text: state, bodyText: state }, copy).verdict,
          state.slice(0, 40),
        ).toBe('pass');
      }
    });

    // …while the rule still bites where a control IS offered, so the
    // gate is about the offer and not a weakening of the check.
    it('still FAILS a blank control that IS offered', () => {
      const v = forcedCloseVerdict({ ...ready, submitLabelled: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/no label at all/);
    });

    it('still FAILS an unpainted label on an offered control', () => {
      const v = forcedCloseVerdict({ ...ready, submitLabelPainted: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/reads as blank/);
    });
  });

  describe('both bracket directions are ambiguous', () => {
    // Round 55 treated `false`-to-`true` as unpairable and left the
    // reverse falling through to a FAIL — so a protocol PAUSING between
    // the DOM observation and the pinned re-read accused a card whose
    // ready action was valid when it was observed.
    it('BLOCKS a permitting-to-refusing crossing rather than accusing', () => {
      const v = forcedCloseVerdict(
        { ...ready, defaultableBefore: true, defaultable: false },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/permitting this close-out to refusing it/);
    });

    it('still BLOCKS the refusing-to-permitting crossing', () => {
      const v = forcedCloseVerdict(
        { ...ready, defaultableBefore: false, defaultable: true },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.why).toMatch(/refusing this close-out to permitting it/);
    });

    // A window that was refusing THROUGHOUT is not ambiguous at all.
    it('still FAILS when both ends refuse', () => {
      const v = forcedCloseVerdict(
        { ...ready, defaultableBefore: false, defaultable: false },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/would be refused/);
    });

    // An older record carries no bracket, so the single reading still
    // decides — otherwise this fix would silently disable the round-54
    // check for every pre-bracket observation.
    it('still FAILS on a single refusing reading with no bracket', () => {
      const v = forcedCloseVerdict({ ...ready, defaultable: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/would be refused/);
    });
  });
});

describe('round 55 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };

  describe('the answer must bracket the render it validates', () => {
    // Round 54 read defaultability only AFTER the whole DOM
    // observation, which can run for thirty seconds. A deadline
    // crossing inside that window let a `true` read taken afterwards
    // validate a ready render the protocol would have refused.
    it('BLOCKS a deadline crossing inside the observation window', () => {
      const v = forcedCloseVerdict(
        { ...base, defaultableBefore: false, defaultable: true },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/while the card was being observed/);
    });

    it('passes a quiet window', () => {
      expect(
        forcedCloseVerdict({ ...base, defaultableBefore: true, defaultable: true }, copy).verdict,
      ).toBe('pass');
    });

    // The after-reading still FAILs on its own: a window that was never
    // permitted is not ambiguous.
    it('still FAILS when the protocol refuses at both ends', () => {
      const v = forcedCloseVerdict(
        { ...base, defaultableBefore: false, defaultable: false },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/would be refused/);
    });

    it('BLOCKS when the BEFORE reading could not answer', () => {
      const v = forcedCloseVerdict(
        { ...base, defaultableBefore: undefined, defaultable: true },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('says nothing for a record predating both fields', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });

    // A WITHHELD card is unaffected by any of it — the arms are gated on
    // the card actually offering the action.
    it('does not report a crossing on a withheld card', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          text: FORCED_CLOSE.notYet,
          bodyText: FORCED_CLOSE.notYet,
          submitDisabled: true,
          confirmExpected: false,
          confirmText: null,
          defaultableBefore: false,
          defaultable: true,
        },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });
  });
});

describe('round 54 review findings', () => {
  const LABELS = [
    enBundle.copy.receipt.youReceive,
    enBundle.copy.receipt.youLock,
    enBundle.copy.receipt.youMayOwe,
    enBundle.copy.receipt.youCanLose,
    enBundle.copy.receipt.fees,
    enBundle.copy.receipt.whenThisEnds,
  ];
  const VALUES = Object.values(FORCED_CLOSE.receipt);
  const paired = (values = VALUES, labels = LABELS) =>
    values.map((v, i) => `${labels[i]}\n${v}`);

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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: {
      standard: VALUES,
      rental: Object.values(FORCED_CLOSE.rentalReceipt),
    },
    receiptRowLabels: LABELS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };

  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };

  describe('each value under its own heading', () => {
    it('passes a correctly paired receipt', () => {
      expect(forcedCloseVerdict({ ...base, confirmRowsText: paired() }, copy).verdict).toBe('pass');
    });

    // The finding's own example: every value present, all six distinct,
    // and each one answering the wrong question. Nothing on the panel
    // is false, which is what makes it the most misleading shape it can
    // take.
    it('BLOCKS a receipt whose values sit under the wrong headings', () => {
      const swapped = [...VALUES];
      [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
      const v = forcedCloseVerdict({ ...base, confirmRowsText: paired(swapped) }, copy);
      expect(v.verdict).not.toBe('pass');
    });

    // Pairing is by index, so the order is enforced with it —
    // `ReviewReceipt` renders "six fixed rows, same order everywhere".
    it('BLOCKS a correctly paired receipt in the wrong ORDER', () => {
      const rows = paired();
      const reordered = [rows[1], rows[0], ...rows.slice(2)];
      expect(forcedCloseVerdict({ ...base, confirmRowsText: reordered }, copy).verdict).not.toBe(
        'pass',
      );
    });

    it('keeps the set-only behaviour for a caller with no labels', () => {
      const { receiptRowLabels, ...older } = copy;
      expect(forcedCloseVerdict({ ...base, confirmRowsText: VALUES }, older).verdict).toBe('pass');
    });
  });

  describe('the outer submit must be readable', () => {
    it('FAILS a blank outer submit', () => {
      const v = forcedCloseVerdict({ ...base, submitLabelled: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/no label at all/);
    });

    it('FAILS an outer submit whose label is not painted', () => {
      const v = forcedCloseVerdict({ ...base, submitLabelPainted: false }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/reads as blank/);
    });

    it('says nothing where neither field was recorded', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });

    it('passes a labelled, painted control', () => {
      expect(
        forcedCloseVerdict({ ...base, submitLabelled: true, submitLabelPainted: true }, copy)
          .verdict,
      ).toBe('pass');
    });
  });

  describe('a ready route the protocol would refuse', () => {
    // The pinned snapshot established Active status and ownership and
    // nothing about the grace deadline, so the readiness copy was
    // allowed to substantiate itself — certifying an action
    // `triggerDefault` is guaranteed to refuse after the lender pays for
    // it.
    it('FAILS ready copy with an enabled action on a non-defaultable loan', () => {
      const v = forcedCloseVerdict({ ...base, defaultable: false }, copy);
      expect(v.verdict).toBe('fail');
      // `inferred` SINCE ROUND 60, and the tag change is the fix rather
      // than a detail. This arm is a disagreement between two providers
      // — the page's endpoint and `OBSERVE_RPC` — and the most ordinary
      // cause of that is the deployment pointing at another chain.
      // `observed` bypasses the infrastructure gates by design (round
      // 38), so it made an operational wrong-chain state exit 1 as a
      // product regression before `pageChainWrong` could report it.
      expect(v.failKind).toBe('inferred');
      expect(v.why).toMatch(/would be refused/);
    });

    it('passes ready copy on a defaultable loan', () => {
      expect(forcedCloseVerdict({ ...base, defaultable: true }, copy).verdict).toBe('pass');
    });

    // A WITHHELD card on a non-defaultable loan is the correct render,
    // not a defect — that is the whole point of `not-yet`.
    it('does not fault a withheld card on a non-defaultable loan', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          text: FORCED_CLOSE.notYet,
          bodyText: FORCED_CLOSE.notYet,
          submitDisabled: true,
          defaultable: false,
          confirmExpected: false,
          confirmText: null,
        },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    // A drive that could not ask must not accuse — and must not pass
    // either, since a ready route offering the action is the strongest
    // claim it makes.
    it('BLOCKS where the defaultability read could not answer', () => {
      const v = forcedCloseVerdict({ ...base, defaultable: undefined }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/could not be simulated/);
    });

    it('says nothing for a record predating the field', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });
  });
});

describe('round 53 review findings', () => {
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };

  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };

  describe('six rows must be THE six', () => {
    it('passes the real collateral receipt', () => {
      expect(
        forcedCloseVerdict({ ...base, confirmRowsText: ROWS.standard }, copy).verdict,
      ).toBe('pass');
    });

    // The finding's own example: six copies of one row, with the fees
    // and loss disclosures gone. Every leaf non-blank, the lead present
    // six times over, and `rowsOk` satisfied.
    it('FAILS six copies of the same row', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmRowsText: Array(6).fill(FORCED_CLOSE.receipt.youReceive) },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/only 1 distinct/);
    });

    it('FAILS a partial duplication too', () => {
      const rows = [...ROWS.standard];
      rows[5] = rows[0];
      const v = forcedCloseVerdict({ ...base, confirmRowsText: rows }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/5 distinct/);
    });
  });

  describe('the receipt must describe the route being confirmed', () => {
    const rental = { ...base, bodyText: FORCED_CLOSE.readyRental, text: FORCED_CLOSE.readyRental };

    it('passes the rental receipt on a rental card', () => {
      expect(
        forcedCloseVerdict({ ...rental, confirmRowsText: ROWS.rental }, copy).verdict,
      ).toBe('pass');
    });

    // Recognised copy, wrong receipt: the drive knows exactly what it is
    // looking at, so this is a defect rather than a vocabulary gap.
    it('FAILS the collateral receipt on a rental card', () => {
      const v = forcedCloseVerdict({ ...rental, confirmRowsText: ROWS.standard }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/rental route and its confirmation shows the collateral receipt/);
    });

    it('FAILS the rental receipt on a collateral card', () => {
      const v = forcedCloseVerdict({ ...base, confirmRowsText: ROWS.rental }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/collateral route and its confirmation shows the rental receipt/);
    });

    // UNRECOGNISED copy is BLOCKED, not failed: this drive's copy comes
    // from the repo and the page's from the deployed bundle, so a
    // divergence is a gap in the drive's vocabulary as readily as a
    // defect. Round 11 settled that direction for the body copy.
    it('BLOCKS six rows matching neither receipt', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmRowsText: ['a', 'b', 'c', 'd', 'e', 'f'] },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/could not identify as either receipt/);
    });

    it('says nothing when the rows were not recorded', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });

    it('says nothing to a caller that supplies no row sets', () => {
      const { receiptRowSets, ...older } = copy;
      expect(
        forcedCloseVerdict({ ...base, confirmRowsText: Array(6).fill('x') }, older).verdict,
      ).toBe('pass');
    });
  });

  describe('the panel other visible text is scanned too', () => {
    // Round 50 kept the readable ROWS and still discarded a banner, a
    // gas note, or the confirm control's own label.
    it('FAILS an invented amount in the confirm action label', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, confirmRowsText: [], confirmOtherText: ['Confirm 100 USDC'] },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/states an amount it cannot know/);
    });

    it('leaves a clean panel alone', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, confirmRowsText: [], confirmOtherText: ['Confirm', 'Back'] },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });
  });

  describe('a compound duration is still a duration', () => {
    // `docs/FunctionalSpecs/Alpha02ConnectedApp.md` permits showing the
    // grace window, so flagging `3-day` made a correct deployed card
    // exit as a product FAIL.
    it('exempts a hyphenated grace window', () => {
      expect(monetaryAmountsIn('Wait 3-day grace period')).toEqual([]);
      expect(monetaryAmountsIn('Wait 3–day grace period')).toEqual([]);
      expect(monetaryAmountsIn('Loan 21-day term')).toEqual([]);
    });

    // The separator widened and nothing else did: a ticker across a
    // hyphen is still an amount.
    it('still flags an asset amount across the same separator', () => {
      expect(monetaryAmountsIn('You receive 100-USDC')).toHaveLength(1);
      expect(monetaryAmountsIn('Pays 250-ETH now')).toHaveLength(1);
    });
  });
});

describe('round 51 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };

  describe('an unsafe render outranks a lifecycle change', () => {
    // Round 50 taught this arm to read `seenRenders` and left it below
    // the applicability exits, so the evidence it had just learned to
    // preserve was still discarded the moment the loan terminated,
    // transferred or gained an accepted sale.
    //
    // It passes round 49's own test for what may be hoisted: the copy
    // and the control come from ONE atomic DOM pass, and the app renders
    // both from the same readiness value — so withheld copy beside an
    // enabled submit is internally inconsistent rather than a transition
    // artefact. The lender could have pressed it.
    const unsafe = [
      { text: FORCED_CLOSE.unknown, submitVisible: true, submitDisabled: false },
      { text: FORCED_CLOSE.readyInKind, submitVisible: true, submitDisabled: false },
    ];

    it('reports it on a position that has since gone', () => {
      const v = forcedCloseVerdict(
        { ...base, lenderHoldsActive: false, seenRenders: unsafe },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/NON-ACTIONABLE state yet offers an enabled action/);
    });

    it('reports it on a position that has since sold', () => {
      const v = forcedCloseVerdict({ ...base, saleLocked: true, seenRenders: unsafe }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    // The limit is unchanged: round 10's transiently DISABLED control is
    // still forgiven, and a clean reading on a position that has gone is
    // still refused rather than banked.
    it('still forgives a transiently disabled control after the position goes', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          lenderHoldsActive: false,
          seenRenders: [
            { text: FORCED_CLOSE.unknown, submitVisible: true, submitDisabled: true },
            { text: FORCED_CLOSE.readyInKind, submitVisible: true, submitDisabled: false },
          ],
        },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });

    it('still refuses to bank a clean reading once the position has gone', () => {
      const v = forcedCloseVerdict({ ...base, lenderHoldsActive: false }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });
});

describe('round 50 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };

  describe('a readable row is scanned even when another row is not', () => {
    // `confirmText` is the whole card's text and is set only when ALL
    // SIX rows rendered readably, so one missing row discarded the text
    // of the five on screen — and an invented amount stated in one of
    // THOSE was downgraded to `blocked/incomplete`.
    it('FAILS on an amount stated in a row that DID render', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, confirmRowsText: ['You receive', '1,250.00 USDC'] },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/states an amount it cannot know/);
    });

    // …while the receipt is still reported as incompletely covered when
    // nothing was invented. `rowsOk` keeps its one job.
    it('still reports the receipt as incomplete when the rows are clean', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, confirmRowsText: ['You receive', 'Fees'] },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    // Round 35's rule survives: rows are scanned SEPARATELY, so one row
    // cannot supply context for another's digits.
    it('does not let one row lend an identifier lead to the next', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, confirmRowsText: ['Loan', '1.5 will be returned'] },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/states an amount it cannot know/);
    });

    it('says nothing where the field was never recorded', () => {
      const v = forcedCloseVerdict({ ...base, confirmText: null }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });
  });

  describe('an unsafe render is judged even after the card settles', () => {
    // Round 10 forgives a transiently DISABLED control — an intermediate
    // state that costs the lender nothing. A transiently ENABLED one
    // beside copy saying the check is still running is the expensive
    // direction, and it was being discarded the moment the card settled.
    it('FAILS on withheld copy beside a live button on an EARLIER render', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          seenRenders: [
            { text: FORCED_CLOSE.unknown, submitVisible: true, submitDisabled: false },
            { text: FORCED_CLOSE.readyInKind, submitVisible: true, submitDisabled: false },
          ],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/NON-ACTIONABLE state yet offers an enabled action/);
    });

    // The round-10 exemption is intact: the same intermediate render
    // with the control DISABLED is a legitimate state and passes.
    it('forgives a transiently DISABLED control on the same copy', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          seenRenders: [
            { text: FORCED_CLOSE.unknown, submitVisible: true, submitDisabled: true },
            { text: FORCED_CLOSE.readyInKind, submitVisible: true, submitDisabled: false },
          ],
        },
        copy,
      );
      expect(v.verdict).toBe('pass');
    });

    it('still FAILS when the settled render itself is the unsafe one', () => {
      const v = forcedCloseVerdict({ ...base, text: FORCED_CLOSE.unknown, settled: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/NON-ACTIONABLE state yet offers an enabled action/);
    });

    it('says nothing where no earlier render was recorded', () => {
      expect(forcedCloseVerdict(base, copy).verdict).toBe('pass');
    });
  });

  describe('an outer submit that cannot be clicked', () => {
    // The drive's real click already failed when the control could not
    // take one, and that result was discarded: the verdict saw only
    // `confirmText === null` and filed the visit as an incomplete
    // READING rather than the defect that stranded the lender.
    it('FAILS rather than reporting an unread confirmation', () => {
      const v = forcedCloseVerdict(
        { ...base, confirmText: null, submitClickable: false },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/cannot receive a click/);
    });

    it('says nothing when the trial was never run', () => {
      const v = forcedCloseVerdict({ ...base, confirmText: null }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('PASSES a submit that can take a click', () => {
      expect(forcedCloseVerdict({ ...base, submitClickable: true }, copy).verdict).toBe('pass');
    });

    // Stays BELOW the applicability exits with the other pointer faults:
    // a transition overlay during a terminalising loan produces exactly
    // this, and reporting it afterwards would be a false FAIL from a race.
    it('does NOT report it once the position has gone', () => {
      const v = forcedCloseVerdict(
        { ...base, lenderHoldsActive: false, confirmText: null, submitClickable: false },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });
});

describe('round 49 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  const opened = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };
  const usable = { present: true, visible: true, enabled: true, labelled: true, count: 1, clickable: true, labelPainted: true };

  describe('a magnitude word after an identifier, spaced', () => {
    // Round 48 closed the JOINED form (`Loan 1k`) with a boundary test
    // and the spaced form beside it walked straight through: `after`
    // begins with whitespace, so the digits end cleanly, and `million`
    // is neither a ticker nor a lower-case asset unit.
    it('flags a spaced magnitude', () => {
      expect(monetaryAmountsIn('Loan 1 million will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2 billion becomes claimable')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 3 lakh now')).toHaveLength(1);
    });

    it('still exempts an identifier followed by ordinary prose', () => {
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
      expect(monetaryAmountsIn('Loan 21 will be returned')).toEqual([]);
      expect(monetaryAmountsIn('Position 4 is held.')).toEqual([]);
    });

    // Inherits `firstWordAfter`'s CLAUSE boundary, so a magnitude word
    // on the NEXT LINE is prose rather than a suffix — the same rule the
    // asset-unit test already follows, and the reason round 24 exists.
    it('does not reach across a line break for the magnitude word', () => {
      expect(monetaryAmountsIn('Loan 21\nmillion is unrelated prose')).toEqual([]);
    });
  });

  describe('structural confirm faults outrank an applicability change', () => {
    // The pinned chain re-read happens AFTER the DOM pass. A loan going
    // terminal, a token transferring or a sale being accepted in between
    // used to discard everything observed about the confirmation.
    const gone = { ...opened, lenderHoldsActive: false };
    const sold = { ...opened, saleLocked: true };

    it('reports a missing action on a position that has since gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmAction: { ...usable, present: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/no confirmation action was rendered/);
    });

    it('reports two actions on a position that has since sold', () => {
      const v = forcedCloseVerdict({ ...sold, confirmAction: { ...usable, count: 2 } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/2 actions beside Back/);
    });

    it('reports an unpainted label on a position that has since gone', () => {
      const v = forcedCloseVerdict(
        { ...gone, confirmAction: { ...usable, labelPainted: false } },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/reads as blank/);
    });

    it('reports an invisible action on a position that has since gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmAction: { ...usable, visible: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/is not visible/);
    });

    // THE DELIBERATE LIMIT, and the substance of the rule rather than an
    // omission. A disabled control, or one briefly covered by a
    // transition overlay, is exactly what a loan terminalising mid-
    // observation produces — reporting either as a product defect would
    // be a false FAIL invented out of a race.
    it('does NOT report a disabled action once the position has gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmAction: { ...usable, enabled: false } }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });

    it('does NOT report an unclickable action once the position has gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmAction: { ...usable, clickable: false } }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });

    // …and both still FAIL where nothing changed underneath, so the
    // limit above is about the race and not about the check.
    it('still reports a disabled action on a live position', () => {
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, enabled: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/is disabled/);
    });

    it('still reports an unclickable action on a live position', () => {
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, clickable: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/cannot receive a click/);
    });

    // A CLEAN reading is still refused on an inapplicable position —
    // round 9's rule, which this fix preserves rather than replaces.
    it('still refuses to BANK a clean reading once the position has gone', () => {
      const v = forcedCloseVerdict({ ...gone, confirmAction: usable }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('inapplicable');
    });
  });
});

describe('round 46 review findings', () => {
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
  };

  const opened = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.receipt.youReceive} …`,
  };
  const usable = { present: true, visible: true, enabled: true, labelled: true, count: 1, clickable: true };

  describe('an identifier is integral', () => {
    // Loan, position, offer and token ids are whole numbers. A
    // fractional value after one of those words is not naming a thing —
    // it is stating a quantity of one.
    it('flags a fractional value after an identifier word', () => {
      expect(monetaryAmountsIn('Loan 1.5 will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2.75 becomes claimable')).toHaveLength(1);
    });

    it('still exempts a whole-number identifier', () => {
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
      expect(monetaryAmountsIn('Position 4 is held.')).toEqual([]);
    });

    // ROUND 48 P2 — AND THE IDENTIFIER ENDS WHERE THE DIGITS END.
    //
    // `NUMBER` captures only the digit in `Loan 1k`, so `integral` was
    // true; `k` is neither a ticker nor one of the listed lower-case
    // units, so nothing objected and the exemption swallowed a compact
    // magnitude — an invented figure wearing the one costume the scan is
    // instructed to ignore.
    it('flags a compact magnitude after an identifier word', () => {
      expect(monetaryAmountsIn('Loan 1k will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Position 2m becomes claimable')).toHaveLength(1);
    });

    // Tested as a BOUNDARY rather than by enumerating suffixes.
    // Enumeration is the mistake this file has made three times, and
    // magnitude suffixes are open-ended across locales.
    it('flags any letter suffix, not a list of known ones', () => {
      expect(monetaryAmountsIn('Loan 3bn will be returned')).toHaveLength(1);
      expect(monetaryAmountsIn('Loan 4lakh will be returned')).toHaveLength(1);
    });

    it('still exempts an identifier that ends at punctuation or a space', () => {
      expect(monetaryAmountsIn('Closing out Loan 21 now.')).toEqual([]);
      expect(monetaryAmountsIn('Loan 21, closing')).toEqual([]);
      expect(monetaryAmountsIn('Loan #21 now')).toEqual([]);
      expect(monetaryAmountsIn('Loan 21')).toEqual([]);
    });

    it('leaves the other exemptions alone', () => {
      expect(monetaryAmountsIn('The grace period is 3 days.')).toEqual([]);
      expect(monetaryAmountsIn('A 2% treasury share is deducted.')).toEqual([]);
      expect(monetaryAmountsIn('Settles within 5 blocks.')).toEqual([]);
    });
  });

  describe('the confirmation action is judged on its own terms', () => {
    // `confirmText` is null whenever ANY receipt row fails its scan, so
    // a broken confirm button plus one bad row suppressed the action
    // finding and reported merely BLOCKED. An incomplete receipt is a
    // gap in what was READ; an unusable transaction button is a defect
    // that WAS read.
    it('FAILS a broken action even when the receipt did not read', () => {
      const v = forcedCloseVerdict(
        { ...opened, confirmText: null, confirmAction: { ...usable, enabled: false } },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/disabled/);
    });

    it('FAILS a second action beside Back', () => {
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, count: 2 } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/2 actions beside Back/);
    });

    // Visible, enabled and labelled are all true of a button covered by
    // another element or under `pointer-events: none`.
    it('FAILS an action that cannot receive a click', () => {
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, clickable: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/cannot receive a click/);
    });

    // ROUND 47 P2 — AN UNTESTED ACTION IS NOT A PASS, and the two
    // shapes of "no verdict" are no longer the same thing.
    //
    // `null` is THIS run declining to test the control (the re-read
    // label did not match the snapshot's), and letting that fall through
    // to `pass` meant a lender run could exit 0 having never established
    // the fee-paying action is usable. BLOCKED, not FAIL: nothing was
    // observed to be wrong, the observation is incomplete, and the
    // coverage gate already exits 2 on that.
    it('BLOCKS when this run declined to test the action', () => {
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, clickable: null } }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/went untested/);
    });

    // ABSENT still says nothing, and that is not the same leniency: it
    // means a record from before the field existed, and accusing one of
    // a gap it could not have filled would be inventing a finding from
    // silence. The drive writes the field unconditionally, so no current
    // observation reaches this arm — `driveConfirmTrial` pins that.
    it('says nothing where the field predates the trial entirely', () => {
      const { clickable, ...noTrial } = usable;
      expect(forcedCloseVerdict({ ...opened, confirmAction: noTrial }, copy).verdict).toBe('pass');
    });

    it('and an observed failure still outranks the untested case', () => {
      // Ordering, not just presence: `false` must reach its FAIL arm
      // rather than being swallowed by the blocked one beneath it.
      const v = forcedCloseVerdict({ ...opened, confirmAction: { ...usable, clickable: false } }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
    });

    it('PASSES a usable, single, clickable action', () => {
      expect(forcedCloseVerdict({ ...opened, confirmAction: usable }, copy).verdict).toBe('pass');
    });

    // SELF-REVIEW AFTER ROUND 46 — the pass REPORTS whether the trial
    // ran. `undefined` is a legitimate outcome (the re-read label did
    // not match the control the snapshot described) and is otherwise
    // indistinguishable from the check having quietly stopped running,
    // which is the failure this file keeps finding in its own guards.
    it('reports that the trial ran', () => {
      expect(forcedCloseVerdict({ ...opened, confirmAction: usable }, copy).confirmClickable).toBe(
        true,
      );
    });

    // ROUND 47 narrowed this: `null` is BLOCKED above, so the only
    // values that can reach a pass are `true` and the older-record
    // `undefined`. A pass printing `unrecorded` on a current run would
    // mean the drive's assignment had gone missing.
    it('reports an older record as unrecorded rather than implying a trial', () => {
      const { clickable, ...noTrial } = usable;
      expect(
        forcedCloseVerdict({ ...opened, confirmAction: noTrial }, copy).confirmClickable,
      ).toBeUndefined();
    });

    // SELF-REVIEW AFTER ROUND 46 — the LABEL must be painted, not merely
    // present in the markup. `labelled` reads `innerText`, which yields
    // every word whatever its colour, and the button's own visibility
    // check cannot cover it: `paintsText` exempts a node with no own
    // text, and a button wrapping its label in a span is that node.
    // Round 37 fixed this for the receipt's leaves and not for the
    // button beside them.
    it('FAILS an action whose label is not painted', () => {
      const v = forcedCloseVerdict(
        { ...opened, confirmAction: { ...usable, labelPainted: false } },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/reads as blank/);
    });

    it('says nothing where the field was never recorded', () => {
      const { labelPainted, ...older } = { ...usable, labelPainted: true };
      expect(forcedCloseVerdict({ ...opened, confirmAction: older }, copy).verdict).toBe('pass');
    });

    // The two are DIFFERENT defects and report differently: a button
    // with no label at all is blank markup; one with an unpainted label
    // is a control that is not there until it is hovered.
    it('distinguishes an unpainted label from a missing one', () => {
      const missing = forcedCloseVerdict(
        { ...opened, confirmAction: { ...usable, labelled: false } },
        copy,
      );
      const unpainted = forcedCloseVerdict(
        { ...opened, confirmAction: { ...usable, labelPainted: false } },
        copy,
      );
      expect(missing.why).toMatch(/has no label/);
      expect(unpainted.why).not.toMatch(/has no label/);
    });

    it('and says nothing at all where no action was recorded', () => {
      const { confirmAction, ...noField } = { ...opened, confirmAction: usable };
      expect(forcedCloseVerdict(noField, copy).confirmClickable).toBeUndefined();
    });
  });
});

describe('round 62 review findings', () => {
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
  const LABELS = [
    enBundle.copy.receipt.youReceive,
    enBundle.copy.receipt.youLock,
    enBundle.copy.receipt.youMayOwe,
    enBundle.copy.receipt.youCanLose,
    enBundle.copy.receipt.fees,
    enBundle.copy.receipt.whenThisEnds,
  ];
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    receiptRowLabels: LABELS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    bodyText: FORCED_CLOSE.readyRental,
    text: FORCED_CLOSE.readyRental,
    confirmExpected: true,
    confirmText: `${FORCED_CLOSE.rentalReceipt.youReceive} …`,
  };

  // THE STATE IS RECOGNISED FROM WHAT IS PAINTED.
  //
  // `bodyText` is raw `innerText` and keeps yielding a sentence that is
  // transparent, clipped or filter-erased. The rental route is the
  // cheapest observable proof that the SOURCE changed, because which
  // receipt row-set is expected turns on recognising one copy string.
  describe('state recognition reads the painted body', () => {
    it('prefers the painted text over the raw DOM text', () => {
      // Raw text says rental; painted text does not carry it. The rental
      // route must no longer be selected on the strength of a sentence
      // the lender cannot read.
      const v = forcedCloseVerdict(
        { ...base, bodyVisibleText: 'Something else entirely.' },
        copy,
      );
      // The standard row-set is expected now, and the rental confirm
      // panel does not satisfy it — the verdict must not be a clean pass
      // reached through the wrong route.
      expect(v.verdict).not.toBe('pass');
    });

    it('still passes when the painted text carries the recognised copy', () => {
      const v = forcedCloseVerdict(
        { ...base, bodyVisibleText: FORCED_CLOSE.readyRental },
        copy,
      );
      expect(v.verdict).toBe(forcedCloseVerdict(base, copy).verdict);
    });

    it('falls back for a record predating the field', () => {
      // `undefined` must keep meaning "this observation did not report
      // painted text", never "nothing was painted" — otherwise every
      // older fixture becomes a finding. This is the same tri-state
      // discipline `clickable` carries.
      const { bodyVisibleText, ...old } = { ...base, bodyVisibleText: undefined };
      expect(bodyVisibleText).toBeUndefined();
      expect(forcedCloseVerdict(old, copy)).toEqual(forcedCloseVerdict(base, copy));
    });

    it('reads the card’s painted text where there is no body', () => {
      // `saysCheckRunning` reads the CARD, and leaving that one site on
      // raw `innerText` would have closed one instance of this defect
      // and left its sibling open.
      const noBody = {
        ...base,
        bodyPresent: false,
        bodyText: null,
        bodyVisibleText: undefined,
        text: FORCED_CLOSE.unknown,
        visibleText: FORCED_CLOSE.unknown,
        submitPresent: false,
        submitVisible: false,
        visibleSubmits: 0,
        confirmExpected: false,
        confirmText: null,
      };
      const v = forcedCloseVerdict(noBody, copy);
      // Whatever the arm, it must be reached having READ the card — the
      // assertion that matters is that the painted text is consulted at
      // all, which the identical verdict for an absent `visibleText`
      // would not show.
      expect(v.verdict).toBe(
        forcedCloseVerdict({ ...noBody, visibleText: undefined }, copy).verdict,
      );
    });
  });
});

describe('round 63 review findings', () => {
  // VULGAR FRACTIONS ARE NUMBERS. `½`, `¼` and their siblings are
  // Unicode category `No`, not `Nd`, so `You receive ½ ETH` produced no
  // numeric run at all — the scanner returned clean on a card stating an
  // invented outcome in an entirely ordinary compact form. The worst way
  // for a guard on funds copy to be green: it looks exactly like
  // coverage.
  describe('an amount written as a fraction is still an amount', () => {
    it('reports a bare vulgar fraction with a ticker', () => {
      expect(monetaryAmountsIn('You receive ½ ETH')).not.toHaveLength(0);
      expect(monetaryAmountsIn('¼ WETH')).not.toHaveLength(0);
    });

    it('reads a mixed number as ONE run', () => {
      // Otherwise `1` is judged on its own and the glyph beside it is
      // never read — a number whose neighbour analysis is wrong is worse
      // than one that is missed, because it can exempt itself.
      const found = monetaryAmountsIn('1½ ETH');
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('1½');
    });

    it('does NOT treat a superscript footnote marker as a number', () => {
      // The reason the fractions are enumerated instead of taken as
      // `\p{No}` wholesale: that category also holds the superscript
      // digits, and `Fees¹` becoming a "number" would have its following
      // word judged — an invented finding on correct copy, which is the
      // failure that gets a check switched off.
      expect(monetaryAmountsIn('Fees¹ apply')).toHaveLength(0);
      expect(monetaryAmountsIn('See note² below')).toHaveLength(0);
    });

    it('leaves every existing exemption intact', () => {
      // The regression risk in widening a tokenizer is that the widened
      // matches take a different path through the exemptions. These are
      // the three the file has been caught on before.
      expect(monetaryAmountsIn('Loan 21 will be returned')).toHaveLength(0);
      expect(monetaryAmountsIn('Wait 3-day grace period')).toHaveLength(0);
      expect(monetaryAmountsIn('Rate 5% applies')).toHaveLength(0);
    });

    it('still reads an ordinary grouped decimal', () => {
      expect(monetaryAmountsIn('2,500.75 USDC')).toHaveLength(1);
    });
  });
});

describe('round 64 review findings', () => {
  // AN ACCUSATION MUST BE BUILT FROM WHAT THE LENDER CAN SEE.
  //
  // `parts` feeds three rules that all return `fail`: the amount scan,
  // the check-running-versus-refusal contradiction, and the two-states-
  // at-once scan. Built from raw `innerText`, a recognised sentence
  // erased in the DOM counted as something the lender was shown — so a
  // card displaying exactly ONE legitimate state was reported as having
  // shown two. A product failure assembled entirely from copy nobody can
  // read.
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
  };

  it('does not accuse a card of two states when one of them is erased', () => {
    // The raw text carries both sentences; only one is painted. The
    // lender saw one state.
    const both = `${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.notYet}`;
    const v = forcedCloseVerdict(
      {
        ...base,
        text: both,
        bodyText: both,
        visibleText: FORCED_CLOSE.readyInKind,
        bodyVisibleText: FORCED_CLOSE.readyInKind,
      },
      copy,
    );
    expect(v.verdict).not.toBe('fail');
  });

  it('still accuses when BOTH states are painted', () => {
    // The fix must not switch the rule off — this is the shape it exists
    // for, and it is the assertion that keeps the previous case from
    // passing for the wrong reason.
    const both = `${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.notYet}`;
    const v = forcedCloseVerdict(
      { ...base, text: both, bodyText: both, visibleText: both, bodyVisibleText: both },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/recognised readiness states at once/);
  });

  it('does not report an amount that is in the DOM but not painted', () => {
    // The deliberate widening beyond the finding. An erased figure is
    // not something the card is STATING to anyone, and leaving the most
    // consequential rule in the file able to invent a finding from
    // invisible copy would be the inconsistency the finding names.
    const v = forcedCloseVerdict(
      {
        ...base,
        text: `${FORCED_CLOSE.readyInKind} You receive 100 USDC`,
        bodyText: FORCED_CLOSE.readyInKind,
        visibleText: FORCED_CLOSE.readyInKind,
        bodyVisibleText: FORCED_CLOSE.readyInKind,
      },
      copy,
    );
    expect(v.verdict).not.toBe('fail');
  });

  it('still reports an amount that IS painted', () => {
    const shown = `${FORCED_CLOSE.readyInKind} You receive 100 USDC`;
    const v = forcedCloseVerdict(
      { ...base, text: shown, bodyText: shown, visibleText: shown, bodyVisibleText: shown },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/states an amount it cannot know/);
  });

  it('falls back to raw text for a record predating the fields', () => {
    // `undefined` must keep meaning "this observation did not report
    // painted text", never "nothing was painted" — otherwise every older
    // record stops being scanned at all, which would silently retire the
    // rules rather than refine them.
    const shown = `${FORCED_CLOSE.readyInKind} You receive 100 USDC`;
    const v = forcedCloseVerdict({ ...base, text: shown, bodyText: shown }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/states an amount it cannot know/);
  });

  it('judges the withheld-copy-beside-a-live-button gate on painted text', () => {
    // Same rule one level down: an erased withheld sentence must not
    // accuse a card that is, on screen, offering an action beside
    // perfectly good ready copy.
    const both = `${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.notYet}`;
    const v = forcedCloseVerdict(
      {
        ...base,
        text: both,
        bodyText: FORCED_CLOSE.readyInKind,
        visibleText: FORCED_CLOSE.readyInKind,
        bodyVisibleText: FORCED_CLOSE.readyInKind,
      },
      copy,
    );
    expect(v.why ?? '').not.toMatch(/NON-ACTIONABLE state yet offers an enabled action/);
  });
});

describe('round 64 P2 — the settlement route the card promises', () => {
  // `triggerDefault(loanId, [])` simulates cleanly on a defaultable loan
  // whether the contract dispatches an internal match or takes the
  // in-kind path, because the match is dispatched FIRST and succeeds. So
  // "the transaction would succeed" never said WHICH settlement the
  // lender is about to get — and the standard receipt deliberately
  // covers both outcomes, so its six rows could not catch it either.
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    defaultable: true,
    defaultableBefore: true,
  };
  const inKind = {
    ...base,
    text: FORCED_CLOSE.readyInKind,
    bodyText: FORCED_CLOSE.readyInKind,
    visibleText: FORCED_CLOSE.readyInKind,
    bodyVisibleText: FORCED_CLOSE.readyInKind,
  };
  const match = {
    ...base,
    text: FORCED_CLOSE.readyInternalMatch,
    bodyText: FORCED_CLOSE.readyInternalMatch,
    visibleText: FORCED_CLOSE.readyInternalMatch,
    bodyVisibleText: FORCED_CLOSE.readyInternalMatch,
  };

  it('reports a card promising collateral when a match would be dispatched', () => {
    const v = forcedCloseVerdict(
      { ...inKind, internalMatch: true, internalMatchBefore: true },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.failKind).toBe('inferred');
    expect(v.why).toMatch(/would dispatch that instead/);  // settled render, judged by the per-render rule since round 69
  });

  it('reports a card promising a match when the protocol holds none', () => {
    const v = forcedCloseVerdict(
      { ...match, internalMatch: false, internalMatchBefore: false },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.failKind).toBe('inferred');
    expect(v.why).toMatch(/held no match candidate throughout/);
  });

  it('passes each route when the protocol agrees with it', () => {
    expect(
      forcedCloseVerdict({ ...inKind, internalMatch: false, internalMatchBefore: false }, copy)
        .verdict,
    ).not.toBe('fail');
    expect(
      forcedCloseVerdict({ ...match, internalMatch: true, internalMatchBefore: true }, copy).verdict,
    ).not.toBe('fail');
  });

  it('is INFERRED, not observed, so the chain gate can go first', () => {
    // Same reasoning as the refusal arm: this is a disagreement between
    // the page and a protocol read, and its commonest cause is a
    // deployment pointed at another chain. `observed` bypasses the
    // infrastructure gates by design, so tagging it that way would exit
    // 1 on an operational misconfiguration.
    const v = forcedCloseVerdict(
      { ...inKind, internalMatch: true, internalMatchBefore: true },
      copy,
    );
    expect(v.failKind).toBe('inferred');
  });

  it('says INCOMPLETE when the route changed while the card was watched', () => {
    const v = forcedCloseVerdict(
      { ...inKind, internalMatch: true, internalMatchBefore: false },
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    expect(v.why).toMatch(/changed while the card was being observed/);
  });

  it('claims nothing when the route could not be read', () => {
    // `undefined` is a failure to determine, not an answer of `false`.
    // A view that declined to answer must never become a finding.
    expect(
      forcedCloseVerdict({ ...inKind, internalMatch: undefined, internalMatchBefore: undefined }, copy)
        .verdict,
    ).not.toBe('fail');
    expect(
      forcedCloseVerdict({ ...match, internalMatch: undefined, internalMatchBefore: true }, copy)
        .verdict,
    ).not.toBe('fail');
  });

  it('claims nothing about a card painting NEITHER of the two routes', () => {
    // The rental and needs-route states are different settlements and
    // not this rule's business; judging them here would name the wrong
    // defect.
    const rental = {
      ...base,
      text: FORCED_CLOSE.readyRental,
      bodyText: FORCED_CLOSE.readyRental,
      visibleText: FORCED_CLOSE.readyRental,
      bodyVisibleText: FORCED_CLOSE.readyRental,
    };
    expect(
      forcedCloseVerdict({ ...rental, internalMatch: true, internalMatchBefore: true }, copy)
        .verdict,
    ).not.toBe('fail');
  });

  it('judges the route from PAINTED copy, like everything else', () => {
    // An in-kind promise erased in the DOM beside a painted match
    // promise must not be accused: the lender read the match sentence.
    const both = `${FORCED_CLOSE.readyInKind} ${FORCED_CLOSE.readyInternalMatch}`;
    const v = forcedCloseVerdict(
      {
        ...base,
        text: both,
        bodyText: both,
        visibleText: FORCED_CLOSE.readyInternalMatch,
        bodyVisibleText: FORCED_CLOSE.readyInternalMatch,
        internalMatch: true,
        internalMatchBefore: true,
      },
      copy,
    );
    expect(v.verdict).not.toBe('fail');
  });

  // SELF-REVIEW — the THIRD arm of this family, brought to the same shape
  // as the two round-69/70 corrected its siblings to. It read the settled
  // snapshot, and it fired with no route promise painted at all.
  describe('the changed-route arm, on the same two counts', () => {
    it('reports a promise made on an earlier PRESSABLE render', () => {
      // The card promised in-kind while it could be acted on, then
      // withdrew the action. The route changed under it, so the promise
      // cannot be paired with a chain answer — and gating on the settled
      // snapshot skipped the whole history.
      const v = forcedCloseVerdict(
        {
          ...base,
          submitDisabled: true,
          text: FORCED_CLOSE.unknown,
          bodyText: FORCED_CLOSE.unknown,
          visibleText: FORCED_CLOSE.unknown,
          bodyVisibleText: FORCED_CLOSE.unknown,
          internalMatch: true,
          internalMatchBefore: false,
          seenRenders: [
            {
              text: FORCED_CLOSE.readyInKind,
              bodyText: FORCED_CLOSE.readyInKind,
              visibleText: FORCED_CLOSE.readyInKind,
              bodyVisibleText: FORCED_CLOSE.readyInKind,
              submitVisible: true,
              submitDisabled: false,
            },
          ],
        },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/changed while the card was being observed/);
    });

    it('does NOT block a card that painted neither route', () => {
      // Both siblings decline this case in so many words: a card making
      // no route promise is not making the claim the probe checks, and
      // blocking it reports a gap in coverage that was never there.
      const rental = {
        ...base,
        text: FORCED_CLOSE.readyRental,
        bodyText: FORCED_CLOSE.readyRental,
        visibleText: FORCED_CLOSE.readyRental,
        bodyVisibleText: FORCED_CLOSE.readyRental,
        internalMatch: true,
        internalMatchBefore: false,
      };
      expect(forcedCloseVerdict(rental, copy).why ?? '').not.toMatch(
        /changed while the card was being observed/,
      );
    });

    it('judges a render whatever its submit facts say', () => {
      // ROUND 72 P2 — the route arms no longer consult the render's own
      // control at all, so a record carrying neither submit field is
      // judged like any other. The silence reading that matters is now
      // the refusal arm's, and it is pinned there.
      const v = forcedCloseVerdict(
        {
          ...base,
          submitDisabled: true,
          text: FORCED_CLOSE.unknown,
          bodyText: FORCED_CLOSE.unknown,
          visibleText: FORCED_CLOSE.unknown,
          bodyVisibleText: FORCED_CLOSE.unknown,
          internalMatch: true,
          internalMatchBefore: true,
          seenRenders: [
            {
              text: FORCED_CLOSE.readyInKind,
              bodyText: FORCED_CLOSE.readyInKind,
              visibleText: FORCED_CLOSE.readyInKind,
              bodyVisibleText: FORCED_CLOSE.readyInKind,
            },
          ],
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/would dispatch that instead/);
    });

    it('still reports a promise on the settled render', () => {
      const v = forcedCloseVerdict(
        { ...inKind, internalMatch: false, internalMatchBefore: true },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.why).toMatch(/changed while the card was being observed/);
    });
  });
});

describe('round 65 review findings', () => {
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
    refusalStateCopy: [
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
    ],
  };
  const withheld = (sentence) => ({
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    text: sentence,
    bodyText: sentence,
    visibleText: sentence,
    bodyVisibleText: sentence,
  });

  // A CARD THAT WITHHOLDS AND BLAMES THE PROTOCOL. The ready-route arm
  // is one-way — `readyOffered` is false here, so it did nothing, and
  // the recognition arm then passed the card as correctly withheld. The
  // lender is denied a close-out the protocol accepts and given a reason
  // that is not the protocol's.
  describe('a refusal the protocol does not make', () => {
    for (const key of ['notYet', 'blockedPaused', 'blockedSequencer', 'blockedNoConsent']) {
      it(`reports "${key}" when the simulation says the call would succeed`, () => {
        const v = forcedCloseVerdict(
          { ...withheld(FORCED_CLOSE[key]), defaultable: true, defaultableBefore: true },
          copy,
        );
        expect(v.verdict).toBe('fail');
        expect(v.failKind).toBe('inferred');
        expect(v.why).toMatch(/denied a close-out the protocol accepts/);
      });
    }

    it('says nothing when the protocol agrees the call would fail', () => {
      const v = forcedCloseVerdict(
        { ...withheld(FORCED_CLOSE.notYet), defaultable: false, defaultableBefore: false },
        copy,
      );
      expect(v.verdict).not.toBe('fail');
    });

    it('says nothing when the window was not quiet', () => {
      const v = forcedCloseVerdict(
        { ...withheld(FORCED_CLOSE.notYet), defaultable: true, defaultableBefore: false },
        copy,
      );
      expect(v.verdict).not.toBe('fail');
    });

    it('does NOT judge copy that claims no protocol refusal', () => {
      // `unknown` asserts nothing and `readyNeedsRoute` is a claim about
      // the app's ability to route, not about the protocol's answer. A
      // close-out that simulates with empty calldata makes neither a
      // false statement, and accusing them would be the false-FAIL
      // direction.
      for (const sentence of [FORCED_CLOSE.unknown, FORCED_CLOSE.readyNeedsRoute]) {
        const v = forcedCloseVerdict(
          { ...withheld(sentence), defaultable: true, defaultableBefore: true },
          copy,
        );
        expect(v.why ?? '').not.toMatch(/denied a close-out the protocol accepts/);
      }
    });

    it('judges the claim from PAINTED copy', () => {
      // A refusal erased in the DOM was never made to the lender.
      const v = forcedCloseVerdict(
        {
          ...withheld(FORCED_CLOSE.notYet),
          visibleText: FORCED_CLOSE.unknown,
          bodyVisibleText: FORCED_CLOSE.unknown,
          defaultable: true,
          defaultableBefore: true,
        },
        copy,
      );
      expect(v.why ?? '').not.toMatch(/denied a close-out the protocol accepts/);
    });

    // ROUND 72 P2 — ON EVERY CAPTURED RENDER.
    describe('an earlier render that refused', () => {
      const ready = {
        ...withheld(FORCED_CLOSE.readyInKind),
        submitDisabled: false,
        defaultable: true,
        defaultableBefore: true,
      };

      it('reports a refusal stated before the card settled ready', () => {
        const v = forcedCloseVerdict(
          {
            ...ready,
            seenRenders: [
              {
                text: FORCED_CLOSE.blockedPaused,
                bodyText: FORCED_CLOSE.blockedPaused,
                visibleText: FORCED_CLOSE.blockedPaused,
                bodyVisibleText: FORCED_CLOSE.blockedPaused,
                submitVisible: true,
                submitDisabled: true,
              },
            ],
          },
          copy,
        );
        expect(v.verdict).toBe('fail');
        expect(v.failKind).toBe('inferred');
        expect(v.why).toMatch(/denied a close-out the protocol accepts/);
      });

      it('skips a render that OFFERED the action — that is not a refusal', () => {
        // Whatever it painted, a render exposing an enabled control is
        // not withholding. The unsafe-control arm judges that pairing.
        const v = forcedCloseVerdict(
          {
            ...ready,
            seenRenders: [
              {
                text: FORCED_CLOSE.blockedPaused,
                bodyText: FORCED_CLOSE.blockedPaused,
                visibleText: FORCED_CLOSE.blockedPaused,
                bodyVisibleText: FORCED_CLOSE.blockedPaused,
                submitVisible: true,
                submitDisabled: false,
              },
            ],
          },
          copy,
        );
        expect(v.why ?? '').not.toMatch(/denied a close-out the protocol accepts/);
      });

      it('reads a render carrying NEITHER submit fact as offered, so skips it', () => {
        // The documented silence reading, pinned where it now decides
        // something: `!== false` passes and `!undefined` passes.
        const v = forcedCloseVerdict(
          {
            ...ready,
            seenRenders: [
              {
                text: FORCED_CLOSE.blockedPaused,
                bodyText: FORCED_CLOSE.blockedPaused,
                visibleText: FORCED_CLOSE.blockedPaused,
                bodyVisibleText: FORCED_CLOSE.blockedPaused,
              },
            ],
          },
          copy,
        );
        expect(v.why ?? '').not.toMatch(/denied a close-out the protocol accepts/);
      });

      // ROUND 74 P2 — the three INCOMPLETE arms take the same sweep. My
      // round-73 reply said each was covered by a ready-side counterpart;
      // that holds only for a card which settles READY, and this is the
      // case it does not cover.
      it('reports the three bracket outcomes on an earlier render too', () => {
        const settledElsewhere = {
          ...withheld(FORCED_CLOSE.readyNeedsRoute),
          seenRenders: [
            {
              text: FORCED_CLOSE.blockedPaused,
              bodyText: FORCED_CLOSE.blockedPaused,
              visibleText: FORCED_CLOSE.blockedPaused,
              bodyVisibleText: FORCED_CLOSE.blockedPaused,
              submitVisible: true,
              submitDisabled: true,
            },
          ],
        };
        const at = (defaultable, defaultableBefore) =>
          forcedCloseVerdict({ ...settledElsewhere, defaultable, defaultableBefore }, copy);

        expect(at(false, false).why).toMatch(/establishes THAT and not WHY/);
        expect(at(undefined, undefined).why).toMatch(/could not simulate the close-out/);
        expect(at(true, false).why).toMatch(/from refusing this close-out to permitting it/);
        for (const v of [at(false, false), at(undefined, undefined), at(true, false)]) {
          expect(v.verdict).toBe('blocked');
          expect(v.blockedKind).toBe('incomplete');
        }
      });

      it('still requires both ends of the bracket', () => {
        for (const [a, b] of [
          [false, false],
          [true, false],
          [undefined, undefined],
        ]) {
          const v = forcedCloseVerdict(
            {
              ...ready,
              defaultable: a,
              defaultableBefore: b,
              seenRenders: [
                {
                  text: FORCED_CLOSE.blockedPaused,
                  bodyText: FORCED_CLOSE.blockedPaused,
                  visibleText: FORCED_CLOSE.blockedPaused,
                  bodyVisibleText: FORCED_CLOSE.blockedPaused,
                  submitVisible: true,
                  submitDisabled: true,
                },
              ],
            },
            copy,
          );
          expect(v.why ?? '').not.toMatch(/denied a close-out the protocol accepts/);
        }
      });
    });
  });

  // THE CANCEL CONTROL. A pre-signature panel whose Back button cannot be
  // activated leaves the lender no way out but to leave the page.
  describe('the confirmation’s Back control', () => {
    const base = {
      ...withheld(FORCED_CLOSE.readyInKind),
      submitDisabled: false,
      defaultable: true,
      defaultableBefore: true,
    };

    it('reports a Back control that cannot be activated', () => {
      const v = forcedCloseVerdict(
        { ...base, backAction: { present: true, clickable: false } },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/Back control the lender cannot activate/);
    });

    it('says nothing when it was trialled and works', () => {
      const v = forcedCloseVerdict(
        { ...base, backAction: { present: true, clickable: true } },
        copy,
      );
      expect(v.why ?? '').not.toMatch(/Back control/);
    });

    it('says nothing when the run did not establish it', () => {
      // `null` is "not tested" and `undefined` is "a record predating the
      // field". Neither is a defect, and collapsing either into one would
      // invent a finding out of a re-render.
      //
      // AMENDED IN ROUND 84, and the amendment is the finding. "Not a
      // defect" is right and was implemented as "not anything": `null`
      // fell through to `pass`, so a visit could report the confirmation
      // scanned while never having established that the lender can leave
      // a pre-signature panel. It is now an INCOMPLETE observation — the
      // same verdict `confirmAction.clickable === null` has carried since
      // round 47 — which is still not a defect, and no longer a pass.
      for (const backAction of [{ present: true, clickable: null }, undefined]) {
        const v = forcedCloseVerdict({ ...base, backAction }, copy);
        expect(v.verdict, 'an unestablished trial is never a FAIL').not.toBe('fail');
      }
      const untested = forcedCloseVerdict(
        { ...base, backAction: { present: true, clickable: null } },
        copy,
      );
      expect(untested.verdict).toBe('blocked');
      expect(untested.blockedKind).toBe('incomplete');
      // A record predating the field still says nothing at all — accusing
      // it of a gap it could not have filled is inventing a finding from
      // silence, which is the half of this case that has not changed.
      const legacy = forcedCloseVerdict({ ...base, backAction: undefined }, copy);
      expect(legacy.why ?? '').not.toMatch(/Back control/);
    });

    // ROUND 84 P2 — the sibling null, which the finding did not name and
    // which means the same thing one step earlier: the panel was gone
    // before Back could be counted, so whether there is a way out went
    // unread. It needs the panel evidence `present === false` needs,
    // since unlike `present === true` it proves nothing on its own.
    it('is equally incomplete when the panel went before Back was counted', () => {
      const v = forcedCloseVerdict(
        {
          ...base,
          backAction: { present: null, clickable: null },
          // A structurally sound confirm action, so the panel evidence is
          // positive and nothing above this arm fires first.
          confirmAction: {
            present: true,
            visible: true,
            labelled: true,
            painted: true,
            enabled: true,
            clickable: true,
            count: 1,
          },
        },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      // With no evidence the confirmation ever opened, THIS arm stays
      // silent. Asserted on the reason rather than on the verdict: such a
      // record is already incomplete for an unread confirmation, and a
      // blanket `not.toBe('blocked')` would pass or fail on that unrelated
      // arm instead of on this one.
      const noPanel = forcedCloseVerdict(
        { ...base, backAction: { present: null, clickable: null } },
        copy,
      );
      expect(noPanel.why ?? '').not.toMatch(/Back control/);
    });

    // ROUND 86 P2 — THE THIRD NULL, which round 84 left behind while
    // fixing its two siblings. `painted` is null when the evaluation could
    // not run — the control detached between its trial click and the paint
    // read, or the injected predicate threw — and Playwright's trial does
    // not consider opacity, which is the entire reason the paint question
    // is asked separately. A clickable-but-unread Back establishes nothing
    // about whether the lender can SEE the only way to decline.
    it('is equally incomplete when the paint read could not run', () => {
      const v = forcedCloseVerdict(
        { ...base, backAction: { present: true, clickable: true, painted: null } },
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      // And a trialled, painted control is still a pass — the arm must not
      // have swallowed the ordinary case.
      const ok = forcedCloseVerdict(
        { ...base, backAction: { present: true, clickable: true, painted: true } },
        copy,
      );
      expect(ok.why ?? '').not.toMatch(/Back control/);
    });
  });
});

describe('round 67 review findings', () => {
  const ROWS = {
    standard: Object.values(FORCED_CLOSE.receipt),
    rental: Object.values(FORCED_CLOSE.rentalReceipt),
  };
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    notYetCopy: FORCED_CLOSE.notYet,
    overdueTitleCopy: FORCED_CLOSE.title,
    pendingTitleCopy: FORCED_CLOSE.titlePending,
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
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: ROWS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
    refusalStateCopy: [
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
    ],
  };
  const card = (heading, body, extra = {}) => ({
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    text: `${heading} ${body}`,
    visibleText: `${heading} ${body}`,
    bodyText: body,
    bodyVisibleText: body,
    ...extra,
  });

  // THE HEADING AND THE BODY ARE TWO STATEMENTS ABOUT ONE DEADLINE.
  // `ForcedCloseCard` picks the heading on `view.overdue` alone, and
  // every other state check in the module reads the body — so a
  // regressed heading was never compared with anything.
  describe('the heading must not contradict the body', () => {
    it('reports "overdue" above a body saying the borrower still has time', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.notYet, {
          defaultable: false,
          defaultableBefore: false,
        }),
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/both on screen, disagreeing/);
    });

    it('reports a ready close-out under the approaching-deadline heading', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.titlePending, FORCED_CLOSE.readyInKind, {
          submitDisabled: false,
          defaultable: true,
          defaultableBefore: true,
        }),
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/both on screen, disagreeing/);
    });

    it('says nothing when heading and body agree', () => {
      for (const [heading, body] of [
        [FORCED_CLOSE.titlePending, FORCED_CLOSE.notYet],
        [FORCED_CLOSE.title, FORCED_CLOSE.readyInKind],
      ]) {
        const v = forcedCloseVerdict(
          card(heading, body, {
            submitDisabled: body === FORCED_CLOSE.readyInKind ? false : true,
            defaultable: body === FORCED_CLOSE.readyInKind,
            defaultableBefore: body === FORCED_CLOSE.readyInKind,
          }),
          copy,
        );
        expect(v.why ?? '').not.toMatch(/both on screen, disagreeing/);
      }
    });

    it('does NOT judge states that leave the deadline open', () => {
      // A paused protocol or an unreachable sequencer is perfectly
      // compatible with an overdue loan, and `unknown` settles nothing.
      // Reading either as a contradiction would accuse a card telling the
      // truth — the direction this file refuses.
      for (const body of [
        FORCED_CLOSE.blockedPaused,
        FORCED_CLOSE.blockedSequencer,
        FORCED_CLOSE.unknown,
      ]) {
        for (const heading of [FORCED_CLOSE.title, FORCED_CLOSE.titlePending]) {
          const v = forcedCloseVerdict(
            card(heading, body, { defaultable: false, defaultableBefore: false }),
            copy,
          );
          expect(v.why ?? '').not.toMatch(/both on screen, disagreeing/);
        }
      }
    });

    it('says nothing when the headings cannot be told apart', () => {
      const same = { ...copy, pendingTitleCopy: FORCED_CLOSE.title };
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.notYet, {
          defaultable: false,
          defaultableBefore: false,
        }),
        same,
      );
      expect(v.why ?? '').not.toMatch(/both on screen, disagreeing/);
    });
  });

  // A REVERT SAYS *THAT*, NOT *WHY*. The round-65 arm catches a refusal
  // the protocol does not make; it cannot catch the protocol refusing for
  // one reason while the card names another.
  describe('an unverified refusal reason', () => {
    it('reports INCOMPLETE, not a defect', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          defaultable: false,
          defaultableBefore: false,
        }),
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/establishes THAT and not WHY/);
    });

    it('does not fire when the protocol ACCEPTS — that is the round-65 arm', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          defaultable: true,
          defaultableBefore: true,
        }),
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/denied a close-out the protocol accepts/);
    });

    it('does not fire when the simulation could not be run', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          defaultable: undefined,
          defaultableBefore: undefined,
        }),
        copy,
      );
      expect(v.why ?? '').not.toMatch(/establishes THAT and not WHY/);
    });
  });

  // SELF-REVIEW — the withheld arms read as a MATRIX rather than one at
  // a time. `true`/`true`, either end `undefined` and `false`/`false` are
  // each covered; the two DISAGREEING combinations were not, and fell
  // through to a clean pass on a bracket that never settled.
  describe('a bracket that answered twice, differently', () => {
    it('reports INCOMPLETE when the protocol became permitting mid-observation', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          defaultable: true,
          defaultableBefore: false,
        }),
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/withholds the action and states a specific reason/);
      expect(v.why).toMatch(/from refusing this close-out to permitting it/);
    });

    it('reports INCOMPLETE in the reverse direction too', () => {
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          defaultable: false,
          defaultableBefore: true,
        }),
        copy,
      );
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/from permitting this close-out to refusing it/);
    });

    it('judges the claim from PAINTED copy', () => {
      // A refusal erased in the DOM was never made to the lender, so
      // there is nothing here that went unestablished.
      const v = forcedCloseVerdict(
        card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, {
          visibleText: `${FORCED_CLOSE.title} ${FORCED_CLOSE.unknown}`,
          bodyVisibleText: FORCED_CLOSE.unknown,
          defaultable: true,
          defaultableBefore: false,
        }),
        copy,
      );
      expect(v.why ?? '').not.toMatch(/withholds the action and states a specific reason/);
    });

    it('leaves the three settled brackets to their own arms', () => {
      const at = (defaultable, defaultableBefore) =>
        forcedCloseVerdict(
          card(FORCED_CLOSE.title, FORCED_CLOSE.blockedPaused, { defaultable, defaultableBefore }),
          copy,
        );
      expect(at(true, true).why).toMatch(/denied a close-out the protocol accepts/);
      expect(at(undefined, undefined).why).toMatch(/could not simulate the close-out/);
      expect(at(false, false).why).toMatch(/establishes THAT and not WHY/);
    });
  });
});

describe('the heading/body contradiction is judged on every render', () => {
  // SELF-REVIEW of the round-67 arm, checked proactively rather than
  // waiting for the next round to point at the parallel site — which is
  // this PR's single most frequent finding.
  //
  // A transient mismatch here IS a real one, and that is not the general
  // rule in this file: round 10 forgives a transiently disabled control,
  // because that is a legitimate intermediate state. This pair is
  // different. `ForcedCloseCard` derives the heading and the body from
  // ONE `view` in ONE render, so they cannot legitimately disagree even
  // for a frame.
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    notYetCopy: FORCED_CLOSE.notYet,
    overdueTitleCopy: FORCED_CLOSE.title,
    pendingTitleCopy: FORCED_CLOSE.titlePending,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyInKind],
  };
  const settled = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    defaultable: false,
    defaultableBefore: false,
    // The settled render is consistent — heading and body agree.
    text: `${FORCED_CLOSE.titlePending} ${FORCED_CLOSE.notYet}`,
    visibleText: `${FORCED_CLOSE.titlePending} ${FORCED_CLOSE.notYet}`,
    bodyText: FORCED_CLOSE.notYet,
    bodyVisibleText: FORCED_CLOSE.notYet,
  };

  it('reports a contradiction seen only in an EARLIER render', () => {
    const v = forcedCloseVerdict(
      {
        ...settled,
        seenRenders: [
          {
            text: `${FORCED_CLOSE.title} ${FORCED_CLOSE.notYet}`,
            visibleText: `${FORCED_CLOSE.title} ${FORCED_CLOSE.notYet}`,
            bodyText: FORCED_CLOSE.notYet,
            bodyVisibleText: FORCED_CLOSE.notYet,
            submitVisible: true,
            submitDisabled: true,
          },
        ],
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/both on screen, disagreeing/);
  });

  it('says nothing when every render agrees', () => {
    const v = forcedCloseVerdict(
      {
        ...settled,
        seenRenders: [
          {
            text: `${FORCED_CLOSE.titlePending} ${FORCED_CLOSE.unknown}`,
            visibleText: `${FORCED_CLOSE.titlePending} ${FORCED_CLOSE.unknown}`,
            bodyText: FORCED_CLOSE.unknown,
            bodyVisibleText: FORCED_CLOSE.unknown,
            submitVisible: true,
            submitDisabled: true,
          },
        ],
      },
      copy,
    );
    expect(v.why ?? '').not.toMatch(/both on screen, disagreeing/);
  });

  it('judges an earlier render on its PAINTED text', () => {
    // A heading erased in that render's DOM was never shown either.
    const v = forcedCloseVerdict(
      {
        ...settled,
        seenRenders: [
          {
            text: `${FORCED_CLOSE.title} ${FORCED_CLOSE.notYet}`,
            visibleText: FORCED_CLOSE.notYet,
            bodyText: FORCED_CLOSE.notYet,
            bodyVisibleText: FORCED_CLOSE.notYet,
            submitVisible: true,
            submitDisabled: true,
          },
        ],
      },
      copy,
    );
    expect(v.why ?? '').not.toMatch(/both on screen, disagreeing/);
  });
});

describe('round 68 — the heading contradiction survives a lifecycle change', () => {
  // Round 59's rule, applied to the round-67 arm: a fault NO STATE
  // CHANGE CAN EXPLAIN belongs above the applicability exits. A
  // contradictory heading/body pair was captured by the scrape; the loan
  // terminating, transferring or gaining an accepted sale before the
  // pinned re-read cannot unshow it.
  //
  // It passes round 59's own test for what may be hoisted: both halves
  // come from ONE render of ONE `view`, so no state change explains them
  // disagreeing.
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    notYetCopy: FORCED_CLOSE.notYet,
    overdueTitleCopy: FORCED_CLOSE.title,
    pendingTitleCopy: FORCED_CLOSE.titlePending,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyInKind],
  };
  const contradictory = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: true,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    defaultable: false,
    defaultableBefore: false,
    text: `${FORCED_CLOSE.title} ${FORCED_CLOSE.notYet}`,
    visibleText: `${FORCED_CLOSE.title} ${FORCED_CLOSE.notYet}`,
    bodyText: FORCED_CLOSE.notYet,
    bodyVisibleText: FORCED_CLOSE.notYet,
  };

  it('reports it on a position that has gone', () => {
    const v = forcedCloseVerdict({ ...contradictory, lenderHoldsActive: false }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/both on screen, disagreeing/);
  });

  it('reports it on a position that has an accepted sale', () => {
    const v = forcedCloseVerdict({ ...contradictory, saleLocked: true }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/both on screen, disagreeing/);
  });
});

describe('round 68 — a receipt stating BOTH settlement routes', () => {
  // `covers` is a substring test: it validates that the required content
  // is present and says nothing about what else is. Appending every
  // rental value to the corresponding standard row keeps six distinct
  // rows, satisfies all six expected label/value pairs, and never
  // reaches the wrong-route arm — while the lender reads two
  // incompatible sets of funds terms on one panel.
  const LABELS = [
    enBundle.copy.receipt.youReceive,
    enBundle.copy.receipt.youLock,
    enBundle.copy.receipt.youMayOwe,
    enBundle.copy.receipt.youCanLose,
    enBundle.copy.receipt.fees,
    enBundle.copy.receipt.whenThisEnds,
  ];
  const STANDARD = Object.values(FORCED_CLOSE.receipt);
  const RENTAL = Object.values(FORCED_CLOSE.rentalReceipt);
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyRental],
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: { standard: STANDARD, rental: RENTAL },
    receiptRowLabels: LABELS,
    rentalReadyCopy: FORCED_CLOSE.readyRental,
  };
  const rows = (values) => values.map((v, i) => `${LABELS[i]}\n${v}`);
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    bodyText: FORCED_CLOSE.readyInKind,
    bodyVisibleText: FORCED_CLOSE.readyInKind,
    text: FORCED_CLOSE.readyInKind,
    visibleText: FORCED_CLOSE.readyInKind,
    confirmExpected: true,
    confirmText: 'x',
  };

  it('reports a row carrying the other route’s terms as well as its own', () => {
    const both = STANDARD.map((v, i) => `${LABELS[i]}\n${v} ${RENTAL[i]}`);
    const v = forcedCloseVerdict({ ...base, confirmRowsText: both }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.failKind).toBe('observed');
    expect(v.why).toMatch(/BOTH settlement routes/);
  });

  it('names which row it found', () => {
    const one = rows(STANDARD).map((t, i) => (i === 3 ? `${t} ${RENTAL[3]}` : t));
    const v = forcedCloseVerdict({ ...base, confirmRowsText: one }, copy);
    expect(v.why).toMatch(/row 4 states/);
  });

  it('says nothing about a clean receipt', () => {
    const v = forcedCloseVerdict({ ...base, confirmRowsText: rows(STANDARD) }, copy);
    expect(v.why ?? '').not.toMatch(/BOTH settlement routes/);
  });

  it('leaves a WHOLLY wrong-route receipt to the arm that names it', () => {
    // The first version of this rule ran above the coverage test and
    // stole these cases, because a receipt that is wholly the other
    // route naturally contains the other route's values. A wrong receipt
    // and a doubled one are different defects and the lender's
    // experience of them differs.
    const v = forcedCloseVerdict({ ...base, confirmRowsText: rows(RENTAL) }, copy);
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/shows the rental receipt/);
  });
});

describe('round 69 — the settlement route is judged on every render', () => {
  // The bracket proves the route did NOT change across the observation,
  // so a render that painted the in-kind promise before the card settled
  // on internal-match copy showed the lender the wrong funds outcome at
  // a moment when the protocol's answer was already fixed.
  //
  // Thirteenth instance of the parallel-site shape, and one I should
  // have closed myself: the HEADING arm was made per-render two cycles
  // ago as a proactive sweep, and the sweep did not reach its sibling.
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch],
    receiptLeads: [FORCED_CLOSE.receipt.youReceive],
    receiptRowSets: {
      standard: Object.values(FORCED_CLOSE.receipt),
      rental: Object.values(FORCED_CLOSE.rentalReceipt),
    },
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
  };
  const render = (body) => ({
    text: body,
    visibleText: body,
    bodyText: body,
    bodyVisibleText: body,
    submitVisible: true,
    submitDisabled: false,
  });
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    defaultable: true,
    defaultableBefore: true,
    internalMatch: true,
    internalMatchBefore: true,
    // The SETTLED render is correct — it promises the internal match.
    ...render(FORCED_CLOSE.readyInternalMatch),
  };

  it('reports a wrong-route promise seen only in an earlier render', () => {
    const v = forcedCloseVerdict(
      { ...base, seenRenders: [render(FORCED_CLOSE.readyInKind)] },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.failKind).toBe('inferred');
    expect(v.why).toMatch(/throughout the observation/);
  });

  it('says nothing when every render promises the route the protocol would take', () => {
    const v = forcedCloseVerdict(
      { ...base, seenRenders: [render(FORCED_CLOSE.readyInternalMatch)] },
      copy,
    );
    expect(v.verdict).not.toBe('fail');
  });

  it('says nothing when the bracket did not agree — that is the race arm', () => {
    // A route that changed mid-observation cannot be matched to any
    // render, and the arm that says so has its own sentence.
    const v = forcedCloseVerdict(
      {
        ...base,
        internalMatchBefore: false,
        seenRenders: [render(FORCED_CLOSE.readyInKind)],
      },
      copy,
    );
    expect(v.why ?? '').not.toMatch(/throughout the observation/);
  });

  it('judges an earlier render on its PAINTED text', () => {
    const hidden = { ...render(FORCED_CLOSE.readyInternalMatch) };
    hidden.text = `${FORCED_CLOSE.readyInternalMatch} ${FORCED_CLOSE.readyInKind}`;
    hidden.bodyText = hidden.text;
    const v = forcedCloseVerdict({ ...base, seenRenders: [hidden] }, copy);
    expect(v.why ?? '').not.toMatch(/throughout the observation/);
  });
});

describe('round 70 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    notYetCopy: FORCED_CLOSE.notYet,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
    ],
    receiptLeads: [enBundle.copy.receipt.youReceive],
    receiptRowSets: {
      standard: Object.values(FORCED_CLOSE.receipt),
      rental: Object.values(FORCED_CLOSE.rentalReceipt),
    },
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
  };

  // EACH RENDER ON ITS OWN ACTION STATE. `actionOffered` describes the
  // SETTLED snapshot, so gating the traversal on it skipped the whole
  // history whenever the card ended up withheld — and an earlier render
  // exposing an enabled submit beside the wrong settlement promise is
  // exactly what this arm is for. The unsafe-control arm does not cover
  // it either: that render's copy is a READY state, not a withheld one.
  it('reports a wrong route that was ACTIONABLE in an earlier render', () => {
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        submitPresent: true,
        // Settled: withheld, no action.
        submitVisible: true,
        submitDisabled: true,
        visibleSubmits: 1,
        visibleCards: 1,
        saleLocked: false,
        settled: true,
        bodyPresent: true,
        bodyVisible: true,
        confirmExpected: false,
        confirmText: null,
        // ROUND 74 P2 — the protocol ACCEPTS here, so this fixture
        // isolates the route arm. It said `false`/`false`, which was
        // incidental until `readyOffered` became per-render: the earlier
        // render offers a ready route, so the round-7 arm now fires first
        // and reports the more serious defect. That arm has its own test.
        defaultable: true,
        defaultableBefore: true,
        internalMatch: true,
        internalMatchBefore: true,
        text: FORCED_CLOSE.unknown,
        visibleText: FORCED_CLOSE.unknown,
        bodyText: FORCED_CLOSE.unknown,
        bodyVisibleText: FORCED_CLOSE.unknown,
        seenRenders: [
          {
            // Earlier: the WRONG promise, and pressable.
            text: FORCED_CLOSE.readyInKind,
            visibleText: FORCED_CLOSE.readyInKind,
            bodyText: FORCED_CLOSE.readyInKind,
            bodyVisibleText: FORCED_CLOSE.readyInKind,
            submitVisible: true,
            submitDisabled: false,
          },
        ],
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/throughout the observation/);
  });

  // ROUND 75 P2 — the LABEL facts are judged per render too. The
  // projection dropped them, so only the settled render reached these
  // arms and a blank fee-paying control passed once a later render
  // repaired the label.
  it('reports a blank action label seen only in an earlier render', () => {
    const settled = {
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      submitLabelled: true,
      submitLabelPainted: true,
      visibleSubmits: 1,
      visibleCards: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyVisible: true,
      confirmExpected: false,
      confirmText: null,
      defaultable: true,
      defaultableBefore: true,
      internalMatch: false,
      internalMatchBefore: false,
      text: FORCED_CLOSE.readyInKind,
      visibleText: FORCED_CLOSE.readyInKind,
      bodyText: FORCED_CLOSE.readyInKind,
      bodyVisibleText: FORCED_CLOSE.readyInKind,
    };
    const earlier = (extra) => ({
      text: FORCED_CLOSE.readyInKind,
      visibleText: FORCED_CLOSE.readyInKind,
      bodyText: FORCED_CLOSE.readyInKind,
      bodyVisibleText: FORCED_CLOSE.readyInKind,
      submitVisible: true,
      submitDisabled: false,
      submitLabelled: true,
      submitLabelPainted: true,
      ...extra,
    });

    const blank = forcedCloseVerdict(
      { ...settled, seenRenders: [earlier({ submitLabelled: false })] },
      copy,
    );
    expect(blank.verdict).toBe('fail');
    expect(blank.why).toMatch(/no label at all/);

    const unpainted = forcedCloseVerdict(
      { ...settled, seenRenders: [earlier({ submitLabelPainted: false })] },
      copy,
    );
    expect(unpainted.verdict).toBe('fail');
    expect(unpainted.why).toMatch(/painted in nothing/);

    // And a render the lender could not act on is not this arm's
    // business — the control has to be offered.
    const withheld = forcedCloseVerdict(
      { ...settled, seenRenders: [earlier({ submitLabelled: false, submitDisabled: true })] },
      copy,
    );
    expect(withheld.why ?? '').not.toMatch(/no label at all/);
  });

  // ROUND 74 P2 — a READY route offered on an earlier render is judged
  // too. `readyOffered` came from the settled snapshot, so a card that
  // offered a fee-paying action the protocol would reject and then
  // settled somewhere non-actionable passed clean.
  it('reports a ready route offered only in an earlier render', () => {
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        submitPresent: true,
        submitVisible: true,
        submitDisabled: true,
        visibleSubmits: 1,
        visibleCards: 1,
        saleLocked: false,
        settled: true,
        bodyPresent: true,
        bodyVisible: true,
        confirmExpected: false,
        confirmText: null,
        defaultable: false,
        defaultableBefore: false,
        internalMatch: undefined,
        internalMatchBefore: undefined,
        text: FORCED_CLOSE.readyNeedsRoute,
        visibleText: FORCED_CLOSE.readyNeedsRoute,
        bodyText: FORCED_CLOSE.readyNeedsRoute,
        bodyVisibleText: FORCED_CLOSE.readyNeedsRoute,
        seenRenders: [
          {
            text: FORCED_CLOSE.readyInKind,
            visibleText: FORCED_CLOSE.readyInKind,
            bodyText: FORCED_CLOSE.readyInKind,
            bodyVisibleText: FORCED_CLOSE.readyInKind,
            submitVisible: true,
            submitDisabled: false,
          },
        ],
      },
      copy,
    );
    expect(v.verdict).toBe('fail');
    expect(v.why).toMatch(/pay a network fee for a call that cannot succeed/);
  });

  // ROUND 72 P2 — AND A PROMISE THE LENDER COULD NOT ACT ON IS STILL A
  // PROMISE. This test asserted the opposite until round 72: the
  // `offered` gate was mine rather than a finding's, and pressability is
  // no part of the claim the card made about funds.
  it('reports a wrong promise even where the control was disabled', () => {
    const v = forcedCloseVerdict(
      {
        lenderHoldsActive: true,
        mounted: true,
        attached: true,
        submitPresent: true,
        submitVisible: true,
        submitDisabled: true,
        visibleSubmits: 1,
        visibleCards: 1,
        saleLocked: false,
        settled: true,
        bodyPresent: true,
        bodyVisible: true,
        confirmExpected: false,
        confirmText: null,
        defaultable: false,
        defaultableBefore: false,
        internalMatch: true,
        internalMatchBefore: true,
        text: FORCED_CLOSE.unknown,
        visibleText: FORCED_CLOSE.unknown,
        bodyText: FORCED_CLOSE.unknown,
        bodyVisibleText: FORCED_CLOSE.unknown,
        seenRenders: [
          {
            text: FORCED_CLOSE.readyInKind,
            visibleText: FORCED_CLOSE.readyInKind,
            bodyText: FORCED_CLOSE.readyInKind,
            bodyVisibleText: FORCED_CLOSE.readyInKind,
            submitVisible: true,
            submitDisabled: true,
          },
        ],
      },
      copy,
    );
    expect(v.why).toMatch(/throughout the observation/);
  });

  // A CONFIRMATION WITH NO BACK CONTROL AT ALL. The panel used to be
  // DETECTED by its Back button, so this rendered as an unread scan
  // rather than as the defect it is.
  describe('a confirmation with no way to decline', () => {
    const panel = (backAction) => ({
      lenderHoldsActive: true,
      mounted: true,
      attached: true,
      submitPresent: true,
      submitVisible: true,
      submitDisabled: false,
      visibleSubmits: 1,
      visibleCards: 1,
      saleLocked: false,
      settled: true,
      bodyPresent: true,
      bodyVisible: true,
      defaultable: true,
      defaultableBefore: true,
      internalMatch: false,
      internalMatchBefore: false,
      text: FORCED_CLOSE.readyInKind,
      visibleText: FORCED_CLOSE.readyInKind,
      bodyText: FORCED_CLOSE.readyInKind,
      bodyVisibleText: FORCED_CLOSE.readyInKind,
      confirmExpected: true,
      // The WHOLE panel's text, as the drive actually records it —
      // `'x'` was my first value and the receipt-content arm fired on it
      // instead, so the test measured a different defect. Two fixture
      // realism errors in one case; the arms are ordered correctly and I
      // was describing a panel that could not exist.
      confirmText: `${enBundle.copy.receipt.youReceive} ${FORCED_CLOSE.receipt.youReceive}`,
      // A COMPLETE action record, as the in-page pass builds one. My
      // first three attempts at this fixture each omitted a field and
      // each fired a different, earlier arm — receipt content, then the
      // lead, then `enabled`. The arms are ordered correctly; I was
      // describing a panel that could not exist, and iterating on the
      // error message instead of on the shape.
      confirmAction: {
        present: true,
        visible: true,
        enabled: true,
        labelled: true,
        labelPainted: true,
        clickable: true,
        panelPresent: true,
        count: 1,
        index: 1,
        label: 'Confirm',
      },
      // The finding's scenario: the receipt and the fee-paying action
      // render NORMALLY and only Back is missing. My first fixture
      // omitted the rows, so the receipt-content arm fired first and the
      // test was measuring a different defect.
      confirmRowsText: Object.values(FORCED_CLOSE.receipt).map(
        (v, i) =>
          `${
            [
              enBundle.copy.receipt.youReceive,
              enBundle.copy.receipt.youLock,
              enBundle.copy.receipt.youMayOwe,
              enBundle.copy.receipt.youCanLose,
              enBundle.copy.receipt.fees,
              enBundle.copy.receipt.whenThisEnds,
            ][i]
          }\n${v}`,
      ),
      backAction,
    });

    it('reports a panel whose Back control is absent', () => {
      const v = forcedCloseVerdict(panel({ present: false, clickable: null }), copy);
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/no way to decline/);
    });

    // ROUND 75 P2 — a panel legitimately WITHDRAWN mid-scan is not a
    // trapped lender. The drive now records `null` when it cannot see the
    // panel any more, and the arm must let that through: the two facts
    // would otherwise come from renders that never coexisted.
    // ROUND 81 P2 — and an observed Back defect outranks an INFERRED
    // protocol mismatch. A visit carries one verdict, and a blocker can
    // downgrade an inferred one to BLOCKED — so a trapped lender would
    // have vanished behind a provider disagreement that cannot explain a
    // broken button.
    it('reports an unusable Back ahead of a protocol mismatch', () => {
      const v = forcedCloseVerdict(
        {
          ...panel({ present: true, clickable: false }),
          // A ready card the bracket refuses: the inferred arm would
          // otherwise return first.
          submitDisabled: false,
          text: FORCED_CLOSE.readyInKind,
          visibleText: FORCED_CLOSE.readyInKind,
          bodyText: FORCED_CLOSE.readyInKind,
          bodyVisibleText: FORCED_CLOSE.readyInKind,
          defaultable: false,
          defaultableBefore: false,
        },
        copy,
      );
      expect(v.verdict).toBe('fail');
      expect(v.failKind).toBe('observed');
      expect(v.why).toMatch(/cannot activate/);
    });

    it('says nothing when Back presence was not established', () => {
      const v = forcedCloseVerdict(panel({ present: null, clickable: null }), copy);
      expect(v.why ?? '').not.toMatch(/no way to decline/);
    });

    it('says nothing when the Back trial was not established', () => {
      const v = forcedCloseVerdict(panel({ present: true, clickable: null }), copy);
      expect(v.why ?? '').not.toMatch(/cannot be activated|no way to decline/);
    });

    it('says nothing when no confirmation was ever opened', () => {
      // Positive evidence that the panel was up is required, or every
      // visit that never opened one becomes a finding.
      const v = forcedCloseVerdict(
        {
          ...panel({ present: false, clickable: null }),
          confirmExpected: false,
          confirmText: null,
          confirmAction: undefined,
          confirmRowsText: undefined,
        },
        copy,
      );
      expect(v.why ?? '').not.toMatch(/no way to decline/);
    });
  });
});

describe('self-review of round 70 — the unread-route arm takes the same sweep', () => {
  // Round 70 paired each render with its own submit facts for the
  // MISMATCH arm and left its sibling gated on `actionOffered`, reading
  // only the settled body. So a card that promised a route on an
  // earlier, pressable render and then withdrew the action reported a
  // clean pass — even though this drive could not read the route that
  // promise depended on.
  //
  // One of two arms in the same file, one round after being told that is
  // the recurring failure. Checked here rather than waiting to be told.
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    recognisedCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch],
    receiptLeads: [enBundle.copy.receipt.youReceive],
    receiptRowSets: {
      standard: Object.values(FORCED_CLOSE.receipt),
      rental: Object.values(FORCED_CLOSE.rentalReceipt),
    },
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
  };
  const withdrawn = (earlier) => ({
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    // Settled: the action is withdrawn.
    submitVisible: true,
    submitDisabled: true,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    // ROUND 74 P2 — accepting, so this isolates the route arm; see the
    // note on the round-70 fixture above.
    defaultable: true,
    defaultableBefore: true,
    // The route could not be read at all.
    internalMatch: undefined,
    internalMatchBefore: undefined,
    text: FORCED_CLOSE.unknown,
    visibleText: FORCED_CLOSE.unknown,
    bodyText: FORCED_CLOSE.unknown,
    bodyVisibleText: FORCED_CLOSE.unknown,
    seenRenders: [earlier],
  });

  it('reports INCOMPLETE for a route promised on an earlier PRESSABLE render', () => {
    const v = forcedCloseVerdict(
      withdrawn({
        text: FORCED_CLOSE.readyInKind,
        visibleText: FORCED_CLOSE.readyInKind,
        bodyText: FORCED_CLOSE.readyInKind,
        bodyVisibleText: FORCED_CLOSE.readyInKind,
        submitVisible: true,
        submitDisabled: false,
      }),
      copy,
    );
    expect(v.verdict).toBe('blocked');
    expect(v.blockedKind).toBe('incomplete');
    expect(v.why).toMatch(/could not read which route/);
  });

  // ROUND 72 P2 — same correction on the sibling arm.
  it('reports an unread route promised on a disabled render too', () => {
    const v = forcedCloseVerdict(
      withdrawn({
        text: FORCED_CLOSE.readyInKind,
        visibleText: FORCED_CLOSE.readyInKind,
        bodyText: FORCED_CLOSE.readyInKind,
        bodyVisibleText: FORCED_CLOSE.readyInKind,
        submitVisible: true,
        submitDisabled: true,
      }),
      copy,
    );
    expect(v.why).toMatch(/could not read which route/);
  });

  it('says nothing when no render committed to a route', () => {
    const v = forcedCloseVerdict(
      withdrawn({
        text: FORCED_CLOSE.unknown,
        visibleText: FORCED_CLOSE.unknown,
        bodyText: FORCED_CLOSE.unknown,
        bodyVisibleText: FORCED_CLOSE.unknown,
        submitVisible: true,
        submitDisabled: false,
      }),
      copy,
    );
    expect(v.why ?? '').not.toMatch(/could not read which route/);
  });
});

// ROUND 85 P2 — TWO MATCHING ENDS OF A BRACKET DO NOT SAY WHAT HAPPENED
// BETWEEN THEM.
//
// Three arms accused the card on the strength of the bracket's ENDS
// agreeing. That is strong evidence for an answer that moves one way and
// none at all for one that can round-trip: an internal-match candidate can
// appear and be consumed inside the observation, leaving both ends `false`
// while a render truthfully painted the match route — and the message the
// arm printed claimed the protocol "held no match candidate throughout",
// which two endpoint reads cannot establish.
//
// The drive now reads the INTERIOR, one probe per block of the span, and
// reports a tri-state. These cases pin what the verdict does with it:
// `true` accuses as before, `false` and `null` report an incomplete
// observation, and a record carrying neither field behaves exactly as it
// did — the `undefined`-predates-the-field rule every arm in this module
// follows.
describe('round 85 review findings', () => {
  const copy = {
    unknownCopy: FORCED_CLOSE.unknown,
    notYetCopy: FORCED_CLOSE.notYet,
    overdueTitleCopy: FORCED_CLOSE.title,
    pendingTitleCopy: FORCED_CLOSE.titlePending,
    readyCopy: [FORCED_CLOSE.readyInKind, FORCED_CLOSE.readyInternalMatch, FORCED_CLOSE.readyRental],
    withheldCopy: [FORCED_CLOSE.unknown, FORCED_CLOSE.notYet, FORCED_CLOSE.readyNeedsRoute],
    refusalStateCopy: [
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.blockedPaused,
      FORCED_CLOSE.blockedSequencer,
      FORCED_CLOSE.blockedNoConsent,
    ],
    recognisedCopy: [
      FORCED_CLOSE.unknown,
      FORCED_CLOSE.notYet,
      FORCED_CLOSE.readyInKind,
      FORCED_CLOSE.readyInternalMatch,
      FORCED_CLOSE.readyRental,
      FORCED_CLOSE.readyNeedsRoute,
    ],
    receiptLeads: [FORCED_CLOSE.receipt.youReceive, FORCED_CLOSE.rentalReceipt.youReceive],
    receiptRowSets: {
      standard: Object.values(FORCED_CLOSE.receipt),
      rental: Object.values(FORCED_CLOSE.rentalReceipt),
    },
    rentalReadyCopy: FORCED_CLOSE.readyRental,
    internalMatchReadyCopy: FORCED_CLOSE.readyInternalMatch,
    inKindReadyCopy: FORCED_CLOSE.readyInKind,
  };
  const base = {
    lenderHoldsActive: true,
    mounted: true,
    attached: true,
    submitPresent: true,
    submitVisible: true,
    submitDisabled: false,
    visibleSubmits: 1,
    visibleCards: 1,
    saleLocked: false,
    settled: true,
    bodyPresent: true,
    bodyVisible: true,
    confirmExpected: false,
    confirmText: null,
    defaultable: true,
    defaultableBefore: true,
  };
  const painted = (sentence) => ({
    text: sentence,
    bodyText: sentence,
    visibleText: sentence,
    bodyVisibleText: sentence,
  });
  const inKind = { ...base, ...painted(FORCED_CLOSE.readyInKind) };
  const withheld = (sentence) => ({
    ...base,
    ...painted(sentence),
    submitDisabled: true,
    confirmExpected: false,
    confirmText: null,
  });

  describe('a ready route the protocol would refuse', () => {
    const refused = { ...inKind, defaultable: false, defaultableBefore: false };

    it('still accuses when the answer held at every block of the span', () => {
      const v = forcedCloseVerdict({ ...refused, defaultableStable: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/would be refused/);
    });

    it('reports an incomplete observation when the span moved', () => {
      const v = forcedCloseVerdict({ ...refused, defaultableStable: false }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/held at every block/);
    });

    it('and when the span could not be covered at all', () => {
      // `null` is the OLD evidence — two matching ends and nothing about
      // the middle. Reading it as `true` is the finding.
      const v = forcedCloseVerdict({ ...refused, defaultableStable: null }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('leaves a record predating the field exactly as it was', () => {
      expect(forcedCloseVerdict(refused, copy).verdict).toBe('fail');
    });
  });

  describe('a refusal the protocol does not make', () => {
    const claiming = { ...withheld(FORCED_CLOSE.notYet), defaultable: true, defaultableBefore: true };

    it('still accuses when the answer held throughout', () => {
      const v = forcedCloseVerdict({ ...claiming, defaultableStable: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/denied a close-out the protocol accepts/);
    });

    it('reports incomplete when a grace crossing could explain it', () => {
      // The case in the wild: the deadline passes inside the observation,
      // both ends read `true`, and the render legitimately showed the
      // state before it.
      const v = forcedCloseVerdict({ ...claiming, defaultableStable: false }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/not attributed to the card/);
    });
  });

  describe('a settlement route the protocol would not take', () => {
    const match = { ...base, ...painted(FORCED_CLOSE.readyInternalMatch) };
    const promisingMatch = { ...match, internalMatch: false, internalMatchBefore: false };

    it('still accuses when no candidate existed at any block of the span', () => {
      const v = forcedCloseVerdict({ ...promisingMatch, internalMatchStable: true }, copy);
      expect(v.verdict).toBe('fail');
      expect(v.why).toMatch(/held no match candidate throughout/);
    });

    // THE ROUND-TRIP, which is why this arm needed the interior read more
    // than its siblings: a candidate that appears and is consumed inside
    // the window leaves both ends `false` while the card painted the truth.
    it('reports incomplete when a candidate could have come and gone', () => {
      const v = forcedCloseVerdict({ ...promisingMatch, internalMatchStable: false }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
      expect(v.why).toMatch(/settlement route/);
    });

    it('and when the span could not be covered', () => {
      const v = forcedCloseVerdict({ ...promisingMatch, internalMatchStable: null }, copy);
      expect(v.verdict).toBe('blocked');
      expect(v.blockedKind).toBe('incomplete');
    });

    it('does not disturb a card whose route the protocol agrees with', () => {
      const v = forcedCloseVerdict(
        { ...match, internalMatch: true, internalMatchBefore: true, internalMatchStable: true },
        copy,
      );
      expect(v.verdict).not.toBe('fail');
    });
  });
});
