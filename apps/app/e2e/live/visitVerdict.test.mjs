import { describe, expect, it } from 'vitest';

import {
  preRaced,
  visitBlockedReason,
  visitProblemKinds,
  visitProblems,
  visitVerdict,
} from './visitVerdict.mjs';

/**
 * Why this file exists (#1861), stated as the finding rather than as a
 * description:
 *
 * The rules under test decide the live drive's exit code, and until now
 * the only way to execute them was to drive a real chain into the exact
 * state each describes. The live chain does not carry those states —
 * every lender position on it is past due — so each of these rules
 * shipped having been reasoned about and never run. Three defects were
 * found in them by reading: an anchor failure suppressed in aggregate
 * (#1853 r18), one message serving two findings (r16), and a
 * suppression keyed on the driver's own prose (r14).
 *
 * The records below are hand-built. That is the whole seam: a visit
 * record is a plain object, so none of this ever needed a browser.
 */

/** A clean lender detail page: card present, all rows, jumps audited. */
const OK_LENDER = Object.freeze({
  path: '/positions/7',
  http: 200,
  chooser: true,
  lenderBlurb: true,
  waitRow: true,
  sellNowRow: true,
  listRow: true,
  waitFirst: true,
  advancedOffered: true,
  advancedJumps: 2,
  advancedAnchorsOk: true,
  advancedAnchors: [
    { title: 'Sell now', target: 'sell-now', reached: 'sell-now', present: true },
    { title: 'List it', target: 'list', reached: 'list', present: true },
  ],
});

const lender = (over) => ({ ...OK_LENDER, ...over });

describe('a clean page', () => {
  it('is neither a failure nor blocked', () => {
    expect(visitVerdict(lender(), 'lender')).toEqual({ problems: [], blocked: null });
  });

  it('ignores the card rules entirely on the list route', () => {
    // Every shape field absent, because the list route has no card.
    const v = { path: '/positions', http: 200 };
    expect(visitProblems(v, 'lender')).toEqual([]);
  });
});

describe('navigation', () => {
  it('fails on a nav error', () => {
    expect(visitProblems({ path: '/positions/7', nav: 'timeout' }, 'lender')).toContain(
      'nav: timeout',
    );
  });

  it('fails on a non-2xx status, which neither throws nor fires pageerror', () => {
    expect(visitProblems({ path: '/positions/7', http: 404 }, 'lender')).toContain(
      'navigation returned 404',
    );
  });

  it('fails when no response was recorded at all', () => {
    expect(visitProblems({ path: '/positions/7', http: null }, 'lender')).toContain(
      'navigation returned no response',
    );
  });

  it('does not add a status problem when the nav itself already failed', () => {
    const problems = visitProblems({ path: '/positions/7', nav: 'timeout' }, 'lender');
    expect(problems).toEqual(['nav: timeout']);
  });

  it('suppresses the card rules when the nav failed', () => {
    // A page that never loaded says nothing about the card.
    const v = lender({ nav: 'timeout', chooser: false });
    expect(visitProblems(v, 'lender')).toEqual(['nav: timeout']);
  });
});

describe('the pre-raced suppression', () => {
  const raced = {
    advancedBlocked: true,
    advancedPreRaced: true,
    cardAbsentAtScrape: true,
  };

  it('fires only with all three of its conditions', () => {
    expect(preRaced(raced)).toBe(true);
    expect(preRaced({ ...raced, advancedBlocked: false })).toBe(false);
    expect(preRaced({ ...raced, advancedPreRaced: false })).toBe(false);
    expect(preRaced({ ...raced, cardAbsentAtScrape: false })).toBe(false);
  });

  it('suppresses the card assertions when the card was never mounted', () => {
    const v = lender({ ...raced, chooser: false, waitRow: false, listRow: false });
    expect(visitProblems(v, 'lender')).toEqual([]);
  });

  it('KEEPS a finding from a card that did render (#1853 r16)', () => {
    // The third condition is the whole point: this card was scraped
    // with a row missing, and the chain moving afterwards must not
    // erase an observation that was real when it was made.
    const v = lender({
      advancedBlocked: true,
      advancedPreRaced: true,
      cardAbsentAtScrape: false,
      listRow: false,
    });
    expect(visitProblems(v, 'lender')).toContain('listing row MISSING from the lender card');
  });
});

