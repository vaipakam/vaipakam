/**
 * apps/keeper — Range Orders matching + #625 auto-lend intent-fill pass.
 *
 * A cron sibling to the autonomous liquidator (keeper.ts). Each tick,
 * per chain: scan the order book, evaluate plausible (lender × borrower)
 * pairs via the on-chain `previewMatch` view, and submit
 * `matchOffers(lenderId, borrowerId)` for every pair the preview
 * accepts; THEN run the #625 WI-2c auto-lend intent-fill pass — page the
 * funded, active lender intents (`getActiveLenderIntents`), size a fill
 * against the same hydrated borrower book, confirm it with `previewIntent`,
 * and submit `matchIntent`; and FINALLY the auto-roll pass — page the
 * fully-repaid intent loans (`getRollableIntentLoans`) and `rollIntentLoan`
 * each, re-lending the proceeds back into the lender's intent capital (this
 * pass runs even when there are no open offers). The match + fill paths earn
 * the keeper EOA the 1% LIF matcher kickback (see
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
  RiskAccessFacetABI,
  AdminFacetABI,
  LenderIntentFacetABI,
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
// `getActiveLenderIntents` lives on MetricsFacet; `previewIntent` on
// RiskAccessFacet; `matchIntent` on OfferMatchFacet — added for the #625
// WI-2c auto-lend intent-fill pass alongside the Range-Orders selectors.
const MATCHER_ABI: Abi = [
  ...(MetricsFacetABI as Abi),
  ...(OfferCreateFacetABI as Abi),
  ...(OfferAcceptFacetABI as Abi),
  ...(OfferCancelFacetABI as Abi),
  ...(OfferMatchFacetABI as Abi),
  ...(RiskAccessFacetABI as Abi),
  ...(AdminFacetABI as Abi), // keepersPaused() self-gate (Codex #748 r3)
  ...(LenderIntentFacetABI as Abi), // rollIntentLoan — #625 WI-2c part 2b
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
  // #625 WI-2c — borrower-side fields the auto-lend intent-fill pass needs to
  // pre-size a fill + pre-filter on the WI-3 guards before paying for a
  // `previewIntent` eth_call. (Carried on every offer; only read for borrowers.)
  amount: bigint; // min fill (single-value lower bound)
  amountMax: bigint; // max fill ceiling
  amountFilled: bigint; // already consumed
  interestRateBpsMax: bigint; // borrower's rate ceiling (rate-overlap pre-filter)
  fillMode: number; // 0 = Partial, 1 = Aon
  useFullTermInterest: boolean; // intent fills require this true
  allowsPartialRepay: boolean; // intent fills require this false
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

/** Throttles the `keepersPaused` self-gate log to once per chain per warm
 *  isolate (Codex #748 r3). */
const keepersPausedLogged = new Map<number, boolean>();

// ═══════════════════════════════════════════════════════════════════════
// #625 WI-2c — auto-lend intent-fill pass
//
// Alongside the Range-Orders matcher, each tick also scans the funded,
// active LENDER INTENTS (`getActiveLenderIntents`, the WI-2a discovery feed)
// and, for each, looks across the already-hydrated borrower book for a fillable
// counterparty. The keeper sizes the fill from the intent's + borrower's
// bounds, confirms it with the gas-free `previewIntent` view (WI-2b — the SAME
// predicates `matchIntent` runs), and only then submits `matchIntent`. The
// keeper EOA is the solver, so it earns the 1% LIF matcher kickback exactly as
// on the `matchOffers` path. A `requiresKeeperAuth` intent is skipped unless
// the keeper holds the lender's `KEEPER_ACTION_SIGNED_FILL` delegation — the
// `previewIntent` `KeeperUnauthorized` code surfaces that without a revert.
// ═══════════════════════════════════════════════════════════════════════

/** Pagination size for `getActiveLenderIntents`. */
const INTENT_SCAN_PAGE = 100n;

/** `LibVaipakam.FillMode.Aon`. */
const FILL_MODE_AON = 1;

// `LibOfferMatch.IntentError` indices the intent-fill pass classifies a non-ok
// `previewIntent` by (Ok, Paused, Sanctioned, MatcherDisabled, IntentDisabled,
//  AggregatorPaused, Inactive, VpfiLendingUnsupported, KeeperUnauthorized,
//  BelowMinFill, ExposureExceeded, DurationTooLong, FullTermRequired,
//  PartialRepayNotAllowed, CollateralUnresolvable, CapitalInsufficient, …):

