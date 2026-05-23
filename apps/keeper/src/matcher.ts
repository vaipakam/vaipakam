/**
 * apps/keeper — Range Orders Phase 1 matching pass.
 *
 * A cron sibling to the autonomous liquidator (keeper.ts). Each tick,
 * per chain: scan the order book, evaluate plausible (lender × borrower)
 * pairs via the on-chain `previewMatch` view, and submit
 * `matchOffers(lenderId, borrowerId)` for every pair the preview
 * accepts — the keeper EOA earns the 1% LIF matcher kickback (see
 * `OfferFacet._acceptOffer` lender-asset path + `LibVPFIDiscount.*` VPFI
 * path). Ported from the public reference bot
 * (`vaipakam-keeper-bot/src/detectors/offerMatcher.ts`) into the Worker
 * shape — `Env` / `getChainConfigs` / `createPublicClient` /
 * `buildKeeperContext` / `console.*` logging / `@vaipakam/contracts/abis`.
 *
 * Per tick, per chain:
 *   1. `getActiveOffersCount` (O(1)) — short-circuit when 0.
 *   2. Page `getActiveOffersPaginated` for all live ids.
 *   3. Hydrate each id via `getOffer(id)`; split into lender / borrower.
 *   4. Bucket by the cheap continuity key (`(lendingAsset,
 *      collateralAsset, assetType, collateralAssetType, durationDays)`)
 *      so the cartesian shrinks to per-bucket nested loops.
 *   5. Within each bucket, `previewMatch(L, B)` until a pair returns
 *      `errorCode == 0` (Ok).
 *   6. Submit `matchOffers(L, B)`. Reverts (lost a race, kill-switch
 *      off, …) are logged and treated as no-ops — next tick re-evaluates.
 *
 * Gated on the same flag as the liquidator: `KEEPER_ENABLED == 'true'`
 * AND `KEEPER_PRIVATE_KEY` set (`isKeeperEnabled`). Master kill-switch:
 * `OfferMatchFacet.matchOffers` reverts `FunctionDisabled(3)` while
 * `s.protocolCfg.partialFillEnabled` is false (the default until
 * governance flips it) — logged once per chain per warm isolate, then
 * the matcher keeps polling.
 *
 * Discovery is on-chain (count + paginate + getOffer) for now; a future
 * optimisation could read candidate pairs from the indexer's `offers`
 * table via the shared D1 binding and only `previewMatch` on-chain.
 */