describe('the lender card shape', () => {
  it('fails a missing chooser and says nothing further about rows', () => {
    const v = lender({ chooser: false, waitRow: false, listRow: false });
    expect(visitProblems(v, 'lender')).toEqual(['lender chooser MISSING on an eligible loan']);
  });

  it('names each absent row, because a missing row reads as "no such option"', () => {
    const v = lender({ waitRow: false, sellNowRow: false, listRow: false, lenderBlurb: false });
    expect(visitProblems(v, 'lender')).toEqual([
      'lender card title without its own blurb',
      'wait row MISSING from the lender card',
      'sell-now row MISSING from the lender card',
      'listing row MISSING from the lender card',
    ]);
  });

  it('fails a mis-ordered wait row', () => {
    expect(visitProblems(lender({ waitFirst: false }), 'lender')).toContain(
      'wait row is NOT first on the lender card',
    );
  });

  it('does NOT fail order when there were too few rows to have one', () => {
    // `null` means the order question does not arise; the missing row
    // is already reported and must not be double-counted.
    const v = lender({ waitFirst: null, listRow: false });
    expect(visitProblems(v, 'lender')).toEqual(['listing row MISSING from the lender card']);
  });
});

describe('the borrower card shape', () => {
  it('requires both newly-exposed paths', () => {
    const v = { path: '/positions/7', http: 200, chooser: true, handover: false, offset: false };
    expect(visitProblems(v, 'borrower')).toEqual([
      'handover path MISSING from the chooser',
      'offset path MISSING from the chooser',
    ]);
  });

  it('does not apply the lender row rules', () => {
    const v = { path: '/positions/7', http: 200, chooser: true, handover: true, offset: true };
    expect(visitProblems(v, 'borrower')).toEqual([]);
  });
});

describe('dead anchors', () => {
  it('names where the button actually went, not only where it should have', () => {
    // A swapped binding has BOTH anchors present, so "missing element"
    // would send a reader looking for something that exists (r26).
    const v = lender({
      advancedAnchorsOk: false,
      advancedAnchors: [
        { title: 'Sell now', target: 'sell-now', reached: 'list', present: false },
      ],
    });
    expect(visitProblems(v, 'lender')).toEqual([
      'a lender jump button did not reach its own anchor: sell-now → list',
    ]);
  });

  it('says "nowhere" for a click that navigated nowhere at all', () => {
    const v = lender({
      advancedAnchorsOk: false,
      advancedAnchors: [{ title: 'List it', target: 'list', reached: null, present: false }],
    });
    expect(visitProblems(v, 'lender')).toContain(
      'a lender jump button did not reach its own anchor: list → nowhere',
    );
  });

  it('reports a dead anchor BESIDE an unmapped row, and blocks too (#1853 r18)', () => {
    // The regression this pins: suppressing the whole anchor finding
    // whenever any unmapped title existed, so one reworded row hid a
    // positively observed dead button next to it and the run exited 2
    // for the harness's gap while the product defect went unprinted.
    const v = lender({
      advancedAnchorsOk: false,
      advancedUnmapped: ['Something new'],
      advancedAnchors: [
        { title: 'Sell now', target: 'sell-now', reached: 'nope', present: false },
        { title: 'Something new', target: null, reached: undefined, present: null },
      ],
    });
    const { problems, blocked } = visitVerdict(v, 'lender');
    expect(problems).toEqual([
      'a lender jump button did not reach its own anchor: sell-now → nope',
    ]);
    // BOTH verdicts, independently. The caller ranks them.
    expect(blocked).toBe(
      'jumping row(s) this drive cannot map to an anchor: Something new',
    );
  });
});

describe('the zero-jump verdict', () => {
  it('states its own finding rather than borrowing the anchor sentence', () => {
    // The no-op switch renders NO button, so an anchor sentence sends a
    // reader looking for something never rendered (#1853 r16).
    const v = lender({
      advancedJumps: 0,
      advancedAnchorsOk: false,
      advancedAnchors: [],
      advancedWhy: 'the switch was clicked and no jump appeared',
    });
    expect(visitProblems(v, 'lender')).toEqual([
      'the switch was clicked and no jump appeared',
    ]);
  });

  it('falls back to a fixed sentence when the probe named no reason', () => {
    const v = lender({ advancedJumps: 0, advancedAnchorsOk: false, advancedAnchors: [] });
    expect(visitProblems(v, 'lender')).toEqual([
      'the lender card offered the switch and rendered no jump',
    ]);
  });

  it('does not fire when the anchors are fine', () => {
    const v = lender({ advancedJumps: 0, advancedAnchorsOk: true, advancedAnchors: [] });
    expect(visitProblems(v, 'lender')).toEqual([]);
  });
});