/** GLOBAL codes — identical for every intent + borrower this tick, so the whole
 *  pass stops (Codex #748 r2/r3). 3/4 (the master kill-switches) additionally
 *  log once. */
const INTENT_ERR_PASS_TERMINAL = new Set<number>([
  1, // Paused — diamond globally paused
  3, // MatcherDisabled — partialFillEnabled off
  4, // IntentDisabled — lenderIntentEnabled off
]);
const INTENT_ERR_MATCHER_DISABLED = 3;
const INTENT_ERR_INTENT_DISABLED = 4;

/** INTENT-level codes — identical for every BORROWER of this intent, so abandon
 *  the intent (not just the one borrower) rather than burning a preview per
 *  borrower for the same verdict (Codex #748 r1/r3).
 *
 *  CollateralUnresolvable (14) is DELIBERATELY excluded (Codex #748 r4): it
 *  fires both when the pair is unpriceable (intent-level) AND when a tiny fill
 *  rounds the required collateral to zero (size-specific), indistinguishable
 *  from the code alone — abandoning the intent on a dust borrower would skip
 *  later fillable ones. Treated as borrower-specific (continue). */
const INTENT_ERR_INTENT_TERMINAL = new Set<number>([
  2, // Sanctioned — solver (keeper) or this lender
  5, // AggregatorPaused — this aggregator-adapter intent frozen
  6, // Inactive
  7, // VpfiLendingUnsupported
  8, // KeeperUnauthorized — this keeper not delegated for a gated intent
]);

/** `LibOfferMatch.MatchError.CollateralBelowRequired` — index 6. When a non-AON
 *  fill fails on this, the keeper binary-searches `previewIntent.ok` over
 *  [lo, hi) for the LARGEST viable fill, rather than re-attempting the same
 *  too-large amount every tick (Codex r4/r5). NOTE: `previewIntent` returns
 *  `reqCollateral == 0` on this failure (the match core returns before assigning
 *  it — LibOfferMatch CBR branches), so a reqCollateral-scaled single retry
 *  cannot work; the search probes the predicate directly. */
const MATCH_ERR_COLLATERAL_BELOW = 6;

/** Max `previewIntent` probes for the collateral size-down binary search. */
const INTENT_SIZE_DOWN_MAX_PROBES = 6;

/** One row of `MetricsFacet.getActiveLenderIntents` (`LenderIntentSummary`). */
interface LenderIntentSummary {
  owner: Address;
  lendingAsset: Address;
  collateralAsset: Address;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
  livePrincipal: bigint;
  availableCapital: bigint;
}

/** `RiskAccessFacet.previewIntent` → `LibOfferMatch.IntentPreviewResult`. */
interface IntentPreview {
  ok: boolean;
  intentError: number;
  matchError: number;
  riskBlock: number;
  matchAmount: bigint;
  matchRateBps: bigint;
  reqCollateral: bigint;
  availableCapital: bigint;
}

// ═══════════════════════════════════════════════════════════════════════
// #625 WI-2c part 2b — auto-lend ROLL pass
//
// After the fill pass, the keeper pages the on-chain registry of fully-repaid
// intent loans (`getRollableIntentLoans`, the WI-2c part-2a discovery surface)
// and AUTO-ROLLS each via `rollIntentLoan` — re-lending the proceeds straight
// back into the lender's intent capital with no claim/refund round-trip. The
// keeper must hold the lender's `KEEPER_ACTION_AUTO_ROLL` delegation (or be the
// owner); a loan it isn't delegated for reverts, so the pass skips every later
// loan with the SAME owner once one reverts for that reason.
// ═══════════════════════════════════════════════════════════════════════

/** Pagination size for `getRollableIntentLoans`. */
const ROLL_SCAN_PAGE = 100n;

/** One row of `MetricsFacet.getRollableIntentLoans` (`RollableIntentLoan`). */
interface RollableIntentLoan {
  loanId: bigint;
  owner: Address;
  lendingAsset: Address;
  collateralAsset: Address;
  amount: bigint;
}

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
    amount: BigInt(raw['amount'] as bigint | number),
    amountMax: BigInt(raw['amountMax'] as bigint | number),
    amountFilled: BigInt(raw['amountFilled'] as bigint | number),
    interestRateBpsMax: BigInt(raw['interestRateBpsMax'] as bigint | number),
    fillMode: Number(raw['fillMode']),
    useFullTermInterest: Boolean(raw['useFullTermInterest']),
    allowsPartialRepay: Boolean(raw['allowsPartialRepay']),
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