import { createPublicClient, http, type Abi, type Address, type Hex } from 'viem';
import {
  MetricsFacetABI,
  OfferCreateFacetABI,
  OfferAcceptFacetABI,
  OfferCancelFacetABI,
  OfferMatchFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import {
  buildKeeperContext,
  isKeeperEnabled,
  type KeeperContext,
} from './keeper';

// `getActiveOffersCount` / `getActiveOffersPaginated` live on
// MetricsFacet; `getOffer` on OfferCancelFacet post the EIP-170 facet
// split; `previewMatch` / `matchOffers` on OfferMatchFacet. Merge the
// relevant facet ABIs so viem can resolve every selector against the
// Diamond.
const MATCHER_ABI: Abi = [
  ...(MetricsFacetABI as Abi),
  ...(OfferCreateFacetABI as Abi),
  ...(OfferAcceptFacetABI as Abi),
  ...(OfferCancelFacetABI as Abi),
  ...(OfferMatchFacetABI as Abi),
];

/** Pagination size for `getActiveOffersPaginated`. */
const SCAN_PAGE = 200n;

/** Chunk size for the `getOffer` hydration fan-out — keeps the
 *  concurrent `eth_call` count off a single RPC endpoint bounded. */
const HYDRATE_CHUNK = 40;

/** Per-tick cap on `previewMatch` calls (one `eth_call` each). */
const MAX_PREVIEW_CALLS_PER_TICK = 2000;

/** Per-tick cap on `matchOffers` submissions — a busy book shouldn't
 *  burn the keeper's whole gas budget in one cron tick. */
const MAX_SUBMITS_PER_TICK = 25;

/** Codex #176 round-2 P2 — per-chain wall-time budget. `submitMatch`
 *  awaits `waitForTransactionReceipt` (up to ~30 s per match post-#172);
 *  `runMatcher` runs chains sequentially. Without a budget, one
 *  congested chain can consume `MAX_SUBMITS_PER_TICK × 30 s` ≈ 12.5 min
 *  and push the scheduled invocation past the Workers cron wall-time
 *  limit, starving later chains for that tick. 90 s per chain leaves
 *  headroom for ~3 multi-chain ticks within a 5-min cron envelope. */
const PER_CHAIN_WALL_TIME_BUDGET_MS = 90_000;

/** `LibOfferMatch.MatchError` index 0 == Ok. */
const MATCH_ERR_OK = 0;
/** `LibOfferMatch.MatchError.SelfTrade` (the same-creator-both-sides
 *  classifier added in vaipakam #234). The contract-side load-bearing
 *  gate lives in `OfferAcceptFacet._acceptOffer`; `previewMatch`
 *  returns this variant when `L.creator == B.creator` so bots can
 *  short-circuit before submitting `matchOffers`. Numeric value 11 —
 *  the variant is the 12th in the enum (after `LtvAboveTier`). */
const MATCH_ERR_SELF_TRADE = 11;

/** `LibVaipakam.OfferType`. */
const OFFER_TYPE_LENDER = 0;
const OFFER_TYPE_BORROWER = 1;

/** Subset of the `Offer` struct the matcher needs. */
interface OfferLite {
  id: bigint;
  /** Offer creator — used for the #235 self-trade pre-filter. Two
   *  offers with the same creator can never produce a valid loan
   *  (the contract reverts `SelfTradeForbidden(party)` in
   *  `_acceptOffer`), so we skip them client-side before paying for
   *  an `eth_call` to `previewMatch`. */
  creator: Address;
  offerType: number;
  accepted: boolean;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: Address;
  collateralAsset: Address;
  durationDays: bigint;
}

interface MatchPreview {
  errorCode: number;
  matchAmount: bigint;
  matchRateBps: bigint;
  reqCollateral: bigint;
  lenderRemainingPostMatch: bigint;
}

/** Throttles the `FunctionDisabled(3)` kill-switch log to once per
 *  chain per warm isolate. */
const killSwitchLogged = new Map<number, boolean>();

function bucketKey(o: OfferLite): string {
  return [
    o.lendingAsset.toLowerCase(),
    o.collateralAsset.toLowerCase(),
    o.assetType,
    o.collateralAssetType,
    o.durationDays.toString(),
  ].join('|');
}

function liftOffer(raw: Record<string, unknown>): OfferLite {
  return {
    id: BigInt(raw['id'] as bigint | number),
    creator: raw['creator'] as Address,
    offerType: Number(raw['offerType']),
    accepted: Boolean(raw['accepted']),
    assetType: Number(raw['assetType']),
    collateralAssetType: Number(raw['collateralAssetType']),
    lendingAsset: raw['lendingAsset'] as Address,
    collateralAsset: raw['collateralAsset'] as Address,
    durationDays: BigInt(raw['durationDays'] as bigint | number),
  };
}

async function listActiveOfferIds(ctx: KeeperContext): Promise<bigint[]> {
  let total: bigint;
  try {
    total = (await ctx.client.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'getActiveOffersCount',
    })) as bigint;
  } catch (err) {
    console.error(
      `[matcher] chain=${ctx.chainId} getActiveOffersCount failed: ${String(err).slice(0, 200)}`,
    );
    return [];
  }
  if (total === 0n) return [];

  const ids: bigint[] = [];
  for (let offset = 0n; offset < total; offset += SCAN_PAGE) {
    try {
      const page = (await ctx.client.readContract({
        address: ctx.diamond,
        abi: MATCHER_ABI,
        functionName: 'getActiveOffersPaginated',
        args: [offset, SCAN_PAGE],
      })) as readonly bigint[];
      for (const id of page) ids.push(id);
      if (page.length < Number(SCAN_PAGE)) break;
    } catch (err) {
      console.error(
        `[matcher] chain=${ctx.chainId} getActiveOffersPaginated offset=${Number(offset)} failed: ${String(err).slice(0, 200)}`,
      );
      break;
    }
  }
  return ids;
}

