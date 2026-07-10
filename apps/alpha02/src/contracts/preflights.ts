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
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { defaultGraceSeconds } from '../lib/grace';
import { formatTokenAmount } from '../lib/format';

export { defaultGraceSeconds };

/** Live ERC-20 balance gate. Throws `needMore` when short; throws the
 *  transport error when the read fails (fail closed). */
export async function assertErc20BalanceLive(opts: {
  publicClient: PublicClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  amount: bigint;
  symbol?: string;
}): Promise<void> {
  let held: bigint;
  try {
    held = await opts.publicClient.readContract({
      address: opts.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [opts.owner],
    });
  } catch {
    // Fail closed, in words the user can act on — a raw viem
    // transport message is not a next step.
    throw new Error(copy.errors.checkRetry);
  }
  if (held < opts.amount) {
    // F-20260703-005 (#988) — tell the user HOW MUCH is missing, not
    // just that something is. The decimals read runs only on this
    // failure path; if it fails, fall back to the amount-less message
    // rather than formatting the shortfall at a guessed scale (a wrong
    // number is worse than none).
    let shortBy: string | undefined;
    try {
      const decimals = await opts.publicClient.readContract({
        address: opts.token,
        abi: erc20Abi,
        functionName: 'decimals',
      });
      shortBy = formatTokenAmount(opts.amount - held, decimals);
    } catch {
      shortBy = undefined;
    }
    throw new Error(
      copy.errors.needMore(opts.symbol ?? 'the required asset', shortBy),
    );
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
  } catch (err) {
    // Fail closed either way, but say the TRUE thing: a revert means
    // the token is gone (burned/claimed → the position really moved);
    // a transport failure means we couldn't check — "transferred"
    // would be a false claim and "refresh" wouldn't help.
    const isRevert =
      err instanceof BaseError &&
      (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
        err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
    throw new Error(isRevert ? copy.errors.positionMoved : copy.errors.checkRetry);
  }
  if (owner.toLowerCase() !== opts.expectedOwner.toLowerCase()) {
    throw new Error(copy.errors.positionMoved);
  }
}

/** LIVE grace window for a duration — reads governance-configured
 *  buckets (ConfigFacet.getGraceBuckets) and mirrors the contract's
 *  walk (first bucket whose threshold strictly exceeds durationDays
 *  wins; a trailing maxDurationDays==0 entry is the catch-all). An
 *  EMPTY bucket set resolves to the compile-time default schedule —
 *  that IS the live config (the contract's own zero-bucket path). A
 *  FAILED read THROWS: substituting the default there is not
 *  knowledge — it can enable signing against a wrong grace label
 *  (useGraceLabel's `ready` gate) or wrongly refuse a valid repay
 *  when the configured window is longer than the default. Callers
 *  surface a visible retry instead. */
export async function readGraceSecondsLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  durationDays: number;
}): Promise<bigint> {
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
    // No match and no catch-all (malformed set) — the contract's
    // defensive fallback returns the LAST entry's grace; mirror it.
    return buckets[buckets.length - 1].graceSeconds;
  }
  return defaultGraceSeconds(opts.durationDays);
}

/** True when a contract read failed because the Diamond doesn't cut the
 *  selector — as opposed to a transient RPC/ABI error. `0xa9ad62f8` is
 *  the Diamond's FunctionNotFound selector. Shared by the accept
 *  signers' gate previews and the signed-fill KYC preflight so every
 *  "older deploy without the view" branch classifies identically. */
export function isMissingSelectorError(e: unknown): boolean {
  const msg = String(
    (e as { data?: string; message?: string })?.data ??
      (e as Error)?.message ??
      '',
  );
  return /function does not exist|functionnotfound|0xa9ad62f8/i.test(msg);
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
  /** Throw on read failure instead of assuming liquid. Use wherever
   *  the answer gates a DISCLOSURE (an unknown must not silently
   *  render as "liquid, no warning needed"). */
  failClosed?: boolean;
}): Promise<boolean> {
  if (
    !opts.asset ||
    opts.asset.toLowerCase() === '0x0000000000000000000000000000000000000000'
  ) {
    return false;
  }
  let status: unknown;
  try {
    status = await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'checkLiquidity',
      args: [opts.asset as `0x${string}`],
    });
  } catch (err) {
    if (opts.failClosed) {
      throw new Error(copy.errors.checkRetry);
    }
    status = LIQUIDITY_LIQUID;
    void err;
  }
  return Number(status) !== LIQUIDITY_LIQUID;
}

