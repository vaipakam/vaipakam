/**
 * RL-2 (#1303) — loop closure on /analytics (TokenomicsTechSpec,
 * "Loop-closure transparency metric").
 *
 * Pins: a zero-distribution day is "not applicable", never 0; the daily
 * FLOW and lifetime STOCK figures are shown apart; every proportion rounds
 * DOWN (the metric may never overstate closure); a positive amount below
 * the display precision is labelled, not zeroed; days are the indexer's
 * own UTC calendar date, shown verbatim and labelled as such; a day the
 * record has not finished (or not reached) is shown as such, never as zero
 * or "nothing paid out", with the series' as-of moment beside it; and a
 * malformed payload withholds only this section.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '../../content/copy';
import { parseLoopClosure } from '../../data/recycling';
import { LoopClosureView, type LoopClosureState } from './LoopClosure';
import { renderMarkup } from './staticMarkup';

const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const L = copy.loopClosure;

type Obj = Record<string, unknown>;

const day = (over: Obj = {}) => ({
  dayId: 20730,
  date: '2026-10-04',
  status: 'complete',
  distributed: tok(10),
  netVaultDelivered: tok(4),
  absorbed: tok(1),
  ratio: 0.5,
  ...over,
});

const quietDay = (over: Obj = {}) =>
  day({ distributed: '0', netVaultDelivered: '0', absorbed: '0', ratio: null, ...over });

/** The day the record stops in (or the day in progress): amounts so far, no ratio. */
const partialDay = (over: Obj = {}) => day({ status: 'partial', ratio: null, ...over });

/** A day the record has not reached: nothing known. */
const unrecordedDay = (over: Obj = {}) =>
  day({
    status: 'unrecorded',
    distributed: null,
    netVaultDelivered: null,
    absorbed: null,
    ratio: null,
    ...over,
  });

const RECORDED_BEFORE = '2026-10-07T09:30:00.000Z';

const loop = (over: Obj = {}): Obj => ({
  chainId: 8453,
  days: 30,
  recordedBefore: RECORDED_BEFORE,
  daily: [day()],
  cumulative: { cumDistributed: tok(100), cumAbsorbed: tok(5), retainedStock: tok(40), ratio: 0.45 },
  ...over,
});

function stateFor(raw: unknown): LoopClosureState {
  const data = raw === null ? null : parseLoopClosure(raw);
  return data ? { status: 'ready', data } : { status: 'unavailable' };
}

const render = (raw: unknown, locale = 'en') =>
  renderMarkup(createElement(LoopClosureView, { state: stateFor(raw), locale }));

describe('LoopClosure — not applicable is not zero', () => {
  it('a day with nothing paid out says "not applicable", never 0 or 0%', () => {
    const r = render(loop({ daily: [quietDay({ dayId: 20731, date: '2026-10-05' })] }));
    expect(r.textOf('loop-ratio-20731')).toBe(L.notApplicable);
    expect(r.textOf('loop-ratio-20731')).not.toMatch(/^0%?$/);
  });

  it('the lifetime proportion is not applicable while nothing has been paid out', () => {
    const r = render(
      loop({
        daily: [quietDay()],
        cumulative: { cumDistributed: '0', cumAbsorbed: '0', retainedStock: '0', ratio: null },
      }),
    );
    expect(r.textOf('loop-lifetime-ratio')).toBe(L.notApplicable);
    // The amounts behind it are real zeros, and are stated as such.
    expect(r.textOf('loop-cum-distributed')).toBe('0');
  });

  it('a mixed window keeps each day’s own answer', () => {
    const r = render(
      loop({ daily: [day({ dayId: 1, ratio: 0.25 }), quietDay({ dayId: 2, date: '2026-10-05' })] }),
    );
    expect(r.textOf('loop-ratio-1')).toBe('25%');
    expect(r.textOf('loop-ratio-2')).toBe(L.notApplicable);
  });
});