async function hydrateOffers(
  ctx: KeeperContext,
  ids: readonly bigint[],
): Promise<OfferLite[]> {
  const out: OfferLite[] = [];
  for (let i = 0; i < ids.length; i += HYDRATE_CHUNK) {
    const chunk = ids.slice(i, i + HYDRATE_CHUNK);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          const raw = (await ctx.client.readContract({
            address: ctx.diamond,
            abi: MATCHER_ABI,
            functionName: 'getOffer',
            args: [id],
          })) as Record<string, unknown>;
          return liftOffer(raw);
        } catch {
          // A cancelled-mid-tick offer is expected to occasionally
          // fail here — skip it, don't kill the loop.
          return null;
        }
      }),
    );
    for (const o of results) {
      if (o && !o.accepted) out.push(o);
    }
  }
  return out;
}

function partitionByBucket(offers: readonly OfferLite[]): {
  lenders: Map<string, OfferLite[]>;
  borrowers: Map<string, OfferLite[]>;
} {
  const lenders = new Map<string, OfferLite[]>();
  const borrowers = new Map<string, OfferLite[]>();
  for (const o of offers) {
    const target =
      o.offerType === OFFER_TYPE_LENDER
        ? lenders
        : o.offerType === OFFER_TYPE_BORROWER
          ? borrowers
          : null;
    if (!target) continue;
    const key = bucketKey(o);
    let bucket = target.get(key);
    if (!bucket) {
      bucket = [];
      target.set(key, bucket);
    }
    bucket.push(o);
  }
  return { lenders, borrowers };
}

async function previewMatch(
  ctx: KeeperContext,
  lenderId: bigint,
  borrowerId: bigint,
): Promise<MatchPreview | null> {
  try {
    const raw = (await ctx.client.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'previewMatch',
      args: [lenderId, borrowerId],
    })) as Record<string, unknown>;
    return {
      errorCode: Number(raw['errorCode']),
      matchAmount: BigInt(raw['matchAmount'] as bigint | number),
      matchRateBps: BigInt(raw['matchRateBps'] as bigint | number),
      reqCollateral: BigInt(raw['reqCollateral'] as bigint | number),
      lenderRemainingPostMatch: BigInt(
        raw['lenderRemainingPostMatch'] as bigint | number,
      ),
    };
  } catch {
    return null;
  }
}

