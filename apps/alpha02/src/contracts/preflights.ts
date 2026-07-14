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

/** `LibVaipakam.RiskAccessLevel` ordinals (BlueChipOnly = 0,
 *  BroadLiquid = 1, IlliquidCustom = 2). */
const RISK_LEVEL_BROAD_LIQUID = 1;
const RISK_LEVEL_ILLIQUID_CUSTOM = 2;

/**
 * #1145 (Codex round-6 P2) — fail a SIGNED-OFFER fill BEFORE the
 * AcceptTerms signature and allowance approval when the progressive
 * risk-access gate (#671/#728) would reject it on-chain. A signed
 * order's MAKER is never gated at signing (nothing touches the chain),
 * so the fill is where their create-time gate finally runs: the
 * materialization (`OfferCreateFacet` create chokepoint,
 * OfferCreateFacet.sol:882) asserts the MAKER against the pair, and the
 * loan-init gate (`LoanFacet._maybeRunInitialRiskGates`,
 * LoanFacet.sol:608-646) re-asserts the maker (standing consent only)
 * and gates the TAKER via `assertAcceptorMayTransact`. A down-tiered /
 * consent-revoked maker or an under-tiered taker therefore reverts
 * `RiskTierTooLow` / `IlliquidPairNotConsented` /
 * `MidTierPairNotAcknowledged` only at the write — after the taker
 * signed and possibly mined an approval — unless it's previewed here.
 *
 * WHY NOT `previewOfferAcceptBlock`: it is offerId-keyed
 * (RiskPreviewFacet.sol:71) and a signed order has no offer id until it
 * materializes mid-fill. Instead this composes the party/pair-keyed
 * views `RiskAccessFacet` exposes for exactly this pre-flight purpose
 * ("Surfaced so the frontend can pre-flight the gate" —
 * RiskAccessFacet.sol:469), which are the SAME primitives
 * `LibRiskAccess.previewActorBlock` (LibRiskAccess.sol:482-500) chains:
 *   - `pairRequiredRiskLevel(pair)`  = `_pairRequiredLevel`;
 *   - `getEffectiveRiskTier(actor)`  = `effectiveTier` (read-time
 *     re-locked: stale terms anchor + raise-cooldown both fold in);
 *   - `hasIlliquidPairConsent(actor, pair)` = `_illiquidConsentEffective`
 *     (set + version-fresh + arming cooldown elapsed);
 *   - `midTierStrictBlocked(actor, pair)`   = `midTierStrictBlock`.
 * The PairId is built from the signed order verbatim — the same fields
 * `toCreateOfferParams` materializes, which both enforcing gates
 * classify against, so preview and gate cannot disagree on the pair.
 *
 * MAKER posture: exact `previewActorBlock` mirror (tier, then standing
 * illiquid consent, then strict-mode mid-tier ack) — both enforcing
 * sites gate the maker standing-consent-only (the creator authors no
 * #662 accept ack).
 *
 * TAKER posture: `assertAcceptorMayTransact` (LibRiskAccess.sol:366)
 * additionally lets the taker's #662 acknowledgement SUBSTITUTE for a
 * standing illiquid-pair consent — but only for legs the gate VERIFIED
 * illiquid via `checkLiquidity` (`_ackCoversIlliquidLegs`'s
 * `*AckVerified` flags, LibRiskAccess.sol:445-470). On THIS flow that
 * substitution can never be the deciding factor: the signed-fill
 * signer (useSignedOfferAcceptTermsSigning) hard-aborts on any
 * checkLiquidity-illiquid leg before signing (the compact confirm has
 * no in-kind-default disclosure surface), so an `IlliquidCustom`-
 * required pair that would reach the write owes its level to a
 * non-checkLiquidity reason (derived tier-0 asset, rental prepay) —
 * exactly the legs the ack is never verified for and standing consent
 * remains mandatory. Requiring the taker's standing consent here is
 * therefore exact for this flow, not a lossy approximation.
 *
 * Gated on `ConfigFacet.getRiskAccessGateEnabled` FIRST
 * (ConfigFacet.sol:1865) — the retail deploy (gate OFF, the deploy
 * default) pays one cheap read and passes through, the same
 * flag-gating posture as the KYC preflight above.
 *
 * Fail postures (matching the KYC preflight): a missing selector
 * PASSES — an older deploy without the gate machinery (or its views)
 * still enforces on-chain; any transport failure fails CLOSED
 * (retrying is free, a wasted signature + approval is not).
 */