describe('LoopClosure — conservative, so rounded down', () => {
  it('never rounds a daily proportion up', () => {
    const r = render(loop({ daily: [day({ ratio: 0.9995 })] }));
    expect(r.textOf('loop-ratio-20730')).toBe('99.9%');
  });

  it('never rounds the lifetime proportion up', () => {
    const r = render(
      loop({ cumulative: { cumDistributed: tok(100), cumAbsorbed: tok(5), retainedStock: tok(40), ratio: 0.456789 } }),
    );
    expect(r.textOf('loop-lifetime-ratio')).toBe('45.6%');
  });

  it.each([0.000999, 0.000001])(
    'labels a positive daily proportion of %s as below a tenth of a percent, never "0%"',
    (ratio) => {
      const r = render(loop({ daily: [day({ ratio })] }));
      expect(r.textOf('loop-ratio-20730')).toBe(copy.recycling.shareBelowPrecision('0.1'));
      expect(r.textOf('loop-ratio-20730')).toBe('less than 0.1%');
    },
  );

  it.each([0.000999, 0.000001])(
    'labels a positive lifetime proportion of %s as below a tenth of a percent, never "0%"',
    (ratio) => {
      const r = render(
        loop({ cumulative: { cumDistributed: tok(100), cumAbsorbed: tok(5), retainedStock: tok(40), ratio } }),
      );
      expect(r.textOf('loop-lifetime-ratio')).toBe('less than 0.1%');
    },
  );

  it('a genuinely zero proportion is still "0%"', () => {
    const r = render(loop({ daily: [day({ netVaultDelivered: '0', absorbed: '0', ratio: 0 })] }));
    expect(r.textOf('loop-ratio-20730')).toBe('0%');
  });

  it('does not clamp a proportion above 100% (absorption is not bounded by payout)', () => {
    const r = render(loop({ daily: [day({ ratio: 1.5 })] }));
    expect(r.textOf('loop-ratio-20730')).toBe('150%');
  });
});

describe('LoopClosure — figures', () => {
  it('shows every amount the lifetime proportion is built from', () => {
    const r = render(loop());
    expect(r.textOf('loop-retained-stock')).toBe('40');
    expect(r.textOf('loop-cum-absorbed')).toBe('5');
    expect(r.textOf('loop-cum-distributed')).toBe('100');
    expect(r.textOf('loop-lifetime-ratio')).toBe('45%');
  });

  it('shows each day’s paid-out, kept and absorbed amounts', () => {
    const r = render(loop());
    expect(r.textOf('loop-distributed-20730')).toBe('10');
    expect(r.textOf('loop-kept-20730')).toBe('4');
    expect(r.textOf('loop-absorbed-20730')).toBe('1');
  });

  it('labels a positive amount below the precision, never 0', () => {
    const r = render(loop({ daily: [day({ absorbed: '1' })] }));
    expect(r.textOf('loop-absorbed-20730')).toBe(copy.recycling.belowPrecision('0.0001'));
  });

  it('formats in the reader’s locale', () => {
    const r = render(
      loop({ cumulative: { cumDistributed: (1234n * 10n ** 18n).toString(), cumAbsorbed: '0', retainedStock: '0', ratio: 0 } }),
      'de',
    );
    expect(r.textOf('loop-cum-distributed')).toBe('1.234');
  });
});

describe('LoopClosure — the two measures, and which day', () => {
  it('states that the daily flow and lifetime stock are different quantities', () => {
    const r = render(loop());
    expect(r.textOf('loop-measures-note')).toBe(L.measuresNote);
    expect(r.textOf('loop-lower-bound-note')).toBe(L.lowerBoundNote);
  });

  it('shows the indexer’s own UTC date verbatim, labelled as a calendar day', () => {
    const r = render(loop({ daily: [day({ dayId: 20730, date: '2026-10-04' })] }));
    expect(r.textOf('loop-date-20730')).toBe('2026-10-04');
    expect(r.text).toContain(L.colDay);
    // …and says these are not the recycling account's programme days.
    expect(r.textOf('loop-days-note')).toBe(L.daysNote);
  });

  it('discloses the window and that quiet days are included', () => {
    expect(render(loop()).textOf('loop-window')).toBe(L.windowNote(30));
  });
});

