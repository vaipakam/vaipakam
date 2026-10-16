/**
 * M5 (#1218 / #1349) — the recycling account on /analytics.
 *
 * Ported from the retired dashboard's suite
 * (`apps/defi/test/components/RecyclingAccount.test.tsx` at 008405887^),
 * one `it` per original case, in the original order and describe blocks.
 * Where the new surface deliberately differs the case says so — chiefly,
 * a withheld cell now NAMES its reason instead of being left blank (a
 * blank reads as zero to anyone who skips the footnote), and the backing
 * verdict is the indexer's, not one this page computes.
 *
 * These pin HONESTY properties, not layout. Each test is one way a refusal
 * could reach the screen as a zero, a dash or a blank.
 *
 * Rendering: the app's vitest runs in `node` with no DOM library, so the
 * pure view is rendered with `react-dom/server` and queried by test id.
 * Each payload goes through the real `parseRecyclingSeries`, exactly as
 * the container's fetch does, so validation is exercised end to end.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  recycleBackingVerdict,
  type RecycleBackingInputs,
} from '@vaipakam/contracts/recycle-backing';
import { copy } from '../../content/copy';
import { parseRecyclingSeries } from '../../data/recycling';
import {
  RecyclingAccountView,
  type RecyclingAccountState,
} from './RecyclingAccount';
import { renderMarkup } from './staticMarkup';

/** Whole-token amount as a wei string — large enough to render at 4 dp. */
const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString();

type Obj = Record<string, unknown>;

const day = (over: Obj = {}) => ({
  dayId: 1,
  stamped: true,
  armed: true,
  estimate: false,
  origin: 'event',
  scheduleFloor: '1000',
  recycledBudget: '250',
  aBar: '10',
  marginBps: 1000,
  freshDrawdown: '900',
  netEmission: '900',
  selfFundingRatio: 0.2,
  absorbedLocal: '5',
  absorbedMirror: '0',
  absorbed: '5',
  ...over,
});

/** A day that has not been finalized, in the exact shape the indexer serves. */
const openDay = (over: Obj = {}) =>
  day({
    stamped: false,
    armed: false,
    estimate: false,
    scheduleFloor: null,
    recycledBudget: null,
    freshDrawdown: null,
    netEmission: null,
    selfFundingRatio: null,
    absorbed: null,
    ...over,
  });

/**
 * A backing block as the indexer builds it. The verdict is produced by the
 * SAME shared function the indexer uses, so every fixture is a payload the
 * indexer can actually emit; pass `backed` explicitly to override it.
 */
const backing = (over: Obj = {}): Obj => {
  const base: Obj = {
    vpfiBalance: tok(100),
    bucket: tok(40),
    unearmarked: tok(60),
    outstandingRecycled: tok(10),
    paidOutRecycled: tok(2),
    keeperBudget: tok(5),
    platformRetained: tok(25),
    releasedRemitStranded: '0',
    strandedRecoveryReserved: '0',
    recoveryPositionReserved: '0',
    custodyActivated: false,
    holderBalanceKnown: true,
    holderBalance: '0',
    holderAttributed: '0',
    blockNumber: '12345678',
    diamond: '0xd89f0000000000000000000000000000000000ab',
    unavailableReason: null,
    asOf: '2026-08-03T00:00:00.000Z',
    ...over,
  };
  if (!('backed' in over)) {
    try {
      base.backed = recycleBackingVerdict(base as unknown as RecycleBackingInputs);
    } catch {
      base.backed = null; // a deliberately corrupt fixture
    }
  }
  return base;
};

const cumulative = (over: Obj = {}) => ({
  absorbed: '5',
  absorbedPreLaunch: '0',
  absorbedLocal: '5',
  absorbedMirror: '0',
  freshDrawdown: '900',
  recycledBudget: '250',
  runwayExtensionDays: 3,
  runwayUnavailableReason: null,
  selfFunded: false,
  ...over,
});

const series = (over: Obj = {}): Obj => ({
  chainId: 8453,
  days: 30,
  fromDay: 1,
  toDay: 1,
  scope: 'global',
  coverageFromDay: 1,
  daily: [day()],
  backing: backing(),
  cumulative: cumulative(),
  ...over,
});

/** The view's state for a fetched body — exactly the container's mapping. */
function stateFor(raw: unknown): RecyclingAccountState {
  const data = raw === null ? null : parseRecyclingSeries(raw);
  return data ? { status: 'ready', data } : { status: 'unavailable' };
}

const render = (raw: unknown, locale = 'en') =>
  renderMarkup(createElement(RecyclingAccountView, { state: stateFor(raw), locale }));

const renderState = (state: RecyclingAccountState) =>
  renderMarkup(createElement(RecyclingAccountView, { state, locale: 'en' }));

/** A withheld backing block, as the indexer serves one. */
const noBacking = (reason: string) => ({
  vpfiBalance: null,
  bucket: null,
  unearmarked: null,
  outstandingRecycled: null,
  paidOutRecycled: null,
  keeperBudget: null,
  platformRetained: null,
  releasedRemitStranded: null,
  strandedRecoveryReserved: null,
  recoveryPositionReserved: null,
  custodyActivated: null,
  holderBalanceKnown: null,
  holderBalance: null,
  holderAttributed: null,
  backed: null,
  blockNumber: null,
  diamond: null,
  unavailableReason: reason,
  asOf: null,
});

const R = copy.recycling;

/* ═══════════════════ Ported from the retired suite ═══════════════════ */

