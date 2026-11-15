/**
 * #3622 B2 — the matcher's fresh lane: new and re-priced offers are previewed
 * first, under a hard minority quota, once per offer, without taking the
 * ordinary walk's turn.
 */
import { describe, expect, it } from 'vitest';
import {
  FRESH_COOL_OFF_SEC,
  FRESH_LANE_DEFAULT_SHARE,
  FRESH_LOOKBACK_SEC,
  FreshLaneTracker,
  freshLaneBudget,
  freshLaneShare,
} from '../src/freshLane';
import {
  MATCH_ERR_TERMS_TOO_FRESH,
  MAX_PREVIEW_CALLS_PER_TICK,
  partitionByBucket,
  runMatchWalks,
  type MatchPreview,
  type MatchWalkIO,
  type OfferLite,
} from '../src/matcher';

const COLL = '0x00000000000000000000000000000000000000c2';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

function offer(
  id: number,
  creator: `0x${string}`,
  offerType: 0 | 1,
  opts: { asset?: `0x${string}`; createdAt?: number; termsSetAt?: number } = {},
): OfferLite {
  return {
    id: BigInt(id), creator, offerType, accepted: false, assetType: 0, collateralAssetType: 0,
    lendingAsset: opts.asset ?? addr(0xa1), collateralAsset: COLL, durationDays: 30n, amount: 100n,
    amountMax: 100n, amountFilled: 0n, interestRateBpsMax: 1000n, fillMode: 0,
    useFullTermInterest: true, allowsPartialRepay: false,
    createdAt: BigInt(opts.createdAt ?? 0), termsSetAt: BigInt(opts.termsSetAt ?? opts.createdAt ?? 0),
  };
}

const PASS = { previews: MAX_PREVIEW_CALLS_PER_TICK, submits: 25, wallMs: 90_000 };

/** A preview that refuses every pair with `code`, recording what it saw. */
function refusingIO(code = 4, seen: string[] = []): MatchWalkIO {
  return {
    preview: async (L, B) => {
      seen.push(`${L.id}:${B.id}`);
      return { errorCode: code, matchAmount: 0n, matchRateBps: 0n, reqCollateral: 0n, lenderRemainingPostMatch: 0n };
    },
    submit: async () => false,
  };
}

function walkArgs(offers: OfferLite[], fresh: Set<string>, io: MatchWalkIO, run = 0, entered: OfferLite[] = []) {
  const { lenders, borrowers } = partitionByBucket(offers);
  return {
    lenders,
    borrowers,
    run,
    fresh,
    lane: freshLaneBudget(FRESH_LANE_DEFAULT_SHARE, PASS),
    stop: () => false,
    laneStop: () => false,
    onEntered: (o: OfferLite) => entered.push(o),
    io,
    log: () => {},
  };
}

describe('freshLaneShare', () => {
  it('defaults, clamps, and turns off at 0', () => {
    expect(freshLaneShare(undefined)).toBe(0.25);
    expect(freshLaneShare('')).toBe(0.25);
    expect(freshLaneShare('abc')).toBe(0.25);
    expect(freshLaneShare('0.1')).toBe(0.1);
    expect(freshLaneShare('0.9')).toBe(0.5);
    expect(freshLaneShare('-1')).toBe(0);
    expect(freshLaneShare('0')).toBe(0);
  });

  it('sizes the lane caps as floors of the pass caps', () => {
    expect(freshLaneBudget(0.25, PASS)).toEqual({ previews: 500, submits: 6, wallMs: 22_500 });
  });
});

describe('FreshLaneTracker', () => {
  const now = 1_000_000;
  const L = addr(1);

  it('takes offers changed within the look-back and past the terms age', () => {
    const t = new FreshLaneTracker();
    const offers = [
      offer(1, L, 0, { createdAt: now - 60 }), // fresh
      offer(2, L, 0, { createdAt: now - 2 }), // too young for the terms-age rule
      offer(3, L, 0, { createdAt: now - FRESH_LOOKBACK_SEC - 1 }), // too old
      offer(4, L, 0, { createdAt: now - 7200, termsSetAt: now - 30 }), // re-priced recently
    ];
    expect([...t.select(offers, now, 5)].sort()).toEqual(['1', '4']);
  });

  it('enters an offer once, and a re-price again only after the cool-off', () => {
    const t = new FreshLaneTracker();
    const o = offer(1, L, 0, { createdAt: now - 60 });
    t.markEntered(o, now);
    expect(t.select([o], now + 10, 5).size).toBe(0);

    // Re-priced inside the cool-off: still out.
    const repriced = { ...o, termsSetAt: BigInt(now + 100) };
    expect(t.select([repriced], now + 200, 5).size).toBe(0);

    // Re-priced after the cool-off: back in.
    const later = { ...o, termsSetAt: BigInt(now + FRESH_COOL_OFF_SEC + 10) };
    expect(t.select([later], now + FRESH_COOL_OFF_SEC + 60, 5).has('1')).toBe(true);
  });

  it('forgets entries once neither rule can use them', () => {
    const t = new FreshLaneTracker();
    t.markEntered(offer(1, L, 0, { createdAt: now }), now);
    expect(t.size).toBe(1);
    t.select([], now + FRESH_COOL_OFF_SEC + FRESH_LOOKBACK_SEC + 1, 5);
    expect(t.size).toBe(0);
  });
});

