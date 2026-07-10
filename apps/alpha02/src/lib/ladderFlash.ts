/**
 * #1131 phase 3 — book delta animations, the pure half.
 *
 * RateLadder flashes a level whose remaining size changed (or that
 * just appeared) since the previous render of the SAME (pair, tenor)
 * market. These helpers do the detection so it can be unit-tested in
 * isolation: snapshot a ladder's per-level sizes, and diff a new
 * ladder against the previous snapshot. A market switch (different
 * `marketKey`) or an absent/empty previous snapshot yields NO flash
 * ids — loading a fresh market must not strobe every row.
 */
import type { DeskLadder, LadderLevel } from '../data/desk';

export interface LadderSnapshot {
  /** Identity of the (chain, pair, tenor) the sizes belong to;
   *  `null` when the ladder was absent or empty. */
  marketKey: string | null;
  /** `levelFlashId` → remaining size at that level. */
  sizes: Map<string, bigint>;
}

/** Side-scoped level identity — an ask and a bid can rest at the
 *  same rate without colliding. */
export function levelFlashId(side: 'ask' | 'bid', rateBps: number): string {
  return `${side}:${rateBps}`;
}

/**
 * Market identity derived from the ladder's own rows — every row in a
 * built ladder shares pair AND tenor (`buildLadder` filters on both
 * via `isLiveMarketRow`), so the first offer found is representative.
 * Empty/absent ladder → `null`: with no rows there is nothing to
 * diff, and the NEXT (first-populated) render must not flash either.
 */
export function ladderMarketKey(
  ladder: DeskLadder | null,
  chainId: number,
): string | null {
  const first = ladder?.asks[0]?.offers[0] ?? ladder?.bids[0]?.offers[0];
  if (!first) return null;
  return `${chainId}:${first.lendingAsset.toLowerCase()}:${first.collateralAsset.toLowerCase()}:${first.durationDays}`;
}

/** Capture the ladder's per-level sizes for the next render's diff. */
export function snapshotLadder(
  ladder: DeskLadder | null,
  chainId: number,
): LadderSnapshot {
  const sizes = new Map<string, bigint>();
  if (ladder) {
    for (const l of ladder.asks) sizes.set(levelFlashId('ask', l.rateBps), l.size);
    for (const l of ladder.bids) sizes.set(levelFlashId('bid', l.rateBps), l.size);
  }
  return { marketKey: ladderMarketKey(ladder, chainId), sizes };
}

/**
 * Level ids to flash: size changed vs `prev`, or newly present — but
 * ONLY when `prev` covered the same market. Deterministic and pure;
 * disappeared levels need no entry (their row unmounts anyway).
 */
export function ladderFlashIds(
  prev: LadderSnapshot,
  ladder: DeskLadder | null,
  chainId: number,
): Set<string> {
  const flash = new Set<string>();
  const marketKey = ladderMarketKey(ladder, chainId);
  if (ladder === null || marketKey === null || prev.marketKey !== marketKey) {
    return flash;
  }
  const scan = (side: 'ask' | 'bid', levels: LadderLevel[]) => {
    for (const l of levels) {
      const id = levelFlashId(side, l.rateBps);
      // `undefined !== bigint` covers "newly present" in the same test.
      if (prev.sizes.get(id) !== l.size) flash.add(id);
    }
  };
  scan('ask', ladder.asks);
  scan('bid', ladder.bids);
  return flash;
}
