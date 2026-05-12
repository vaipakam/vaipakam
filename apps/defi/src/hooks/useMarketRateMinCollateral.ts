import { useEffect, useMemo, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';
import { useProtocolConfig } from './useProtocolConfig';

/**
 * Computes the smallest collateral that clears the on-chain loan-init
 * gate (`HF ≥ MIN_HEALTH_FACTOR`, ~1.5) for a given lending asset +
 * amount + collateral asset, as a human-readable decimal string ready
 * for the Create Offer collateral input. Powers the "Lend / Borrow at
 * market rate" widget's auto-fill (the widget then deep-links to Create
 * Offer with this value prefilled; Create Offer re-validates and blocks
 * decreasing below it).
 *
 * The math mirrors `OfferRiskPreview`'s preview, inverted: that shows
 * `HF = collateralUSD × liqThresholdBps/10000 / debtUSD`; here we solve
 * for `collateral` at `HF = minHealthFactor`:
 *
 *    minCollateralUSD = debtUSD × minHealthFactor / (liqThresholdBps/10000)
 *    minCollateral    = minCollateralUSD / collateralPriceUSD × (1 + buffer)
 *
 * Reads `OracleFacet.getAssetPrice` for both legs and the collateral's
 * `getAssetRiskProfile().{isSupported, liqThresholdBps}`; pulls
 * `MIN_HEALTH_FACTOR` from `useProtocolConfig`. The buffer is a small
 * cushion so a user who takes the suggested value doesn't land exactly
 * on the HF≥1.5 boundary and revert from oracle rounding / a price tick
 * between preview and submit.
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
  /** Smallest collateral satisfying `HF ≥ minHealthFactor` for the
   *  typed lending amount, as a decimal string; `null` until inputs +
   *  oracle data are ready, or when the pair isn't priceable. */
  minCollateral: string | null;
  lendingPriceUsd: number | null;
  collateralPriceUsd: number | null;
  /** The collateral asset's `liqThresholdBps`, or `null`. */
  liqThresholdBps: number | null;
  /** The on-chain HF floor at loan init (`MIN_HEALTH_FACTOR`), as a
   *  float — defaults to 1.5 if the protocol config isn't loaded yet. */
  minHealthFactor: number;
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
  const minHealthFactor =
    config && config.minHealthFactor > 0n
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
        const profile = Array.isArray(rp)
          ? { isSupported: Boolean(rp[0]), liqThresholdBps: Number(rp[3]) }
          : (rp as { isSupported: boolean; liqThresholdBps: bigint | number });
        if (cancelled) return;
        setData({
          lendingPrice: decode(lp),
          collateralPrice: decode(cp),
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
    const minCollateralUsd =
      (debtUsd * minHealthFactor) / (data.liqThresholdBps / 1e4);
    const buffered = minCollateralUsd * (1 + MIN_COLLATERAL_BUFFER_BPS / 1e4);
    const collateralTokens = buffered / data.collateralPrice.usd;
    if (!isFinite(collateralTokens) || collateralTokens <= 0) return null;
    // Round UP to a sensible precision so we never suggest a value a
    // hair under the gate. Precision scales with magnitude.
    const decimals = collateralTokens >= 1 ? 4 : 8;
    const factor = 10 ** decimals;
    return (Math.ceil(collateralTokens * factor) / factor).toString();
  }, [data, lendingAmount, minHealthFactor]);

  return {
    minCollateral,
    lendingPriceUsd: data?.lendingPrice.usd ?? null,
    collateralPriceUsd: data?.collateralPrice.usd ?? null,
    liqThresholdBps: data?.liqThresholdBps ?? null,
    minHealthFactor,
    loading,
    error,
    collateralUnsupported: data ? !data.isSupported : false,
  };
}