describe('RecyclingAccount — refusals must survive rendering', () => {
  it('shows nothing rather than zeros when the read fails', () => {
    const r = render(null);
    expect(r.textOf('recycling-unavailable')).toBe(R.unavailable);
    // A zeroed account would look like a quiet programme.
    expect(r.has('recycling-absorbed')).toBe(false);
  });

  it("names an UNARMED day's drawn cell as not committed — never 0 or blank", () => {
    // Retired surface: an empty cell. Now the cell says why it is empty.
    const r = render(
      series({ daily: [day({ dayId: 7, armed: false, estimate: true, netEmission: null })] }),
    );
    expect(r.textOf('drawn-7')).toBe(R.cellNotCommitted);
    expect(r.has('estimate-7')).toBe(true);
  });

  it("names a PARTIAL day's combined absorption as pending — never 0 or blank", () => {
    // The retired fixture was a finalized day with `absorbed: null`, which
    // the indexer never serves (and which the read layer now refuses); the
    // partial case is an open day.
    const r = render(series({ daily: [openDay({ dayId: 9 })] }));
    expect(r.textOf('absorbed-9')).toBe(R.cellCombinedPending);
  });

  it('renders the REASON a runway is withheld, not a dash', () => {
    const r = render(
      series({
        cumulative: cumulative({
          runwayExtensionDays: null,
          runwayUnavailableReason: 'backfilled-mirror-absorption-not-decomposable',
        }),
      }),
    );
    expect(r.textOf('recycling-runway')).toBe(R.runwayBackfilledMirror);
    expect(r.textOf('recycling-runway')).not.toBe('—');
  });

  it('says so when this deployment has finalized no day itself', () => {
    const r = render(series({ scope: 'local-only' }));
    expect(r.textOf('recycling-scope-note')).toBe(R.scopeLocalOnly);
  });

  it('publishes the pre-launch stock as its own figure', () => {
    const r = render(series({ cumulative: cumulative({ absorbedPreLaunch: tok(42) }) }));
    expect(r.textOf('recycling-prelaunch')).toBe('42');
  });

  it('states where the records begin rather than implying quiet days', () => {
    // The table starts AT the coverage boundary, so the boundary is the gap
    // a reader sees at its top.
    const r = render(
      series({ coverageFromDay: 300, fromDay: 300, toDay: 300, daily: [day({ dayId: 300 })] }),
    );
    expect(r.textOf('recycling-coverage')).toContain('300');
  });

  it('states no records gap when coverage starts at programme day 0', () => {
    // Day 0 is the first programme day: there are no earlier days, so
    // "earlier days are not shown" would describe a gap that does not exist.
    const r = render(
      series({ coverageFromDay: 0, fromDay: 0, toDay: 0, daily: [day({ dayId: 0 })] }),
    );
    expect(r.has('recycling-coverage')).toBe(false);
  });

  it('leaves the coverage gap to the window note when the window cut the table later', () => {
    // Records begin at day 5, but the table starts at day 40: the days
    // before 40 are absent because of the window, not the coverage.
    const r = render(
      series({ coverageFromDay: 5, fromDay: 40, toDay: 40, daily: [day({ dayId: 40 })] }),
    );
    expect(r.has('recycling-coverage')).toBe(false);
    expect(r.textOf('recycling-window')).toContain(R.windowSingleDay('40'));
  });

  it('says no day is recorded rather than rendering an empty table silently', () => {
    const r = render(series({ daily: [] }));
    expect(r.textOf('recycling-no-days')).toBe(R.noRecordedDays);
  });
});

describe('RecyclingAccount — M5 content requirements', () => {
  it('formats wei rather than printing the raw integer', () => {
    const r = render(series({ daily: [day({ dayId: 1, scheduleFloor: tok(1234) })] }));
    expect(r.textOf('recycling-day-1')).toContain('1,234');
    expect(r.textOf('recycling-day-1')).not.toContain('1234000000000000000000');
  });

  it('WITHHOLDS global totals on a local-only deployment — as declined, with the reason', () => {
    const r = render(
      series({
        scope: 'local-only',
        cumulative: cumulative({ absorbed: '0', freshDrawdown: '0', absorbedLocal: tok(7) }),
      }),
    );
    expect(r.has('recycling-scope-note')).toBe(true);
    // A zero here is exactly the "looks like a quiet programme" failure.
    expect(r.has('recycling-absorbed')).toBe(false);
    expect(r.has('recycling-drawn')).toBe(false);
    // New: the declined totals SAY they are declined, and why.
    expect(r.textOf('recycling-absorbed-declined')).toBe(R.totalDeclined);
    expect(r.textOf('recycling-drawn-declined')).toBe(R.totalDeclined);
    // …while what WAS observed locally is shown.
    expect(r.textOf('recycling-absorbed-local')).toBe('7');
  });

  it('publishes the local / mirror split, not just a combined figure', () => {
    const r = render(
      series({ cumulative: cumulative({ absorbedLocal: tok(3), absorbedMirror: tok(4) }) }),
    );
    expect(r.textOf('recycling-absorbed-local')).toBe('3');
    expect(r.textOf('recycling-absorbed-mirror')).toBe('4');
  });

  it('LISTS an unfinalized day so its live absorption is visible', () => {
    const r = render(series({ daily: [openDay({ dayId: 11, absorbedLocal: tok(2) })] }));
    expect(r.has('recycling-day-11')).toBe(true);
    expect(r.textOf('drawn-11')).toBe(R.cellNoPool);
    // The COMBINED figure is withheld until the day closes…
    expect(r.textOf('absorbed-11')).toBe(R.cellCombinedPending);
    // …but the live component is the whole reason the row is listed.
    expect(r.textOf('absorbed-local-11')).toBe('2');
  });

  it('WITHHOLDS the mirror component until the day closes', () => {
    // A rendered 0 under "Absorbed elsewhere" would state that no other
    // chain absorbed anything — the one thing an open day cannot know.
    const r = render(
      series({ daily: [openDay({ dayId: 12, absorbedLocal: tok(2), absorbedMirror: '0' })] }),
    );
    expect(r.textOf('absorbed-mirror-12')).toBe(R.cellMirrorPending);
    expect(r.textOf('absorbed-local-12')).toBe('2');
  });

  it('shows the mirror component once the day HAS closed', () => {
    const r = render(
      series({ daily: [day({ dayId: 13, absorbedMirror: tok(9), absorbed: tok(9) })] }),
    );
    expect(r.textOf('absorbed-mirror-13')).toBe('9');
  });

  it('marks a recomputed day as reconstructed, not recorded', () => {
    const r = render(series({ daily: [day({ dayId: 4, origin: 'backfill' })] }));
    expect(r.textOf('recomputed-4')).toBe(R.recomputedBadge);
  });

  it('shows the self-funded share the endpoint already computes', () => {
    const r = render(series({ daily: [day({ dayId: 5, selfFundingRatio: 0.25 })] }));
    expect(r.textOf('selffunded-5')).toBe('25%');
  });

  it('explains the estimate badge only when a row on screen carries it', () => {
    const without = render(series());
    expect(without.has('recycling-footnote-estimate')).toBe(false);
    const withIt = render(
      series({ daily: [day({ dayId: 7, armed: false, estimate: true, netEmission: null })] }),
    );
    expect(withIt.textOf('recycling-footnote-estimate')).toBe(R.footnoteEstimate);
  });

  it('explains the recomputed badge only when a row on screen carries it', () => {
    const without = render(series());
    expect(without.has('recycling-footnote-recomputed')).toBe(false);
    const withIt = render(series({ daily: [day({ dayId: 4, origin: 'backfill' })] }));
    expect(withIt.textOf('recycling-footnote-recomputed')).toBe(R.footnoteRecomputed);
    expect(withIt.has('recycling-footnote-estimate')).toBe(false);
  });

  it('always states how cells and precision work — that holds on every render', () => {
    expect(render(series()).textOf('recycling-footnote-cells')).toBe(R.footnoteCells);
    expect(render(series({ daily: [] })).textOf('recycling-footnote-cells')).toBe(R.footnoteCells);
  });

  it("states the drawn figure's limits ON THIS SURFACE", () => {
    expect(render(series()).textOf('recycling-drawn-bounds')).toBe(R.drawnBounds);
  });

  it("states the drawn figure's limits on a local-only deployment once a day shows a drawn cell", () => {
    const r = render(series({ scope: 'local-only' }));
    expect(r.textOf('drawn-1')).not.toBe(R.cellNotCommitted);
    expect(r.textOf('recycling-drawn-bounds')).toBe(R.drawnBounds);
  });

  it("omits the drawn figure's limits where no drawn figure is on screen", () => {
    // Local-only: the drawn total is declined, and an open day and an
    // uncommitted day carry no drawn amount — the caveat would qualify a
    // figure the page is withholding.
    const localOnly = render(
      series({
        scope: 'local-only',
        fromDay: 1,
        toDay: 2,
        daily: [
          openDay({ dayId: 1 }),
          day({ dayId: 2, armed: false, estimate: true, netEmission: null }),
        ],
      }),
    );
    expect(localOnly.has('recycling-drawn-declined')).toBe(true);
    expect(localOnly.has('recycling-drawn-bounds')).toBe(false);
    const empty = render(
      series({ scope: 'empty', daily: [], fromDay: null, toDay: null, coverageFromDay: null }),
    );
    expect(empty.has('recycling-drawn-bounds')).toBe(false);
  });

  it('discloses the window as the day range served, not the number of days requested', () => {
    // 30 days requested, five served: the note names the five.
    const r = render(
      series({
        days: 30,
        fromDay: 1,
        toDay: 5,
        daily: [1, 2, 3, 4, 5].map((dayId) => day({ dayId })),
      }),
    );
    const text = r.textOf('recycling-window');
    expect(text).toBe(`${R.windowRange('1', '5')} ${R.windowTotalsWholeProgramme}`);
    expect(text).not.toContain('30');
  });

  it('does not call the totals programme-wide where they are declined', () => {
    const r = render(series({ scope: 'local-only' }));
    const text = r.textOf('recycling-window');
    expect(text).toBe(`${R.windowSingleDay('1')} ${R.windowTotalsRecordedHere}`);
    expect(text).not.toContain(R.windowTotalsWholeProgramme);
  });

  it('carries no window note when no day is served', () => {
    const r = render(
      series({ scope: 'empty', daily: [], fromDay: null, toDay: null, coverageFromDay: null }),
    );
    expect(r.has('recycling-window')).toBe(false);
  });
});