// ─── #625 WI-2c intent-fill helpers ────────────────────────────────────────

function liftIntent(raw: Record<string, unknown>): LenderIntentSummary {
  return {
    owner: raw['owner'] as Address,
    lendingAsset: raw['lendingAsset'] as Address,
    collateralAsset: raw['collateralAsset'] as Address,
    maxExposure: BigInt(raw['maxExposure'] as bigint | number),
    minRateBps: BigInt(raw['minRateBps'] as bigint | number),
    maxInitLtvBps: Number(raw['maxInitLtvBps']),
    maxDurationDays: Number(raw['maxDurationDays']),
    minFillAmount: BigInt(raw['minFillAmount'] as bigint | number),
    requiresKeeperAuth: Boolean(raw['requiresKeeperAuth']),
    livePrincipal: BigInt(raw['livePrincipal'] as bigint | number),
    availableCapital: BigInt(raw['availableCapital'] as bigint | number),
  };
}

async function listActiveIntents(
  ctx: KeeperContext,
  overBudget: () => boolean,
): Promise<LenderIntentSummary[]> {
  const out: LenderIntentSummary[] = [];
  let total: bigint | null = null;
  for (
    let offset = 0n;
    total === null || offset < total;
    offset += INTENT_SCAN_PAGE
  ) {
    // Codex #748 r3 — stop paging the registry the moment the per-chain
    // wall-time budget is spent; a large/slow registry must not delay later
    // chains in the same cron tick before any borrower scanning starts.
    if (overBudget()) break;
    try {
      const res = (await ctx.client.readContract({
        address: ctx.diamond,
        abi: MATCHER_ABI,
        functionName: 'getActiveLenderIntents',
        args: [offset, INTENT_SCAN_PAGE],
      })) as readonly [readonly Record<string, unknown>[], bigint];
      const [rows, t] = res;
      total = t;
      for (const r of rows) out.push(liftIntent(r));
      if (rows.length < Number(INTENT_SCAN_PAGE)) break;
    } catch (err) {
      console.error(
        `[matcher] chain=${ctx.chainId} getActiveLenderIntents offset=${Number(offset)} failed: ${String(err).slice(0, 200)}`,
      );
      break;
    }
  }
  return out;
}

async function previewIntent(
  ctx: KeeperContext,
  solver: Address,
  intent: LenderIntentSummary,
  borrowerId: bigint,
  fillAmount: bigint,
): Promise<IntentPreview | null> {
  try {
    const raw = (await ctx.client.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'previewIntent',
      args: [
        solver,
        intent.owner,
        intent.lendingAsset,
        intent.collateralAsset,
        borrowerId,
        fillAmount,
      ],
    })) as Record<string, unknown>;
    return {
      ok: Boolean(raw['ok']),
      intentError: Number(raw['intentError']),
      matchError: Number(raw['matchError']),
      riskBlock: Number(raw['riskBlock']),
      matchAmount: BigInt(raw['matchAmount'] as bigint | number),
      matchRateBps: BigInt(raw['matchRateBps'] as bigint | number),
      reqCollateral: BigInt(raw['reqCollateral'] as bigint | number),
      availableCapital: BigInt(raw['availableCapital'] as bigint | number),
    };
  } catch {
    return null;
  }
}