describe('an explicit verdict from the producer', () => {
  it('is honoured without the reporter recognising a field pattern (r27)', () => {
    // Round 25's Basic-mode leak: positive jumps, no anchors — a shape
    // neither inference arm matches — so the run exited clean on a
    // directly observed defect.
    const v = lender({
      advancedFailed: true,
      advancedWhy: 'Basic mode rendered the Advanced jump buttons',
      advancedJumps: 2,
      advancedAnchors: [],
      advancedAnchorsOk: false,
    });
    expect(visitProblems(v, 'lender')).toEqual([
      'Basic mode rendered the Advanced jump buttons',
    ]);
  });

  it('has a fallback sentence of its own', () => {
    const v = lender({ advancedFailed: true, advancedAnchors: [], advancedAnchorsOk: false, advancedJumps: 2 });
    expect(visitProblems(v, 'lender')).toEqual([
      'the lender Advanced audit reported a failure',
    ]);
  });

  it('prints ONCE when it also matches the inferred zero-jump shape (r29)', () => {
    // Both the flag and the inference describe the same defect here, and
    // a reader counting problems would have counted two.
    const v = lender({
      advancedFailed: true,
      advancedWhy: 'the card claims a jumpable row and offered no switch',
      advancedJumps: 0,
      advancedAnchorsOk: false,
      advancedAnchors: [],
    });
    expect(visitProblems(v, 'lender')).toEqual([
      'the card claims a jumpable row and offered no switch',
    ]);
  });
});

describe('the blocked reason', () => {
  it('is null for a page with nothing blocking', () => {
    expect(visitBlockedReason(lender())).toBe(null);
  });

  it('blocks without failing on an unmapped row alone', () => {
    const v = lender({
      advancedJumps: 1,
      advancedAnchorsOk: false,
      advancedUnmapped: ['Brand new row'],
      advancedAnchors: [{ title: 'Brand new row', target: null, reached: undefined, present: null }],
    });
    const { problems, blocked } = visitVerdict(v, 'lender');
    expect(problems).toEqual([]);
    expect(blocked).toBe('jumping row(s) this drive cannot map to an anchor: Brand new row');
  });

  it('names a mapped button that could not be clicked', () => {
    const v = lender({ advancedUnexercised: ['Sell now'] });
    expect(visitBlockedReason(v)).toBe('jump button(s) that could not be clicked: Sell now');
  });

  it('joins both gaps when a page has each', () => {
    const v = lender({ advancedUnmapped: ['New row'], advancedUnexercised: ['Sell now'] });
    expect(visitBlockedReason(v)).toBe(
      'jumping row(s) this drive cannot map to an anchor: New row; ' +
        'jump button(s) that could not be clicked: Sell now',
    );
  });

  it("prefers the probe's own reason over the assembled sentence", () => {
    const v = lender({
      advancedBlocked: true,
      advancedWhy: 'the lender card unmounted while the probe waited',
      advancedUnmapped: ['New row'],
    });
    expect(visitBlockedReason(v)).toBe('the lender card unmounted while the probe waited');
  });

  it('falls past an EMPTY reason to the assembled sentence', () => {
    // `??` would pass `''` straight through — the falsy verdict again,
    // by a second door.
    const v = lender({ advancedWhy: '', advancedUnmapped: ['New row'] });
    expect(visitBlockedReason(v)).toBe(
      'jumping row(s) this drive cannot map to an anchor: New row',
    );
  });

  it('never returns the empty string, which a caller would read as unblocked', () => {
    // The flag is the verdict and the prose is only the detail, so a
    // record with the flag and no prose must still come back truthy.
    // Unreachable today — every producer sets `advancedWhy` — and pinned
    // because "the callers all happen to set the other field" is exactly
    // the invariant that stops holding quietly.
    const reason = visitBlockedReason({ advancedBlocked: true });
    expect(reason).toBeTruthy();
    expect(reason).toBe('the Advanced probe did not complete and named no reason');
  });
});