describe('RecyclingAccount — a positive figure is never rendered as zero', () => {
  it('marks a small nonzero amount below the display threshold', () => {
    const r = render(series({ cumulative: cumulative({ absorbedPreLaunch: '1' }) }));
    expect(r.textOf('recycling-prelaunch')).toBe(R.belowPrecision('0.0001'));
  });

  it('still renders a genuine zero as zero', () => {
    const r = render(series({ cumulative: cumulative({ absorbedPreLaunch: '0' }) }));
    expect(r.textOf('recycling-prelaunch')).toBe('0');
  });

  it('never rounds a partially self-funded day up to 100%', () => {
    const r = render(series({ daily: [day({ dayId: 8, selfFundingRatio: 0.9995 })] }));
    expect(r.textOf('selffunded-8')).not.toContain('100');
    expect(r.textOf('selffunded-8')).toBe('99.9%');
  });

  it('shows 100% only when the day genuinely reached it', () => {
    const r = render(series({ daily: [day({ dayId: 10, selfFundingRatio: 1 })] }));
    expect(r.textOf('selffunded-10')).toBe('100%');
  });

  it.each([0.000999, 0.000001])(
    'labels a positive self-funded share of %s as below a tenth of a percent, never "0%"',
    (ratio) => {
      // An early day with a small recycled portion: the share floors to
      // 0 tenths, and the cell must still say it is positive.
      const r = render(
        series({ daily: [day({ dayId: 11, recycledBudget: '1', selfFundingRatio: ratio })] }),
      );
      expect(r.textOf('selffunded-11')).toBe(R.shareBelowPrecision('0.1'));
      expect(r.textOf('selffunded-11')).toBe('less than 0.1%');
    },
  );

  it('a genuinely zero self-funded share is still "0%"', () => {
    const r = render(series({ daily: [day({ dayId: 12, recycledBudget: '0', selfFundingRatio: 0 })] }));
    expect(r.textOf('selffunded-12')).toBe('0%');
  });

  it('labels a positive runway below a tenth of a day, never "About 0 days"', () => {
    const r = render(series({ cumulative: cumulative({ runwayExtensionDays: 0.04 }) }));
    expect(r.textOf('recycling-runway')).toBe(R.runwayBelowPrecision('0.1'));
    expect(r.textOf('recycling-runway')).not.toBe(R.runwayDays('0'));
  });

  it('the runway label follows the reader’s number format', () => {
    const r = render(series({ cumulative: cumulative({ runwayExtensionDays: 0.000001 }) }), 'de');
    expect(r.textOf('recycling-runway')).toBe(R.runwayBelowPrecision('0,1'));
  });
});

describe('RecyclingAccount — a corrupt payload degrades narrowly', () => {
  it('falls back to unavailable rather than throwing through the boundary', () => {
    const r = render(series({ cumulative: cumulative({ absorbedLocal: 'not-a-number' }) }));
    expect(r.textOf('recycling-unavailable')).toBe(R.unavailable);
  });

  it('rejects a corrupt DAILY amount too, not only a cumulative one', () => {
    const r = render(series({ daily: [day({ dayId: 3, scheduleFloor: '12,34' })] }));
    expect(r.has('recycling-unavailable')).toBe(true);
  });

  it('does NOT substitute a zero for the corrupt field', () => {
    const r = render(series({ cumulative: cumulative({ absorbedLocal: 'x' }) }));
    expect(r.has('recycling-unavailable')).toBe(true);
    expect(r.has('recycling-absorbed-local')).toBe(false);
  });
});