async function submitIntentFill(
  ctx: KeeperContext,
  intent: LenderIntentSummary,
  borrowerId: bigint,
  fillAmount: bigint,
  preview: IntentPreview,
): Promise<boolean> {
  const account = ctx.wallet.account;
  if (!account) return false;
  let hash: Hex;
  try {
    hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'matchIntent',
      args: [
        intent.owner,
        intent.lendingAsset,
        intent.collateralAsset,
        borrowerId,
        fillAmount,
      ],
      account,
      chain: ctx.wallet.chain,
    });
  } catch (err) {
    const errStr = String(err);
    // partialFillEnabled (3) or lenderIntentEnabled (4) master flag off.
    if (errStr.includes('FunctionDisabled')) {
      if (!killSwitchLogged.get(ctx.chainId)) {
        console.log(
          `[matcher] chain=${ctx.chainId} intent-fill disabled: a master flag (partialFill/lenderIntent) is off; retrying every tick`,
        );
        killSwitchLogged.set(ctx.chainId, true);
      }
    } else {
      console.log(
        `[matcher] chain=${ctx.chainId} matchIntent lender=${intent.owner} borrower=${Number(borrowerId)} broadcast failed: ${errStr.slice(0, 200)}`,
      );
    }
    return false;
  }
  try {
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    if (receipt.status !== 'success') {
      console.log(
        `[matcher] chain=${ctx.chainId} matchIntent lender=${intent.owner} borrower=${Number(borrowerId)} reverted on-chain tx=${hash}`,
      );
      return false;
    }
  } catch (err) {
    console.log(
      `[matcher] chain=${ctx.chainId} matchIntent lender=${intent.owner} borrower=${Number(borrowerId)} receipt wait failed tx=${hash}: ${String(err).slice(0, 200)}`,
    );
    return false;
  }
  console.log(
    `[matcher] chain=${ctx.chainId} intent-filled lender=${intent.owner} borrower=${Number(borrowerId)} tx=${hash} amount=${fillAmount.toString()} rateBps=${Number(preview.matchRateBps)}`,
  );
  return true;
}

/** Read the operational keeper pause (Codex #748 r3/r4). Fail-CLOSED: a failed
 *  read returns `true` so the pass skips rather than risk originating loans
 *  during an unconfirmed pause. Cheap enough to re-read immediately before each
 *  submit, since the flag can flip mid-scan (the r4 P1 race). */
async function keepersPaused(ctx: KeeperContext): Promise<boolean> {
  try {
    return (await ctx.client.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'keepersPaused',
    })) as boolean;
  } catch {
    return true;
  }
}

function logKeepersPausedOnce(ctx: KeeperContext): void {
  if (!keepersPausedLogged.get(ctx.chainId)) {
    console.log(
      `[matcher] chain=${ctx.chainId} intent-fill skipped: keepersPaused (or its read failed); retrying every tick`,
    );
    keepersPausedLogged.set(ctx.chainId, true);
  }
}

/**
 * Size the fill for an (intent, borrower) pair from BOTH sides' bounds, or
 * null when no legal amount exists. Mirrors `matchIntent`'s reserve accounting:
 *   lo = max(intent dust floor, borrower min);
 *   hi = min(remaining exposure headroom, un-lent funded capital, borrower
 *           remaining capacity).
 * A non-AON fill deploys the most capital the window allows (`hi`); an AON
 * borrower pins the fill to its full `amount` (admits exactly one fill).
 */
function sizeIntentFill(
  intent: LenderIntentSummary,
  b: OfferLite,
): bigint | null {
  const exposureHeadroom =
    intent.maxExposure > intent.livePrincipal
      ? intent.maxExposure - intent.livePrincipal
      : 0n;
  const borrowerRemaining =
    b.amountMax > b.amountFilled ? b.amountMax - b.amountFilled : 0n;
  const lo = intent.minFillAmount > b.amount ? intent.minFillAmount : b.amount;
  let hi =
    exposureHeadroom < intent.availableCapital
      ? exposureHeadroom
      : intent.availableCapital;
  if (borrowerRemaining < hi) hi = borrowerRemaining;
  if (hi === 0n || hi < lo) return null;
  if (b.fillMode === FILL_MODE_AON) {
    return b.amount >= lo && b.amount <= hi ? b.amount : null;
  }
  return hi;
}

/**
 * Auto-lend intent-fill pass: for each funded, active lender intent, scan the
 * already-hydrated borrower book for a fillable counterparty, confirm with the
 * gas-free `previewIntent` view, and submit `matchIntent`. Bounded by the
 * per-tick caps + the shared per-chain wall-time budget.
 */