async function submitMatch(
  ctx: KeeperContext,
  lenderId: bigint,
  borrowerId: bigint,
  preview: MatchPreview,
): Promise<boolean> {
  const account = ctx.wallet.account;
  if (!account) return false;
  let hash: Hex;
  try {
    hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'matchOffers',
      args: [lenderId, borrowerId],
      account,
      chain: ctx.wallet.chain,
    });
  } catch (err) {
    const errStr = String(err);
    // FunctionDisabled(3) — the partialFillEnabled master kill-switch.
    // Log once per chain per warm isolate; keep polling so a governance
    // flip is picked up without a restart.
    if (errStr.includes('FunctionDisabled') || errStr.includes('0x96624a75')) {
      if (!killSwitchLogged.get(ctx.chainId)) {
        console.log(
          `[matcher] chain=${ctx.chainId} disabled: partialFillEnabled master flag is off; retrying every tick`,
        );
        killSwitchLogged.set(ctx.chainId, true);
      }
    } else {
      console.log(
        `[matcher] chain=${ctx.chainId} matchOffers lender=${Number(lenderId)} borrower=${Number(borrowerId)} broadcast failed: ${errStr.slice(0, 200)}`,
      );
    }
    return false;
  }

  // Codex #176 round-1 P1 — wait for inclusion before returning success.
  // Without this, the matcher tick's inner loop continues immediately
  // and the next `previewMatch` reads `latest` state which doesn't
  // include the just-broadcast tx's effects. Subsequent (L,B) pairs
  // then evaluate against PRE-match lender capacity, queue up multiple
  // matches against the SAME unallocated balance, and most of them
  // revert when mined — burning keeper gas AND wasting
  // `MAX_SUBMITS_PER_TICK` slots that should go to valid pairs.
  //
  // Pattern mirrors `apps/keeper/src/dailyOracleSnapshot.ts:127` (the
  // existing sibling that waits for receipt before continuing). 30s
  // timeout per match — bounded by chain block time × small constant.
  // Worst-case tick duration: `MAX_SUBMITS_PER_TICK × ~block_time`,
  // which is acceptable given the cron cadence (the next cron either
  // overlaps via the Workers concurrency lock or starts fresh state).
  try {
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    if (receipt.status !== 'success') {
      // On-chain revert — another keeper / a borrower cancel / a
      // governance flip raced us. Log it; caller breaks the inner
      // loop on `false` because the lender's state has moved beyond
      // what previewMatch predicted, and subsequent submits would
      // likely revert for the same reason.
      console.log(
        `[matcher] chain=${ctx.chainId} matchOffers lender=${Number(lenderId)} borrower=${Number(borrowerId)} reverted on-chain tx=${hash}`,
      );
      return false;
    }
  } catch (err) {
    // Timeout (tx dropped from mempool or RPC slow) — assume in-flight
    // and back off this lender for the tick.
    console.log(
      `[matcher] chain=${ctx.chainId} matchOffers lender=${Number(lenderId)} borrower=${Number(borrowerId)} receipt wait failed tx=${hash}: ${String(err).slice(0, 200)}`,
    );
    return false;
  }

  console.log(
    `[matcher] chain=${ctx.chainId} matched lender=${Number(lenderId)} borrower=${Number(borrowerId)} tx=${hash} amount=${preview.matchAmount.toString()} rateBps=${Number(preview.matchRateBps)} lenderRemaining=${preview.lenderRemainingPostMatch.toString()}`,
  );
  return true;
}