describe('LoopClosure — a day not yet recorded is not a day of nothing (#1349 M5)', () => {
  // The window as the indexer serves it two days into a lag: a complete
  // quiet day, the day the record stops in, then days it has not reached.
  const lagging = () =>
    loop({
      daily: [
        quietDay({ dayId: 20730, date: '2026-10-04' }),
        partialDay({ dayId: 20731, date: '2026-10-05', distributed: '0', netVaultDelivered: '0', absorbed: '0' }),
        unrecordedDay({ dayId: 20732, date: '2026-10-06' }),
        unrecordedDay({ dayId: 20733, date: '2026-10-07' }),
      ],
    });

  it('shows the series’ as-of moment', () => {
    expect(render(lagging()).textOf('loop-recorded-before')).toBe(L.recordedBefore(RECORDED_BEFORE));
  });

  it('a day the record has not reached says "not yet recorded" in every cell — never 0', () => {
    const r = render(lagging());
    for (const cell of ['distributed', 'kept', 'absorbed', 'ratio']) {
      expect(r.textOf(`loop-${cell}-20732`)).toBe(L.notRecorded);
      expect(r.textOf(`loop-${cell}-20733`)).toBe(L.notRecorded);
    }
    expect(r.textOf('loop-ratio-20733')).not.toBe(L.notApplicable);
  });

  it('a day still being recorded shows its amounts so far, labelled, and no proportion', () => {
    const r = render(lagging());
    expect(r.textOf('loop-status-20731')).toBe(L.dayPartial);
    expect(r.textOf('loop-distributed-20731')).toBe('0');
    // Not "not applicable — nothing paid out": the day is not over.
    expect(r.textOf('loop-ratio-20731')).toBe(L.ratioNotFinal);
  });

  it('a partial day that HAS paid out still shows no proportion yet', () => {
    const r = render(loop({ daily: [partialDay({ dayId: 20733, date: '2026-10-07' })] }));
    expect(r.textOf('loop-distributed-20733')).toBe('10');
    expect(r.textOf('loop-ratio-20733')).toBe(L.ratioNotFinal);
  });

  it('straddle: a COMPLETE quiet day keeps "not applicable — nothing paid out"', () => {
    const r = render(lagging());
    expect(r.textOf('loop-ratio-20730')).toBe(L.notApplicable);
    expect(r.has('loop-status-20730')).toBe(false);
  });

  it('with no recorded moment, it says so — and every day is unrecorded', () => {
    const r = render(
      loop({ recordedBefore: null, daily: [unrecordedDay({ dayId: 20733, date: '2026-10-07' })] }),
    );
    expect(r.textOf('loop-recorded-before')).toBe(L.recordedBeforeUnknown);
    expect(r.textOf('loop-distributed-20733')).toBe(L.notRecorded);
  });
});

describe('LoopClosure — a malformed payload withholds only this section', () => {
  it.each([
    ['a failed read', null],
    ['a malformed amount', loop({ daily: [day({ distributed: '1.0' })] })],
    ['a ratio on a zero-distribution day', loop({ daily: [quietDay({ ratio: 0 })] })],
    ['a missing ratio on a day that paid out', loop({ daily: [day({ ratio: null })] })],
    ['a malformed date', loop({ daily: [day({ date: 'yesterday' })] })],
    // An indexer that predates `status` pads unknown days with zeros it
    // cannot tell apart from recorded ones; refused, not shown as facts.
    ['a day with no status', loop({ daily: [day({ status: undefined })] })],
    ['a response with no recorded moment', loop({ recordedBefore: undefined })],
    ['a ratio on a partial day', loop({ daily: [partialDay({ ratio: 0.5 })] })],
    ['a zero on an unrecorded day', loop({ daily: [unrecordedDay({ distributed: '0' })] })],
    ['a complete day after an unrecorded one', loop({ daily: [unrecordedDay({ dayId: 1 }), day({ dayId: 2 })] })],
    ['two partial days', loop({ daily: [partialDay({ dayId: 1 }), partialDay({ dayId: 2 })] })],
    ['a known day with no recorded moment', loop({ recordedBefore: null })],
  ])('%s → unavailable, no figures', (_why, raw) => {
    const r = render(raw);
    expect(r.textOf('loop-unavailable')).toBe(L.unavailable);
    expect(r.has('loop-lifetime-ratio')).toBe(false);
  });
});

describe('LoopClosure — posture', () => {
  const renderState = (state: LoopClosureState) =>
    renderMarkup(createElement(LoopClosureView, { state, locale: 'en' }));

  it('keeps the #loop-closure anchor in every state', () => {
    expect(renderState({ status: 'loading' }).hasId('loop-closure')).toBe(true);
    expect(renderState({ status: 'unavailable' }).hasId('loop-closure')).toBe(true);
    expect(render(loop()).hasId('loop-closure')).toBe(true);
  });

  it('loading says loading — not unavailable, not zeros', () => {
    const r = renderState({ status: 'loading' });
    expect(r.text).toContain(L.loading);
    expect(r.has('loop-unavailable')).toBe(false);
    expect(r.has('loop-lifetime-ratio')).toBe(false);
  });

  it('carries no rate, return or yield wording (RL-6)', () => {
    expect(render(loop()).html.toLowerCase()).not.toMatch(/\bapr\b|\bapy\b|yield|income|interest/);
  });
});
