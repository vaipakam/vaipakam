// apps/keeper/src/freshLane.ts
//
// The offer matcher's fresh lane (#3622 part B2). A new or re-priced offer
// whose counterparty is already resting should match on the next pass, not
// whenever the rotating walk next reaches its pair. So each pass first
// previews the offers created or re-priced recently against their bucket,
// then hands what is left of the pass to the ordinary walk.
//
// Three rules keep the lane from taking the walk's turn
// (docs: IdleLiquidityMatchingDesign.md section 3, B2):
//
//  - A hard quota. The lane may spend at most `share` of the pass's previews,
//    submissions and wall time (`MATCHER_FRESH_LANE_SHARE`, a plain var,
//    default a quarter, at most a half). The walk keeps the rest whether or
//    not the lane used its share, so it never gets less than (1 - share) of
//    what it had before the lane existed.
//  - Once per offer. An offer enters the lane for its creation once. A
//    re-price enters again only after a cool-off, so re-pricing an offer
//    over and over cannot buy it standing priority.
//  - The same fairness units as the walk: one unit per pair of creators in a
//    bucket, so one wallet's burst of new offers is one unit.
//
// The lane is in-process state. A restarted keeper forgets which offers
// already entered, so an offer changed within the look-back may enter once
// more after a restart; that costs at most one quota's worth of previews.

import type { OfferLite } from './matcher';

/** The share of a pass the lane may spend when the var is unset. */
export const FRESH_LANE_DEFAULT_SHARE = 0.25;
/** The most the var may give the lane: the walk always keeps at least half. */
export const FRESH_LANE_MAX_SHARE = 0.5;
/** How recent a creation or re-price must be for the offer to count as
 *  fresh. Several passes long, so an offer the quota did not reach this pass
 *  is still fresh on the next one. */
export const FRESH_LOOKBACK_SEC = 600;
/** How long after an offer entered the lane before a re-price may enter it
 *  again. */
export const FRESH_COOL_OFF_SEC = 3600;
/** The terms-age rule's default (`ConfigFacet.getMinTermsAgeSec`), used when
 *  the chain's own value cannot be read. */
export const DEFAULT_MIN_TERMS_AGE_SEC = 5;

/** The lane's share of a pass, from `MATCHER_FRESH_LANE_SHARE`. Unset or
 *  unreadable reads as the default; a value outside 0 to the maximum is
 *  clamped into it. 0 turns the lane off. */
export function freshLaneShare(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return FRESH_LANE_DEFAULT_SHARE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return FRESH_LANE_DEFAULT_SHARE;
  return Math.min(FRESH_LANE_MAX_SHARE, Math.max(0, n));
}

/** The lane's caps for one pass, each the floor of `share` of the pass's. */
export interface FreshLaneBudget {
  readonly previews: number;
  readonly submits: number;
  readonly wallMs: number;
}

export function freshLaneBudget(
  share: number,
  pass: { previews: number; submits: number; wallMs: number },
): FreshLaneBudget {
  return {
    previews: Math.floor(pass.previews * share),
    submits: Math.floor(pass.submits * share),
    wallMs: Math.floor(pass.wallMs * share),
  };
}

/** When the offer's terms last changed: its creation, or its latest
 *  re-price. Both are block timestamps in seconds. */
export function termsChangedAt(o: Pick<OfferLite, 'createdAt' | 'termsSetAt'>): number {
  return Number(o.createdAt > o.termsSetAt ? o.createdAt : o.termsSetAt);
}

interface Entry {
  /** The terms change the offer entered the lane for. */
  changedAt: number;
  /** When it entered, by the keeper's clock (seconds). */
  enteredAt: number;
}

/**
 * Which offers of one chain have entered the lane, and for which terms
 * change. One per chain, kept for the life of the process.
 */
export class FreshLaneTracker {
  private readonly entries = new Map<string, Entry>();

  /**
   * The ids (decimal strings) of the offers the lane should look at this
   * pass: terms changed within the look-back, old enough for the terms-age
   * rule, and not entered already for that change. A re-price of an offer
   * that entered counts only once the cool-off since its entry has passed.
   * Also forgets entries too old to matter.
   */
  select(offers: readonly OfferLite[], nowSec: number, minTermsAgeSec: number): Set<string> {
    this.prune(nowSec);
    const fresh = new Set<string>();
    for (const o of offers) {
      const changedAt = termsChangedAt(o);
      const age = nowSec - changedAt;
      if (age > FRESH_LOOKBACK_SEC || age < minTermsAgeSec) continue;
      const entry = this.entries.get(o.id.toString());
      if (entry) {
        if (changedAt <= entry.changedAt) continue;
        if (nowSec - entry.enteredAt < FRESH_COOL_OFF_SEC) continue;
      }
      fresh.add(o.id.toString());
    }
    return fresh;
  }

  /** Records that the offer entered the lane for its current terms. */
  markEntered(o: OfferLite, nowSec: number): void {
    this.entries.set(o.id.toString(), { changedAt: termsChangedAt(o), enteredAt: nowSec });
  }

  /** How many offers the tracker holds (for tests). */
  get size(): number {
    return this.entries.size;
  }

  private prune(nowSec: number): void {
    for (const [id, e] of this.entries) {
      if (nowSec - e.enteredAt > FRESH_COOL_OFF_SEC + FRESH_LOOKBACK_SEC) this.entries.delete(id);
    }
  }
}

/**
 * The buckets the lane walks: those holding at least one fresh offer, with
 * every offer of the bucket on both sides (a fresh offer's counterparty is
 * usually a resting one). The caller skips pairs with no fresh side.
 */
export function freshBuckets(
  lenders: ReadonlyMap<string, readonly OfferLite[]>,
  borrowers: ReadonlyMap<string, readonly OfferLite[]>,
  fresh: ReadonlySet<string>,
): { lenders: Map<string, readonly OfferLite[]>; borrowers: Map<string, readonly OfferLite[]> } {
  const outL = new Map<string, readonly OfferLite[]>();
  const outB = new Map<string, readonly OfferLite[]>();
  if (fresh.size === 0) return { lenders: outL, borrowers: outB };
  for (const [key, ls] of lenders) {
    const bs = borrowers.get(key);
    if (!bs || bs.length === 0) continue;
    const any = ls.some((o) => fresh.has(o.id.toString())) || bs.some((o) => fresh.has(o.id.toString()));
    if (!any) continue;
    outL.set(key, ls);
    outB.set(key, bs);
  }
  return { lenders: outL, borrowers: outB };
}
