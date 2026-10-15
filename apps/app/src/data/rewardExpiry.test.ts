/**
 * RL-3 (#1956) — the Claim Center countdown's two pure decisions: which
 * entry's estimate to show (the SOONEST non-zero one — zero means no
 * countdown: dark, unstarted or forfeited) and when the wording becomes a
 * final notice (no more than the notice period away; straddled by a second).
 */
import { describe, expect, it } from 'vitest';
import {
  REWARD_CLAIM_NOTICE_DAYS,
  type SoonestExpiryPage,
  inFinalNotice,
  readSoonestRewardExpiry,
  soonestRewardExpiry,
} from './rewardExpiry';

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

describe('readSoonestRewardExpiry (Codex #2489 r16)', () => {
  /** A fake of the contract's paged view over an index of `total` positions
   *  whose live entries (position → estimate) are `live`, with a live-from
   *  cursor at `liveFrom`: the page starts at max(offset, cursor), scans up to
   *  `limit` positions, prices at most `maxLive` live entries and ends before
   *  the first it would not price. */
  const view = (total: bigint, live: Map<bigint, bigint>, liveFrom = 0n) => {
    const calls: [bigint, bigint, bigint][] = [];
    const read = async (offset: bigint, limit: bigint, maxLive: bigint): Promise<SoonestExpiryPage> => {
      calls.push([offset, limit, maxLive]);
      let i = offset > liveFrom ? offset : liveFrom;
      const end = i + limit < total ? i + limit : total;
      let priced = 0n;
      let soonestId = 0n;
      let soonestAt = 0n;
      for (; i < end; i++) {
        const at = live.get(i);
        if (at === undefined) continue;
        if (priced !== 0n && priced >= maxLive) break;
        priced++;
        if (at !== 0n && (soonestAt === 0n || at < soonestAt)) {
          soonestAt = at;
          soonestId = i + 1n; // entry ids are 1-based in the fake
        }
      }
      return [soonestId, soonestAt, i, total];
    };
    return { read, calls };
  };

  it('walks from each returned nextOffset to the total and keeps the soonest across pages', async () => {
    // 250 positions; live at 5 (late), 150 (soonest) and 249 (later).
    const { read, calls } = view(250n, new Map([[5n, 9_000n], [150n, 1_500n], [249n, 2_000n]]));
    expect(await readSoonestRewardExpiry(read, 100n, 100n)).toEqual({ entryId: 151n, expiresAt: 1_500 });
    expect(calls).toEqual([
      [0n, 100n, 100n],
      [100n, 100n, 100n],
      [200n, 100n, 100n],
    ]);
  });

  it('starts past the settled history: the first page is raised to the live-from cursor', async () => {
    const { read, calls } = view(450n, new Map([[420n, 7_000n]]), 400n);
    expect(await readSoonestRewardExpiry(read, 100n, 100n)).toEqual({ entryId: 421n, expiresAt: 7_000 });
    expect(calls).toHaveLength(1);
  });

  it('a page bounded by live entries ends before the entry it did not price; the next page prices it', async () => {
    const { read, calls } = view(10n, new Map([[1n, 5_000n], [2n, 4_000n], [3n, 6_000n]]));
    expect(await readSoonestRewardExpiry(read, 100n, 1n)).toEqual({ entryId: 3n, expiresAt: 4_000 });
    expect(calls.map((c) => c[0])).toEqual([0n, 2n, 3n]);
  });

  it('shows nothing when no live entry carries an estimate, and reads an empty index in one page', async () => {
    expect(await readSoonestRewardExpiry(view(40n, new Map([[3n, 0n]])).read, 100n, 100n)).toBeNull();
    const empty = view(0n, new Map());
    expect(await readSoonestRewardExpiry(empty.read, 100n, 100n)).toBeNull();
    expect(empty.calls).toHaveLength(1);
  });

  it('a page that makes no progress short of the total is an error, never a silent early end', async () => {
    const read = async (): Promise<SoonestExpiryPage> => [0n, 0n, 0n, 7n];
    await expect(readSoonestRewardExpiry(read, 3n, 3n)).rejects.toThrow(/no progress/);
  });
});
