import { useCallback, useEffect, useState } from 'react';
import { parseAbi, type Address } from 'viem';
import { useDiamondPublicClient, useReadyDiamond, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 60_000;
const BASIS_POINTS = 10_000;
/**
 * Fallback when the live `decimals()` read on the VPFI token contract
 * fails (e.g. the address isn't registered on this chain yet, RPC
 * dropped). All Vaipakam VPFI deploys (canonical Base + every mirror)
 * are required to use 18 by the OFT bridge spec, so this fallback is
 * safe — it just means we'll render display values correctly even
 * before the read resolves.
 */
const VPFI_DECIMALS_FALLBACK = 18;
const VPFI_DECIMALS_ABI = parseAbi([
  'function decimals() view returns (uint8)',
]);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Effective (override OR library default) value of every admin-tunable
 * protocol knob. Mirrors the tuple returned by
 * `ConfigFacet.getProtocolConfigBundle` — see
 * {@link contracts/src/facets/ConfigFacet.sol:259}.
 *
 * All BPS fields are integers where `10_000 == 100%`. `apr*Pct` /
 * `*FeePct` are pre-computed decimal fractions (0..1) for convenient
 * use in UI math (e.g. `amount * treasuryFeePct`).
 */
export interface ProtocolConfig {
  /** Treasury's cut of lender interest (default 1%). */
  treasuryFeeBps: number;
  treasuryFeePct: number;
  /** Fee deducted from ERC-20 principal at loan initiation (default 0.1%). */
  loanInitiationFeeBps: number;
  loanInitiationFeePct: number;
  /** Treasury cut on successful DEX liquidation (default 2%). */
  liquidationHandlingFeeBps: number;
  liquidationHandlingFeePct: number;
  /** Ceiling on 0x slippage before falling back to snapshot settlement (default 6%). */
  maxLiquidationSlippageBps: number;
  maxLiquidationSlippagePct: number;
  /** Cap on dynamic liquidator incentive (default 3%). */
  maxLiquidatorIncentiveBps: number;
  maxLiquidatorIncentivePct: number;
  /** LTV above which the loan drops to snapshot settlement (default 110%). */
  volatilityLtvThresholdBps: number;
  volatilityLtvThresholdPct: number;
  /** Safety buffer on NFT rental prepayment (default 5%). */
  rentalBufferBps: number;
  rentalBufferPct: number;
  /** Annualized staking reward on escrow-held VPFI (default 5%). */
  vpfiStakingAprBps: number;
  vpfiStakingAprPct: number;
  /** VPFI tier thresholds (token wei, 18-dec): T1 entry, T2 entry, T3 entry, T4 cutoff. */
  tierThresholds: [bigint, bigint, bigint, bigint];
  /** Same thresholds as {@link tierThresholds} but pre-divided to whole VPFI
   *  tokens for display. Tier thresholds are integer-token-multiples on-chain
   *  (e.g. 100, 1_000, 10_000, 100_000), so this conversion is lossless in
   *  practice. Use this in any UI surface — auto-injected `<CardInfo>`
   *  placeholders, the discount-status card, the tier table — so a wei-
   *  denominated `100000000000000000000000` doesn't render as
   *  "100,000,000,000,000,000,000". */
  tierThresholdsTokens: [number, number, number, number];
  /** Per-tier discount BPS: index 0 = T1, index 3 = T4. */
  tierDiscountBps: [number, number, number, number];
  /** Per-tier discount as a decimal fraction, same index as {@link tierDiscountBps}. */
  tierDiscountPct: [number, number, number, number];
  // ── Compile-time constants from `getProtocolConstants` ─────────────
  /** 1e18-scaled HF floor at loan initiation / cure / withdrawal. */
  minHealthFactor: bigint;
  /** Same as {@link minHealthFactor} but as a display-ready decimal
   *  ("1.5", "1.25"). */
  minHealthFactorDisplay: string;
  /** Hard cap on the staking-rewards pool (wei). */
  vpfiStakingPoolCap: bigint;
  /** Compact "55.2M" / "69M" string for marketing-style display. */
  vpfiStakingPoolCapCompact: string;
  /** Hard cap on the interaction-rewards pool (wei). */
  vpfiInteractionPoolCap: bigint;
  /** Compact display version of {@link vpfiInteractionPoolCap}. */
  vpfiInteractionPoolCapCompact: string;
  /** Max days an interaction-rewards claim walks per tx. */
  maxInteractionClaimDays: number;
  /** VPFI ERC-20 `decimals()` read live from the token contract on the
   *  active chain. All Vaipakam VPFI deploys must use 18 (the OFT bridge
   *  spec requires identical decimals across canonical + mirrors), but
   *  reading at runtime keeps every display path bound to contract
   *  truth rather than a hardcoded constant. Falls back to 18 if the
   *  read fails (no token registered yet, RPC blip). */
  vpfiDecimals: number;
  /** Range Orders Phase 1 master kill-switch flags. All three default
   *  `false` on a fresh deploy. UI gates (range sliders, partial-fill
   *  checkbox, advanced-mode reveals) must consult these so users
   *  never see controls for mechanics governance hasn't enabled. */
  rangeAmountEnabled: boolean;
  rangeRateEnabled: boolean;
  partialFillEnabled: boolean;
  /** Matcher's slice of LIF that flows to treasury, in BPS. Default
   *  100 (1%) but governance-tunable up to 5000 (50%). Frontend
   *  bot-economics copy renders against this so a flag flip
   *  propagates without redeploy. */
  lifMatcherFeeBps: number;
  lifMatcherFeePct: number;
  /** Auto-pause window duration (seconds). Default 1800 (30 min);
   *  governance-tunable via setAutoPauseDurationSeconds within
   *  [300, 7200]. Frontend renders the security disclosure + the
   *  live countdown when AdminFacet.pausedUntil() returns non-zero. */
  autoPauseDurationSeconds: number;
  // ── Depth-tiered LTV (Piece B) ─────────────────────────────────────
  // From `ConfigFacet.getDepthTierConfigBundle` / `getPaaAssets`. While
  // `depthTieredLtvEnabled` is false (the default), the loan-init gate
  // stays today's HF≥1.5 — the rest of these are still meaningful for
  // UI surfaces (the keeper / protocol-console knob registry / the
  // "this asset is Tier N → up to X%" hint on create-offer).
  /** Master kill-switch: when false the init gate ignores the tier
   *  cap entirely (today's HF≥1.5 behaviour). */
  depthTieredLtvEnabled: boolean;
  /** Slippage budget (bps) a simulated test trade must clear to count
   *  toward a tier. Default 200 (2%). */
  liquiditySlippageBps: number;
  liquiditySlippagePct: number;
  /** TWAP-consistency guard window (seconds) and band (bps). Default
   *  1800 / 300 (30 min / 3%). */
  twapWindowSec: number;
  twapConsistencyBps: number;
  twapConsistencyPct: number;
  /** Simulated-swap test sizes in PAD × 1e6 units (so `5000_000_000n`
   *  = "5,000 PAD" — USD on the retail deploy, whatever governance has
   *  rotated PAD to via T-048 otherwise). Defaults: 5k floor / 50k
   *  Tier 1 / 500k Tier 2 / 5M Tier 3. */
  floorSizePad: bigint;
  tier1SizePad: bigint;
  tier2SizePad: bigint;
  tier3SizePad: bigint;
  /** Per-tier max init-LTV caps (bps). Defaults: 5000 / 6000 / 6500. */
  tier1MaxInitLtvBps: number;
  tier2MaxInitLtvBps: number;
  tier3MaxInitLtvBps: number;
  tier1MaxInitLtvPct: number;
  tier2MaxInitLtvPct: number;
  tier3MaxInitLtvPct: number;
  /** Resolved PAA list — the per-chain quote tokens the depth probe
   *  looks at. Empty config resolves to `[wethContract]` on-chain, so
   *  this is always at least 1 entry. */
  paaAssets: readonly Address[];
  fetchedAt: number;
}

interface CacheEntry {
  data: ProtocolConfig;
  at: number;
  key: string;
}

let cached: CacheEntry | null = null;

/**
 * Tuple shape of `ConfigFacet.getDepthTierConfigBundle()` — the 11
 * effective values (override OR library default) for the depth-tiered
 * LTV mechanic. Kept as a separate bundle from {@link BundleTuple} so
 * neither getter's tuple grows unwieldy on the contract side. See
 * `contracts/src/facets/ConfigFacet.sol:getDepthTierConfigBundle`.
 */
type DepthTierBundleTuple = [
  boolean, // depthTieredLtvEnabled
  bigint,  // liquiditySlippageBps
  bigint,  // twapWindowSec
  bigint,  // twapConsistencyBps
  bigint,  // floorSizePad (PAD × 1e6)
  bigint,  // tier1SizePad
  bigint,  // tier2SizePad
  bigint,  // tier3SizePad
  bigint,  // tier1MaxInitLtvBps
  bigint,  // tier2MaxInitLtvBps
  bigint,  // tier3MaxInitLtvBps
];

type BundleTuple = [
  bigint, // treasuryFeeBps
  bigint, // loanInitiationFeeBps
  bigint, // liquidationHandlingFeeBps
  bigint, // maxLiquidationSlippageBps
  bigint, // maxLiquidatorIncentiveBps
  bigint, // volatilityLtvThresholdBps
  bigint, // rentalBufferBps
  bigint, // vpfiStakingAprBps
  [bigint, bigint, bigint, bigint], // tierThresholds
  [bigint, bigint, bigint, bigint], // tierDiscountBps
  // Range Orders Phase 1 master kill-switch flags. All three default
  // `false` on a fresh deploy. Frontend conditionals + Advanced-mode
  // reveals for range sliders / partial-fill checkbox gate on these.
  // See docs/RangeOffersDesign.md §15.
  boolean, // rangeAmountEnabled
  boolean, // rangeRateEnabled
  boolean, // partialFillEnabled
  // Matcher's slice of any LIF that flows to treasury (BPS).
  // Default 100 (1%); governance-tunable via setLifMatcherFeeBps,
  // capped at 5000 (50%). Surfaced so the bot-economics dashboard
  // can render "you earn X% of the LIF" copy without recompiling.
  bigint, // lifMatcherFeeBps
  // Auto-pause window duration (seconds). Default 1800 (30 min);
  // governance-tunable via setAutoPauseDurationSeconds within
  // [300, 7200] (5 min – 2h). Frontend renders the security
  // disclosure + the live countdown when an auto-pause is active.
  bigint, // autoPauseDurationSeconds
];

function bpsToPct(bps: bigint | number): number {
  return Number(bps) / BASIS_POINTS;
}

/**
 * Format a basis-points value as a percentage string suitable for i18n
 * `{{placeholder}}` interpolation. 100 → "1", 10 → "0.1", 1500 → "15",
 * 575 → "5.75". Whole-percent values render without decimals; the
 * trailing zero on round fractional values is stripped (1050 → "10.5").
 *
 * NOTE: takes BPS not the decimal-fraction `*Pct` field.
 */
export function bpsToPctString(bps: bigint | number): string {
  const b = typeof bps === 'bigint' ? bps : BigInt(bps);
  if (b % 100n === 0n) return (b / 100n).toString();
  return (Number(b) / 100).toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Format a wei amount as a compact "55.2M" / "69M" / "1.2k" string
 * for VPFI pool-cap displays in marketing-style copy. `decimals`
 * defaults to 18 (the only value Vaipakam VPFI ever uses on-chain)
 * but is parameterized so callers with the live `vpfiDecimals` from
 * `useProtocolConfig` can pass it explicitly.
 */
export function vpfiCapToCompact(weiAmount: bigint, decimals: number = VPFI_DECIMALS_FALLBACK): string {
  const whole = Number(weiAmount / 10n ** BigInt(decimals));
  if (whole >= 1_000_000) {
    const m = whole / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (whole >= 1_000) {
    const k = whole / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return whole.toString();
}

/** Format 1e18-scaled HF as a decimal string ("1.5", "1.25"). HF is a
 *  protocol-internal scalar, not a token amount — it's always 1e18-
 *  scaled by spec, regardless of any token's decimals. */
export function hfToDisplay(hf18: bigint): string {
  const n = Number(hf18) / 1e18;
  return n % 1 === 0 ? n.toString() : n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Read-only view of the protocol's admin-configurable parameter surface.
 * Resolves every knob to its **effective** value — when admin hasn't
 * overridden a field, the on-chain getter falls back to the library
 * default, so the UI never has to duplicate default values.
 *
 * Cached module-scope (keyed by chainId + diamond address) for
 * {@link STALE_MS} so every fee hint / tier row on a page shares one RPC
 * roundtrip.
 */
export function useProtocolConfig() {
  const diamond = useReadyDiamond();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}`;

  const [config, setConfig] = useState<ProtocolConfig | null>(() =>
    cached && cached.key === cacheKey ? cached.data : null,
  );
  const [loading, setLoading] = useState(!(cached && cached.key === cacheKey));
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setConfig(cached.data);
      setLoading(false);
      return;
    }
    // useReadyDiamond returns null when chain.diamondAddress is null.
    // Bail before firing the contract call against ZERO_ADDRESS.
    if (!diamond) {
      setConfig(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'config',
      flow: 'useProtocolConfig',
      step: 'getProtocolConfigBundle',
    });
    try {
      const d = diamond as unknown as {
        getProtocolConfigBundle: () => Promise<BundleTuple>;
        getProtocolConstants: () => Promise<[bigint, bigint, bigint, bigint]>;
        getVPFIToken: () => Promise<string>;
        getDepthTierConfigBundle: () => Promise<DepthTierBundleTuple>;
        getPaaAssets: () => Promise<readonly Address[]>;
      };
      // Fetch the governance bundle, the compile-time constants, the
      // registered VPFI token address, and the depth-tier surface
      // (Piece B — bundle + PAA list) in parallel. All feed the same
      // `ProtocolConfig` shape so consumers don't have to thread
      // multiple hooks. Each non-essential view degrades to a safe
      // default if missing on an older deploy: constants → library
      // defaults; depth-tier bundle → "feature off + library
      // defaults"; PAA list → empty.
      const [tuple, consts, vpfiTokenAddr, depthBundle, paaAssets] = await Promise.all([
        d.getProtocolConfigBundle(),
        d.getProtocolConstants().catch(() => [
          1500000000000000000n, // MIN_HEALTH_FACTOR default 1.5e18
          55_200_000n * 10n ** 18n,
          69_000_000n * 10n ** 18n,
          30n,
        ] as [bigint, bigint, bigint, bigint]),
        d.getVPFIToken().catch(() => ZERO_ADDRESS),
        d.getDepthTierConfigBundle().catch(
          () => [false, 200n, 1800n, 300n, 5_000_000_000n, 50_000_000_000n, 500_000_000_000n, 5_000_000_000_000n, 5000n, 6000n, 6500n] as DepthTierBundleTuple,
        ),
        d.getPaaAssets().catch(() => [] as readonly Address[]),
      ]);

      // Live `decimals()` read on the VPFI token contract. Done as a
      // sequenced second-phase fetch since we need the address from
      // `getVPFIToken()` first. Falls back to 18 if the token isn't
      // registered or the read fails — matches the contract source
      // (every Vaipakam VPFI deploy is 18-decimal by OFT-mesh
      // requirement) so display paths render correctly while the
      // read is in flight or after a transient failure.
      let vpfiDecimals: number = VPFI_DECIMALS_FALLBACK;
      if (
        vpfiTokenAddr &&
        vpfiTokenAddr !== ZERO_ADDRESS &&
        /^0x[0-9a-fA-F]{40}$/.test(vpfiTokenAddr)
      ) {
        try {
          const decRaw = await publicClient.readContract({
            address: vpfiTokenAddr as Address,
            abi: VPFI_DECIMALS_ABI,
            functionName: 'decimals',
          });
          vpfiDecimals = Number(decRaw);
        } catch {
          // Swallow — fallback already in place.
        }
      }
      const decScale = 10n ** BigInt(vpfiDecimals);
      const [
        treasuryFeeBps,
        loanInitiationFeeBps,
        liquidationHandlingFeeBps,
        maxLiquidationSlippageBps,
        maxLiquidatorIncentiveBps,
        volatilityLtvThresholdBps,
        rentalBufferBps,
        vpfiStakingAprBps,
        tierThresholds,
        tierDiscountBps,
        rangeAmountEnabled,
        rangeRateEnabled,
        partialFillEnabled,
        lifMatcherFeeBps,
        autoPauseDurationSeconds,
      ] = tuple;
      const [minHealthFactor, vpfiStakingPoolCap, vpfiInteractionPoolCap, maxInteractionClaimDays] = consts;
      const [
        depthTieredLtvEnabled,
        liquiditySlippageBps,
        twapWindowSec,
        twapConsistencyBps,
        floorSizePad,
        tier1SizePad,
        tier2SizePad,
        tier3SizePad,
        tier1MaxInitLtvBps,
        tier2MaxInitLtvBps,
        tier3MaxInitLtvBps,
      ] = depthBundle;

      const next: ProtocolConfig = {
        treasuryFeeBps: Number(treasuryFeeBps),
        treasuryFeePct: bpsToPct(treasuryFeeBps),
        loanInitiationFeeBps: Number(loanInitiationFeeBps),
        loanInitiationFeePct: bpsToPct(loanInitiationFeeBps),
        liquidationHandlingFeeBps: Number(liquidationHandlingFeeBps),
        liquidationHandlingFeePct: bpsToPct(liquidationHandlingFeeBps),
        maxLiquidationSlippageBps: Number(maxLiquidationSlippageBps),
        maxLiquidationSlippagePct: bpsToPct(maxLiquidationSlippageBps),
        maxLiquidatorIncentiveBps: Number(maxLiquidatorIncentiveBps),
        maxLiquidatorIncentivePct: bpsToPct(maxLiquidatorIncentiveBps),
        volatilityLtvThresholdBps: Number(volatilityLtvThresholdBps),
        volatilityLtvThresholdPct: bpsToPct(volatilityLtvThresholdBps),
        rentalBufferBps: Number(rentalBufferBps),
        rentalBufferPct: bpsToPct(rentalBufferBps),
        vpfiStakingAprBps: Number(vpfiStakingAprBps),
        vpfiStakingAprPct: bpsToPct(vpfiStakingAprBps),
        tierThresholds: [
          tierThresholds[0],
          tierThresholds[1],
          tierThresholds[2],
          tierThresholds[3],
        ],
        // Pre-divide to whole tokens for display. Bigint divide first
        // (lossless) before Number cast — `Number(100_000n * 10n**18n)`
        // would silently round at 2^53. Uses the live `vpfiDecimals`
        // read from the VPFI token contract above, falling back to 18
        // if the read failed.
        tierThresholdsTokens: [
          Number(tierThresholds[0] / decScale),
          Number(tierThresholds[1] / decScale),
          Number(tierThresholds[2] / decScale),
          Number(tierThresholds[3] / decScale),
        ],
        tierDiscountBps: [
          Number(tierDiscountBps[0]),
          Number(tierDiscountBps[1]),
          Number(tierDiscountBps[2]),
          Number(tierDiscountBps[3]),
        ],
        tierDiscountPct: [
          bpsToPct(tierDiscountBps[0]),
          bpsToPct(tierDiscountBps[1]),
          bpsToPct(tierDiscountBps[2]),
          bpsToPct(tierDiscountBps[3]),
        ],
        minHealthFactor,
        minHealthFactorDisplay: hfToDisplay(minHealthFactor),
        vpfiStakingPoolCap,
        vpfiStakingPoolCapCompact: vpfiCapToCompact(vpfiStakingPoolCap, vpfiDecimals),
        vpfiInteractionPoolCap,
        vpfiInteractionPoolCapCompact: vpfiCapToCompact(vpfiInteractionPoolCap, vpfiDecimals),
        maxInteractionClaimDays: Number(maxInteractionClaimDays),
        vpfiDecimals,
        rangeAmountEnabled,
        rangeRateEnabled,
        partialFillEnabled,
        lifMatcherFeeBps: Number(lifMatcherFeeBps),
        lifMatcherFeePct: bpsToPct(lifMatcherFeeBps),
        autoPauseDurationSeconds: Number(autoPauseDurationSeconds),
        depthTieredLtvEnabled,
        liquiditySlippageBps: Number(liquiditySlippageBps),
        liquiditySlippagePct: bpsToPct(liquiditySlippageBps),
        twapWindowSec: Number(twapWindowSec),
        twapConsistencyBps: Number(twapConsistencyBps),
        twapConsistencyPct: bpsToPct(twapConsistencyBps),
        floorSizePad,
        tier1SizePad,
        tier2SizePad,
        tier3SizePad,
        tier1MaxInitLtvBps: Number(tier1MaxInitLtvBps),
        tier2MaxInitLtvBps: Number(tier2MaxInitLtvBps),
        tier3MaxInitLtvBps: Number(tier3MaxInitLtvBps),
        tier1MaxInitLtvPct: bpsToPct(tier1MaxInitLtvBps),
        tier2MaxInitLtvPct: bpsToPct(tier2MaxInitLtvBps),
        tier3MaxInitLtvPct: bpsToPct(tier3MaxInitLtvBps),
        paaAssets,
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now(), key: cacheKey };
      setConfig(next);
      step.success({
        note:
          `treasury=${next.treasuryFeeBps}bps, ` +
          `stakingApr=${next.vpfiStakingAprBps}bps, ` +
          `tiers=[${next.tierDiscountBps.join(',')}]`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  return { config, loading, error, reload };
}
