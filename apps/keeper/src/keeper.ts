/**
 * Phase 7a.4 — autonomous keeper that submits `triggerLiquidation` for
 * any subscribed loan whose on-chain HF crosses 1.0.
 *
 * Invoked from the watcher loop right after the per-loan HF read. The
 * keeper:
 *   1. Reads the loan's collateral / principal asset metadata from
 *      `getLoanDetails`.
 *   2. Fetches quotes from every available DEX venue server-side
 *      (no proxy roundtrip — the keeper sees the API keys directly).
 *   3. Ranks by expected output, packs `AdapterCall[]`.
 *   4. Submits `triggerLiquidation(loanId, sellAmount, calls)` from the
 *      keeper EOA, quoted for only the collateral the debt needs (#2796):
 *      the middle of the range `previewForcedSale` accepts.
 *
 * SAFETY:
 *   - `KEEPER_PRIVATE_KEY` is a Cloudflare secret — never logged.
 *   - The keeper does NOT alter the on-chain `minOutputAmount` floor
 *     (oracle-derived inside the diamond). A bad quote will fail the
 *     adapter's slippage check; LibSwap moves to the next entry.
 *   - In-memory dedupe per cron tick prevents resubmitting the same
 *     loan twice; the diamond's status check would revert anyway, but
 *     this saves an RPC roundtrip + gas griefing.
 *   - If the keeper is disabled (KEEPER_ENABLED unset / false) the
 *     entire path is no-op.
 */

import { isSendPastDeadline, queuedWallet, reportSendError } from './submissionQueue';
import { attemptErrorReason } from './keeperSend';
import {
  type Abi,
  type Address,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  AdminFacetABI,
  DefaultedFacetABI,
  FlashLoanLiquidatorABI,
  LoanFacetABI,
  RiskFacetABI,
  RiskSplitLiquidationFacetABI,
} from '@vaipakam/contracts/abis';
import { attemptCloseOut } from './closeOut';
import { parseLiquidationLoan } from './liquidationLoan';
import { tryMatchLiquidation } from './matchLiquidation';
import { orchestrateDexDirectQuotes } from './dexDirectQuotes';
import { describeFailure, redactedError } from '@vaipakam/lib/errorDescription';
import { inTermOnLoanClock } from './loanClockReads';
import {
  FORCED_SALE_KIND,
  forcedSaleQuoteAmount,
  readForcedSalePlan,
  type ForcedSalePlan,
} from '@vaipakam/lib/routeBuilder';
import type { ChainConfig, Env } from './env';
import {
  orchestrateServerQuotes,
  readKeeperRouteStanding,
  type ServerOrchestrationResult,
  type ServerRankedQuote,
} from './serverQuotes';
import { flashLoanRoute } from './flashLoanProviders';
import { discountPathBlocker } from './discountPath';
import {
  liquidatorFunction,
  minProfitForFee,
  planFlashLoanLiquidation,
  readDiscountedLiquidation,
} from './discountedLiquidation';
import { estimateTxFeeWei } from './txFee';
import {
  BPS,
  MAX_PARTIAL_FRACTION_BPS,
  runPartialAttempts,
  sellAmountForFractionBps,
  normalizeCloseFactorCapBps,
} from './partialResize';