describe('RecyclingAccount — per-day provenance and scope', () => {
  it('keeps the daily table scrollable on a narrow viewport', () => {
    const r = render(series());
    // The app's scroller class (the retired surface used `pd-table-wrap`).
    expect(r.attr('recycling-table-wrap', 'class')).toContain('rc-table-wrap');
    expect(r.hasClass('table', 'recycling-days')).toBe(true);
  });

  it("shows each day's local and mirror components, not only the combined", () => {
    const r = render(
      series({
        daily: [day({ dayId: 6, absorbedLocal: tok(3), absorbedMirror: tok(4), absorbed: tok(7) })],
      }),
    );
    expect(r.textOf('absorbed-local-6')).toBe('3');
    expect(r.textOf('absorbed-mirror-6')).toBe('4');
    expect(r.textOf('absorbed-6')).toBe('7');
  });

  it('explains the difference WHEN the parts exceed the combined total', () => {
    const r = render(
      series({ cumulative: cumulative({ absorbed: tok(5), absorbedLocal: tok(5), absorbedMirror: tok(3) }) }),
    );
    expect(r.textOf('recycling-split-scope')).toBe(R.splitScopeNote);
  });

  it('does NOT claim a divergence when the figures agree', () => {
    const r = render(
      series({ cumulative: cumulative({ absorbed: tok(8), absorbedLocal: tok(5), absorbedMirror: tok(3) }) }),
    );
    expect(r.has('recycling-absorbed')).toBe(true);
    expect(r.has('recycling-split-scope')).toBe(false);
  });

  it('does NOT claim a divergence too small to SEE', () => {
    // 3 wei of excess is invisible at four decimals in all three cells.
    const r = render(
      series({ cumulative: cumulative({ absorbed: '5', absorbedLocal: '5', absorbedMirror: '3' }) }),
    );
    expect(r.has('recycling-absorbed')).toBe(true);
    expect(r.has('recycling-split-scope')).toBe(false);
  });

  it('explains a below-precision part beside a combined total of exactly 0', () => {
    // Every units count is 0 here, but the reader sees "less than 0.0001"
    // and "0" over a total of "0" — a visible excess.
    const r = render(
      series({ cumulative: cumulative({ absorbed: '0', absorbedLocal: '1', absorbedMirror: '0' }) }),
    );
    expect(r.textOf('recycling-absorbed')).toBe('0');
    expect(r.textOf('recycling-absorbed-local')).toBe(R.belowPrecision('0.0001'));
    expect(r.textOf('recycling-split-scope')).toBe(R.splitScopeNote);
  });

  it('does NOT explain a combined total it is not showing', () => {
    const r = render(
      series({
        scope: 'local-only',
        cumulative: cumulative({ absorbed: '0', absorbedLocal: tok(5), absorbedMirror: tok(3) }),
      }),
    );
    expect(r.has('recycling-scope-note')).toBe(true);
    expect(r.has('recycling-absorbed')).toBe(false);
    expect(r.has('recycling-split-scope')).toBe(false);
  });
});

