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
  parseAbi,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig, Env } from './env';
import { orchestrateServerQuotes } from './serverQuotes';

const TRIGGER_ABI = parseAbi([
  // Phase 7a — adapter try-list signature.
  'function triggerLiquidation(uint256 loanId, (uint256 adapterIdx, bytes data)[] calls)',
  'function getLoanDetails(uint256 loanId) view returns ((uint256 offerId, address lender, address borrower, address principalAsset, uint256 principal, address collateralAsset, uint256 collateralAmount, address prepayAsset, uint256 prepayAmount, uint256 interestRateBps, uint256 startTime, uint256 durationDays, uint8 status, uint8 assetType, uint256 lenderTokenId, uint256 borrowerTokenId, uint256 tokenId, uint256 quantity, bool fallbackConsentFromBoth, uint8 collateralAssetType, uint256 collateralTokenId, uint256 collateralQuantity, uint256 lenderDiscountAccAtInit, uint256 borrowerDiscountAccAtInit) loan)',
]);

interface KeeperContext {
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
      abi: TRIGGER_ABI,
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

    // Fetch quotes server-side. Empty result → nothing to submit.
    const quotes = await orchestrateServerQuotes(env, publicClient, {
      chainId: chain.id,
      sellToken: loan.collateralAsset,
      buyToken: loan.principalAsset,
      sellAmount: loan.collateralAmount,
      taker: ctx.diamond,
    });
    if (quotes.calls.length === 0) {
      console.log(
        `[keeper] loan=${loanId} chain=${chain.name} no-quotes (failed: ${quotes.failed.join(',')})`,
      );
      return false;
    }

    const account = ctx.wallet.account;
    if (!account) return false;

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

function isKeeperEnabled(env: Env): boolean {
  if (!env.KEEPER_ENABLED) return false;
  const v = env.KEEPER_ENABLED.toLowerCase();
  if (v !== 'true' && v !== '1') return false;
  return !!env.KEEPER_PRIVATE_KEY;
}

function buildKeeperContext(
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
