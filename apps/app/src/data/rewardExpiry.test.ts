/**
 * RL-3 (#1956) — the Claim Center countdown's two pure decisions: which
 * entry's estimate to show (the SOONEST non-zero one — zero means no
 * countdown: dark, unstarted or forfeited) and when the wording becomes a
 * final notice (no more than the notice period away; straddled by a second).
 */
import { describe, expect, it } from 'vitest';
import { REWARD_CLAIM_NOTICE_DAYS, inFinalNotice, soonestRewardExpiry } from './rewardExpiry';

describe('soonestRewardExpiry', () => {
  it('picks the soonest non-zero estimate and skips entries with no countdown', () => {
    expect(
      soonestRewardExpiry([
        { id: 1n, expiresAt: 0 },
        { id: 2n, expiresAt: 2_000 },
        { id: 3n, expiresAt: 1_500 },
        { id: 4n, expiresAt: 0 },
      ]),
    ).toEqual({ entryId: 3n, expiresAt: 1_500 });
  });

  it('shows nothing when no entry carries a countdown', () => {
    expect(soonestRewardExpiry([{ id: 1n, expiresAt: 0 }])).toBeNull();
    expect(soonestRewardExpiry([])).toBeNull();
  });
});

describe('inFinalNotice', () => {
  const NOW = 1_800_000_000;
  const NOTICE = REWARD_CLAIM_NOTICE_DAYS * 86_400;
  it('switches to the final notice exactly at the notice period (straddle)', () => {
    expect(inFinalNotice(NOW + NOTICE, NOW), 'exactly the notice period away').toBe(true);
    expect(inFinalNotice(NOW + NOTICE + 1, NOW), 'one second more').toBe(false);
  });
  it('never for an entry with no countdown', () => {
    expect(inFinalNotice(0, NOW)).toBe(false);
  });
});