/**
 * #1145 (Codex round-3 P2) — fail a SIGNED-OFFER fill BEFORE the
 * AcceptTerms signature and allowance approval when tiered KYC
 * enforcement would reject it on-chain. The materialized fill runs
 * `_acceptOffer`'s check — `ProfileFacet.meetsKYCRequirement` for BOTH
 * parties at the transaction's numeraire value — and reverts
 * `KYCRequired`; the direct-accept signer previews its gates before any
 * signature, so the signed path must too. A signed order has no offer
 * id until it materializes, so the offer-keyed previews
 * (`OfferPreviewFacet.previewAccept`, the #627
 * `calculateTransactionValueNumeraire` view) can't be reused — the
 * value is recomputed here mirroring
 * `OfferAcceptFacet._liquidNumeraireValue` exactly: each LIQUID leg
 * contributes `amount × price × 1e18 / 10^feedDecimals /
 * 10^tokenDecimals` (OracleFacet.getAssetPrice); an illiquid/unpriced
 * leg contributes 0. A just-materialized offer can carry no sale link,
 * so the sale-vehicle collateral substitution never applies.
 *
 * Gated on `AdminFacet.isKYCEnforcementEnabled` FIRST, so the retail
 * deploy (enforcement OFF — `meetsKYCRequirement` short-circuits true)
 * pays one cheap read and zero oracle round-trips — the same
 * flag-gating `RiskPreviewFacet.previewIntent` applies for the same
 * reason. This makes the preflight a no-op passthrough on retail while
 * staying real on the KYC-enabled industrial forks.
 *
 * Fail postures: a missing selector (older deploy without the getter)
 * PASSES — the contract still enforces; any transport failure fails
 * CLOSED (retrying is free, a wasted signature + approval is not — the
 * same posture as the direct signer's risk-gate preview).
 */
export async function assertSignedFillKycEligibleLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  /** The order's maker (`order.signer`). */
  maker: `0x${string}`;
  /** The prospective taker (the connected wallet). */
  taker: `0x${string}`;
  lendingAsset: `0x${string}`;
  /** Role-aware effective principal — what `_acceptOffer` gates KYC
   *  on: a LENDER order's headline max (`amountMax`), a BORROWER
   *  order's headline floor (`amount`). */
  lendingAmount: bigint;
  collateralAsset: `0x${string}`;
  collateralAmount: bigint;
}): Promise<void> {
  let enforced: boolean;
  try {
    enforced = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isKYCEnforcementEnabled',
    })) as boolean;
  } catch (err) {
    if (isMissingSelectorError(err)) return; // pre-getter deploy — the contract still enforces
    throw new Error(copy.errors.checkRetry);
  }
  if (!enforced) return; // retail default — the on-chain check short-circuits true

  let makerOk: boolean;
  let takerOk: boolean;
  try {
    const [lendValue, collValue] = await Promise.all([
      liquidNumeraireValueLive(opts, opts.lendingAsset, opts.lendingAmount),
      liquidNumeraireValueLive(opts, opts.collateralAsset, opts.collateralAmount),
    ]);
    const valueNumeraire = lendValue + collValue;
    [makerOk, takerOk] = (await Promise.all([
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'meetsKYCRequirement',
        args: [opts.maker, valueNumeraire],
      }),
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'meetsKYCRequirement',
        args: [opts.taker, valueNumeraire],
      }),
    ])) as [boolean, boolean];
  } catch {
    throw new Error(copy.errors.checkRetry);
  }
  if (!makerOk || !takerOk) {
    throw new Error(copy.desk.signed.kycBlocked);
  }
}

/** One leg of `_liquidNumeraireValue`, read live. Throws the raw
 *  transport error on an unreadable leg (the caller maps it to
 *  `checkRetry`) — an unknown price must not silently value a leg at 0
 *  and wave through a taker the contract would reject. */
async function liquidNumeraireValueLive(
  opts: { publicClient: PublicClient; diamondAddress: `0x${string}` },
  asset: `0x${string}`,
  amount: bigint,
): Promise<bigint> {
  if (amount === 0n) return 0n;
  const status = await opts.publicClient.readContract({
    address: opts.diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'checkLiquidity',
    args: [asset],
  });
  if (Number(status) !== LIQUIDITY_LIQUID) return 0n; // illiquid leg ≡ 0, per the contract
  const [[price, feedDecimals], tokenDecimals] = await Promise.all([
    opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getAssetPrice',
      args: [asset],
    }) as Promise<[bigint, number]>,
    opts.publicClient.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
  ]);
  return (
    (amount * price * 10n ** 18n) /
    10n ** BigInt(feedDecimals) /
    10n ** BigInt(tokenDecimals)
  );
}
