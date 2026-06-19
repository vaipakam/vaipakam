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
 *   4. Submits `triggerLiquidation(loanId, calls)` from the keeper EOA.
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

import {
  type Address,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AdminFacetABI,
  FlashLoanLiquidatorABI,
  LoanFacetABI,
  OracleFacetABI,
  RiskFacetABI,
  RiskSplitLiquidationFacetABI,
} from '@vaipakam/contracts/abis';
import { orchestrateDexDirectQuotes } from './dexDirectQuotes';
import type { ChainConfig, Env } from './env';
import {
  orchestrateServerQuotes,
  type ServerOrchestrationResult,
  type ServerRankedQuote,
} from './serverQuotes';
import { getFlashLoanProvider } from './flashLoanProviders';

function parsePosIntEnv(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Compute the smallest partial-liquidation fraction (in BPS) that
 *  brings a distressed loan's health factor back above `1.0 +
 *  targetBufferBps`, given the asset's `liqThresholdBps`.
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

/** Decide whether splitting the liquidation swap 50/50 across two
 *  distinct adapters beats running the full size through a single
 *  adapter via failover. Returns the chosen `{a, b}` half-quote pair
 *  + the projected total + the bps improvement vs the full-size
 *  top-1, or `null` if splitting doesn't help (no two distinct
 *  adapters at the half size, or the improvement is below
 *  `minImprovementBps` — gas + tx complexity isn't worth it).
 *
 *  The on-chain split is atomic-revert-on-leg-failure, so we only
 *  return non-null when both halves have a successful aggregator
 *  quote at the smaller size. Picks the top-2 *distinct-adapter*
 *  half-quotes (which is usually 0x and 1inch, since each tends to
 *  win when the other doesn't).
 */
function pickSplitLegs(
  halfQuotes: ServerOrchestrationResult,
  fullQuotes: ServerOrchestrationResult,
  minImprovementBps: number,
): { a: ServerRankedQuote; b: ServerRankedQuote; totalExpected: bigint; gainBps: number } | null {
  if (halfQuotes.ranked.length < 2) return null;
  if (fullQuotes.ranked.length === 0) return null;
  // Find the top-2 quotes with distinct `adapterIdx`. `ranked` is
  // already best-first by expectedOutput.
  const a = halfQuotes.ranked[0];
  let b: ServerRankedQuote | null = null;
  for (let i = 1; i < halfQuotes.ranked.length; i++) {
    if (halfQuotes.ranked[i].call.adapterIdx !== a.call.adapterIdx) {
      b = halfQuotes.ranked[i];
      break;
    }
  }
  if (!b) return null;
  const totalExpected = a.expectedOutput + b.expectedOutput;
  const fullTop = fullQuotes.ranked[0].expectedOutput;
  if (totalExpected <= fullTop) return null;
  // `gainBps = (totalExpected - fullTop) * 10_000 / fullTop`, computed
  // with bigints to avoid Number precision at e18 magnitudes.
  const gainBps = Number(((totalExpected - fullTop) * 10_000n) / fullTop);
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
const ORACLE_ABI = OracleFacetABI;      // hosts getAssetRiskProfile

export interface KeeperContext {
  /** Wallet client for the keeper EOA on this chain. */
  wallet: WalletClient;
  /** Public client (read-only) on this chain — same RPC as watcher. */
  client: PublicClient;
  diamond: Address;
  chainId: number;
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
): Promise<boolean> {
  // Eligibility: keeper enabled, HF actually below 1, dedupe miss.
  if (!isKeeperEnabled(env)) return false;
  if (hfRaw >= 10n ** 18n) return false; // HF >= 1.0 → not liquidatable
  const loanId = Number(loanIdBig);
  const key = dedupeKey(chain.id, loanId);
  if (ATTEMPTED.has(key)) return false;
  ATTEMPTED.add(key);

  const ctx = buildKeeperContext(env, chain, publicClient);
  if (!ctx) return false;

  try {
    // Read loan struct so we know the collateral asset (which we then
    // use to fetch the asset risk profile for partial-fraction math).
    // `startTime` + `durationDays` are picked up too so we can decide
    // whether the partial-liquidation path is open — partial is in-term
    // only by contract design.
    const loan = (await publicClient.readContract({
      address: ctx.diamond,
      abi: LOAN_DETAILS_ABI,
      functionName: 'getLoanDetails',
      args: [loanIdBig],
    })) as {
      collateralAsset: Address;
      collateralAmount: bigint;
      principalAsset: Address;
      status: number;
      assetType: number;
      startTime: bigint;
      durationDays: bigint;
    };

    // assetType 0 = ERC20 — only liquidate ERC20 loans (NFT rentals
    // never hit the swap path; they default via the time-based route).
    if (loan.assetType !== 0) return false;
    // Status 0 = Active. Anything else (FallbackPending, Repaid,
    // Defaulted, Settled) means the diamond would revert.
    if (loan.status !== 0) return false;

    // Now read the collateral asset's risk profile so we can size the
    // partial swap precisely. `getAssetRiskProfile.liqThresholdBps`
    // feeds `computeOptimalPartialFractionBps` — the smallest f that
    // restores HF >= 1.05 given the per-asset threshold. Replaces the
    // hardcoded 50% from the prior commit: at HF=0.99 / T=0.85 the
    // optimal is ~37% (smaller swap, more residual to the borrower);
    // at HF=0.93 / T=0.85 it's ~78% (the legacy 50% would have reverted
    // {PartialMustRestoreHF}). If the read fails (RPC blip, asset not
    // yet onboarded), `liqThresholdBps = 0n` and the math returns 0n,
    // making the partial path skip — we fall through to full liquidation
    // so the keeper stays operational on the legacy path.
    const riskProfile = (await publicClient
      .readContract({
        address: ctx.diamond,
        abi: ORACLE_ABI,
        functionName: 'getAssetRiskProfile',
        args: [loan.collateralAsset],
      })
      .catch(() => null)) as
      | readonly [boolean, number, bigint, bigint, bigint]
      | null;
    // getAssetRiskProfile returns (isSupported, status, maxLtvBps,
    // liqThresholdBps, liqBonusBps). We only need liqThresholdBps for
    // the partial-fraction math; if the read failed (RPC blip, asset
    // not yet onboarded, etc.) we fall through to the legacy 5_000
    // fraction so the path stays operational.
    const liqThresholdBps = riskProfile ? riskProfile[3] : 0n;

    // Partial-liquidation decision: when the loan is only mildly-to-
    // moderately undercollateralized AND still in-term, a precisely-
    // sized partial sweep restores HF >= 1 without closing the
    // position. The on-chain `triggerPartialLiquidation` checks the
    // post-mutation HF strictly improves AND lands >= 1.0; if our
    // computed fraction is too small the tx reverts and we retry
    // next tick (possibly as full liquidation).
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
    const endTime = loan.startTime + loan.durationDays * 86_400n;
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    const inTerm = nowTs < endTime;

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
    // coarse cutoff for chains where we don't yet have a tuned
    // liqThresholdBps and don't want to attempt partial blindly).
    const partialEligible =
      inTerm &&
      hfRaw >= partialMinHfRaw &&
      hfRaw < 10n ** 18n &&
      optimalPartialFractionBps > 0n &&
      optimalPartialFractionBps < 7_500n;

    // Compute the partial-size for quote fetching. Falls back to half
    // when we don't have liqThresholdBps (the legacy 50% path).
    const partialAmount = partialEligible
      ? (loan.collateralAmount * optimalPartialFractionBps) / 10_000n
      : loan.collateralAmount / 2n;
    // The split-route decision is built around 50/50 splitting, so we
    // always also fetch the half-size quote for that branch.
    const halfAmount = loan.collateralAmount / 2n;
    const otherHalf = loan.collateralAmount - halfAmount;
    const [quotes, halfQuotes, partialQuotes] = await Promise.all([
      orchestrateServerQuotes(env, publicClient, {
        chainId: chain.id,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount: loan.collateralAmount,
        taker: ctx.diamond,
      }),
      orchestrateServerQuotes(env, publicClient, {
        chainId: chain.id,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount: halfAmount,
        taker: ctx.diamond,
      }),
      // Skip the third quote when partial isn't viable — keeps the
      // hot-path RPC volume the same as before in the common "full
      // liquidation" case. When partial IS viable, all three run in
      // parallel so per-loan latency stays at the max of the three
      // rather than serializing.
      partialEligible && partialAmount !== halfAmount
        ? orchestrateServerQuotes(env, publicClient, {
            chainId: chain.id,
            sellToken: loan.collateralAsset,
            buyToken: loan.principalAsset,
            sellAmount: partialAmount,
            taker: ctx.diamond,
          })
        : Promise.resolve(null),
    ]);
    if (quotes.calls.length === 0) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} no-quotes (failed: ${quotes.failed.join(',')})`,
      );
      return false;
    }

    const account = ctx.wallet.account;
    if (!account) return false;

    // ── Flash-loan / discount-path branch — Phase 3 of
    //    FlashLoanLiquidationPath.md. Slots in AHEAD of partial /
    //    split / atomic because the discount path is the most
    //    capital-efficient option when:
    //      - the discount-path master kill-switch is on, AND
    //      - we have a FlashLoanLiquidator deployed on this chain,
    //        AND
    //      - the projected swap proceeds (collateral seizure ×
    //        best DEX quote) exceed (totalDebt + flash-loan fee +
    //        gas headroom). I.e. the trade clears with positive
    //        margin even after the liquidator-side costs.
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
      loan,
      hfRaw,
      quotes, // full-size collateral→principal quotes already fetched
    });
    if (flashLoanSubmitted) return true;

    // Use the dedicated partial quote when we fetched one, else the
    // half-quote (legacy 50% path when liqThresholdBps was missing).
    const effectivePartialQuotes: ServerOrchestrationResult | null =
      partialQuotes ?? (partialEligible ? halfQuotes : null);
    const effectivePartialFractionBps: bigint = partialQuotes
      ? optimalPartialFractionBps
      : 5_000n;

    if (
      partialEligible &&
      effectivePartialQuotes &&
      effectivePartialQuotes.calls.length > 0
    ) {
      // #395 (Codex r4 P2) — the partial may revert under the new on-chain
      // sizing guards: `PartialOverLiquidates` (slice over the HF ceiling),
      // `InternalMatchOnlyBand` (loan still inside the internal-match priority
      // window), or `PartialLeavesDust` (would strand a sub-dust position). In
      // ALL three the correct resolution is FULL liquidation — it has no
      // over-liquidation ceiling, auto-dispatches an in-window internal match,
      // and closes a tiny position cleanly. `writeContract` estimates gas
      // first, so a guard revert throws here BEFORE any tx is broadcast; catch
      // it and fall THROUGH to the split/full path below instead of returning
      // (which previously left the loan unresolved and re-attempted next tick).
      try {
        const hash = await ctx.wallet.writeContract({
          address: ctx.diamond,
          abi: TRIGGER_ABI,
          functionName: 'triggerPartialLiquidation',
          args: [loanIdBig, effectivePartialFractionBps, effectivePartialQuotes.calls],
          account,
          chain: ctx.wallet.chain,
        });
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} submitted-partial tx=${hash} fraction=${effectivePartialFractionBps}bps liqThreshold=${liqThresholdBps}bps via=${effectivePartialQuotes.ranked[0].kind} hfBefore=${hfRaw} expected=${effectivePartialQuotes.ranked[0].expectedOutput}`,
        );
        return true;
      } catch (partialErr) {
        // #395 (Codex r6/r7 P2) — classify the partial revert into two
        // actions:
        //   ESCALATE → full liquidation (fall through): the guard says a
        //     partial is the wrong tool for this loan right now —
        //       · InternalMatchOnlyBand  (in the priority window → full
        //         auto-dispatches the reserved internal match),
        //       · PartialLeavesDust      (a clean partial would strand dust),
        //       · InvalidPartialFraction (governance lowered the close-factor
        //         cap below any usable slice),
        //       · PartialFullyClosedUseFull (slice would retire all principal),
        //       · PartialAfterMaturity   (past maturity — full/default path).
        //   RE-SIZE → skip this tick, recompute next tick (do NOT close the
        //     whole loan): the slice itself was just mis-sized / the route
        //     failed, and a smaller/re-quoted partial can still restore HF and
        //     preserve the borrower's position —
        //       · PartialOverLiquidates  (slice too big → pick a smaller one),
        //       · PartialMustRestoreHF / PartialMustImproveHF (too small),
        //       · PartialSwapAllFailed   (route failed), and any unknown error.
        // viem surfaces the decoded error name in the message string.
        const msg = String(partialErr);
        const escalate =
          msg.includes('InternalMatchOnlyBand') ||
          msg.includes('PartialLeavesDust') ||
          msg.includes('InvalidPartialFraction') ||
          msg.includes('PartialFullyClosedUseFull') ||
          msg.includes('PartialAfterMaturity');
        if (!escalate) {
          console.log(
            `[keeper] loan=${loanId} chain=${chain.name} partial-reverted-resize (${msg.slice(0, 140)}) — skipping; recompute slice next tick`,
          );
          return false;
        }
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} partial-reverted-escalation (${msg.slice(0, 140)}) — falling back to split/full liquidation`,
        );
        // escalation case — fall THROUGH to the split / full branches below.
      }
    }

    // Split-route decision: when ≥2 distinct-adapter quotes succeeded at
    // the half size AND their combined output beats the single-adapter
    // full quote by `SPLIT_MIN_IMPROVEMENT_BPS` (default 100 = 1%), use
    // `triggerLiquidationSplit`. Below the threshold the gas + tx
    // complexity isn't worth it. The split is atomic-revert-on-leg-
    // failure on-chain, so we only invoke it when both legs are
    // independently OK at quote time.
    const minImprovementBps = parsePosIntEnv(env.SPLIT_MIN_IMPROVEMENT_BPS, 100);
    const split = pickSplitLegs(halfQuotes, quotes, minImprovementBps);
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
        console.log(
          `[keeper] loan=${loanId} chain=${chain.name} split-reverted (${String(splitErr).slice(0, 140)}) — falling back to full liquidation`,
        );
        // do NOT return — fall through to the full `triggerLiquidation` below.
      }
    }

    // Default path: failover via `triggerLiquidation` — unchanged.
    const hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: TRIGGER_ABI,
      functionName: 'triggerLiquidation',
      args: [loanIdBig, quotes.calls],
      account,
      chain: ctx.wallet.chain,
    });
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} submitted tx=${hash} via=${quotes.ranked[0].kind} expected=${quotes.ranked[0].expectedOutput}`,
    );
    return true;
  } catch (err) {
    // Any failure here is non-fatal — we logged + dedupe'd, so the
    // watcher won't hammer the same loan in this tick. The most
    // common cause is "another keeper got there first" or "MEV bot
    // front-ran us", both of which are fine — the loan is liquidated.
    console.error(
      `[keeper] loan=${loanId} chain=${chain.name} err=${String(err).slice(0, 250)}`,
    );
    return false;
  }
}

export function isKeeperEnabled(env: Env): boolean {
  if (!env.KEEPER_ENABLED) return false;
  const v = env.KEEPER_ENABLED.toLowerCase();
  if (v !== 'true' && v !== '1') return false;
  return !!env.KEEPER_PRIVATE_KEY;
}

export function buildKeeperContext(
  env: Env,
  chain: ChainConfig,
  publicClient: PublicClient,
): KeeperContext | null {
  if (!env.KEEPER_PRIVATE_KEY) return null;
  let pk = env.KEEPER_PRIVATE_KEY.trim();
  if (!pk.startsWith('0x')) pk = `0x${pk}`;
  if (pk.length !== 66) {
    console.error('[keeper] KEEPER_PRIVATE_KEY malformed length');
    return null;
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({
    account,
    transport: http(chain.rpc),
  });
  return {
    wallet,
    client: publicClient,
    diamond: chain.diamond as Address,
    chainId: chain.id,
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
  loan: {
    collateralAsset: Address;
    collateralAmount: bigint;
    principalAsset: Address;
    status: number;
    assetType: number;
    startTime: bigint;
    durationDays: bigint;
  };
  hfRaw: bigint;
  /** Quote bundle for the full-size collateral→principal swap.
   *  Reused from the main flow's earlier `orchestrateServerQuotes`
   *  call — no extra RPC roundtrip needed. */
  quotes: ServerOrchestrationResult;
}

/**
 * Try the flash-loan-funded discount path. Three gates:
 *   1. Per-chain `FlashLoanLiquidator` deployed AND at least one
 *      flash-loan provider configured (Aave V3 / Balancer V2).
 *   2. Diamond's `discountPathEnabled` governance flag is true.
 *   3. Simulated trade is profitable after flash-loan fee + a
 *      gas-headroom buffer.
 *
 * Returns true iff a tx was submitted. Any failure mode (provider
 * not configured, kill-switch off, unprofitable simulation, RPC
 * error during read) returns false silently so the caller falls
 * through to the existing decision tree.
 */
async function tryFlashLoanDiscountedPath(
  args: FlashLoanBranchArgs,
): Promise<boolean> {
  const { env, chain, ctx, publicClient, loanId, loanIdBig, loan, quotes } = args;

  // Gate 1 — per-chain provider config.
  const provider = getFlashLoanProvider(chain.id);
  if (!provider) {
    // Either chain unsupported OR FlashLoanLiquidator not deployed
    // yet. Silent skip — the bot continues with the legacy branches.
    return false;
  }

  // Gate 2 — diamond-side master kill-switch. Read live (governance
  // can flip it at any tick). Use ConfigFacet.getTierLiqDiscountBps
  // as a proxy: it always returns non-zero defaults regardless of
  // the kill-switch, so we read the kill-switch differently. The
  // diamond doesn't expose a direct `getDiscountPathEnabled()`
  // view; instead we use eth_call to triggerLiquidationDiscounted
  // with a known-Active loan and check whether the revert reason
  // matches `DiscountPathDisabled` — but that's expensive per
  // loan. Cheaper: rely on a per-chain env override
  // `DISCOUNT_PATH_ENABLED_<chainId>` set by the operator when
  // they flip the flag on. If unset, treat as disabled (safe
  // default — the path stays inert until the operator
  // affirmatively turns it on).
  const enabledKey = `DISCOUNT_PATH_ENABLED_${chain.id}`;
  const enabledFlag = (env as unknown as Record<string, string | undefined>)[enabledKey];
  if (enabledFlag !== 'true') return false;

  // Gate 3 — profitability simulation. We already have the full-
  // size collateral→principal quote bundle from the main flow (the
  // best-ranked entry's `expectedOutput` is what the swap would
  // yield). Subtract the flash-loan fee + a small gas headroom
  // expressed in principal-token units.
  if (quotes.calls.length === 0) return false;
  const bestQuote = quotes.ranked[0];
  if (!bestQuote) return false;

  // Compute totalDebt — principal + accrued interest. The diamond
  // computes this internally inside `triggerLiquidationDiscounted`;
  // we approximate off-chain so the simulation matches what the
  // diamond will charge. Floor: just the principal. Ceiling: read
  // current borrow balance via `LoanFacet.getLoanDetails` (already
  // in `loan`) — but `getLoanDetails` returns the snapshot at
  // init, not the current balance. For now we estimate using the
  // principal as the lower-bound; the actual on-chain seize will
  // top out at the real `totalDebt`. The keeper bot can be made
  // more precise in a follow-up by adding a `calculateCurrentDebt`
  // view to `LoanFacet`.
  const totalDebtEstimate = loan.collateralAmount; // very rough placeholder
  // (TODO: compute proper currentBorrowBalance via OracleFacet)

  // Aave V3 standard premium = 5 BPS. Reading the exact value from
  // `IAaveV3Pool.FLASHLOAN_PREMIUM_TOTAL()` costs a per-tick RPC
  // call; the standard 5 BPS holds on every chain we target, so
  // we use the conservative constant. Operator can override via
  // `FLASH_PREMIUM_BPS_<chainId>` if a chain ever bumps it.
  const flashFeeBps = 5;
  const flashFee = (totalDebtEstimate * BigInt(flashFeeBps)) / 10_000n;

  // Simulated proceeds = best-quote expectedOutput on the
  // collateral→principal swap. The seizure size at the diamond
  // includes the per-tier discount which we don't precisely
  // simulate here (Tier 3 default 5%), so the realised proceeds
  // will be slightly higher than this estimate. Adding the
  // discount-implied uplift would tighten the simulation; for v1
  // we use the floor estimate so the simulation is conservative.
  const simulatedProceeds = bestQuote.expectedOutput;

  // Gas headroom — order-of-magnitude estimate for a flash-loan
  // tx (~600k gas at 2 gwei on an L2 = ~1.2e-3 ETH). Express as
  // a fixed bigint in principal-token units; operator can fine-
  // tune via `FLASH_GAS_HEADROOM_PRINCIPAL_<chainId>`. v1 default:
  // 1 ether of principal-token (overstated on L2s, ~$2-3 worth on
  // most chains — comfortably profitable trades clear this easily).
  const gasHeadroomKey = `FLASH_GAS_HEADROOM_PRINCIPAL_${chain.id}`;
  const gasHeadroomRaw =
    (env as unknown as Record<string, string | undefined>)[gasHeadroomKey];
  const gasHeadroom = gasHeadroomRaw
    ? BigInt(gasHeadroomRaw)
    : 10n ** 18n; // 1 token (18-dec convention)

  const requiredProceeds = totalDebtEstimate + flashFee + gasHeadroom;
  if (simulatedProceeds < requiredProceeds) {
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} flash-loan-skip ` +
        `unprofitable: proceeds=${simulatedProceeds} < ` +
        `needed=${requiredProceeds} (debt~${totalDebtEstimate} ` +
        `fee=${flashFee} gas=${gasHeadroom})`,
    );
    return false;
  }

  // Provider preference — Aave V3 first (broader asset coverage,
  // 5 BPS premium), Balancer V2 fallback (zero-fee but narrower
  // asset list).
  const useAave = !!provider.aaveV3Pool;
  const useBalancer = !useAave && !!provider.balancerV2Vault;
  if (!useAave && !useBalancer) return false;

  const account = ctx.wallet.account;
  if (!account) return false;

  // ── DEX-direct quote fetch ────────────────────────────────────
  // Re-fetch with the FlashLoanLiquidator receiver as taker (not
  // the diamond), so the aggregator builds calldata + allowance
  // target tailored to the receiver's call shape. We can't reuse
  // the `quotes` bundle from the main flow because that was
  // built with `taker = diamond` for the diamond-LibSwap-adapter
  // path; the aggregator's response is taker-specific.
  const directQuotes = await orchestrateDexDirectQuotes(env, publicClient, {
    chainId: chain.id,
    sellToken: loan.collateralAsset,
    buyToken: loan.principalAsset,
    sellAmount: loan.collateralAmount,
    taker: provider.liquidator as Address,
  });
  if (directQuotes.ranked.length === 0) {
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} flash-loan-skip ` +
        `no-dex-direct-quotes (failed: ${directQuotes.failed.join(',')})`,
    );
    return false;
  }
  const bestDirect = directQuotes.ranked[0];

  // Re-validate profitability against the DEX-direct quote
  // (which can differ from the LibSwap-adapter quote we used in
  // the initial simulation — the aggregator returns slightly
  // different routes per-taker).
  if (bestDirect.expectedOutput < requiredProceeds) {
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} flash-loan-skip ` +
        `direct-quote-unprofitable: proceeds=${bestDirect.expectedOutput} < ` +
        `needed=${requiredProceeds}`,
    );
    return false;
  }

  try {
    const fnName = useAave ? 'liquidateViaAaveV3' : 'liquidateViaBalancerV2';
    const hash = await ctx.wallet.writeContract({
      address: provider.liquidator as Address,
      abi: FlashLoanLiquidatorABI,
      functionName: fnName,
      args: [
        loanIdBig,
        loan.principalAsset,
        loan.collateralAsset,
        totalDebtEstimate,
        bestDirect.swapTarget,
        bestDirect.swapAllowanceTarget,
        bestDirect.swapCalldata,
      ],
      account,
      chain: ctx.wallet.chain,
    });
    console.log(
      `[keeper] loan=${loanId} chain=${chain.name} submitted-flashloan ` +
        `tx=${hash} via=${useAave ? 'aave-v3' : 'balancer-v2'} ` +
        `swap=${bestDirect.kind} expected=${bestDirect.expectedOutput}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[keeper] loan=${loanId} chain=${chain.name} flash-loan-submit-failed ` +
        `err=${String(err).slice(0, 250)}`,
    );
    // Fall through to legacy branches so the loan still gets
    // liquidated somehow.
    return false;
  }
}