async function runIntentFillPass(
  ctx: KeeperContext,
  borrowers: readonly OfferLite[],
  overBudget: () => boolean,
  submitsUsed: number,
  previewsUsed: number,
  // Codex #748 r2/r3 — borrowers whose submit (matchOffers OR matchIntent) was
  // uncertain this tick. Shared with the matchOffers loop so a borrower left
  // in-flight by an offer-match timeout isn't double-filled by an intent.
  uncertainBorrowers: Set<string>,
  // #625 WI-2c part 2b — returns the cumulative submit count so the tick can
  // thread the SHARED per-tick budget on into the roll pass.
): Promise<number> {
  // Codex #748 r1/r2 — don't even PAGE the intent registry unless there is
  // budget left to act on it: the wall-time budget, AND the inherited shared
  // preview/submit caps the matchOffers loop may already have drained. Either
  // way the pass can do no legal work, so the `getActiveLenderIntents` RPCs
  // would be pure waste (and could themselves blow the 90s budget).
  if (
    overBudget() ||
    submitsUsed >= MAX_SUBMITS_PER_TICK ||
    previewsUsed >= MAX_PREVIEW_CALLS_PER_TICK
  ) {
    return submitsUsed;
  }
  const solver = ctx.wallet.account?.address;
  if (!solver) return submitsUsed;

  // Codex #748 r3 — self-gate on the OPERATIONAL keeper pause. For OPEN
  // (non-keeper-gated) intents `previewIntent` returns ok even while
  // `keepersPaused` is set — `LibAuth` is consulted only for gated intents — so
  // without this the keeper would keep ORIGINATING auto-lend loans during a
  // pause. The design requires the off-chain bot to self-gate
  // (AutoLendIntentUnificationDesign.md). Fail CLOSED: a failed read skips the
  // pass this tick rather than risk filling during an (unconfirmed) pause. The
  // flag is re-read immediately before each submit too (Codex r4 P1 race).
  if (await keepersPaused(ctx)) {
    logKeepersPausedOnce(ctx);
    return submitsUsed;
  }

  const intents = await listActiveIntents(ctx, overBudget);
  if (intents.length === 0 || borrowers.length === 0) return submitsUsed;

  // Codex #748 r1 — CONTINUE the outer tick's RPC/gas budget rather than
  // resetting it: the intent pass shares `MAX_PREVIEW_CALLS_PER_TICK` /
  // `MAX_SUBMITS_PER_TICK` with the matchOffers loop, so the two passes can't
  // together exceed the documented per-chain rails on a busy book.
  let previews = previewsUsed;
  let submits = submitsUsed;
  let intentFills = 0;
  for (const intent of intents) {
    if (overBudget() || submits >= MAX_SUBMITS_PER_TICK) break;
    for (const b of borrowers) {
      if (
        previews >= MAX_PREVIEW_CALLS_PER_TICK ||
        submits >= MAX_SUBMITS_PER_TICK ||
        overBudget()
      ) {
        break;
      }
      if (uncertainBorrowers.has(b.id.toString())) continue;
      // Cheap client-side pre-filter (cuts previewIntent eth_calls) — the
      // continuity + WI-3 + rate-overlap conditions `matchIntent` enforces.
      if (
        b.lendingAsset.toLowerCase() !== intent.lendingAsset.toLowerCase() ||
        b.collateralAsset.toLowerCase() !==
          intent.collateralAsset.toLowerCase() ||
        b.creator.toLowerCase() === intent.owner.toLowerCase() || // self-trade
        Number(b.durationDays) > intent.maxDurationDays ||
        !b.useFullTermInterest ||
        b.allowsPartialRepay ||
        intent.minRateBps > b.interestRateBpsMax // rate overlap
      ) {
        continue;
      }
      // `b.amountFilled` is kept fresh as same-tick fills land (below + in the
      // matchOffers loop), so `sizeIntentFill` sees live residual capacity and
      // doesn't oversize into a `previewIntent` rejection (Codex #748 r1).
      let fillAmount = sizeIntentFill(intent, b);
      if (fillAmount === null) continue;

      previews += 1;
      let preview = await previewIntent(ctx, solver, intent, b.id, fillAmount);
      if (!preview) continue;
      // Codex #748 r4/r5/r6 — a non-AON oversized fill that fails ONLY on the
      // borrower's collateral (intent LTV stricter than the offer was sized
      // for) can often succeed smaller. `previewIntent` returns reqCollateral=0
      // on that very failure, so rather than reqCollateral-scaling, probe `lo`
      // first (guaranteeing a viable fill is found when one exists) then
      // binary-search upward for the LARGEST viable fill — a bounded handful of
      // probes — instead of re-attempting the too-large amount every tick (which
      // would never auto-fill that borrower for this intent).
      if (
        !preview.ok &&
        preview.matchError === MATCH_ERR_COLLATERAL_BELOW &&
        b.fillMode !== FILL_MODE_AON &&
        previews < MAX_PREVIEW_CALLS_PER_TICK
      ) {
        const lo =
          intent.minFillAmount > b.amount ? intent.minFillAmount : b.amount;
        const originalFill = fillAmount; // the `hi` that just failed
        if (lo < originalFill) {
          // Probe the SMALLEST legal fill FIRST (Codex #748 r6): when the
          // collateral-supported amount is a tiny fraction of `hi`, a pure
          // midpoint search can spend every probe still above the viable
          // threshold and miss a fillable `lo`. Probing `lo` guarantees we find
          // a viable fill when one exists; if even `lo` fails the borrower is
          // unfillable for this intent.
          previews += 1;
          const loProbe = await previewIntent(ctx, solver, intent, b.id, lo);
          if (loProbe && loProbe.ok) {
            fillAmount = lo;
            preview = loProbe;
            // Binary-search (lo, hi) for the LARGEST viable fill, on the now
            // known-viable floor.
            let searchLo = lo + 1n;
            let searchHi = originalFill - 1n;
            let probes = 0;
            while (
              searchLo <= searchHi &&
              probes < INTENT_SIZE_DOWN_MAX_PROBES &&
              previews < MAX_PREVIEW_CALLS_PER_TICK
            ) {
              const mid = (searchLo + searchHi) / 2n;
              previews += 1;
              probes += 1;
              const probe = await previewIntent(ctx, solver, intent, b.id, mid);
              if (probe && probe.ok) {
                fillAmount = mid;
                preview = probe;
                searchLo = mid + 1n;
              } else {
                searchHi = mid - 1n;
              }
            }
          }
          // else: even `lo` failed — `preview` stays the original CBR failure
          // and the handler below continues to the next borrower.
        }
      }
      // `ok` already folds intentError == Ok && matchError == Ok && riskBlock == 0.
      if (!preview.ok) {
        const e = preview.intentError;
        // GLOBAL terminal — same verdict for EVERY intent + borrower this tick,
        // so stop the whole pass; the master kill-switches additionally log
        // once (sharing the matchOffers latch) (Codex #748 r2/r3).
        if (INTENT_ERR_PASS_TERMINAL.has(e)) {
          if (
            (e === INTENT_ERR_MATCHER_DISABLED ||
              e === INTENT_ERR_INTENT_DISABLED) &&
            !killSwitchLogged.get(ctx.chainId)
          ) {
            console.log(
              `[matcher] chain=${ctx.chainId} intent-fill disabled: a master flag (partialFill/lenderIntent) is off; retrying every tick`,
            );
            killSwitchLogged.set(ctx.chainId, true);
          }
          return submits;
        }
        // INTENT-level terminal — same verdict for every BORROWER of this intent
        // (auth, aggregator-pause, inactive, VPFI-lending, unresolvable
        // collateral, …), so abandon the intent rather than burning a preview
        // per borrower for an identical result (Codex #748 r1/r3).
        if (INTENT_ERR_INTENT_TERMINAL.has(e)) break;
        // Borrower-specific — try the next borrower.
        continue;
      }

      // Codex #748 r4 P1 — re-read the pause immediately before committing gas:
      // `keepersPaused` may have flipped during the scan/paging since the
      // pass-start gate, and `matchIntent` does NOT enforce the pause for OPEN
      // intents, so without this re-check the keeper could originate a loan
      // moments after operators paused for an incident. Fail-closed (terminal).
      if (await keepersPaused(ctx)) {
        logKeepersPausedOnce(ctx);
        return submits;
      }

      submits += 1;
      const filled = await submitIntentFill(ctx, intent, b.id, fillAmount, preview);
      if (filled) {
        intentFills += 1;
        // Keep the in-memory borrower snapshot live for later intents that
        // target the same borrower (the single-fill slice consumes exactly
        // `matchAmount`).
        b.amountFilled += preview.matchAmount;
      } else {
        // Uncertain (broadcast fail / receipt timeout) — quarantine this
        // borrower for the rest of the tick so no other intent double-fills it
        // before the possibly-in-flight tx lands (Codex #748 r2).
        uncertainBorrowers.add(b.id.toString());
      }
      // Back off this intent after ANY submit attempt — a success moved its
      // exposure/capital, an uncertain result leaves the tx possibly in-flight;
      // either way, sizing more fills for it against the stale snapshot would
      // queue reverting txs (mirrors the matchOffers path — Codex #748 r1).
      break;
    }
  }
  if (intentFills > 0) {
    console.log(
      `[matcher] chain=${ctx.chainId} intent-fill pass: ${intentFills} fill(s) across ${intents.length} active intent(s)`,
    );
  }
  return submits;
}

