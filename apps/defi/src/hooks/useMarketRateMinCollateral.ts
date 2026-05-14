import { useEffect, useMemo, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';
import { useAssetTier } from './useAssetTier';
import { useProtocolConfig } from './useProtocolConfig';

/**
 * Computes the smallest collateral that clears the on-chain loan-init
 * gate for a given lending asset + amount + collateral asset, as a
 * human-readable decimal string ready for the Create Offer collateral
 * input. Powers the "Lend / Borrow at market rate" widget's auto-fill
 * (the widget then deep-links to Create Offer with this value prefilled;
 * Create Offer re-validates and blocks decreasing below it).
 *
 * Two regimes, matching the on-chain `LoanFacet._checkInitialLtvAndHf`:
 *
 *   • OFF (`depthTieredLtvEnabled = false`, the default): the
 *     classic gate — `LTV ≤ maxLtvBps` AND `HF ≥ MIN_HEALTH_FACTOR`
 *     (1.5). The HF floor is typically binding (since
 *     `liqThresholdBps/1.5 < maxLtvBps` for typical params), so the
 *     min-collateral math inverts the HF formula:
 *
 *        minCollateralUSD = debtUSD × 1.5 / (liqThresholdBps/10000)
 *
 *   • ON (`depthTieredLtvEnabled = true`, post-flip per chain): the
 *     binding gate becomes a per-tier LTV cap with the HF floor
 *     relaxed to ≥ 1.0:
 *
 *        cap              = min(maxLtvBps, tierMaxInitLtvBps[tier])
 *        minByLtvCap      = debtUSD / (cap/10000)
 *        minByHfRelaxed   = debtUSD × 1.0 / (liqThresholdBps/10000)
 *        minCollateralUSD = max(minByLtvCap, minByHfRelaxed)
 *
 *     With the usual `maxLtvBps ≤ liqThresholdBps` invariant the
 *     tier cap is the binding constraint and the HF=1 term is just a
 *     defensive lower bound for unusual parameter regimes.
 *
 * Reads `OracleFacet.getAssetPrice` for both legs, the collateral's
 * `getAssetRiskProfile().{isSupported, maxLtvBps, liqThresholdBps}`,
 * the protocol-config bundle (kill-switch + per-tier LTV caps), and
 * the per-asset effective tier via `useAssetTier`. The buffer is a
 * small cushion so a user who takes the suggested value doesn't land
 * exactly on the boundary and revert from oracle rounding / a price
 * tick between preview and submit.
 *
 * Returns `collateralUnsupported: true` (and `minCollateral: null`) when
 * the collateral asset has no oracle / risk-profile entry — i.e. it's
 * illiquid: the minimum can't be computed, and the widget should route
 * to manual Create Offer with a "set terms yourself" warning rather
 * than disabling the button.
 */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** 0.5% extra on the auto-filled minimum — see the doc comment above. */
const MIN_COLLATERAL_BUFFER_BPS = 50;

interface PriceSnapshot {
  raw: bigint;
  decimals: number;
  /** Convenience float — `raw / 10**decimals`. */
  usd: number;
}

export interface MarketRateCollateralResult {
  /** Smallest collateral satisfying the on-chain loan-init gate for
   *  the typed lending amount, as a decimal string; `null` until
   *  inputs + oracle data are ready, or when the pair isn't priceable. */
  minCollateral: string | null;
  lendingPriceUsd: number | null;
  collateralPriceUsd: number | null;
  /** The collateral asset's `liqThresholdBps`, or `null`. */
  liqThresholdBps: number | null;
  /** The on-chain HF floor at loan init, as a float — `1.5` in the
   *  legacy regime (`depthTieredLtvEnabled = false`); relaxed to
   *  `1.0` when the kill-switch is on (the tier cap is the binding
   *  buffer in that regime). Defaults to 1.5 if the protocol config
   *  isn't loaded yet. */
  minHealthFactor: number;
  /** The effective init-LTV ceiling actually applied (BPS). In the
   *  legacy regime this is just `maxLtvBps`; under the tier regime
   *  it's `min(maxLtvBps, tierMaxInitLtvBps[tier])`. `null` while
   *  the tier read is in flight. */
  effectiveLtvCapBps: number | null;
  /** Whether the on-chain depth-tiered-LTV master kill-switch is
   *  flipped on this chain (mirrors `ProtocolConfig.depthTieredLtvEnabled`). */
  depthTieredLtvEnabled: boolean;
  loading: boolean;
  error: string | null;
  /** Collateral asset has no oracle / risk-profile entry (illiquid). */
  collateralUnsupported: boolean;
}

export function useMarketRateMinCollateral({
  lendingAsset,
  collateralAsset,
  lendingAmount,
}: {
  lendingAsset: string | null;
  collateralAsset: string | null;
  /** User-typed lending amount (decimal string). */
  lendingAmount: string;
}): MarketRateCollateralResult {
  const diamondRead = useDiamondRead();
  const { config } = useProtocolConfig();
  const tierStatus = useAssetTier(collateralAsset);
  const depthTieredLtvEnabled = !!config?.depthTieredLtvEnabled;
  // Under the tier-mode regime the binding HF floor on-chain is 1.0
  // (the tier cap supplies the safety buffer). Pre-flip the floor
  // stays at 1.5 (today's behaviour). Defaults to 1.5 while the
  // config is still loading.
  const minHealthFactor = depthTieredLtvEnabled
    ? 1
    : config && config.minHealthFactor > 0n
      ? Number(config.minHealthFactor) / 1e18
      : 1.5;

  const haveAddrs =
    !!lendingAsset &&
    !!collateralAsset &&
    ADDR_RE.test(lendingAsset) &&
    ADDR_RE.test(collateralAsset);

  const [data, setData] = useState<{
    lendingPrice: PriceSnapshot;
    collateralPrice: PriceSnapshot;
    /** Per-asset hard LTV cap from `getAssetRiskProfile`. Always
     *  applies — the on-chain init gate uses
     *  `min(maxLtvBps, tierMaxInitLtvBps[tier])` under the tier
     *  regime, just `maxLtvBps` in the legacy regime. */
    maxLtvBps: number;
    liqThresholdBps: number;
    isSupported: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!haveAddrs) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [lp, cp, rp] = await Promise.all([
          diamondRead.getAssetPrice(lendingAsset),
          diamondRead.getAssetPrice(collateralAsset),
          diamondRead.getAssetRiskProfile(collateralAsset),
        ]);
        const decode = (res: unknown): PriceSnapshot => {
          let price: bigint;
          let dec: number;
          if (Array.isArray(res)) {
            price = res[0] as bigint;
            dec = Number(res[1]);
          } else {
            const r = res as { price?: bigint; decimals?: number };
            price = r.price ?? 0n;
            dec = Number(r.decimals ?? 8);
          }
          return { raw: price, decimals: dec, usd: Number(price) / 10 ** dec };
        };
        // `getAssetRiskProfile(asset)` returns
        // `(isSupported, status, maxLtvBps, liqThresholdBps, liqBonusBps)`.
        // We need the first, third and fourth fields here. The viem
        // decoder gives us either a tuple (`Array.isArray(rp)` true)
        // or a named-record shape depending on the registered ABI.
        const profile = Array.isArray(rp)
          ? {
              isSupported: Boolean(rp[0]),
              maxLtvBps: Number(rp[2]),
              liqThresholdBps: Number(rp[3]),
            }
          : (rp as {
              isSupported: boolean;
              maxLtvBps: bigint | number;
              liqThresholdBps: bigint | number;
            });
        if (cancelled) return;
        setData({
          lendingPrice: decode(lp),
          collateralPrice: decode(cp),
          maxLtvBps: Number(
            (profile as { maxLtvBps: bigint | number }).maxLtvBps,
          ),
          liqThresholdBps: Number(
            (profile as { liqThresholdBps: bigint | number }).liqThresholdBps,
          ),
          isSupported: Boolean(
            (profile as { isSupported: boolean }).isSupported,
          ),
        });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setData(null);
        setError(
          err instanceof Error
            ? err.message
            : 'Oracle / risk-profile unavailable.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [haveAddrs, diamondRead, lendingAsset, collateralAsset]);

  // Resolve the effective LTV cap (BPS). Under the tier regime
  // it's `min(maxLtvBps, tierMaxInitLtvBps[effectiveTier])`; under
  // the legacy regime it's just `maxLtvBps`. Returns null while
  // the tier read is in flight (tier-mode only).
  const effectiveLtvCapBps = useMemo<number | null>(() => {
    if (!data) return null;
    if (!depthTieredLtvEnabled) return data.maxLtvBps;
    if (tierStatus === 'loading' || tierStatus === 'unknown') return null;
    if (tierStatus === 0) return 0; // untierable ⇒ no borrow
    const tier = tierStatus;
    const tierCap =
      tier === 1
        ? (config?.tier1MaxInitLtvBps ?? 0)
        : tier === 2
          ? (config?.tier2MaxInitLtvBps ?? 0)
          : (config?.tier3MaxInitLtvBps ?? 0);
    if (tierCap <= 0) return null; // config still loading
    return Math.min(data.maxLtvBps, tierCap);
  }, [data, depthTieredLtvEnabled, tierStatus, config]);

  const minCollateral = useMemo<string | null>(() => {
    if (!data) return null;
    const debt = Number(lendingAmount);
    if (!isFinite(debt) || debt <= 0) return null;
    if (
      data.liqThresholdBps <= 0 ||
      data.collateralPrice.usd <= 0 ||
      data.lendingPrice.usd <= 0
    ) {
      return null;
    }
    const debtUsd = debt * data.lendingPrice.usd;
    // HF-floor leg: `collateralUSD ≥ debtUSD × minHF / (liqThreshold/10000)`
    // — applies in BOTH regimes, with `minHealthFactor` already
    // resolved to 1.0 or 1.5 depending on the kill-switch state.
    const minByHfUsd = (debtUsd * minHealthFactor) / (data.liqThresholdBps / 1e4);
    // LTV-cap leg: `collateralUSD ≥ debtUSD / (cap/10000)`. Only
    // computable once we have the resolved cap (waits for tier read
    // in tier mode). Tier 0 (cap=0) means no borrow at all — return
    // null and let the caller surface the "this collateral is
    // untierable" message.
    let minByLtvUsd = 0;
    if (effectiveLtvCapBps !== null) {
      if (effectiveLtvCapBps === 0) return null; // Tier 0 ⇒ no borrow
      minByLtvUsd = debtUsd / (effectiveLtvCapBps / 1e4);
    } else if (depthTieredLtvEnabled) {
      // Tier mode is on but the cap isn't resolved yet ⇒ defer the
      // suggestion. Showing a HF-only value would mis-represent the
      // binding gate.
      return null;
    }
    const minCollateralUsd = Math.max(minByHfUsd, minByLtvUsd);
    const buffered = minCollateralUsd * (1 + MIN_COLLATERAL_BUFFER_BPS / 1e4);
    const collateralTokens = buffered / data.collateralPrice.usd;
    if (!isFinite(collateralTokens) || collateralTokens <= 0) return null;
    // Round UP to a sensible precision so we never suggest a value a
    // hair under the gate. Precision scales with magnitude.
    const decimals = collateralTokens >= 1 ? 4 : 8;
    const factor = 10 ** decimals;
    return (Math.ceil(collateralTokens * factor) / factor).toString();
  }, [
    data,
    lendingAmount,
    minHealthFactor,
    effectiveLtvCapBps,
    depthTieredLtvEnabled,
  ]);

  return {
    minCollateral,
    lendingPriceUsd: data?.lendingPrice.usd ?? null,
    collateralPriceUsd: data?.collateralPrice.usd ?? null,
    liqThresholdBps: data?.liqThresholdBps ?? null,
    minHealthFactor,
    effectiveLtvCapBps,
    depthTieredLtvEnabled,
    loading,
    error,
    collateralUnsupported: data ? !data.isSupported : false,
  };
}