describe('a page can carry both verdicts at once', () => {
  it('a pre-raced page blocks while its suppressed shape does not fail', () => {
    const v = lender({
      advancedBlocked: true,
      advancedPreRaced: true,
      cardAbsentAtScrape: true,
      advancedWhy: 'the card could not be mounted when the probe read the chain',
      chooser: false,
    });
    expect(visitVerdict(v, 'lender')).toEqual({
      problems: [],
      blocked: 'the card could not be mounted when the probe read the chain',
    });
  });
});

describe('the forced-close card (#2069)', () => {
  const fail = { verdict: 'fail', why: 'card absent on a held Active lender position' };

  it('fails when its verdict is fail', () => {
    expect(visitProblems(lender({ forcedCloseVerdict: fail }), 'lender')).toContain(
      `forced-close card: ${fail.why}`,
    );
  });

  it('is REPORTED ALONGSIDE a missing exit chooser, not swallowed by it', () => {
    // The placement test, and the reason this arm sits above the
    // `!v.chooser` early return. They are different cards that happen
    // to share a page; a run that observed two defects must report two.
    const problems = visitProblems(
      lender({ chooser: false, forcedCloseVerdict: fail }),
      'lender',
    );
    expect(problems).toContain(`forced-close card: ${fail.why}`);
    expect(problems).toContain('lender chooser MISSING on an eligible loan');
    expect(problems).toHaveLength(2);
  });

  it('adds nothing when the verdict passes', () => {
    expect(
      visitProblems(lender({ forcedCloseVerdict: { verdict: 'pass', why: 'present' } }), 'lender'),
    ).toEqual([]);
  });

  it('adds nothing when the verdict is blocked — nothing observed is not a defect', () => {
    expect(
      visitProblems(
        lender({ forcedCloseVerdict: { verdict: 'blocked', why: 'not a held Active position' } }),
        'lender',
      ),
    ).toEqual([]);
  });

  it('adds nothing when there is no verdict at all (borrower runs)', () => {
    expect(visitProblems(lender({ forcedCloseVerdict: null }), 'lender')).toEqual([]);
    expect(visitProblems(lender({ forcedCloseVerdict: undefined }), 'lender')).toEqual([]);
  });

  it('stays silent on the list route, which has no position card', () => {
    expect(
      visitProblems({ path: '/positions', http: 200, forcedCloseVerdict: fail }, 'lender'),
    ).toEqual([]);
  });
});

describe('the forced-close card is judged above the chooser suppressions', () => {
  const fail = { verdict: 'fail', why: 'card absent on a held Active lender position' };

  it('survives preRaced, which is built only from CHOOSER facts', () => {
    // `preRaced` = advancedBlocked && advancedPreRaced && cardAbsentAtScrape.
    // All three describe the lender exit card. The divergence is real:
    // a sanctions-flagged holder correctly loses the exit chooser while
    // the forced-close card deliberately stays available, so a
    // positively observed amount would have been discarded here.
    const v = lender({
      advancedBlocked: true,
      advancedPreRaced: true,
      cardAbsentAtScrape: true,
      forcedCloseVerdict: fail,
    });
    expect(visitProblems(v, 'lender')).toContain(`forced-close card: ${fail.why}`);
  });

  it('still suppresses the CHOOSER rows under preRaced', () => {
    // The suppression must keep doing its own job — this change moves
    // one arm above it, it does not disable it.
    const v = lender({
      advancedBlocked: true,
      advancedPreRaced: true,
      cardAbsentAtScrape: true,
      chooser: false,
      waitRow: false,
      forcedCloseVerdict: null,
    });
    expect(visitProblems(v, 'lender')).toEqual([]);
  });

  it('is still not judged on a page that never navigated', () => {
    // A page that failed to load produced no observation of either
    // card; the nav failure is the only honest finding.
    expect(visitProblems({ path: '/positions/7', nav: 'timeout', forcedCloseVerdict: fail }, 'lender')).toEqual(
      ['nav: timeout'],
    );
  });
});