describe('runMatchWalks', () => {
  it('previews a fresh pair first and does not preview it again in the walk', async () => {
    const offers = [
      offer(1, addr(1), 0), offer(2, addr(2), 1), // resting pair, bucket A
      offer(3, addr(3), 0, { asset: addr(0xb1) }), offer(4, addr(4), 1, { asset: addr(0xb1) }), // bucket B
    ];
    const seen: string[] = [];
    const entered: OfferLite[] = [];
    const r = await runMatchWalks(walkArgs(offers, new Set(['4']), refusingIO(4, seen), 0, entered));
    expect(seen[0]).toBe('3:4');
    expect(seen.filter((k) => k === '3:4')).toHaveLength(1);
    expect(seen).toContain('1:2');
    expect(r.lanePreviews).toBe(1);
    expect(entered.map((o) => o.id)).toEqual([4n]);
  });

  it('does not use an offer\'s entry on a TermsTooFresh answer', async () => {
    const offers = [offer(1, addr(1), 0), offer(2, addr(2), 1)];
    const entered: OfferLite[] = [];
    await runMatchWalks(walkArgs(offers, new Set(['2']), refusingIO(MATCH_ERR_TERMS_TOO_FRESH), 0, entered));
    expect(entered).toHaveLength(0);
  });

  it('stops both walks when the lane finds the fill capacity spent', async () => {
    const offers = [
      offer(1, addr(1), 0), offer(2, addr(2), 1),
      offer(3, addr(3), 0, { asset: addr(0xb1) }), offer(4, addr(4), 1, { asset: addr(0xb1) }),
    ];
    const seen: string[] = [];
    const r = await runMatchWalks(walkArgs(offers, new Set(['4']), refusingIO(18, seen)));
    expect(r.capacitySpent).toBe(true);
    expect(seen).toEqual(['3:4']);
  });

  it('caps the lane at its share of submissions', async () => {
    // Twenty fresh borrowers against one lender with plenty of room: every
    // preview clears, every submit lands.
    const offers = [offer(1, addr(1), 0)];
    const fresh = new Set<string>();
    for (let i = 0; i < 20; i++) {
      offers.push(offer(100 + i, addr(100 + i), 1));
      fresh.add(String(100 + i));
    }
    const ok: MatchPreview = { errorCode: 0, matchAmount: 1n, matchRateBps: 0n, reqCollateral: 0n, lenderRemainingPostMatch: 50n };
    const io: MatchWalkIO = { preview: async () => ok, submit: async () => true };
    const r = await runMatchWalks(walkArgs(offers, fresh, io));
    expect(r.laneSubmits).toBe(6);
    expect(r.submits).toBe(20); // the walk finished the rest
  });

  it('under fresh traffic above the quota, a resting pair is reached as soon as without the lane', async () => {
    // Bucket Y: 50 x 50 creators of fresh offers every pass (2,500 units, five
    // times the lane's preview quota). Bucket X: one resting pair. A pass can
    // preview 2,000 pairs, so without the lane the walk reaches every unit
    // within two passes; with it, the walk keeps 1,500 and must too.
    const passesToReach = async (share: number, run0: number): Promise<number> => {
      for (let pass = 0; pass < 10; pass++) {
        const offers = [offer(1, addr(1), 0), offer(2, addr(2), 1)];
        const fresh = new Set<string>();
        let id = 10_000 + pass * 1_000;
        for (let c = 0; c < 50; c++) {
          for (const side of [0, 1] as const) {
            id += 1;
            offers.push(offer(id, addr(0x10000 + side * 0x1000 + c), side, { asset: addr(0xb1) }));
            fresh.add(String(id));
          }
        }
        const seen: string[] = [];
        const args = walkArgs(offers, share > 0 ? fresh : new Set(), refusingIO(4, seen), run0 + pass);
        args.lane = freshLaneBudget(share, PASS);
        const r = await runMatchWalks(args);
        expect(r.lanePreviews).toBeLessThanOrEqual(args.lane.previews);
        expect(r.previews).toBeLessThanOrEqual(MAX_PREVIEW_CALLS_PER_TICK);
        if (seen.includes('1:2')) return pass + 1;
      }
      return Infinity;
    };
    for (const run0 of [0, 1, 7, 123, 4_567]) {
      const without = await passesToReach(0, run0);
      const withLane = await passesToReach(0.25, run0);
      expect(without).toBeLessThanOrEqual(2);
      expect(withLane).toBeLessThanOrEqual(2);
    }
  });
});