function parsePosIntEnv(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Compute the smallest partial-liquidation fraction (in BPS) that
 *  brings a distressed loan's health factor back above `1.0 +
 *  targetBufferBps`, given the loan's stamped liquidation threshold
 *  (`liquidationLtvBpsAtInit`, the T `calculateHealthFactor` uses).
 *
 *  Algebra (derived from the on-chain HF formula
 *  `HF = collateralValue × T / debt`):
 *
 *      Let T = liqThresholdBps / 10_000  (e.g. 0.85)
 *      Let HF = hfRaw / 1e18             (the pre-call HF, < 1)
 *      Let k = swapEfficiencyBps / 10_000 (1 - effective swap-fee
 *        deduction; the on-chain `triggerPartialLiquidation` deducts
 *        up to 3% liquidator bonus + 2% handling fee = ~5% from the
 *        raw swap proceeds before applying to debt — k = 0.95).
 *      Let `target` = (10_000 + targetBufferBps) / 10_000 (e.g. 1.05).
 *
 *      For `HF_after ≥ target`, the partial fraction f must satisfy:
 *
 *        f ≥ T × (HF - target) / (HF × (T - target × k))
 *
 *      Both numerator and denominator are negative (HF < target,
 *      T < target × k for any reasonable threshold), so the ratio is
 *      positive. f ∈ (0, 1]; values close to 1 mean partial isn't
 *      really partial (use full liquidation).
 *
 *  Returns the computed `f` in BPS, padded by a 5% safety margin to
 *  cover real-world slippage beyond the deterministic bonus/handling
 *  deductions. Clamped to `[MIN_FRACTION_BPS, MAX_FRACTION_BPS]` —
 *  below the min the slice is dust, above the max we're past the
 *  point of "partial". Callers fall back to full liquidation when the
 *  computed fraction hits the upper clamp.
 */
function computeOptimalPartialFractionBps(
  hfRaw: bigint,
  liqThresholdBps: bigint,
  targetBufferBps: number = 500,
  swapEfficiencyBps: number = 9_500,
  minFractionBps: number = 200,
  maxFractionBps: number = 7_500,
  safetyMargin: number = 1.05,
  // #395 (Codex r4 P2) — the on-chain over-liquidation ceiling
  // (`AdminFacet.getPartialLiquidationSizing().targetHfCeilingBps`, default
  // 12_000 = HF 1.20). The keeper must not size a partial that lands HF
  // ABOVE this, or `triggerPartialLiquidation` reverts `PartialOverLiquidates`.
  // We clamp the (safety-padded) fraction to the one that achieves a target a
  // little UNDER the ceiling, so the slice stays in the [1.0, ceiling] band.
  ceilingHfBps: number = 11_800,
): bigint {
  if (liqThresholdBps <= 0n) return 0n;
  if (hfRaw <= 0n) return 0n;

  // Use Number for the float algebra (the magnitudes here stay safely
  // within IEEE-754 range — T is in [0, 1], HF in [0, 1], so all
  // intermediate products fit in a double). The final result rounds
  // back to a bigint BPS value for on-chain submission.
  const T = Number(liqThresholdBps) / 10_000;
  const hf = Number(hfRaw) / 1e18;
  const target = 1 + targetBufferBps / 10_000;
  const k = swapEfficiencyBps / 10_000;

  // Numerator = T × (HF - target). Negative since HF < target.
  // Denominator = HF × (T - target × k). Negative since T < target × k
  // for any conservative threshold (T ≈ 0.85, target × k ≈ 1.05 × 0.95
  // = 0.9975 → denominator factor = 0.85 - 0.9975 = -0.1475).
  const numerator = T * (hf - target);
  const denominator = hf * (T - target * k);
  if (denominator === 0) return 0n;

  const fRaw = numerator / denominator;
  if (fRaw <= 0) return 0n;
  if (fRaw >= 1) return BigInt(maxFractionBps); // signal "too distressed for partial"

  // Pad with the safety margin, ceil to the next BPS.
  let fBps = Math.ceil(fRaw * safetyMargin * 10_000);

  // #395 (Codex r4 P2) — clamp DOWN so the slice can't over-restore past the
  // on-chain ceiling. `fCeiling` is the fraction that lands HF exactly at
  // `ceilingHfBps`; sizing above it would revert `PartialOverLiquidates`. The
  // ceiling-achieving fraction is the same closed form with the ceiling HF as
  // the target. Only clamps when the padded fraction would overshoot — a
  // partial that legitimately needs more than `fCeiling` to restore HF >= 1 is
  // "too distressed for a routine partial" and is steered to full liquidation
  // by the caller (and, defensively, by the on-chain revert + keeper fallback).
  const ceilingTarget = ceilingHfBps / 10_000;
  const ceilDenom = hf * (T - ceilingTarget * k);
  if (ceilDenom !== 0) {
    const fCeilingRaw = (T * (hf - ceilingTarget)) / ceilDenom;
    if (fCeilingRaw > 0 && fCeilingRaw < 1) {
      const fCeilingBps = Math.floor(fCeilingRaw * 10_000);
      if (fBps > fCeilingBps) fBps = fCeilingBps;
    }
  }

  if (fBps < minFractionBps) return BigInt(minFractionBps);
  if (fBps > maxFractionBps) return BigInt(maxFractionBps);
  return BigInt(fBps);
}

/**
 * #2796 — the collateral a full and a split liquidation quote for, from the
 * contract's own plans (`previewForcedSale` kinds HealthFactorLiquidation and
 * HealthFactorSplitLiquidation, read at one block). Each is the middle of the
 * range its kind accepts (`forcedSaleQuoteAmount`); the split's is cut into
 * two legs that sum to it exactly. Null when no full sale is due; a split
 * with no sale due has no total and no legs.
 */
export function liquidationSaleSizes(
  fullPlan: ForcedSalePlan,
  splitPlan: ForcedSalePlan,
): { fullAmount: bigint; splitTotal: bigint | null; halfAmount: bigint; otherHalf: bigint } | null {
  const fullAmount = forcedSaleQuoteAmount(fullPlan);
  if (fullAmount === null) return null;
  const splitTotal = forcedSaleQuoteAmount(splitPlan);
  const halfAmount = (splitTotal ?? 0n) / 2n;
  return { fullAmount, splitTotal, halfAmount, otherHalf: (splitTotal ?? 0n) - halfAmount };
}

/** The least a split-liquidation leg selling `legInput` must deliver (#2724):
 *  its share of the split's floor, rounded up, as the contract sets it
 *  (`ceil(totalFloor × legInput / totalInput)`). `plan` is the split kind's
 *  `previewForcedSale`, whose floor is for `plan.sell`; the floor is linear in
 *  what is sold, so the share is taken at that rate. A pre-check, not the
 *  rule: the contract measures each leg at the recipient and is the judge, and
 *  a refused split falls through to the full liquidation. */
export function splitLegFloor(plan: { floor: bigint; sell: bigint }, legInput: bigint): bigint {
  if (plan.sell === 0n) return 0n;
  return (plan.floor * legInput + plan.sell - 1n) / plan.sell;
}

/** Decide whether splitting the liquidation swap across two distinct
 *  aggregators beats running the full size through a single adapter via
 *  failover. Returns the chosen `{a, b}` leg pair + the projected total + the
 *  bps improvement vs the full-size top-1, or `null` if splitting doesn't help
 *  (no pair of distinct aggregators whose legs each clear their own floor, or
 *  the improvement is below `minImprovementBps` — gas + tx complexity isn't
 *  worth it).
 *
 *  The on-chain split is atomic-revert-on-leg-failure, and since #2724 every
 *  leg must deliver its own share of the floor (a leg below it reverts the
 *  whole split), so a pair is chosen only when EACH leg's quote clears its
 *  share, not merely the two together. Among such pairs the best combined
 *  output wins (usually 0x and 1inch, since each tends to win when the other
 *  doesn't).
 */
export function pickSplitLegs(
  halfQuotes: ServerOrchestrationResult,
  fullQuotes: ServerOrchestrationResult,
  minImprovementBps: number,
  /** Collateral the split sells (both legs) and the full sale sells. Since
   *  #2796 each sale is sized by its own `previewForcedSale` kind, so the
   *  two can differ and their outputs are compared per unit sold. `legs` is
   *  what each leg sells (`a` then `b`), and `splitPlan` the split kind's
   *  preview, whose floor sets each leg's share (`splitLegFloor`). */
  sizes: { split: bigint; full: bigint; legs: readonly [bigint, bigint]; splitPlan: { floor: bigint; sell: bigint } },
): { a: ServerRankedQuote; b: ServerRankedQuote; totalExpected: bigint; gainBps: number } | null {
  if (fullQuotes.ranked.length === 0 || sizes.split === 0n || sizes.full === 0n) return null;
  // AGGREGATOR LEGS ONLY (#2480 r1 `4267324333`). A leg must carry its own
  // slippage bound in its calldata — which aggregator calldata does and a raw
  // UniV3 / mock call does not (`LibSwap.sol`, swapSplit's dev note); the
  // contract's per-leg floor (#2724) bounds what a leg delivers, not how the
  // venue executes it. And two UniV3 adapters during an adapter replacement
  // quote the SAME pools, so their half-size quotes are not independent
  // liquidity — and the same holds for two instances of ONE aggregator (an
  // old and a new 0x adapter during a replacement route to the same venue),
  // so the two legs must be different aggregators, not merely different
  // indexes (#2480 r2).
  const legs = halfQuotes.ranked.filter((q) => q.kind === 'zeroex' || q.kind === 'oneinch');
  if (legs.length < 2) return null;
  const [sizeA, sizeB] = sizes.legs;
  const floorA = splitLegFloor(sizes.splitPlan, sizeA);
  const floorB = splitLegFloor(sizes.splitPlan, sizeB);
  // The best pair from distinct aggregators whose legs each clear their own
  // floor. `ranked` is best-first by expectedOutput.
  let best: { a: ServerRankedQuote; b: ServerRankedQuote; total: bigint } | null = null;
  for (const a of legs) {
    if (a.expectedOutput < floorA) continue;
    for (const b of legs) {
      if (b === a || b.kind === a.kind || b.expectedOutput < floorB) continue;
      const total = a.expectedOutput + b.expectedOutput;
      if (best === null || total > best.total) best = { a, b, total };
    }
  }
  if (best === null) return null;
  const { a, b } = best;
  const totalExpected = best.total;
  const fullTop = fullQuotes.ranked[0].expectedOutput;
  // Output per unit of collateral sold, cross-multiplied so nothing is
  // divided before the comparison: the split's rate is totalExpected /
  // split, the full sale's fullTop / full.
  const splitScaled = totalExpected * sizes.full;
  const fullScaled = fullTop * sizes.split;
  if (fullScaled === 0n || splitScaled <= fullScaled) return null;
  // `gainBps = (splitRate - fullRate) * 10_000 / fullRate`, computed
  // with bigints to avoid Number precision at e18 magnitudes.
  const gainBps = Number(((splitScaled - fullScaled) * 10_000n) / fullScaled);
  if (gainBps < minImprovementBps) return null;
  return { a, b, totalExpected, gainBps };
}

// Diamond ABIs sourced from `@vaipakam/contracts/abis`. The previous
// inline `parseAbi` block hand-typed the full Loan-tuple components
// of `getLoanDetails` — exactly the kind of positional-decode drift
// hazard ReleaseNotes-2026-05-05.md flagged when the watcher's
// `getOfferDetails` tuple silently misaligned after a struct-shape
// change. Importing the compiled-bytecode ABI makes that drift
// structurally impossible: the JSON regenerates from the contract
// source on every deploy via `exportFrontendAbis.sh`.
// `triggerLiquidation` lives on RiskFacet; the higher-LTV-aware
// `triggerLiquidationSplit` was carved out into RiskSplitLiquidationFacet
// (#66 + #633) for EIP-170 headroom. Merge both facet ABIs so viem can
// encode either call against the single Diamond address.
const TRIGGER_ABI = [...RiskFacetABI, ...RiskSplitLiquidationFacetABI];
const LOAN_DETAILS_ABI = LoanFacetABI;  // hosts getLoanDetails

export interface KeeperContext {
  /** Wallet client for the keeper EOA on this chain. */
  wallet: WalletClient;
  /** Public client (read-only) on this chain — same RPC as watcher. */
  client: PublicClient;
  diamond: Address;
  chainId: number;
  /** The run deadline the wallet's queue enforces (#2572), restated here so a
   *  pass's own loops can stop asking for work its sends would be refused. */
  notAfterMs: number;
}

const ATTEMPTED: Set<string> = new Set();

/** Reset between cron ticks so a permanently-broken loan can be
 *  retried next tick (the diamond will keep reverting, which is the
 *  safe behaviour). Called from `runWatcher` start. */
export function resetKeeperDedupe(): void {
  ATTEMPTED.clear();
}

function dedupeKey(chainId: number, loanId: number): string {
  return `${chainId}:${loanId}`;
}

/**
 * Null when every build for this loan was a no-quote the market gave — each
 * venue asked, each venue's own outcome `declined` — so the
 * in-kind close may be considered; otherwise the reason it may not. A venue
 * that was not heard from might have quoted, and an in-kind close cannot be
 * undone, so anything short of `declined` keeps the loan waiting (#2487 r1).
 */
export function inKindBlocker(
  builds: readonly Pick<ServerOrchestrationResult, 'calls' | 'noQuote' | 'marketDeclined'>[],
): string | null {
  for (const b of builds) {
    if (b.calls.length > 0) return 'another size quoted';
    if (b.noQuote !== 'declined') return `no-quote reason ${b.noQuote ?? 'none'}`;
    // `declined` as worded for readers also covers a quote whose swap
    // target governance has not allowed: a route exists (#2487 r2).
    if (!b.marketDeclined) return 'a venue quoted a swap target its adapter does not allow';
  }
  return builds.length > 0 ? null : 'no builds';
}

/**
 * The liquidator's no-route fallback (#2487): when the loan is past grace,
 * close it in kind through the attempt the grace-default pass uses, in its
 * `in-kind` role. Returns true when a transaction was submitted or may have
 * been broadcast. Every other outcome is logged with its reason.
 */
export async function tryInKindCloseOut(
  chain: Pick<ChainConfig, 'id' | 'name'>,
  ctx: KeeperContext,
  publicClient: PublicClient,
  loanIdBig: bigint,
): Promise<boolean> {
  const defaultable = (await publicClient
    .readContract({
      address: ctx.diamond,
      abi: DefaultedFacetABI,
      functionName: 'isLoanDefaultable',
      args: [loanIdBig],
    })
    .catch(() => null)) as boolean | null;
  if (defaultable !== true) {
    const why = defaultable === null ? 'defaultable-unread' : 'not-past-grace';
    console.log(`[keeper] loan=${loanIdBig} chain=${chain.name} in-kind skipped: ${why}`);
    return false;
  }
  const outcome = await attemptCloseOut(
    {
      client: publicClient,
      wallet: ctx.wallet,
      diamond: ctx.diamond,
      chainId: chain.id,
      notAfterMs: ctx.notAfterMs,
      // The in-kind role sends an empty list and never builds a route.
      buildRoute: () => Promise.reject(new Error('in-kind close-out builds no route')),
    },
    loanIdBig,
    'in-kind',
  ).catch((err: unknown) => ({ kind: 'skipped' as const, reason: attemptErrorReason(err) }));
  if (outcome.kind === 'skipped') {
    console.log(`[keeper] loan=${loanIdBig} chain=${chain.name} in-kind skipped: ${outcome.reason}`);
    return false;
  }
  console.log(
    `[keeper] loan=${loanIdBig} chain=${chain.name} in-kind ${outcome.kind === 'submitted' ? 'submitted' : `send-unconfirmed (${outcome.reason})`} tx=${outcome.tx} preview=${outcome.preview}`,
  );
  return true;
}

/**
 * Try to liquidate `loanId` autonomously. Idempotent within a tick
 * (won't retry the same loan). Returns true on a submitted tx, false
 * on any skip — disabled keeper, no quotes, dedupe hit, RPC error,
 * or revert. Errors are logged but do not propagate to the caller
 * (the watcher must keep iterating other loans).
 */
export async function maybeAutonomousLiquidate(
  env: Env,
  chain: ChainConfig,
  loanIdBig: bigint,
  hfRaw: bigint,
  publicClient: PublicClient,
  /** The liquidator run's deadline (#2572): a send whose turn in the queue
   *  comes after it is refused before broadcast, and the loan is retried by the
   *  next run, from fresh health-factor reads and fresh quotes. */
  notAfterMs: number,
): Promise<boolean> {
  // Eligibility: keeper enabled, HF actually below 1, dedupe miss.
  if (!isKeeperEnabled(env)) return false;
  if (hfRaw >= 10n ** 18n) return false; // HF >= 1.0 → not liquidatable
  const loanId = Number(loanIdBig);
  const key = dedupeKey(chain.id, loanId);
  if (ATTEMPTED.has(key)) return false;
  ATTEMPTED.add(key);

  const ctx = buildKeeperContext(env, chain, publicClient, { notAfterMs });
  if (!ctx) return false;

  try {
    // Read the loan by field name (#2733). `startTime` + `durationDays`
    // decide whether the partial path is open (partial is in-term only by
    // contract design), and `liquidationLtvBpsAtInit` is the threshold the
    // loan's health factor is computed against: the sizer below needs the
    // SAME number the contract uses, and this is it. A struct this keeper
    // does not recognise is not acted on at all.
    const loan = parseLiquidationLoan(
      await publicClient.readContract({
        address: ctx.diamond,
        abi: LOAN_DETAILS_ABI,
        functionName: 'getLoanDetails',
        args: [loanIdBig],
      }),
    );
    if (!loan) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} skipped: getLoanDetails did not decode to the fields this keeper reads (ABI out of step with the Diamond)`,
      );
      return false;
    }

    // assetType 0 = ERC20 — only liquidate ERC20 loans (NFT rentals
    // never hit the swap path; they default via the time-based route).
    if (loan.assetType !== 0) return false;
    // Status 0 = Active. Anything else (FallbackPending, Repaid,
    // Defaulted, Settled) means the diamond would revert.
    if (loan.status !== 0) return false;

    // The partial-fraction math (`computeOptimalPartialFractionBps`) takes
    // the loan's own stamped liquidation threshold: the smallest f that
    // restores HF >= 1.05 at that threshold. At HF=0.99 / T=0.85 the optimal
    // is ~37% (smaller swap, more residual to the borrower); at HF=0.93 /
    // T=0.85 it's ~78%, past the partial band, so the loan goes to full. A
    // zero stamp makes the math return 0n and the partial path is skipped.
    const liqThresholdBps = BigInt(loan.liquidationLtvBpsAtInit);

    // Partial-liquidation decision: when the loan is only mildly-to-
    // moderately undercollateralized AND still in-term, a precisely-
    // sized partial sweep restores HF >= 1 without closing the
    // position. The on-chain `triggerPartialLiquidation` checks the
    // post-mutation HF strictly improves AND lands >= 1.0 (and no
    // higher than the governance ceiling); a refused size is searched
    // around in-tick, below, before any fall-back to full liquidation.
    //
    // Past maturity, partial is locked out by the on-chain
    // {PartialAfterMaturity} guard.
    //
    // Why prefer partial when feasible: a smaller swap means lower
    // market impact + cleaner fill (higher chance the keeper actually
    // gets paid versus a full swap that exceeds the 6% slippage
    // ceiling and falls back to the claim-time settlement), AND
    // preserves the borrower's residual position. The optimal fraction
    // here replaces the previous hardcoded 50% (Aave's classic
    // close-factor) — at HF=0.99 / T=0.85 the optimal is ~37%, at
    // HF=0.93 / T=0.85 it's ~78%. Smaller swap = less collateral
    // sold = better outcome for the borrower whenever the smaller
    // fraction works.
    const partialMinHfBps = parsePosIntEnv(env.PARTIAL_LIQ_MIN_HF_BPS, 9500);
    const partialMinHfRaw = (10n ** 18n * BigInt(partialMinHfBps)) / 10_000n;
    // #2808 — "in term" is measured against the EFFECTIVE due date on the
    // loan clock (#668 / #935): the contract's `PartialAfterMaturity` guard
    // reads `LibLoanClock.maturity`, which a pause moved later. The original
    // `startTime + durationDays` would send a loan a pause kept in term
    // straight to full liquidation. When that date is unknown the loan is
    // skipped this tick (and retried next tick) rather than sized against a
    // date the chain may not hold it to.
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    const term = await inTermOnLoanClock(publicClient, ctx.diamond, loan, nowTs);
    if (!term.known) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} skipped: its due date (and whether a partial is allowed) is unknown — ${term.reason}`,
      );
      return false;
    }
    const inTerm = term.inTerm;

    // #395 (Codex r5 P2) — read the LIVE on-chain over-liquidation ceiling so
    // the keeper tracks a governance change. If governance lowers
    // `partialLiqTargetHfCeilingBps` below the default, a stale hard-coded
    // clamp would size a partial the contract rejects, and the fallback would
    // then close the WHOLE loan even though a smaller in-band partial was
    // allowed. Read it, subtract a small margin, and feed it to the sizer. On
    // a read failure we keep the conservative 11_800 default (the on-chain
    // guard + keeper fallback remain the backstop).
    let ceilingHfBps = 11_800;
    try {
      const sizing = (await publicClient.readContract({
        address: ctx.diamond,
        abi: AdminFacetABI,
        functionName: 'getPartialLiquidationSizing',
      })) as readonly [bigint, bigint, bigint];
      // [targetHfCeilingBps, deepUnderwaterHfBps, dustFloorNumeraire]
      const liveCeiling = Number(sizing[0]);
      if (liveCeiling > 10_000) ceilingHfBps = Math.max(10_500, liveCeiling - 200);
    } catch {
      /* keep the conservative default */
    }
    const optimalPartialFractionBps = computeOptimalPartialFractionBps(
      hfRaw,
      liqThresholdBps,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ceilingHfBps,
    );
    // Partial path is feasible when: in-term, HF below 1 but not so
    // deeply distressed the per-asset math says we need > 75% (the
    // upper clamp from computeOptimalPartialFractionBps means a
    // returned 7_500n is the "no, use full instead" signal — above
    // 75% the partial is mostly closing the loan anyway, full
    // liquidation is cleaner because it refunds surplus collateral
    // to the borrower and emits the terminal event), and HF is at
    // least at the configured floor (default 0.95 — the floor is a
    // coarse cutoff below which a partial is not attempted at all).
    const partialEligible =
      inTerm &&
      hfRaw >= partialMinHfRaw &&
      hfRaw < 10n ** 18n &&
      optimalPartialFractionBps > 0n &&
      optimalPartialFractionBps < MAX_PARTIAL_FRACTION_BPS;

    // #2796 — a full or split liquidation sells only the collateral the
    // debt needs, and the contract accepts a quote only inside the range
    // `previewForcedSale` reports at the settling block (else it reverts
    // `ForcedSaleQuoteOutOfRange`, before broadcast here: `writeContract`
    // estimates first). Both ranges come from one block. A split is its own
    // kind because its legs bear their own charges; its legs' amounts sum
    // into its range. A partial liquidation is sized by its fraction, not by
    // these. No sale due by the contract's reckoning ends the attempt.
    const planBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    const [fullPlan, splitPlan] = await Promise.all([
      readForcedSalePlan({
        client: publicClient,
        diamond: ctx.diamond,
        loanId: loanIdBig,
        kind: FORCED_SALE_KIND.HealthFactorLiquidation,
        blockNumber: planBlock,
      }),
      readForcedSalePlan({
        client: publicClient,
        diamond: ctx.diamond,
        loanId: loanIdBig,
        kind: FORCED_SALE_KIND.HealthFactorSplitLiquidation,
        blockNumber: planBlock,
      }),
    ]);
    const sizes = liquidationSaleSizes(fullPlan, splitPlan);
    if (sizes === null) {
      console.log(`[keeper] loan=${loanId} chain=${chain.name} skip: no liquidation sale due (previewForcedSale sells nothing)`);
      return false;
    }
    const { fullAmount, splitTotal, halfAmount, otherHalf } = sizes;

    // Compute the partial-size for quote fetching. When no partial is
    // eligible the value is unused (the half amount, for the split below).
    const partialAmount = partialEligible
      ? (loan.collateralAmount * optimalPartialFractionBps) / 10_000n
      : halfAmount;
    // ONE roster read for this loan's builds — the same moment for the
    // full, half and partial quotes and any re-size below (#2480 r1). A
    // failed read is left to each build, which reports it.
    const txOrigin = ctx.wallet.account?.address;
    const standing = await readKeeperRouteStanding(
      env,
      publicClient,
      chain.id,
      ctx.diamond,
      txOrigin,
    ).catch(() => undefined);
    // EVERY build for this loan goes through here, so a venue lost from any
    // try-list that may be sent — full, half, partial or a re-sized partial
    // — is logged, even when a back-up venue makes the route usable. 0x
    // quoting a swap target its adapter is not allowed to call is the
    // runbook's allowlist-rotation signal (#2480 r5, r7).
    const buildRoute = async (
      sellAmount: bigint,
      label: string,
    ): Promise<ServerOrchestrationResult> => {
      const res = await orchestrateServerQuotes(env, publicClient, {
        chainId: chain.id,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount,
        diamond: ctx.diamond,
        txOrigin,
      }, standing);
      if (res.calls.length > 0 && res.failed.length > 0) {
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} route-degraded size=${label} (failed: ${res.failed.join(',')})`,
        );
      }
      return res;
    };
    const [quotes, halfQuotes, partialQuotes] = await Promise.all([
      buildRoute(fullAmount, 'full'),
      // No split sale due (its plan sells nothing) → no half quote.
      halfAmount > 0n ? buildRoute(halfAmount, 'half') : Promise.resolve(null),
      // Skip the third quote when partial isn't viable — keeps the
      // hot-path RPC volume the same as before in the common "full
      // liquidation" case. When partial IS viable, all three run in
      // parallel so per-loan latency stays at the max of the three
      // rather than serializing.
      partialEligible && partialAmount !== halfAmount
        ? buildRoute(partialAmount, 'partial')
        : Promise.resolve(null),
    ]);
    if (quotes.calls.length === 0) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} no-quotes (failed: ${quotes.failed.join(',')})`,
      );
      // #2501 — `triggerLiquidation` asks the internal-match auto-dispatch
      // before it reads the swap list, so an opposing position can still
      // close this loan at oracle price with an empty list. Sent only when
      // the preview shows that match; it comes first because the in-kind
      // close below refuses an ending that is a match and leaves it here.
      if (await tryMatchLiquidation(chain, ctx, publicClient, loanIdBig)) return true;
      // #2487 — if every venue was asked about every size and every one
      // DECLINED, and the loan is also past grace, it is still this pass's
      // (it is under water) and the grace-default pass will not touch it,
      // so the liquidator sends the in-kind close-out itself:
      // `triggerDefault` with an empty list, where the contract's
      // collapsed-LTV branch hands the collateral to the lender. The shared
      // attempt sends only when the preview shows that terminal default,
      // with no swap and no internal match.
      //
      // An empty list is NOT enough on its own (#2487 r1): an unread
      // roster, a venue that did not answer, or one this keeper cannot ask
      // also leaves it empty, and a route might exist there. Only the
      // shared `declined` verdict says the market was asked and said no.
      const blocker = inKindBlocker([
        quotes,
        ...(halfQuotes ? [halfQuotes] : []),
        ...(partialQuotes ? [partialQuotes] : []),
      ]);
      if (blocker === null) return tryInKindCloseOut(chain, ctx, publicClient, loanIdBig);
      console.log(`[keeper] loan=${loanId} chain=${chain.name} in-kind not considered: ${blocker}`);
      return false;
    }

    const account = ctx.wallet.account;
    if (!account) return false;

    // ── Flash-loan / discount-path branch — Phase 3 of
    //    FlashLoanLiquidationPath.md. Slots in AHEAD of partial /
    //    split / atomic because the discount path is the most
    //    capital-efficient option when:
    //      - we have a FlashLoanLiquidator deployed on this chain and
    //        the operator has armed it, AND
    //      - the Diamond's preview says the discounted liquidation can
    //        run (its own switch on, the loan under water, the
    //        collateral tiered and priced), AND
    //      - the exact call, its swap quoted for the previewed seizure,
    //        simulates to a run that keeps at least its own fee (#2697).
    //
    //    If any condition fails, we fall through to the existing
    //    partial / split / atomic branches — same code path as
    //    before this commit. No regression possible.
    const flashLoanSubmitted = await tryFlashLoanDiscountedPath({
      env,
      chain,
      ctx,
      publicClient,
      loanId,
      loanIdBig,
    });
    if (flashLoanSubmitted) return true;

    // Use the dedicated partial quote when we fetched one. It is skipped
    // only when the partial slice sells exactly the half amount, whose quote
    // is then the partial's.
    const effectivePartialQuotes: ServerOrchestrationResult | null =
      partialQuotes ?? (partialEligible ? halfQuotes : null);
    const effectivePartialFractionBps: bigint = optimalPartialFractionBps;

    if (
      partialEligible &&
      effectivePartialQuotes &&
      effectivePartialQuotes.calls.length > 0
    ) {
      // #395 / #642 / #2733 — the partial may revert under the on-chain
      // sizing guards. `writeContract` estimates gas first, so a guard revert
      // throws BEFORE any tx is broadcast, and `runPartialAttempts` re-sizes
      // and re-quotes in-tick, searching the sizes between the refusals (see
      // its doc). It escalates to split/full only when no partial size is left.
      // Re-quote the collateral→principal swap for a new slice fraction. Returns
      // null when the amount is zero or every route fails (treated as skip).
      const reQuotePartial = async (
        fractionBps: bigint,
      ): Promise<ServerOrchestrationResult | null> => {
        const sellAmount = sellAmountForFractionBps(
          loan.collateralAmount,
          fractionBps,
        );
        if (sellAmount === 0n) return null;
        const q = await buildRoute(sellAmount, `partial-${fractionBps}bps`);
        return q.calls.length > 0 ? q : null;
      };
      // Read the live close-factor cap; default to BPS (no cap) on any failure.
      const readCloseFactorCapBps = async (): Promise<bigint> => {
        try {
          const raw = (await publicClient.readContract({
            address: ctx.diamond,
            abi: AdminFacetABI,
            functionName: 'getMaxPartialLiquidationCloseFactorBps',
          })) as bigint;
          return normalizeCloseFactorCapBps(raw);
        } catch {
          return BPS;
        }
      };

      const outcome = await runPartialAttempts(effectivePartialFractionBps, effectivePartialQuotes, {
        submit: (fractionBps, q) =>
          ctx.wallet.writeContract({
            address: ctx.diamond,
            abi: TRIGGER_ABI,
            functionName: 'triggerPartialLiquidation',
            args: [loanIdBig, fractionBps, q.calls],
            account,
            chain: ctx.wallet.chain,
          }),
        reQuote: reQuotePartial,
        readCloseFactorCapBps,
        // #2572 — a deadline refusal ends the attempt: every later send this
        // run would be refused too. Rethrown to the outer catch, which logs it
        // as a deferral rather than as this route's failure.
        isFatal: isSendPastDeadline,
        log: (line) => console.log(`[keeper] loan=${loanId} chain=${chain.name} ${line}`),
      });
      if (outcome.kind === 'submitted') {
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} submitted-partial tx=${outcome.hash} fraction=${outcome.fractionBps}bps attempt=${outcome.attempt} liqThreshold=${liqThresholdBps}bps via=${outcome.quotes.ranked[0].kind} hfBefore=${hfRaw} expected=${outcome.quotes.ranked[0].expectedOutput}`,
        );
        return true;
      }
      // A re-quote that came back empty (no route) or an unclassified refusal
      // is a skip, not an escalation.
      if (outcome.kind === 'skip') return false;
    }

    // Split-route decision: when ≥2 distinct-adapter quotes succeeded at
    // the half size AND their combined output per unit sold beats the
    // single-adapter full quote's by `SPLIT_MIN_IMPROVEMENT_BPS` (default
    // 100 = 1%), use
    // `triggerLiquidationSplit`. Below the threshold the gas + tx
    // complexity isn't worth it. The split is atomic-revert-on-leg-
    // failure on-chain, and each leg must deliver its own share of the
    // floor (#2724), so we only invoke it when both legs are
    // independently OK at quote time, each clearing its share.
    const minImprovementBps = parsePosIntEnv(env.SPLIT_MIN_IMPROVEMENT_BPS, 100);
    const split =
      halfQuotes && splitTotal !== null
        ? pickSplitLegs(halfQuotes, quotes, minImprovementBps, { split: splitTotal, full: fullAmount, legs: [halfAmount, otherHalf], splitPlan })
        : null;
    if (split) {
      const splits = [
        { adapterIdx: split.a.call.adapterIdx, splitAmount: halfAmount, data: split.a.call.data },
        { adapterIdx: split.b.call.adapterIdx, splitAmount: otherHalf, data: split.b.call.data },
      ];
      // #395 (Codex r5 P2) — the split route now also defers to the
      // internal-match priority window (`triggerLiquidationSplit` reverts
      // `InternalMatchOnlyBand` in-window), so wrap it the same way the
      // partial branch is wrapped: on ANY split revert, fall THROUGH to full
      // `triggerLiquidation`, which runs `attemptInternalMatchAutoDispatch`
      // first — so the in-window internal match the window was reserving
      // actually gets dispatched instead of the loan being skipped this tick.
      try {
        const hash = await ctx.wallet.writeContract({
          address: ctx.diamond,
          abi: TRIGGER_ABI,
          functionName: 'triggerLiquidationSplit',
          args: [loanIdBig, splits],
          account,
          chain: ctx.wallet.chain,
        });
        const improvementBps = (split.gainBps);
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} submitted-split tx=${hash} via=${split.a.kind}+${split.b.kind} expected=${split.totalExpected} improvement=${improvementBps}bps over single-route`,
        );
        return true;
      } catch (splitErr) {
        // #2572 — a deadline refusal ends the attempt: every later send this run
        // would be refused too. Rethrown to the outer catch, which logs it
        // as a deferral rather than as this route's failure.
        if (isSendPastDeadline(splitErr)) throw splitErr;
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} split-reverted (${redactedError(splitErr, { stack: false }).slice(0, 140)}) — falling back to full liquidation`,
        );
        // do NOT return — fall through to the full `triggerLiquidation` below.
      }
    }

    // Default path: failover via `triggerLiquidation` — unchanged.
    const hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: TRIGGER_ABI,
      functionName: 'triggerLiquidation',
      args: [loanIdBig, fullAmount, quotes.calls],
      account,
      chain: ctx.wallet.chain,
    });
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} submitted tx=${hash} via=${quotes.ranked[0].kind} sell=${fullAmount} expected=${quotes.ranked[0].expectedOutput}`,
    );
    return true;
  } catch (err) {
    // #2572 — a deadline refusal came before broadcast (no nonce spent, nothing
    // sent) and is reported as a deferral. Any other failure here is
    // non-fatal — we logged + dedupe'd, so the watcher won't hammer the same
    // loan in this tick. The most common cause is "another keeper got there
    // first" or "MEV bot front-ran us", both of which are fine — the loan is
    // liquidated.
    reportSendError(`[keeper] loan=${loanId} chain=${chain.name}`, err, `err=${redactedError(err, { stack: false }).slice(0, 250)}`);
    return false;
  }
}

/**
 * Env keys that arm an individual periodic pass, on top of `KEEPER_ENABLED`.
 *
 * A union rather than `string` on purpose. The call sites this replaces each
 * reached their flag through
 * `(env as unknown as Record<string, string | undefined>)[key]` — a cast to
 * reach a field `Env` already declares. That cast bought nothing and cost
 * the compiler's help: a mistyped key compiled cleanly and read `undefined`
 * forever, leaving the pass permanently dark. Which is the same failure this
 * module's logging exists to expose, one layer down.
 */
export type PassArmingFlag =
  | 'REWARD_REMIT_ENABLED'
  | 'REWARD_COMMIT_ENABLED'
  | 'REWARD_DELIVERY_PROOF_ENABLED'
  | 'REWARD_SANCTIONS_KEEPER_ENABLED'
  | 'REWARD_HORIZON_HEARTBEAT_ENABLED'
  | 'REWARD_DAY_CLOSE_ENABLED'
  | 'GRACE_DEFAULT_ENABLED'
  | 'PERIODIC_SETTLE_ENABLED';

/**
 * Describe a rejected flag value WITHOUT echoing it.
 *
 * An earlier version printed the raw value quoted, which reads as harmless
 * for a boolean-ish binding and is not. `KEEPER_ENABLED` is `secret_text` on
 * the live Worker, and the whole reason this diagnostic exists is the case
 * where the value is NOT what was intended — a paste error is exactly how a
 * credential ends up in the wrong binding. Echoing it would write that
 * credential into the Worker logs, defeating the binding's no-readback
 * protection precisely in the scenario the diagnostic handles.
 *
 * So the classification is bounded: it names the FORM of the mistake, never
 * the content. Every failure mode #1475 set out to expose survives —
 * surrounding whitespace, wrong case, and a value that is simply not either
 * accepted spelling — and the character count distinguishes a four-letter
 * typo from a pasted key without disclosing which.
 *
 * `caseInsensitive` because the two gates genuinely differ: `KEEPER_ENABLED`
 * accepts `True`, the pass flags do not. Reporting "wrong case" for a value
 * the caller would have accepted would send an operator chasing a non-fault.
 */
function describeFlagValue(
  raw: string | undefined,
  caseInsensitive: boolean,
): string {
  if (raw === undefined) return 'unset';
  if (raw === '') return 'empty';
  const accepts = (s: string): boolean => {
    const c = caseInsensitive ? s.toLowerCase() : s;
    return c === 'true' || c === '1';
  };
  const trimmed = raw.trim();

  // `false` is the DOCUMENTED way to disable the keeper (README: "Master
  // kill-switch; set to `false`"), so reporting it as `unrecognised (5
  // chars)` told an operator their deliberate shutdown looked like a typo —
  // during a shutdown or restore, which is exactly when a spurious
  // configuration warning is most expensive. An explicitly-off value is a
  // state, not a mistake, and the line should say so.
  //
  // Recognised case-insensitively on BOTH gates even though the pass flags
  // arm case-sensitively. This function only LABELS; it never arms, and the
  // caller has already decided the value is not accepted. `False` means the
  // same thing its author intended whichever flag it sits on.
  if (['false', '0'].includes(trimmed.toLowerCase())) {
    return trimmed === raw
      ? 'off (explicitly disabled)'
      : 'off (explicitly disabled), with surrounding whitespace';
  }
  if (trimmed !== raw) {
    return accepts(trimmed)
      ? 'has surrounding whitespace (otherwise correct — re-enter without it)'
      : `has surrounding whitespace and is unrecognised (${raw.length} chars)`;
  }
  if (!caseInsensitive && accepts(trimmed.toLowerCase())) {
    return 'wrong case — these flags require lowercase `true`';
  }
  return `unrecognised (${raw.length} chars)`;
}

