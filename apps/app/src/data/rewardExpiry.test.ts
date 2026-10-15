/**
 * RL-3 (#1956) — the Claim Center countdown's two pure decisions: which
 * entry's estimate to show (the SOONEST non-zero one — zero means no
 * countdown: dark, unstarted or forfeited) and when the wording becomes a
 * final notice (no more than the notice period away; straddled by a second).
 */
import { describe, expect, it } from 'vitest';
import { REWARD_CLAIM_NOTICE_DAYS, inFinalNotice, readAllRewardEntryIds, soonestRewardExpiry } from './rewardExpiry';

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

describe('readAllRewardEntryIds', () => {
  const index = (all: bigint[]) => {
    const calls: [bigint, bigint][] = [];
    const read = async (offset: bigint, limit: bigint): Promise<readonly [readonly bigint[], bigint]> => {
      calls.push([offset, limit]);
      return [all.slice(Number(offset), Number(offset + limit)), BigInt(all.length)];
    };
    return { read, calls };
  };

  it('walks every page to the reported total, in order', async () => {
    const all = Array.from({ length: 250 }, (_, i) => BigInt(i + 1));
    const { read, calls } = index(all);
    expect(await readAllRewardEntryIds(read, 100)).toEqual(all);
    expect(calls).toEqual([
      [0n, 100n],
      [100n, 100n],
      [200n, 100n],
    ]);
  });

  it('a page may return fewer ids than it scanned (the live filter), even none, and the walk still reaches the end (r14)', async () => {
    // 250 positions, live ids only at 5, 150 and 249: three pages, three ids.
    const live = new Set([5n, 150n, 249n]);
    const calls: [bigint, bigint][] = [];
    const read = async (offset: bigint, limit: bigint): Promise<readonly [readonly bigint[], bigint]> => {
      calls.push([offset, limit]);
      const out: bigint[] = [];
      for (let p = offset; p < offset + limit && p < 250n; p++) if (live.has(p)) out.push(p);
      return [out, 250n];
    };
    expect(await readAllRewardEntryIds(read, 100)).toEqual([5n, 150n, 249n]);
    expect(calls).toHaveLength(3);
  });

  it('reads an empty index in one page', async () => {
    const { read, calls } = index([]);
    expect(await readAllRewardEntryIds(read, 100)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('an empty page is a page with no live entries, not a stop: the walk continues to the total', async () => {
    const calls: bigint[] = [];
    const read = async (offset: bigint): Promise<readonly [readonly bigint[], bigint]> => {
      calls.push(offset);
      return [[], 7n];
    };
    expect(await readAllRewardEntryIds(read, 3)).toEqual([]);
    expect(calls).toEqual([0n, 3n, 6n]);
  });
});