describe('RecyclingAccount — the reserve is never published alone', () => {
  it('publishes the retained reserve WITH the balance actually behind it', () => {
    const r = render(series());
    expect(r.textOf('recycling-retained')).toBe('25');
    expect(r.textOf('recycling-balance')).toBe('100');
    expect(r.textOf('recycling-unearmarked')).toBe('60');
    expect(r.textOf('recycling-bucket')).toBe('40');
  });

  it('withholds the reserve ENTIRELY when the chain could not be read', () => {
    const r = render(series({ backing: noBacking('read-failed') }));
    expect(r.has('recycling-backing-unavailable')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
    expect(r.has('recycling-balance')).toBe(false);
  });

  it('states WHY the reserve is missing, since a dash reads as zero', () => {
    // A code this build does not recognise is still shown, as a reason.
    const r = render(series({ backing: noBacking('no-rpc-endpoint-configured') }));
    expect(r.textOf('recycling-backing-unavailable')).toContain('no-rpc-endpoint-configured');
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingUnavailable);
  });

  it('degrades rather than crashing when an older indexer omits the block', () => {
    const s = series();
    delete s.backing;
    const r = render(s);
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingReasonNotServed);
    expect(r.has('recycling-absorbed-local')).toBe(true);
  });

  it('a corrupt BACKING amount withholds the BLOCK, not the account', () => {
    const r = render(series({ backing: backing({ platformRetained: 'not-a-number' }) }));
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingReasonMalformed);
    expect(r.has('recycling-absorbed-local')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('a corrupt DAILY amount still withholds the whole account', () => {
    const r = render(series({ daily: [day({ dayId: 3, scheduleFloor: '1,2' })] }));
    expect(r.has('recycling-unavailable')).toBe(true);
  });
});

describe('RecyclingAccount — a floored figure must not hide a shortfall', () => {
  it('says the pool is SHORT when the balance is below what it must cover', () => {
    const r = render(
      series({
        backing: backing({
          vpfiBalance: tok(95),
          bucket: tok(100),
          unearmarked: '0', // floored — looks identical to fully consumed
          outstandingRecycled: tok(90),
          keeperBudget: '0',
          platformRetained: tok(10),
        }),
      }),
    );
    expect(r.textOf('recycling-backed')).toBe(R.backedShortDiamond('5'));
    expect(r.attr('recycling-backed', 'data-verdict')).toBe('short');
  });

  it('says the pool IS backed when the balance covers it', () => {
    const r = render(series());
    expect(r.textOf('recycling-backed')).toBe(R.backedYesDiamond);
    expect(r.attr('recycling-backed', 'data-verdict')).toBe('yes');
  });

  it('does not distinguish exactly-consumed from short by the floored value alone', () => {
    const r = render(
      series({ backing: backing({ vpfiBalance: tok(100), bucket: tok(100), unearmarked: '0' }) }),
    );
    expect(r.textOf('recycling-unearmarked')).toBe('0');
    expect(r.textOf('recycling-backed')).toBe(R.backedYesDiamond);
  });

  it('withholds the WHOLE block when any displayed member is null', () => {
    const r = render(series({ backing: backing({ vpfiBalance: null }) }));
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingReasonIncomplete);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('withholds the block when the BUCKET is null, not just the balance', () => {
    const r = render(series({ backing: backing({ bucket: null }) }));
    expect(r.has('recycling-backing-unavailable')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('never claims a shortfall of ZERO for a real shortfall', () => {
    const r = render(
      series({
        backing: backing({
          vpfiBalance: tok(100),
          bucket: (100n * 10n ** 18n + 3n).toString(), // 3 wei short
          unearmarked: '0',
          outstandingRecycled: '0',
          keeperBudget: '0',
          platformRetained: (100n * 10n ** 18n + 3n).toString(),
        }),
      }),
    );
    const text = r.textOf('recycling-backed');
    expect(text).toBe(R.backedShortDiamond(R.belowPrecision('0.0001')));
    expect(text).not.toMatch(/short by 0\b/);
  });

  it('publishes stranded value so it does not read as a depleted reserve', () => {
    const r = render(series({ backing: backing({ releasedRemitStranded: tok(7) }) }));
    expect(r.textOf('recycling-stranded')).toBe('7');
  });

  it('omits the stranded row entirely when there is none', () => {
    const r = render(series());
    expect(r.has('recycling-backed')).toBe(true);
    expect(r.has('recycling-stranded')).toBe(false);
  });

  it('withholds the block when the STRANDED term is null', () => {
    const r = render(series({ backing: backing({ releasedRemitStranded: null }) }));
    expect(r.has('recycling-backing-unavailable')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('RENDERS the capture time, since the figures are not live', () => {
    expect(render(series()).textOf('recycling-asof')).toContain('2026-08-03T00:00:00.000Z');
  });

  it('withholds the whole block when no snapshot has been captured yet', () => {
    const r = render(series({ backing: noBacking('not-captured-yet') }));
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingReasonNotCaptured);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('withholds the block when the snapshot cannot say WHEN it was taken', () => {
    const r = render(series({ backing: backing({ asOf: null }) }));
    expect(r.has('recycling-backing-unavailable')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('withholds the block when the CHAIN has stopped moving', () => {
    const r = render(series({ backing: noBacking('chain-behind') }));
    expect(r.textOf('recycling-backing-unavailable')).toContain(R.backingReasonChainBehind);
    expect(r.has('recycling-retained')).toBe(false);
  });

  it('withholds the block when it cannot say WHOSE state it describes', () => {
    const r = render(series({ backing: backing({ diamond: null }) }));
    expect(r.has('recycling-backing-unavailable')).toBe(true);
    expect(r.has('recycling-retained')).toBe(false);
  });
});

/* ═══════════════════ New: the two fixed defects ═══════════════════ */

describe('RecyclingAccount — BOTH recovery reservations are published (defect 1)', () => {
  it('lists both reservations beside the remainder they are taken from', () => {
    const r = render(
      series({
        backing: backing({
          strandedRecoveryReserved: tok(3),
          recoveryPositionReserved: tok(2),
          unearmarked: tok(55),
        }),
      }),
    );
    expect(r.textOf('recycling-stranded-recovery')).toBe('3');
    expect(r.textOf('recycling-recovery-position')).toBe('2');
    expect(r.textOf('recycling-unearmarked')).toBe('55');
  });

  it('shows a zero reservation as zero, not hidden', () => {
    const r = render(series());
    expect(r.textOf('recycling-stranded-recovery')).toBe('0');
    expect(r.textOf('recycling-recovery-position')).toBe('0');
  });

  it('a reading that predates both shows each as not determinable — never 0', () => {
    const r = render(
      series({
        backing: backing({ strandedRecoveryReserved: null, recoveryPositionReserved: null }),
      }),
    );
    expect(r.textOf('recycling-stranded-recovery')).toBe(R.olderReading);
    expect(r.textOf('recycling-recovery-position')).toBe(R.olderReading);
    // …and the rest of the reading is still published.
    expect(r.textOf('recycling-retained')).toBe('25');
  });

  it('a reading missing ONE reservation shows only that one as not determinable', () => {
    const r = render(series({ backing: backing({ recoveryPositionReserved: null }) }));
    expect(r.textOf('recycling-stranded-recovery')).toBe('0');
    expect(r.textOf('recycling-recovery-position')).toBe(R.olderReading);
  });

  it('a pre-#1930 row that lacks the keys entirely reads the same as null', () => {
    const b = backing();
    delete b.strandedRecoveryReserved;
    delete b.recoveryPositionReserved;
    const r = render(series({ backing: b }));
    expect(r.textOf('recycling-stranded-recovery')).toBe(R.olderReading);
    expect(r.textOf('recycling-recovery-position')).toBe(R.olderReading);
  });

  it('lists every amount the retained reserve is the remainder of', () => {
    const r = render(series());
    expect(r.textOf('recycling-bucket')).toBe('40');
    expect(r.textOf('recycling-outstanding')).toBe('10');
    expect(r.textOf('recycling-keeper')).toBe('5');
    expect(r.textOf('recycling-retained-note')).toBe(R.retainedNote);
  });
});

describe('RecyclingAccount — the verdict is the indexer’s (defect 2)', () => {
  it('a balance that covers the pool but NOT the reservations is SHORT', () => {
    // The retired rule (`vpfiBalance >= bucket`) called this backed:
    // 100 ≥ 90. The pool AND both reservations are spoken for: 90 + 6 + 5.
    const r = render(
      series({
        backing: backing({
          vpfiBalance: tok(100),
          bucket: tok(90),
          strandedRecoveryReserved: tok(6),
          recoveryPositionReserved: tok(5),
          unearmarked: '0',
        }),
      }),
    );
    expect(r.textOf('recycling-backed')).toBe(R.backedShortDiamond('1'));
    expect(r.textOf('recycling-comparison')).toBe(R.comparisonDiamond);
  });

  it('rounds a Diamond-side shortfall UP — 25.00009 VPFI is never "short by 25"', () => {
    const r = render(
      series({
        backing: backing({
          vpfiBalance: tok(100),
          bucket: (125n * 10n ** 18n + 9n * 10n ** 13n).toString(),
          unearmarked: '0',
        }),
      }),
    );
    expect(r.textOf('recycling-backed')).toBe(R.backedShortDiamond('25.0001'));
  });

  it('does NOT compute a verdict the indexer did not publish', () => {
    // An older indexer serves no `backed`. Balance < bucket here, and the
    // retired page would have said "short" — this one says it cannot say.
    const b = backing({ vpfiBalance: tok(1), bucket: tok(100) });
    delete b.backed;
    const r = render(series({ backing: b }));
    expect(r.textOf('recycling-backed')).toBe(R.backedNotServed);
    expect(r.attr('recycling-backed', 'data-verdict')).toBe('undetermined');
    expect(r.has('recycling-comparison')).toBe(false);
  });

  it('shows the indexer’s answer even where the page’s own arithmetic would differ', () => {
    // The page states what was published; reconciling is the indexer's
    // job (and the shared function's). Here the indexer says backed.
    const r = render(
      series({
        backing: backing({
          vpfiBalance: tok(1),
          bucket: tok(100),
          backed: {
            determinable: true,
            relation: 'diamond',
            ok: true,
            diamondShortfall: null,
            holderShortfall: null,
            reason: null,
          },
        }),
      }),
    );
    expect(r.textOf('recycling-backed')).toBe(R.backedYesDiamond);
  });

  it('a malformed verdict withholds only the verdict', () => {
    const r = render(
      series({
        backing: backing({
          backed: {
            determinable: true,
            relation: 'diamond',
            ok: false,
            diamondShortfall: null, // a failing answer with no shortfall
            holderShortfall: null,
            reason: null,
          },
        }),
      }),
    );
    expect(r.textOf('recycling-backed')).toBe(R.backedMalformed);
    expect(r.textOf('recycling-retained')).toBe('25');
  });

  describe('after custody activation — the holder relation', () => {
    const activated = (over: Obj = {}) =>
      backing({
        custodyActivated: true,
        holderBalanceKnown: true,
        holderBalance: tok(50),
        holderAttributed: tok(40),
        vpfiBalance: tok(10),
        bucket: tok(40),
        strandedRecoveryReserved: tok(2),
        recoveryPositionReserved: tok(30),
        unearmarked: tok(8),
        ...over,
      });

    it('is backed when the holder covers its rows and the platform its reservation', () => {
      // The retired rule would have said SHORT: 10 < 40. Healthy here.
      const r = render(series({ backing: activated() }));
      expect(r.textOf('recycling-backed')).toBe(R.backedYesHolder);
      expect(r.textOf('recycling-comparison')).toBe(R.comparisonHolder);
      expect(r.textOf('recycling-custody')).toBe(R.custodyHolder);
    });

    it('shows the holder’s balance and attributed total', () => {
      const r = render(series({ backing: activated() }));
      expect(r.textOf('recycling-holder-balance')).toBe('50');
      expect(r.textOf('recycling-holder-attributed')).toBe('40');
      expect(r.textOf('recycling-unearmarked-note')).toBe(R.outsideBucketNoteHolder);
    });

    it('names the holder shortfall alone when only the holder is short', () => {
      const r = render(series({ backing: activated({ holderBalance: tok(30) }) }));
      expect(r.attr('recycling-backed', 'data-verdict')).toBe('short');
      expect(r.textOf('recycling-backed')).toContain(R.backedNo);
      expect(r.textOf('recycling-short-holder')).toBe(R.backedShortHolder('10'));
      expect(r.has('recycling-short-diamond')).toBe(false);
    });

    it('names the platform-side shortfall alone when only that leg fails', () => {
      const r = render(series({ backing: activated({ vpfiBalance: tok(1), unearmarked: '0' }) }));
      expect(r.textOf('recycling-short-diamond')).toBe(R.backedShortHolderDiamond('1'));
      expect(r.has('recycling-short-holder')).toBe(false);
    });

    it('names BOTH shortfalls when both legs fail', () => {
      const r = render(
        series({ backing: activated({ holderBalance: tok(39), vpfiBalance: '0', unearmarked: '0' }) }),
      );
      expect(r.textOf('recycling-short-holder')).toBe(R.backedShortHolder('1'));
      expect(r.textOf('recycling-short-diamond')).toBe(R.backedShortHolderDiamond('2'));
    });

    it('a dust holder shortfall is "less than 0.0001", never "0"', () => {
      const r = render(
        series({
          backing: activated({ holderBalance: (40n * 10n ** 18n - 1n).toString() }),
        }),
      );
      expect(r.textOf('recycling-short-holder')).toBe(
        R.backedShortHolder(R.belowPrecision('0.0001')),
      );
    });

    it('rounds a shortfall UP — 25.00009 VPFI is never shown as "short by 25"', () => {
      // Truncation would show the breach smaller than the indexer published.
      const r = render(
        series({
          backing: activated({
            holderBalance: tok(15),
            holderAttributed: (40n * 10n ** 18n + 9n * 10n ** 13n).toString(),
          }),
        }),
      );
      expect(r.textOf('recycling-short-holder')).toBe(R.backedShortHolder('25.0001'));
    });

    it('an unreadable holder balance is not determinable, with that reason', () => {
      const r = render(
        series({ backing: activated({ holderBalanceKnown: false, holderBalance: null }) }),
      );
      expect(r.textOf('recycling-holder-balance')).toBe(R.holderBalanceUnreadable);
      expect(r.textOf('recycling-backed')).toBe(R.backedHolderBalanceUnknown);
      expect(r.attr('recycling-backed', 'data-verdict')).toBe('undetermined');
      // The relation WAS chosen (custody is known), so it is still named.
      expect(r.textOf('recycling-comparison')).toBe(R.comparisonHolder);
    });

    it('an unreadable holder balance WITHHOLDS the reserve — never shown beside a balance that does not back it', () => {
      // Reserve 500 over a 6-VPFI platform balance: once custody has moved
      // the platform contract does not back the reserve, so publishing it
      // here is the counter-derived half shown alone.
      const r = render(
        series({
          backing: activated({
            holderBalanceKnown: false,
            holderBalance: null,
            platformRetained: tok(500),
            vpfiBalance: tok(6),
          }),
        }),
      );
      expect(r.has('recycling-retained')).toBe(false);
      expect(r.has('recycling-bucket')).toBe(false);
      expect(r.has('recycling-outstanding')).toBe(false);
      expect(r.has('recycling-keeper')).toBe(false);
      expect(r.has('recycling-retained-note')).toBe(false);
      expect(r.textOf('recycling-retained-withheld')).toBe(R.retainedWithheldHolderUnread);
      expect(r.attr('recycling-retained-withheld', 'class')).toContain('rc-refusal');
      // The attributed total is the same counter-derived side: withheld too.
      expect(r.textOf('recycling-holder-attributed')).toBe(R.holderAttributedWithheld);
      // The platform-contract figures and the verdict stay.
      expect(r.textOf('recycling-balance')).toBe('6');
      expect(r.has('recycling-unearmarked')).toBe(true);
      expect(r.textOf('recycling-backed')).toBe(R.backedHolderBalanceUnknown);
    });

    it('a holder balance flagged known but not served is withheld the same way', () => {
      const r = render(series({ backing: activated({ holderBalanceKnown: true, holderBalance: null }) }));
      expect(r.has('recycling-retained')).toBe(false);
      expect(r.textOf('recycling-retained-withheld')).toBe(R.retainedWithheldHolderUnread);
      expect(r.textOf('recycling-holder-balance')).toBe(R.holderNotDeterminable);
    });

    it('a READABLE holder balance publishes the reserve with it', () => {
      const r = render(series({ backing: activated() }));
      expect(r.textOf('recycling-retained')).toBe('25');
      expect(r.has('recycling-retained-withheld')).toBe(false);
      expect(r.textOf('recycling-retained-note')).toBe(R.retainedNote);
    });

    it('a missing subtracted amount is not determinable, with that reason', () => {
      const r = render(series({ backing: activated({ strandedRecoveryReserved: null }) }));
      expect(r.textOf('recycling-backed')).toBe(R.backedSubtrahendUnknown);
      expect(r.textOf('recycling-stranded-recovery')).toBe(R.olderReading);
    });
  });

  it('holder figures are NOT shown before activation', () => {
    const r = render(series());
    expect(r.textOf('recycling-custody')).toBe(R.custodyDiamond);
    expect(r.has('recycling-holder-balance')).toBe(false);
    expect(r.has('recycling-holder-attributed')).toBe(false);
    expect(r.textOf('recycling-unearmarked-note')).toBe(R.outsideBucketNoteDiamond);
  });

  it('before activation, a missing reservation is not determinable', () => {
    const r = render(series({ backing: backing({ recoveryPositionReserved: null }) }));
    expect(r.textOf('recycling-backed')).toBe(R.backedSubtrahendUnknown);
    expect(r.textOf('recycling-comparison')).toBe(R.comparisonDiamond);
  });

  describe('custody state unknown (a reading before it was recorded)', () => {
    const unknown = (over: Obj = {}) =>
      backing({
        custodyActivated: null,
        holderBalanceKnown: null,
        holderBalance: null,
        holderAttributed: null,
        ...over,
      });

    it('is not determinable — neither comparison is assumed', () => {
      // Balance 1 < bucket 100: the retired page would have said SHORT.
      const r = render(series({ backing: unknown({ vpfiBalance: tok(1), unearmarked: '0' }) }));
      expect(r.textOf('recycling-backed')).toBe(R.backedCustodyUnknown);
      expect(r.attr('recycling-backed', 'data-verdict')).toBe('undetermined');
      expect(r.has('recycling-comparison')).toBe(false);
    });

    it('says where custody is held is not determinable', () => {
      const r = render(series({ backing: unknown() }));
      expect(r.textOf('recycling-custody')).toBe(R.custodyUnknown);
      expect(r.textOf('recycling-unearmarked-note')).toBe(R.outsideBucketNoteUnknown);
    });

    // Codex #2521 r1 — the indexer's standing signal for a stalled rollout.
    it('names the schema update the data service is still waiting for, instead of a plain unknown', () => {
      const r = render(series({ backing: unknown({ pendingMigration: '0062_recycle_backing_custody' }) }));
      expect(r.textOf('recycling-custody')).toBe(
        R.custodyPendingMigration('0062_recycle_backing_custody'),
      );
      // The migration is NAMED on the page (the template really interpolates it).
      expect(r.textOf('recycling-custody')).toContain('0062_recycle_backing_custody');
    });

    it('a withheld reading still names the pending schema update', () => {
      const r = render(
        series({
          backing: { ...noBacking('read-failed'), pendingMigration: '0062_recycle_backing_custody' },
        }),
      );
      expect(r.textOf('recycling-backing-unavailable')).toContain(
        R.custodyPendingMigration('0062_recycle_backing_custody'),
      );
    });

    it('KEEPS both custody-address rows, each as not determinable — never removed', () => {
      // An older reading shows a newer field as not determinable. Hiding
      // the rows is reserved for a reading that KNOWS custody never moved.
      const r = render(series({ backing: unknown() }));
      expect(r.textOf('recycling-holder-balance')).toBe(R.holderNotDeterminable);
      expect(r.textOf('recycling-holder-attributed')).toBe(R.holderNotDeterminable);
      expect(r.attr('recycling-holder-balance', 'class')).toContain('rc-refusal');
      expect(r.attr('recycling-holder-attributed', 'class')).toContain('rc-refusal');
    });

    it('KEEPS the reserve: an older reading stays a complete record of what it held', () => {
      // Deliberate: the older-reading rule shows the newer field (custody
      // state) as not determinable rather than withdrawing the reading, and
      // the custody row and verdict both say which comparison applies is
      // unknown — so no comparison is asserted.
      const r = render(series({ backing: unknown() }));
      expect(r.textOf('recycling-retained')).toBe('25');
      expect(r.has('recycling-retained-withheld')).toBe(false);
      expect(r.textOf('recycling-custody')).toBe(R.custodyUnknown);
      expect(r.textOf('recycling-backed')).toBe(R.backedCustodyUnknown);
    });

    it('an older indexer that serves no custody fields at all reads the same', () => {
      const b = unknown();
      for (const k of ['custodyActivated', 'holderBalanceKnown', 'holderBalance', 'holderAttributed']) {
        delete b[k];
      }
      const r = render(series({ backing: b }));
      expect(r.textOf('recycling-custody')).toBe(R.custodyUnknown);
      expect(r.textOf('recycling-backed')).toBe(R.backedCustodyUnknown);
    });
  });

  it('the moment AND the contract the reading describes are shown', () => {
    const t = render(series()).textOf('recycling-asof');
    expect(t).toContain('12345678');
    expect(t).toContain('2026-08-03T00:00:00.000Z');
    expect(t).toContain('0xd89f0000000000000000000000000000000000ab');
  });
});

/* ═══════════════════ New: display rules ═══════════════════ */

describe('RecyclingAccount — every withheld figure says why', () => {
  it('an open day has no blank and no zero in any cell', () => {
    const r = render(series({ daily: [openDay({ dayId: 21, absorbedLocal: '0' })] }));
    expect(r.textOf('floor-21')).toBe(R.cellNoPool);
    expect(r.textOf('recycled-21')).toBe(R.cellNoPool);
    expect(r.textOf('selffunded-21')).toBe(R.cellNoPool);
    expect(r.textOf('drawn-21')).toBe(R.cellNoPool);
    expect(r.textOf('absorbed-mirror-21')).toBe(R.cellMirrorPending);
    expect(r.textOf('absorbed-21')).toBe(R.cellCombinedPending);
    // The live local term is a real zero, and is stated as one.
    expect(r.textOf('absorbed-local-21')).toBe('0');
  });

  it('a finalized day with an empty pool says the share is not applicable', () => {
    const r = render(
      series({
        daily: [day({ dayId: 22, scheduleFloor: '0', recycledBudget: '0', freshDrawdown: '0', netEmission: '0', selfFundingRatio: null })],
      }),
    );
    expect(r.textOf('selffunded-22')).toBe(R.cellEmptyPool);
  });

  it('a row whose nulls contradict its flags withholds the account', () => {
    // An armed, finalized day with no net emission: rendering it would
    // label a committed day "none committed".
    const r = render(series({ daily: [day({ dayId: 23, netEmission: null })] }));
    expect(r.has('recycling-unavailable')).toBe(true);
  });

  it.each([
    ['no-armed-finalized-days', R.runwayNoArmedDays],
    ['attribution-column-unavailable', R.runwayAttributionRebuilding],
  ])('names the runway reason %s', (code, text) => {
    const r = render(
      series({ cumulative: cumulative({ runwayExtensionDays: null, runwayUnavailableReason: code }) }),
    );
    expect(r.textOf('recycling-runway')).toBe(text);
  });

  it('an unrecognised runway reason is shown as a reason, with its code', () => {
    const r = render(
      series({ cumulative: cumulative({ runwayExtensionDays: null, runwayUnavailableReason: 'new-code' }) }),
    );
    expect(r.textOf('recycling-runway')).toBe(R.runwayUnrecognised('new-code'));
  });

  it('a runway withheld with no reason says it cannot be calculated', () => {
    const r = render(
      series({ cumulative: cumulative({ runwayExtensionDays: null, runwayUnavailableReason: null }) }),
    );
    expect(r.textOf('recycling-runway')).toBe(R.runwayUnknown);
  });

  it('a self-funding programme says so instead of a day count', () => {
    const r = render(
      series({
        cumulative: cumulative({ selfFunded: true, runwayExtensionDays: null, runwayUnavailableReason: 'self-funded' }),
      }),
    );
    expect(r.textOf('recycling-runway')).toBe(R.runwaySelfFunded);
  });

  it('the runway rounds DOWN — longevity is never overstated', () => {
    const r = render(series({ cumulative: cumulative({ runwayExtensionDays: 3.99 }) }));
    expect(r.textOf('recycling-runway')).toBe(R.runwayDays('3.9'));
  });

  it('an exact published runway is not floored into the tenth below it', () => {
    const r = render(series({ cumulative: cumulative({ runwayExtensionDays: 4.1 }) }));
    expect(r.textOf('recycling-runway')).toBe(R.runwayDays('4.1'));
  });

  it.each([
    ['not-captured-yet', R.backingReasonNotCaptured],
    ['read-failed', R.backingReasonReadFailed],
    ['snapshot-stale', R.backingReasonStale],
    ['chain-behind', R.backingReasonChainBehind],
    ['snapshot-other-deployment', R.backingReasonOtherDeployment],
  ])('a withheld reading (%s) states its own reason', (code, text) => {
    const r = render(series({ backing: noBacking(code) }));
    expect(r.textOf('recycling-backing-unavailable')).toBe(`${R.backingUnavailable} ${text}`);
  });

  it('an empty deployment says no day is recorded and declines the totals', () => {
    const r = render(series({ scope: 'empty', daily: [], fromDay: null, toDay: null, coverageFromDay: null }));
    expect(r.textOf('recycling-scope-note')).toBe(R.scopeEmpty);
    expect(r.textOf('recycling-absorbed-declined')).toBe(R.totalDeclined);
    expect(r.has('recycling-coverage')).toBe(false);
  });
});

describe('RecyclingAccount — days are programme days, never calendar dates', () => {
  it('labels a day by its programme index', () => {
    const r = render(series({ daily: [day({ dayId: 1234 })] }));
    // An index, not a quantity: no grouping separator.
    expect(r.textOf('recycling-day-1234')).toContain(R.dayLabel('1234'));
  });

  it('renders no calendar date anywhere in the day table', () => {
    const r = render(series({ daily: [day({ dayId: 20000 }), openDay({ dayId: 20001 })] }));
    const rows = r.textsMatching(/^recycling-day-/).join(' ');
    expect(rows).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(rows).not.toMatch(/\b(19|20)\d{2}\b.*\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  });
});

describe('RecyclingAccount — locale and posture', () => {
  it('formats amounts in the reader’s locale', () => {
    const r = render(series({ cumulative: cumulative({ absorbedLocal: (1234n * 10n ** 18n + 5n * 10n ** 17n).toString() }) }), 'de');
    expect(r.textOf('recycling-absorbed-local')).toBe('1.234,5');
  });

  it('keeps the #recycling anchor in every state', () => {
    expect(renderState({ status: 'loading' }).hasId('recycling')).toBe(true);
    expect(renderState({ status: 'unavailable' }).hasId('recycling')).toBe(true);
    expect(render(series()).hasId('recycling')).toBe(true);
  });

  it('loading says loading — not unavailable, not zeros', () => {
    const r = renderState({ status: 'loading' });
    expect(r.text).toContain(R.loading);
    expect(r.has('recycling-unavailable')).toBe(false);
    expect(r.has('recycling-absorbed')).toBe(false);
  });

  it('never renders the reward-rate field, even if a payload carried one', () => {
    // RL-6: no rate or return figure on this surface. A stray `aprBps`
    // (the interaction snapshot's field) must not leak through.
    // Values chosen to appear nowhere else in the fixture.
    const r = render(series({ aprBps: 97531, cumulative: cumulative({ aprBps: 86420 }) }));
    expect(r.text).not.toContain('97531');
    expect(r.text).not.toContain('86420');
    expect(r.html.toLowerCase()).not.toMatch(/\bapr\b|\bapy\b|yield/);
  });
});