/** `0x` + 32 bytes, hex-encoded. */
const KEEPER_KEY_CHARS = 66;

/**
 * Resolve the signing key to an account, or say — in bounded terms — why it
 * cannot be one.
 *
 * ONE implementation, used by both the gate and the consumer (#1540 r4/r5),
 * because two implementations of "is this key usable" is exactly how a pass
 * comes to announce `start` and then do nothing. `passIsArmed` originally
 * asked only whether the binding was non-empty; a syntax check replaced that
 * and still admitted 32 hex bytes that are not valid scalars — zero, or at
 * or above the secp256k1 order — which `privateKeyToAccount` rejects when
 * each pass builds its context, long after the line claiming it was armed.
 *
 * So the check IS the construction. Anything viem refuses is reported here
 * rather than re-derived: restating secp256k1's bounds in a second place
 * would recreate the divergence this exists to remove, and would go stale
 * the moment viem's validation changed.
 *
 * Cost is one key derivation per gated pass per tick. That is cheap, and
 * being certain the gate and the signer agree is worth more than saving it.
 *
 * The reason never quotes the value. An unusable key is still a key, and
 * this goes to the same log as everything else.
 */
export function resolveKeeperAccount(
  raw: string,
): { account: PrivateKeyAccount } | { problem: string } {
  const trimmed = raw.trim();
  const pk = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (pk.length !== KEEPER_KEY_CHARS) {
    return {
      problem: `malformed (${pk.length} chars, expected ${KEEPER_KEY_CHARS})`,
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return { problem: 'malformed (not hexadecimal)' };
  }
  try {
    return { account: privateKeyToAccount(pk as `0x${string}`) };
  } catch {
    // Right length, right alphabet, still not a key — zero, or at/above the
    // curve order. Deliberately not echoing the error: viem's message can
    // include the value.
    return { problem: 'malformed (not a valid signing key)' };
  }
}

/**
 * EVERY keeper-level reason the pass cannot run — not just the first.
 *
 * Two independent causes hide behind `isKeeperEnabled`: the flag being off,
 * and the signing key being absent. Both are unreadable, so an operator who
 * cannot tell them apart cannot tell which to fix. And they are reported
 * together rather than in sequence: stopping at the first would mean fixing
 * one binding and waiting a tick to discover the next, which is not what
 * "one cycle settles every switch" promises.
 */
function keeperBlockers(env: Env): string[] {
  const blockers: string[] = [];
  const enabled = env.KEEPER_ENABLED;
  if (enabled === undefined || !['true', '1'].includes(enabled.toLowerCase())) {
    blockers.push(`KEEPER_ENABLED ${describeFlagValue(enabled, true)}`);
  }
  if (!env.KEEPER_PRIVATE_KEY) {
    blockers.push('KEEPER_PRIVATE_KEY unset');
  } else {
    const resolved = resolveKeeperAccount(env.KEEPER_PRIVATE_KEY);
    if ('problem' in resolved) {
      blockers.push(`KEEPER_PRIVATE_KEY ${resolved.problem}`);
    }
  }
  return blockers;
}

/**
 * Unchanged in behaviour — delegates so the boolean and the reasons cannot
 * drift apart. A future cause added to one is a cause in the other.
 */
export function isKeeperEnabled(env: Env): boolean {
  return keeperBlockers(env).length === 0;
}

/**
 * Gate a periodic pass, and say so — exactly one line per pass per tick,
 * whichever way it goes.
 *
 * WHY (#1475). A pass whose arming flag read false and a pass that ran and
 * found nothing to do used to produce byte-identical output: silence. The
 * arming flags are `secret_text` bindings, so their values cannot be read
 * back from the API or the dashboard either. Between the two there was no
 * way at all to confirm a flag was set correctly — not by readback, not by
 * observation — and a typo (`ture`, a trailing newline) left the pass dark
 * and looking perfectly healthy. For reward remittance and commitment
 * reporting that is the worst case, because a silent stall looks exactly
 * like a quiet period.
 *
 * The skip line names the specific binding that stopped the pass and the FORM
 * of the mistake — never the value itself, for the reason given on
 * `describeFlagValue`. `KEEPER_PRIVATE_KEY` is reported only as present or
 * absent.
 *
 * ALL applicable blockers appear on the one line. Reporting only the first
 * would mean an operator fixes one binding, waits a tick, and discovers the
 * next — which is not what a single-cycle diagnosis is worth having for.
 *
 * One `wrangler tail` cycle resolves every gate on every gated pass.
 */
export function passIsArmed(
  env: Env,
  pass: string,
  flag?: PassArmingFlag,
): boolean {
  const blockers = keeperBlockers(env);
  if (flag !== undefined) {
    // Deliberately NOT lowercased, matching the behaviour this replaces.
    // `KEEPER_ENABLED` accepts `True`; these flags do not. Making them agree
    // would arm a fund-moving pass on a deploy that currently has it off, so
    // the asymmetry is surfaced in the log rather than silently resolved.
    const raw = env[flag];
    if (raw !== 'true' && raw !== '1') {
      blockers.push(`${flag} ${describeFlagValue(raw, false)}`);
    }
  }
  if (blockers.length > 0) {
    console.log(`[keeper] ${pass} skipped: ${blockers.join('; ')}`);
    return false;
  }
  console.log(`[keeper] ${pass} start`);
  return true;
}

/** What a pass states when it builds its signing context (#2572). */
export interface KeeperContextOptions {
  /** The pass's run deadline (`PassTick.deadlineMs`), honoured at each send's
   *  turn in the queue: a send whose turn comes after it is refused before
   *  signing (`SendPastDeadline`) and left for the next run. REQUIRED — every
   *  pass has one, and a pass that could omit it is how the liquidator,
   *  matcher and five others came to sign after their run was over. */
  readonly notAfterMs: number;
  /** The fetch the wallet's requests go through — a pass that caps its
   *  requests passes its budget's (see subrequestBudget.ts). */
  readonly fetchFn?: typeof fetch;
}

export function buildKeeperContext(
  env: Env,
  chain: ChainConfig,
  publicClient: PublicClient,
  opts: KeeperContextOptions,
): KeeperContext | null {
  const { notAfterMs, fetchFn } = opts;
  if (!env.KEEPER_PRIVATE_KEY) return null;
  // The same call the gate makes, so a key that logged `start` cannot be
  // rejected here, and one rejected here cannot have logged `start`.
  const resolved = resolveKeeperAccount(env.KEEPER_PRIVATE_KEY);
  if ('problem' in resolved) {
    console.error(`[keeper] KEEPER_PRIVATE_KEY ${resolved.problem}`);
    return null;
  }
  const { account } = resolved;
  // Queued (#2486): every pass signs with this one key, so its sends on
  // this chain are admitted one at a time with a fresh nonce each.
  const wallet = queuedWallet(
    createWalletClient({
      account,
      transport: http(chain.rpc, fetchFn ? { fetchFn } : undefined),
    }),
    chain.id,
    notAfterMs,
  );
  return {
    wallet,
    client: publicClient,
    diamond: chain.diamond as Address,
    chainId: chain.id,
    notAfterMs,
  };
}

// ─── Flash-loan / discount-path branch (Phase 3) ────────────────────
//
// Wraps the simulation + submission shape so the main decision tree
// in `maybeAutonomousLiquidate` stays readable. Returns `true` when a
// tx was submitted, `false` when the path was skipped (caller falls
// through to partial/split/atomic).

interface FlashLoanBranchArgs {
  env: Env;
  chain: ChainConfig;
  ctx: KeeperContext;
  publicClient: PublicClient;
  loanId: number;
  loanIdBig: bigint;
}

/**
 * Try the flash-loan-funded discount path. Three gates:
 *   1. Per-chain `FlashLoanLiquidator` deployed AND at least one
 *      flash-loan provider configured (Aave V3 / Balancer V2).
 *   2. The operator has armed the chain (`DISCOUNT_PATH_CHAIN_IDS`).
 *   3. The trade (discountedLiquidation.ts): the Diamond's preview says
 *      the liquidation can run, a DEX-direct quote sells exactly its
 *      seizure, and the exact call simulates to a run that keeps at least
 *      its own fee. The Diamond's own discount-path switch is the
 *      preview's `Disabled` status.
 *
 * Returns true iff a tx was submitted. Every skip is logged with its
 * reason, and the caller falls through to the existing decision tree.
 */
async function tryFlashLoanDiscountedPath(
  args: FlashLoanBranchArgs,
): Promise<boolean> {
  const { env, chain, ctx, publicClient, loanId, loanIdBig } = args;

  // Gate 1 — the static route: our FlashLoanLiquidator and a provider on
  // this chain (`flashLoanRoute`, the same reading the start-up posture line
  // makes). Silent per loan, because the posture line already names every
  // armed chain this build has no route on; the bot continues with the
  // legacy branches.
  const resolvedRoute = flashLoanRoute(chain.id);
  if ('missing' in resolvedRoute) return false;
  const { route } = resolvedRoute;

  // Gate 2 — the operator has armed this chain (`DISCOUNT_PATH_CHAIN_IDS`,
  // discountPath.ts, #2633). The Diamond's own discount-path switch is read
  // per loan, as the preview's `Disabled` status (gate 3); this is the
  // operator's separate, affirmative step, so an unnamed chain, an unset
  // setting or one that cannot be read keeps the path inert.
  const blocker = discountPathBlocker(env.DISCOUNT_PATH_CHAIN_IDS, chain.id);
  if (blocker !== null) {
    console.log(`[keeper] loan=${loanId} chain=${chain.name} flash-loan-skip not-armed: ${blocker}`);
    return false;
  }

  // Gate 3 — the trade itself (#2697, discountedLiquidation.ts): the
  // Diamond's preview gives the debt and the seizure, the swap is quoted for
  // exactly that seizure with the FlashLoanLiquidator as taker (an
  // aggregator's response is taker-specific, so the main flow's
  // adapter-taker quotes cannot be reused), and the exact call is estimated,
  // which simulates the whole run. The run must keep at least its own fee,
  // in the principal token's units, or the liquidator reverts it.
  const account = ctx.wallet.account;
  if (!account) return false;
  const diamond = chain.diamond as Address;
  const functionName = liquidatorFunction(route.via);
  const plan = await planFlashLoanLiquidation({
    chainId: chain.id,
    loanId: loanIdBig,
    readPreview: () => readDiscountedLiquidation(publicClient, diamond, loanIdBig),
    quote: async (sellAmount, preview) => {
      const direct = await orchestrateDexDirectQuotes(env, publicClient, {
        chainId: chain.id,
        sellToken: preview.collateralAsset,
        buyToken: preview.principalAsset,
        sellAmount,
        taker: route.liquidator,
      });
      if (direct.ranked.length === 0 && direct.failed.length > 0) {
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} flash-loan dex-direct quotes failed: ${direct.failed.join(',')}`,
        );
      }
      return direct.ranked;
    },
    estimateFee: (args) =>
      estimateTxFeeWei(publicClient, chain.id, {
        address: route.liquidator,
        abi: FlashLoanLiquidatorABI as Abi,
        functionName,
        args,
        account,
      }),
    minProfit: (principalAsset, feeWei) => minProfitForFee(publicClient, diamond, chain.id, principalAsset, feeWei),
  });
  if (plan.kind === 'skip') {
    console.log(`[keeper] loan=${loanId} chain=${chain.name} flash-loan-skip ${plan.reason}`);
    return false;
  }

  try {
    const hash = await ctx.wallet.writeContract({
      address: route.liquidator,
      abi: FlashLoanLiquidatorABI,
      functionName,
      args: plan.args,
      account,
      chain: ctx.wallet.chain,
    });
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} submitted-flashloan ` +
        `tx=${hash} via=${route.via} swap=${plan.quote.kind} ` +
        `debt=${plan.preview.debt} sell=${plan.preview.seized} ` +
        `expected=${plan.quote.expectedOutput} minProfit=${plan.minProfit}`,
    );
    return true;
  } catch (err) {
    // #2572 — refused past the run's deadline: rethrown so the caller's outer
    // catch logs one deferral instead of falling through to legacy branches
    // whose sends would be refused the same way.
    if (isSendPastDeadline(err)) throw err;
    console.error(
      `[keeper] loan=${loanId} chain=${chain.name} flash-loan-submit-failed ` +
        `err=${redactedError(err, { stack: false }).slice(0, 250)}`,
    );
    // Fall through to legacy branches so the loan still gets
    // liquidated somehow.
    return false;
  }
}

