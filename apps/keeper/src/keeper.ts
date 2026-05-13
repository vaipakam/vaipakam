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
  LoanFacetABI,
  OracleFacetABI,
  RiskFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import {
  orchestrateServerQuotes,
  type ServerOrchestrationResult,
  type ServerRankedQuote,
} from './serverQuotes';

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

  // Pad with the safety margin, ceil to the next BPS, then clamp.
  const fBps = Math.ceil(fRaw * safetyMargin * 10_000);
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
const TRIGGER_ABI = RiskFacetABI;       // hosts triggerLiquidation
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

    const optimalPartialFractionBps = computeOptimalPartialFractionBps(
      hfRaw,
      liqThresholdBps,
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
