import { describe, expect, it } from 'vitest';
import enBundle from '../../src/i18n/locales/en.json' with { type: 'json' };

import { expectedBacked, expectedWithheld, fill, reviewAnalytics } from './analyticsRecyclingReview.mjs';

const copy = enBundle.copy;
const c = copy.recycling;
const lc = copy.loopClosure;
const DIAMOND = '0x2535baC87F3df287268fC697F2f31cf418365303';

// Shapes copied from the deployed indexer's Base Sepolia answers of
// 2026-10-24 (trimmed to the fields the review reads).
const recBody = () => ({
  chainId: 84532,
  fromDay: 0,
  toDay: 2,
  scope: 'global',
  daily: [
    { dayId: 0, estimate: true },
    { dayId: 1, estimate: true },
    { dayId: 2, estimate: true },
  ],
  backing: {
    custodyActivated: true,
    backed: {
      determinable: true,
      relation: 'holder',
      ok: true,
      diamondShortfall: null,
      holderShortfall: null,
      reason: null,
    },
    pendingMigration: null,
    blockNumber: '49484775',
    diamond: DIAMOND,
    unavailableReason: null,
    asOf: '2026-10-24T05:13:43.000Z',
  },
});
const loopBody = () => ({
  chainId: 84532,
  recordedBefore: '2026-10-24T05:13:43.000Z',
  daily: [
    { dayId: 20749, date: '2026-10-23', status: 'complete' },
    { dayId: 20750, date: '2026-10-24', status: 'partial' },
  ],
});

/** The page a correct deployment renders for these bodies. */
function pageFor(rec, loop) {
  const snap = {};
  const b = rec.backing;
  if (b.unavailableReason !== null) {
    snap['recycling-backing-unavailable'] = {
      text: expectedWithheld(b.unavailableReason, b.pendingMigration, c),
    };
  } else {
    const want = expectedBacked(b.backed, c);
    snap['recycling-backed'] = { text: want.prefix ? `${want.text} 1.5 VPFI` : want.text, verdict: want.posture };
    if (b.backed?.determinable) {
      snap['recycling-comparison'] = {
        text: b.backed.relation === 'holder' ? c.comparisonHolder : c.comparisonDiamond,
      };
      if (!b.backed.ok && b.backed.relation === 'holder') {
        if (b.backed.holderShortfall !== null) snap['recycling-short-holder'] = { text: 'x' };
        if (b.backed.diamondShortfall !== null) snap['recycling-short-diamond'] = { text: 'x' };
      }
    }
    snap['recycling-custody'] = { text: b.custodyActivated ? c.custodyHolder : c.custodyDiamond };
    snap['recycling-asof'] = {
      text: fill(c.asOfValue, { block: b.blockNumber, at: b.asOf, contract: b.diamond }),
    };
  }
  for (const d of rec.daily) {
    snap[`recycling-day-${d.dayId}`] = { text: `Day ${d.dayId}` };
    if (d.estimate) snap[`estimate-${d.dayId}`] = { text: c.estimateBadge };
  }
  snap['recycling-window'] = {
    text: `${fill(c.windowRange, { from: rec.fromDay, to: rec.toDay })} ${
      rec.scope === 'global' ? c.windowTotalsWholeProgramme : c.windowTotalsRecordedHere
    }`,
  };
  if (rec.scope !== 'global') {
    snap['recycling-scope-note'] = { text: rec.scope === 'empty' ? c.scopeEmpty : c.scopeLocalOnly };
  }
  snap['loop-recorded-before'] = {
    text:
      loop.recordedBefore === null
        ? lc.recordedBeforeUnknown
        : fill(lc.recordedBefore, { at: loop.recordedBefore }),
  };
  for (const d of loop.daily) {
    snap[`loop-day-${d.dayId}`] = { text: d.date, status: d.status };
    snap[`loop-date-${d.dayId}`] = {
      text: d.status === 'partial' ? `${d.date}${lc.dayPartial}` : d.date,
    };
  }
  return snap;
}

const run = (rec, loop, snap = pageFor(rec, loop), diamond = DIAMOND) =>
  reviewAnalytics({ rec, loop, snap, copy, diamond, chainId: 84532 });