// ─── #625 WI-2c part 2b roll-pass helpers ───────────────────────────────────

function liftRollable(raw: Record<string, unknown>): RollableIntentLoan {
  return {
    loanId: BigInt(raw['loanId'] as bigint | number),
    owner: raw['owner'] as Address,
    lendingAsset: raw['lendingAsset'] as Address,
    collateralAsset: raw['collateralAsset'] as Address,
    amount: BigInt(raw['amount'] as bigint | number),
  };
}

/**
 * Collect ALL fully-repaid intent loans from the on-chain registry up front.
 * Paged into memory (not rolled mid-page) because a successful roll REMOVES the
 * loan from the registry — paginating while mutating would skip entries. Rolling
 * happens afterward by stable `loanId`. `total` is the FULL registry size; each
 * page yields only its Repaid subset, so we advance by the page span.
 */
async function listRollableLoans(
  ctx: KeeperContext,
  overBudget: () => boolean,
): Promise<RollableIntentLoan[]> {
  const out: RollableIntentLoan[] = [];
  let total: bigint | null = null;
  for (
    let offset = 0n;
    total === null || offset < total;
    offset += ROLL_SCAN_PAGE
  ) {
    if (overBudget()) break;
    try {
      const res = (await ctx.client.readContract({
        address: ctx.diamond,
        abi: MATCHER_ABI,
        functionName: 'getRollableIntentLoans',
        args: [offset, ROLL_SCAN_PAGE],
      })) as readonly [readonly Record<string, unknown>[], bigint];
      const [rows, t] = res;
      total = t;
      for (const r of rows) out.push(liftRollable(r));
    } catch (err) {
      console.error(
        `[matcher] chain=${ctx.chainId} getRollableIntentLoans offset=${Number(offset)} failed: ${String(err).slice(0, 200)}`,
      );
      break;
    }
  }
  return out;
}

