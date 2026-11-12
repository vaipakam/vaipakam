import { describe, expect, it } from 'vitest';
import { READINESS, waitLines, type WaitDetail } from './rewardWait';

const keys = (d: WaitDetail) => waitLines(7n, d).map((l) => l.key);

describe('waitLines', () => {
  it('names why a home network cannot finalise the day, from the readiness answer', () => {
    expect(keys({ kind: 'finalize', reason: READINESS.ready })).toEqual(['rewardsWait.finalizeReady', 'rewardsWait.behind']);
    expect(keys({ kind: 'finalize', reason: READINESS.noReport })).toEqual(['rewardsWait.finalizeNoReport', 'rewardsWait.behind']);
    expect(keys({ kind: 'finalize', reason: READINESS.waiting })).toEqual(['rewardsWait.finalizeReports', 'rewardsWait.behind']);
    expect(keys({ kind: 'finalize', reason: READINESS.finalized })).toEqual(['rewardsWait.finalizeDone', 'rewardsWait.behind']);
    expect(keys({ kind: 'finalize', reason: READINESS.listUnusable })).toEqual(['rewardsWait.finalizeList', 'rewardsWait.behind']);
    expect(waitLines(7n, { kind: 'finalize', reason: 9 })[0]).toEqual({ key: 'rewardsWait.finalizeOther', vars: { day: '7', reason: '9' } });
    expect(keys({ kind: 'finalize', reason: null })).toEqual(['rewardsWait.finalizeUnread', 'rewardsWait.behind']);
  });

  it('says whether the home network’s figures reached a mirror, and states an unread answer', () => {
    expect(keys({ kind: 'broadcast', applied: false })).toEqual(['rewardsWait.broadcast', 'rewardsWait.behind']);
    expect(keys({ kind: 'broadcast', applied: true })).toEqual(['rewardsWait.broadcastApplied', 'rewardsWait.behind']);
    expect(keys({ kind: 'broadcast', applied: null })).toEqual(['rewardsWait.broadcastUnread', 'rewardsWait.behind']);
    expect(keys({ kind: 'unknown' })).toEqual(['rewardsWait.roleUnread', 'rewardsWait.behind']);
  });

  it('a detached network says nothing new becomes claimable, and offers no step that could clear it', () => {
    expect(keys({ kind: 'detached' })).toEqual(['rewardsWait.detached']);
  });

  it('a network with no reward role set says no day finalises there, and offers no step that could clear it', () => {
    expect(keys({ kind: 'unconfigured' })).toEqual(['rewardsWait.unconfigured']);
  });

  it('states a delivery wait in order: not priced, the report, then the parts landed against the whole', () => {
    expect(keys({ kind: 'delivery', stamped: false, reportSent: false, armed: true, parts: null })).toEqual(['rewardsWait.priced', 'rewardsWait.behind']);
    expect(keys({ kind: 'delivery', stamped: null, reportSent: null, armed: null, parts: null })).toEqual(['rewardsWait.pricedUnread', 'rewardsWait.behind']);
    expect(
      keys({
        kind: 'delivery',
        stamped: true,
        reportSent: false,
        armed: true,
        parts: { wholeFresh: 0n, wholeRecycled: 0n, landedFresh: 0n, landedRecycled: 0n, parts: 0, conflict: false },
      }),
    ).toEqual(['rewardsWait.report', 'rewardsWait.noParts', 'rewardsWait.behind']);
    const landed = waitLines(7n, {
      kind: 'delivery',
      stamped: true,
      reportSent: true,
      armed: true,
      parts: { wholeFresh: 6n, wholeRecycled: 4n, landedFresh: 2n, landedRecycled: 2n, parts: 2, conflict: false },
    });
    // Each component against its own whole: an excess in one never covers the other.
    expect(landed[0]).toEqual({
      key: 'rewardsWait.parts',
      vars: { day: '7', parts: '2' },
      amounts: { landedFresh: 2n, wholeFresh: 6n, landedRecycled: 2n, wholeRecycled: 4n },
    });
    expect(keys({ kind: 'delivery', stamped: true, reportSent: true, armed: true, parts: null })).toEqual(['rewardsWait.partsUnread', 'rewardsWait.behind']);
  });

  it('names this network’s report only for an armed day, and says so when arming is unread', () => {
    const none = { wholeFresh: 0n, wholeRecycled: 0n, landedFresh: 0n, landedRecycled: 0n, parts: 0, conflict: false };
    expect(keys({ kind: 'delivery', stamped: true, reportSent: false, armed: false, parts: none })).toEqual(['rewardsWait.noParts', 'rewardsWait.behind']);
    expect(keys({ kind: 'delivery', stamped: true, reportSent: false, armed: null, parts: none })).toEqual([
      'rewardsWait.reportUnread',
      'rewardsWait.noParts',
      'rewardsWait.behind',
    ]);
  });

  it('discloses that a day whose parts disagree can be closed unpaid', () => {
    expect(
      keys({
        kind: 'delivery',
        stamped: true,
        reportSent: true,
        armed: true,
        parts: { wholeFresh: 6n, wholeRecycled: 4n, landedFresh: 6n, landedRecycled: 6n, parts: 3, conflict: true },
      }),
    ).toEqual(['rewardsWait.parts', 'rewardsWait.conflict', 'rewardsWait.behind']);
  });
});