const failed = (checks) => checks.filter((x) => !x.ok).map((x) => x.name);

describe('reviewAnalytics', () => {
  it('passes a page that states exactly what the indexer published', () => {
    const checks = run(recBody(), loopBody());
    expect(failed(checks)).toEqual([]);
    expect(checks.length).toBeGreaterThan(10);
  });

  it('fails a verdict cell whose posture is not the indexer’s', () => {
    const rec = recBody();
    const snap = pageFor(rec, loopBody());
    snap['recycling-backed'].verdict = 'short';
    expect(failed(run(rec, loopBody(), snap))).toEqual(["the verdict cell states the indexer's own posture"]);
  });

  it('fails a page that words a verdict of its own', () => {
    const rec = recBody();
    const snap = pageFor(rec, loopBody());
    snap['recycling-backed'].text = c.backedYesDiamond;
    expect(failed(run(rec, loopBody(), snap))).toEqual(["the verdict cell states the indexer's own answer"]);
  });

  it('fails a reading taken from a contract other than the bundle’s Diamond', () => {
    expect(failed(run(recBody(), loopBody(), undefined, '0x0000000000000000000000000000000000000001'))).toEqual([
      'the indexer read the Diamond this deployment ships',
    ]);
  });

  it('fails while the indexer names a schema update it has not applied', () => {
    const rec = recBody();
    rec.backing.pendingMigration = '0056_recycle_backing_custody.sql';
    rec.backing.custodyActivated = null;
    rec.backing.backed = { determinable: false, relation: null, ok: null, reason: 'custody-state-unknown' };
    const snap = pageFor(rec, loopBody());
    snap['recycling-custody'] = {
      text: fill(c.custodyPendingMigration, { migration: rec.backing.pendingMigration }),
    };
    expect(failed(run(rec, loopBody(), snap))).toEqual([
      'the indexer has applied every schema update its reading needs (backing.pendingMigration is null)',
    ]);
  });

  it('accepts a withheld reading only when the page withholds it whole', () => {
    const rec = recBody();
    rec.backing.unavailableReason = 'snapshot-stale';
    expect(failed(run(rec, loopBody()))).toEqual([]);
    const snap = pageFor(rec, loopBody());
    snap['recycling-backed'] = { text: c.backedYesHolder, verdict: 'yes' };
    expect(failed(run(rec, loopBody(), snap))).toEqual(['a withheld reading is withheld whole']);
  });

  it('fails a withheld notice that drops or misstates the indexer’s reason', () => {
    const rec = recBody();
    rec.backing.unavailableReason = 'snapshot-stale';
    const empty = pageFor(rec, loopBody());
    empty['recycling-backing-unavailable'].text = '';
    expect(failed(run(rec, loopBody(), empty))).toEqual(["the withheld notice states the indexer's reason"]);
    const bare = pageFor(rec, loopBody());
    bare['recycling-backing-unavailable'].text = c.backingUnavailable;
    expect(failed(run(rec, loopBody(), bare))).toEqual(["the withheld notice states the indexer's reason"]);
    const wrong = pageFor(rec, loopBody());
    wrong['recycling-backing-unavailable'].text = `${c.backingUnavailable} ${c.backingReasonNotCaptured}`;
    expect(failed(run(rec, loopBody(), wrong))).toEqual(["the withheld notice states the indexer's reason"]);
  });

  it('expects an unrecognised reason to be stated with its code, and a pending update named', () => {
    expect(expectedWithheld('new-code', null, c)).toBe(
      `${c.backingUnavailable} ${fill(c.backingReasonUnrecognised, { code: 'new-code' })}`,
    );
    expect(expectedWithheld('read-failed', '0056_x.sql', c)).toBe(
      `${c.backingUnavailable} ${c.backingReasonReadFailed} ${fill(c.custodyPendingMigration, { migration: '0056_x.sql' })}`,
    );
    const rec = recBody();
    rec.backing.unavailableReason = 'new-code';
    expect(failed(run(rec, loopBody()))).toEqual([]);
  });

  it('fails a day the indexer did not serve, and a missing estimate badge', () => {
    const rec = recBody();
    const snap = pageFor(rec, loopBody());
    snap['recycling-day-3'] = { text: 'Day 3' };
    delete snap['estimate-1'];
    expect(failed(run(rec, loopBody(), snap))).toEqual([
      'the day table has exactly the programme days the indexer served',
      'a day carries the estimate badge exactly when the indexer calls it an estimate',
    ]);
  });

  it('fails a window or scope note that misstates what the totals cover', () => {
    const rec = recBody();
    rec.scope = 'local-only';
    expect(failed(run(rec, loopBody()))).toEqual([]);
    const snap = pageFor(rec, loopBody());
    snap['recycling-window'].text = `${fill(c.windowRange, { from: 0, to: 2 })} ${c.windowTotalsWholeProgramme}`;
    delete snap['recycling-scope-note'];
    expect(failed(run(rec, loopBody(), snap))).toEqual([
      "the scope note states the indexer's scope",
      'the window note states the range the indexer served, and what the totals cover',
    ]);
    const global = pageFor(recBody(), loopBody());
    global['recycling-scope-note'] = { text: c.scopeLocalOnly };
    expect(failed(run(recBody(), loopBody(), global))).toEqual(['no local-only scope note on programme-wide totals']);
  });

  it('names each failing holder leg the indexer reports, and no other', () => {
    const rec = recBody();
    rec.backing.backed = {
      determinable: true,
      relation: 'holder',
      ok: false,
      holderShortfall: '1000',
      diamondShortfall: null,
      reason: null,
    };
    expect(failed(run(rec, loopBody()))).toEqual([]);
    const snap = pageFor(rec, loopBody());
    snap['recycling-short-diamond'] = { text: 'x' };
    expect(failed(run(rec, loopBody(), snap))).toEqual(['each failing leg the indexer names is listed, and no other']);
  });

  it('expects the unknown-moment sentence when the indexer states no recorded moment', () => {
    const loop = loopBody();
    loop.recordedBefore = null;
    expect(failed(run(recBody(), loop))).toEqual([]);
    const snap = pageFor(recBody(), loop);
    snap['loop-recorded-before'] = { text: fill(lc.recordedBefore, { at: '2026-10-24T05:13:43.000Z' }) };
    expect(failed(run(recBody(), loop, snap))).toEqual(["the loop-closure record's moment is the indexer's"]);
  });

  it('fails a loop-closure day whose status or date is not the indexer’s', () => {
    const loop = loopBody();
    const snap = pageFor(recBody(), loop);
    snap['loop-day-20750'].status = 'complete';
    snap['loop-date-20749'].text = '2026-10-22';
    expect(failed(run(recBody(), loop, snap))).toEqual([
      "each loop-closure day carries the indexer's status",
      "each loop-closure day is labelled with the indexer's own UTC date",
    ]);
  });
});