// ROUND 78 P2 — the TAGS the exit ordering reads.
//
// A page built against another network explains an ABSENCE and nothing
// else. Gating the unknown-chain blocker on the aggregate failure count
// would have downgraded a directly observed defect — a crash, an uncaught
// error, a dead anchor — to "nothing was learned".
describe('visitProblemKinds', () => {
  const detail = (extra) => ({
    path: '/positions/7',
    http: 200,
    chooser: true,
    lenderBlurb: true,
    waitRow: true,
    sellNowRow: true,
    listRow: true,
    waitFirst: true,
    ...extra,
  });
  const kindOf = (v, why) =>
    visitProblemKinds(v, 'lender').find((p) => p.why.includes(why))?.kind;

  it('tags what was READ as observed', () => {
    expect(kindOf(detail({ hooks: true }), 'HOOKS-ORDER')).toBe('observed');
    expect(kindOf(detail({ pageErrors: ['boom'] }), 'uncaught error')).toBe('observed');
    expect(kindOf(detail({ waitFirst: false }), 'NOT first')).toBe('observed');
    expect(
      kindOf(
        detail({ advancedAnchors: [{ target: '#x', present: false, reached: null }] }),
        'did not reach its own anchor',
      ),
    ).toBe('observed');
  });

  it('tags what was MISSING as an absence', () => {
    expect(kindOf(detail({ chooser: false }), 'chooser MISSING')).toBe('absence');
    expect(kindOf(detail({ waitRow: false }), 'wait row MISSING')).toBe('absence');
    expect(kindOf(detail({ listRow: false }), 'listing row MISSING')).toBe('absence');
  });

  it('takes the forced-close card’s own tag rather than deciding again', () => {
    const read = detail({
      forcedCloseVerdict: { verdict: 'fail', failKind: 'observed', why: 'stated an amount' },
    });
    const inferred = detail({
      forcedCloseVerdict: { verdict: 'fail', failKind: 'inferred', why: 'route disagrees' },
    });
    expect(kindOf(read, 'forced-close card')).toBe('observed');
    expect(kindOf(inferred, 'forced-close card')).toBe('absence');
  });

  // ROUND 82 P3 — and this is now the ONLY thing standing between an
  // observed forced-close failure and the blockers that would swallow it.
  //
  // The drive carried a second, unreachable exit of its own for this card
  // (`fcObserved`), pinned by four source-order cases in
  // `exitOrdering.test.mjs`. Folding it away moved the whole property
  // here: the promotion above the infrastructure gates selects on
  // `blockable === false` and knows nothing about which card produced the
  // problem, so if this tag were wrong the card's finding would be
  // reported as an inconclusive run on any drive that also hit a blocked
  // request — round 38's defect, restored silently.
  it('lets a READ forced-close failure past the blockers, and an inferred one not', () => {
    const blockable = (v) =>
      visitProblemKinds(v, 'lender').find((p) => p.why.includes('forced-close card'))
        ?.blockable;
    expect(
      blockable(
        detail({
          forcedCloseVerdict: { verdict: 'fail', failKind: 'observed', why: 'stated an amount' },
        }),
      ),
    ).toBe(false);
    expect(
      blockable(
        detail({
          forcedCloseVerdict: { verdict: 'fail', failKind: 'inferred', why: 'route disagrees' },
        }),
      ),
    ).toBe(true);
  });

  // SELF-REVIEW AFTER ROUND 79 — `blockable` is the second question, and
  // every arm answers it at its own site.
  it('marks what a blocked request could explain', () => {
    const blockable = (v, why) =>
      visitProblemKinds(v, 'lender').find((p) => p.why.includes(why))?.blockable;
    // Read directly AND structurally immune to a missing read.
    expect(blockable(detail({ waitFirst: false }), 'NOT first')).toBe(false);
    expect(
      blockable(
        detail({ advancedAnchors: [{ target: '#x', present: false, reached: null }] }),
        'did not reach its own anchor',
      ),
    ).toBe(false);
    // Read directly, but a refused request is a plausible cause — round
    // 69 added the allowlist gate because this drive can break the page.
    expect(blockable(detail({ hooks: true }), 'HOOKS-ORDER')).toBe(true);
    expect(blockable(detail({ pageErrors: ['x'] }), 'uncaught error')).toBe(true);
    // An absence is always explicable by a blocker.
    expect(blockable(detail({ chooser: false }), 'chooser MISSING')).toBe(true);
  });

  it('reports the same strings as visitProblems, in the same order', () => {
    // One decision site, two views — the property that keeps the tags
    // from drifting away from the text they describe.
    const v = detail({ hooks: true, chooser: false, pageErrors: ['x'] });
    expect(visitProblemKinds(v, 'lender').map((p) => p.why)).toEqual(
      visitProblems(v, 'lender'),
    );
  });
});
