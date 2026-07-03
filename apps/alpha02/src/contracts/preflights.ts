/**
 * Submit-time preflights — the LIVE reads every write path runs
 * immediately before an approval or signature. The review checklists
 * run on CACHED queries (fine for display); these exist because
 * approve()/setApprovalForAll() succeed regardless of balances,
 * pauses, or ownership, so any stale fact turns into a wasted,
 * user-paid transaction unless it's re-checked at the moment of truth.
 *
 * Failure postures (deliberate, per check):
 *   - balance / ownership: FAIL CLOSED — nothing has been sent yet,
 *     so blocking on an unreadable chain is free and re-trying is
 *     cheap. A stale "yes" is exactly the bug class.
 *   - pause: FAIL OPEN on read errors — the contract still guards
 *     (requireAssetNotPaused); the read exists only to save gas.
 */
import { erc20Abi } from 'viem';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';

/** Live ERC-20 balance gate. Throws `needMore` when short; throws the
 *  transport error when the read fails (fail closed). */
export async function assertErc20BalanceLive(opts: {
  publicClient: PublicClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  amount: bigint;
  symbol?: string;
}): Promise<void> {
  const held = await opts.publicClient.readContract({
    address: opts.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [opts.owner],
  });
  if (held < opts.amount) {
    throw new Error(copy.errors.needMore(opts.symbol ?? 'the required asset'));
  }
}

/** Live per-asset pause gate (AdminFacet.isAssetPaused). Fail-open on
 *  read errors — createOffer/acceptOffer still enforce the pause. */
export async function assertAssetNotPausedLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  asset: `0x${string}`;
}): Promise<void> {
  const paused = await opts.publicClient
    .readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isAssetPaused',
      args: [opts.asset],
    })
    .catch(() => false);
  if (paused) {
    throw new Error(copy.errors.assetPaused);
  }
}

/** Live position-NFT ownership gate (Diamond ownerOf). Throws when the
 *  connected wallet no longer holds the position (transferred/burned)
 *  or the read fails — fail closed either way, nothing was sent. */
export async function assertPositionNftHeldLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  tokenId: string;
  expectedOwner: `0x${string}`;
}): Promise<void> {
  let owner: string;
  try {
    owner = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'ownerOf',
      args: [BigInt(opts.tokenId)],
    })) as string;
  } catch {
    // Burned (claimed/terminal) or unreadable — either way this wallet
    // can't be confirmed as the position holder right now.
    throw new Error(copy.errors.positionMoved);
  }
  if (owner.toLowerCase() !== opts.expectedOwner.toLowerCase()) {
    throw new Error(copy.errors.positionMoved);
  }
}

/** Compile-time default grace schedule — mirrors
 *  LibVaipakam.gracePeriod's zero-bucket fallback. */
export function defaultGraceSeconds(durationDays: number): bigint {
  if (durationDays < 7) return 3_600n;
  if (durationDays < 30) return 86_400n;
  if (durationDays < 90) return 3n * 86_400n;
  if (durationDays < 180) return 7n * 86_400n;
  if (durationDays < 365) return 14n * 86_400n;
  return 30n * 86_400n;
}

/** LIVE grace window for a duration — reads governance-configured
 *  buckets (ConfigFacet.getGraceBuckets) and mirrors the contract's
 *  walk (first bucket whose threshold strictly exceeds durationDays
 *  wins; a trailing maxDurationDays==0 entry is the catch-all). Falls
 *  back to the compile-time default schedule when no buckets are set
 *  or the read fails (matching the contract's own zero-bucket path;
 *  a read failure only risks a wasted approval, and the contract
 *  still enforces the real window). */
export async function readGraceSecondsLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  durationDays: number;
}): Promise<bigint> {
  try {
    const buckets = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getGraceBuckets',
    })) as readonly { maxDurationDays: bigint; graceSeconds: bigint }[];
    if (buckets.length > 0) {
      for (const b of buckets) {
        if (b.maxDurationDays === 0n) return b.graceSeconds; // catch-all
        if (BigInt(opts.durationDays) < b.maxDurationDays) return b.graceSeconds;
      }
    }
  } catch {
    // fall through to the default schedule
  }
  return defaultGraceSeconds(opts.durationDays);
}

/** LiquidityStatus enum values (LibVaipakam): 0 = Liquid, 1 = Illiquid. */
export const LIQUIDITY_LIQUID = 0;

/** Live liquidity read for one asset. Returns true when ILLIQUID.
 *  Zero address (no collateral leg) is never illiquid. Fail-open on
 *  read errors for WARNING purposes only — callers that must fail
 *  closed should not use this helper. */
export async function isAssetIlliquidLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  asset: string;
}): Promise<boolean> {
  if (
    !opts.asset ||
    opts.asset.toLowerCase() === '0x0000000000000000000000000000000000000000'
  ) {
    return false;
  }
  const status = await opts.publicClient
    .readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'checkLiquidity',
      args: [opts.asset as `0x${string}`],
    })
    .catch(() => LIQUIDITY_LIQUID);
  return Number(status) !== LIQUIDITY_LIQUID;
}