/** One pass over a chain's order book. */
async function runOfferMatcherTickForChain(ctx: KeeperContext): Promise<void> {
  const ids = await listActiveOfferIds(ctx);
  if (ids.length === 0) return;
  const offers = await hydrateOffers(ctx, ids);
  const { lenders, borrowers } = partitionByBucket(offers);

  // Codex #176 round-2 P2 — bound the chain's wall-time so a congested
  // chain can't starve later chains in the same cron tick. Each call
  // site checks `overBudget()` before doing more work.
  const tickStart = Date.now();
  const overBudget = () =>
    Date.now() - tickStart > PER_CHAIN_WALL_TIME_BUDGET_MS;

  let previewCalls = 0;
  let submits = 0;
  const attempted = new Set<string>();

  for (const [key, lenderList] of lenders) {
    if (submits >= MAX_SUBMITS_PER_TICK) break;
    if (overBudget()) break;
    const borrowerList = borrowers.get(key);
    if (!borrowerList || borrowerList.length === 0) continue;

    for (const L of lenderList) {
      if (submits >= MAX_SUBMITS_PER_TICK) break;
      if (overBudget()) break;
      for (const B of borrowerList) {
        if (previewCalls >= MAX_PREVIEW_CALLS_PER_TICK) break;
        if (submits >= MAX_SUBMITS_PER_TICK) break;
        if (overBudget()) break;
        const pairKey = `${L.id}:${B.id}`;
        if (attempted.has(pairKey)) continue;
        attempted.add(pairKey);

        // #235 — self-trade short-circuit. Same-creator pairs can
        // never produce a valid loan (the contract reverts
        // `SelfTradeForbidden(party)` in `_acceptOffer`), and
        // `previewMatch` returns `MatchError.SelfTrade`. Skipping
        // them before the RPC roundtrip saves one `eth_call` per
        // colluding-creator pair per tick. Lower-cased comparison
        // because `getOffer` returns checksummed addresses but the
        // raw bytes are what matter.
        if (L.creator.toLowerCase() === B.creator.toLowerCase()) {
          continue;
        }

        previewCalls += 1;
        const p = await previewMatch(ctx, L.id, B.id);
        if (!p || p.errorCode !== MATCH_ERR_OK) {
          // Defence-in-depth: the client-side self-trade pre-filter
          // above should catch every same-creator pair, but log here
          // anyway in case `getOffer` ever races against an in-flight
          // ownership transfer or the OfferLite struct loses the
          // `creator` field in a future refactor. Other typed errors
          // are too noisy to log per-pair on a busy book; the
          // observability story for those lives in the per-tick
          // submits / previewCalls metric.
          if (p && p.errorCode === MATCH_ERR_SELF_TRADE) {
            console.log(
              `[matcher] chain=${ctx.chainId} self-trade pair slipped pre-filter — L=${L.id} B=${B.id} creator=${L.creator}`,
            );
          }
          continue;
        }

        const ok = await submitMatch(ctx, L.id, B.id, p);
        if (ok) {
          submits += 1;
          // Issue #172 / #102 — post-borrower-partial-fill, borrower
          // offers are NOT single-fill anymore. Don't break the inner
          // loop on success: the same lender may have remaining capacity
          // to fan-out across additional borrowers in this tick, and the
          // same borrower (post-this match) may still have capacity that
          // a DIFFERENT lender in `lenderList` could fill.
          //
          // The `attempted` set already prevents re-trying the exact
          // (L,B) pair within a tick. After a successful submit, both
          // L's and B's `amountFilled` have grown on-chain; the next
          // `previewMatch` call within this tick reads the updated state
          // and returns the right overlap (or `AmountNoOverlap` /
          // dust-close, which the `if (!p || p.errorCode !== Ok)`
          // continue above handles cleanly).
          //
          // Early-exit only when the preview reports the lender is now
          // FULLY filled (`lenderRemainingPostMatch == 0n`). Anything
          // smaller — where the lender still has some capacity that
          // might not meet the per-match minimum — is left to the
          // contract's `previewMatch` to filter on the next iteration;
          // the extra preview call per exhausted lender per tick is
          // cheap relative to fan-out wins on healthy ones.
          if (p.lenderRemainingPostMatch === 0n) {
            break;
          }
          // Otherwise fall through to the next borrower for this lender.
          continue;
        }
        // Codex #176 round-2 P1 — `submitMatch` returned false. The
        // three causes (broadcast failure, on-chain revert,
        // `waitForTransactionReceipt` timeout) all leave L's state
        // uncertain — the tx may still be in flight, or another keeper
        // / a borrower-cancel raced us. Trying L against B2/B3 in the
        // same tick would re-evaluate against possibly-stale state
        // and either queue duplicate matches (the race the #176
        // round-1 fix existed to prevent) or burn preview calls on
        // doomed pairs. Back off this lender for the tick — `attempted`
        // already prevents (L,B1) retry, but we need an explicit
        // `break` to skip the rest of the borrower list too.
        break;
      }
    }
  }

  if (submits > 0 || previewCalls > 0) {
    console.log(
      `[matcher] chain=${ctx.chainId} activeOffers=${offers.length} previewCalls=${previewCalls} submits=${submits} elapsedMs=${Date.now() - tickStart}`,
    );
  }
  if (overBudget()) {
    console.log(
      `[matcher] chain=${ctx.chainId} wall-time budget exhausted (${
        Date.now() - tickStart
      }ms); deferring remaining work to next tick`,
    );
  }
}

/**
 * Top-level matching pass — one tick across every configured chain.
 * No-op (and a single log line) when the keeper is disabled. Each
 * chain runs in its own try/catch so a transient RPC hiccup on one
 * can't wedge the rest.
 */
export async function runMatcher(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  const chains: ChainConfig[] = getChainConfigs(env);
  for (const chain of chains) {
    try {
      const publicClient = createPublicClient({ transport: http(chain.rpc) });
      const ctx = buildKeeperContext(env, chain, publicClient);
      if (!ctx) continue;
      await runOfferMatcherTickForChain(ctx);
    } catch (err) {
      console.error(
        `[matcher] chain=${chain.id} (${chain.name}) tick failed: ${String(err).slice(0, 250)}`,
      );
    }
  }
}