async function submitRoll(
  ctx: KeeperContext,
  loanId: bigint,
): Promise<{ ok: boolean; unauthorized: boolean }> {
  const account = ctx.wallet.account;
  if (!account) return { ok: false, unauthorized: false };
  let hash: Hex;
  try {
    hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'rollIntentLoan',
      args: [loanId],
      account,
      chain: ctx.wallet.chain,
    });
  } catch (err) {
    const errStr = String(err);
    // KeeperAccessRequired — the keeper isn't AUTO_ROLL-delegated for this loan's
    // owner; every later loan with the SAME owner is equally unrollable, so the
    // caller skips them rather than re-probing each.
    const unauthorized = errStr.includes('KeeperAccessRequired');
    if (!unauthorized) {
      console.log(
        `[matcher] chain=${ctx.chainId} rollIntentLoan loan=${Number(loanId)} broadcast failed: ${errStr.slice(0, 200)}`,
      );
    }
    return { ok: false, unauthorized };
  }
  try {
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    if (receipt.status !== 'success') {
      console.log(
        `[matcher] chain=${ctx.chainId} rollIntentLoan loan=${Number(loanId)} reverted on-chain tx=${hash}`,
      );
      return { ok: false, unauthorized: false };
    }
  } catch (err) {
    console.log(
      `[matcher] chain=${ctx.chainId} rollIntentLoan loan=${Number(loanId)} receipt wait failed tx=${hash}: ${String(err).slice(0, 200)}`,
    );
    return { ok: false, unauthorized: false };
  }
  console.log(
    `[matcher] chain=${ctx.chainId} intent-rolled loan=${Number(loanId)} tx=${hash}`,
  );
  return { ok: true, unauthorized: false };
}

/**
 * Auto-roll pass: page all fully-repaid intent loans + roll each via
 * `rollIntentLoan`. Shares the per-tick submit budget (`submitsUsed`) + wall-time
 * budget with the match/fill passes, and self-gates on `keepersPaused` (re-read
 * before each submit). A loan whose owner the keeper isn't AUTO_ROLL-delegated
 * for reverts; every later loan with that owner is then skipped.
 */