describe('expectedBacked', () => {
  it('maps every indexer answer to the sentence the page states', () => {
    expect(expectedBacked(null, c)).toEqual({ posture: 'undetermined', text: c.backedNotServed, prefix: false });
    expect(expectedBacked({ determinable: false, reason: 'custody-state-unknown' }, c).text).toBe(c.backedCustodyUnknown);
    expect(expectedBacked({ determinable: false, reason: 'holder-balance-unknown' }, c).text).toBe(
      c.backedHolderBalanceUnknown,
    );
    expect(expectedBacked({ determinable: false, reason: 'subtrahend-unknown' }, c).text).toBe(c.backedSubtrahendUnknown);
    expect(expectedBacked({ determinable: true, relation: 'diamond', ok: true }, c).text).toBe(c.backedYesDiamond);
    const short = expectedBacked({ determinable: true, relation: 'diamond', ok: false }, c);
    expect(short.posture).toBe('short');
    expect(short.prefix).toBe(true);
    expect(c.backedShortDiamond.startsWith(short.text)).toBe(true);
    expect(short.text).not.toContain('{{');
    expect(expectedBacked({ determinable: true, relation: 'holder', ok: false }, c)).toEqual({
      posture: 'short',
      text: c.backedNo,
      prefix: true,
    });
  });
});
