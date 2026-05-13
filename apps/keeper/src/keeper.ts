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
import { LoanFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
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
    // Read loan struct so we know the assets + amounts to swap.
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
    };

    // assetType 0 = ERC20 — only liquidate ERC20 loans (NFT rentals
    // never hit the swap path; they default via the time-based route).
    if (loan.assetType !== 0) return false;
    // Status 0 = Active. Anything else (FallbackPending, Repaid,
    // Defaulted, Settled) means the diamond would revert.
    if (loan.status !== 0) return false;

    // Fetch full-size quotes AND half-size quotes in parallel. The
    // half-size set lets us decide between failover (single adapter
    // takes the whole input) and split-route (two adapters each take
    // half). Doing both in parallel keeps the per-liquidation latency
    // at `max(fullCall, halfCall)` rather than `full + half` — minimal
    // overhead on the urgent HF<1 path.
    const halfAmount = loan.collateralAmount / 2n;
    const otherHalf = loan.collateralAmount - halfAmount;
    const [quotes, halfQuotes] = await Promise.all([
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
    ]);
    if (quotes.calls.length === 0) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} no-quotes (failed: ${quotes.failed.join(',')})`,
      );
      return false;
    }

    const account = ctx.wallet.account;
    if (!account) return false;

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