async function runIntentRollPass(
  ctx: KeeperContext,
  overBudget: () => boolean,
  submitsUsed: number,
): Promise<void> {
  if (overBudget() || submitsUsed >= MAX_SUBMITS_PER_TICK) return;
  if (!ctx.wallet.account) return;
  if (await keepersPaused(ctx)) {
    logKeepersPausedOnce(ctx);
    return;
  }

  const rollable = await listRollableLoans(ctx, overBudget);
  if (rollable.length === 0) return;

  let submits = submitsUsed;
  let rolled = 0;
  const unauthorizedOwners = new Set<string>();
  for (const loan of rollable) {
    if (submits >= MAX_SUBMITS_PER_TICK || overBudget()) break;
    if (unauthorizedOwners.has(loan.owner.toLowerCase())) continue;
    // Re-read the pause immediately before committing gas (mirrors the fill
    // pass — the AUTO_ROLL auth path enforces keepersPaused on-chain anyway, but
    // skip the doomed submit + its gas).
    if (await keepersPaused(ctx)) {
      logKeepersPausedOnce(ctx);
      return;
    }
    submits += 1;
    const res = await submitRoll(ctx, loan.loanId);
    if (res.ok) {
      rolled += 1;
    } else if (res.unauthorized) {
      unauthorizedOwners.add(loan.owner.toLowerCase());
    }
  }
  if (rolled > 0) {
    console.log(
      `[matcher] chain=${ctx.chainId} roll pass: ${rolled} loan(s) rolled (${rollable.length} repaid candidate(s))`,
    );
  }
}

/** One pass over a chain's order book. */
async function runOfferMatcherTickForChain(ctx: KeeperContext): Promise<void> {
  // Codex #176 round-2 P2 — bound the chain's wall-time so a congested
  // chain can't starve later chains in the same cron tick. Each call
  // site checks `overBudget()` before doing more work.
  const tickStart = Date.now();
  const overBudget = () =>
    Date.now() - tickStart > PER_CHAIN_WALL_TIME_BUDGET_MS;

  const ids = await listActiveOfferIds(ctx);
  if (ids.length === 0) {
    // No open offers to match/fill, but there may still be fully-repaid intent
    // loans to AUTO-ROLL (independent of the offer book) — #625 WI-2c part 2b.
    if (!overBudget()) await runIntentRollPass(ctx, overBudget, 0);
    return;
  }
  const offers = await hydrateOffers(ctx, ids);
  const { lenders, borrowers } = partitionByBucket(offers);

  let previewCalls = 0;
  let submits = 0;
  const attempted = new Set<string>();
  // Codex #748 r3 — borrowers left in-flight by an UNCERTAIN matchOffers submit
  // (broadcast fail / receipt timeout). Shared with the intent-fill pass so it
  // doesn't queue a `matchIntent` for the same borrower while the offer-match
  // tx may still mine.
  const uncertainBorrowers = new Set<string>();

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
          // Keep B's in-memory snapshot live so the later #625 intent-fill pass
          // sizes against B's true residual capacity, not its tick-start value
          // (Codex #748 r1).
          B.amountFilled += p.matchAmount;
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
        //
        // #748 r3 — also mark B uncertain so the intent-fill pass below won't
        // queue a `matchIntent` for the same borrower while this offer-match tx
        // may still be in flight (it would revert once the offer-match mines).
        uncertainBorrowers.add(B.id.toString());
        break;
      }
    }
  }

  // #625 WI-2c — auto-lend intent-fill pass. Reuses the hydrated borrower book
  // + the same per-chain wall-time budget. Runs AFTER the Range-Orders
  // matchOffers loop so an explicit lender-offer match is preferred when both
  // an offer and an intent could fill the same borrower.
  if (!overBudget() && borrowers.size > 0) {
    const allBorrowers: OfferLite[] = [];
    for (const list of borrowers.values()) {
      for (const b of list) allBorrowers.push(b);
    }
    // Hand the matchOffers loop's spent budget + uncertain-borrower set across
    // so the two passes share the per-tick rails and don't double-fill a
    // borrower left in flight (Codex #748 r1/r3). The fill pass returns the
    // cumulative submit count so the roll pass below inherits the shared budget.
    submits = await runIntentFillPass(
      ctx,
      allBorrowers,
      overBudget,
      submits,
      previewCalls,
      uncertainBorrowers,
    );
  }

  if (submits > 0 || previewCalls > 0) {
    console.log(
      `[matcher] chain=${ctx.chainId} activeOffers=${offers.length} previewCalls=${previewCalls} submits=${submits} elapsedMs=${Date.now() - tickStart}`,
    );
  }

  // #625 WI-2c part 2b — auto-roll fully-repaid intent loans, sharing the
  // per-tick submit + wall-time budget carried through the match + fill passes.
  if (!overBudget()) {
    await runIntentRollPass(ctx, overBudget, submits);
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