export async function assertSignedFillRiskAccessLive(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  /** The order's maker (`order.signer`). */
  maker: `0x${string}`;
  /** The prospective taker (the connected wallet). */
  taker: `0x${string}`;
  lendingAsset: `0x${string}`;
  /** `LibVaipakam.AssetType` ordinal of the lending leg (`order.assetType`). */
  lendingAssetType: number;
  lendingTokenId: bigint;
  collateralAsset: `0x${string}`;
  collateralAssetType: number;
  collateralTokenId: bigint;
  prepayAsset: `0x${string}`;
}): Promise<void> {
  let gateEnabled: boolean;
  try {
    gateEnabled = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getRiskAccessGateEnabled',
    })) as boolean;
  } catch (err) {
    if (isMissingSelectorError(err)) return; // pre-gate deploy — nothing to mirror
    throw new Error(copy.errors.checkRetry);
  }
  if (!gateEnabled) return; // retail default — every enforcing site short-circuits

  // The exact PairId both enforcing gates classify against — the
  // signed order's fields verbatim (`toCreateOfferParams` copies them
  // into the materialized offer unchanged). `pairKey` canonicalizes
  // ERC-20 token ids / unused prepay on-chain, so passing them through
  // is safe for every asset shape.
  const pair = {
    lendAsset: opts.lendingAsset,
    lendType: opts.lendingAssetType,
    lendTokenId: opts.lendingTokenId,
    collAsset: opts.collateralAsset,
    collType: opts.collateralAssetType,
    collTokenId: opts.collateralTokenId,
    prepayAsset: opts.prepayAsset,
  };

  let blocked: boolean;
  try {
    const [required, makerTier, takerTier] = (await Promise.all([
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'pairRequiredRiskLevel',
        args: [pair],
      }),
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getEffectiveRiskTier',
        args: [opts.maker],
      }),
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getEffectiveRiskTier',
        args: [opts.taker],
      }),
    ])) as [number, number, number];

    if (Number(makerTier) < Number(required) || Number(takerTier) < Number(required)) {
      blocked = true; // RiskTierTooLow, either party
    } else if (Number(required) === RISK_LEVEL_ILLIQUID_CUSTOM) {
      // Standing per-pair consent, BOTH parties (taker included — see
      // the header note on why the #662 ack substitution can never
      // decide this flow).
      const [makerConsent, takerConsent] = (await Promise.all([
        opts.publicClient.readContract({
          address: opts.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'hasIlliquidPairConsent',
          args: [opts.maker, pair],
        }),
        opts.publicClient.readContract({
          address: opts.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'hasIlliquidPairConsent',
          args: [opts.taker, pair],
        }),
      ])) as [boolean, boolean];
      blocked = !makerConsent || !takerConsent;
    } else if (Number(required) === RISK_LEVEL_BROAD_LIQUID) {
      // Strict-mode mid-tier ack — the #662 ack does NOT substitute
      // (`assertAcceptorMayTransact`'s non-illiquid branch), so both
      // parties mirror the same view. False for non-strict vaults.
      const [makerStrict, takerStrict] = (await Promise.all([
        opts.publicClient.readContract({
          address: opts.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'midTierStrictBlocked',
          args: [opts.maker, pair],
        }),
        opts.publicClient.readContract({
          address: opts.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'midTierStrictBlocked',
          args: [opts.taker, pair],
        }),
      ])) as [boolean, boolean];
      blocked = makerStrict || takerStrict;
    } else {
      blocked = false; // BlueChipOnly pair — the base tier always covers it
    }
  } catch (err) {
    // The gate flag read TRUE but a view is missing: a partial /
    // pre-#728 deploy — the contract still enforces; pass, like the
    // KYC preflight's missing-getter branch.
    if (isMissingSelectorError(err)) return;
    throw new Error(copy.errors.checkRetry);
  }
  if (blocked) {
    throw new Error(copy.desk.signed.riskBlocked);
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

/**
 * RPC read-diet PR A (design §4.1.2) — BLOCKING click-time preflight
 * for money actions fired straight from a push-finality list row
 * (Positions / OpenOrders cancel and amend). Those rows refresh at
 * push latency rather than tip parity, so a counterparty can consume
 * the offer inside the window and the row stays armed; simulating the
 * exact call first turns that into an inline "this offer just
 * changed" outcome instead of a doomed wallet signature.
 *
 * Posture: a REVERT throws the friendly reason (fail closed — the
 * action would burn gas); transport trouble RETURNS (fail open — the
 * wallet + chain still enforce, and blocking a legitimate cancel on
 * an RPC hiccup would strand the user's own funds behind an outage).
 */
export async function assertRowActionStillValid(opts: {
  publicClient: PublicClient;
  diamond: `0x${string}`;
  account: `0x${string}`;
  functionName: string;
  args: readonly unknown[];
}): Promise<void> {
  try {
    await opts.publicClient.simulateContract({
      address: opts.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: opts.functionName,
      args: opts.args as unknown[],
      account: opts.account,
    });
  } catch (err) {
    // Same revert taxonomy the live-row readers use: only a genuine
    // contract revert blocks; anything transport-shaped passes.
    const revertLike =
      err instanceof BaseError &&
      (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
        err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
    if (revertLike) throw err;
  }
}
