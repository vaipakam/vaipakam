import { useEffect, useMemo, useState } from 'react';
import { useDiamondRead } from '../../contracts/useDiamond';
import { HealthFactorGauge, LTVBar } from './RiskGauge';

/**
 * Offer-creation risk preview. Pure UI math — given the user's typed
 * lending and collateral amounts (or a [min, max] range), reads
 * `OracleFacet.getAssetPrice` for both legs and the collateral's
 * `getAssetRiskProfile().liqThresholdBps` then computes:
 *
 *    LTV_bps = debtUSD / collateralUSD * 10000
 *    HF      = (collateralUSD * liqThresholdBps / 10000) / debtUSD   [scaled to 1e18]
 *
 * For range-amount offers the worst case (lowest HF / highest LTV) sits
 * at `amountMax`; the best case sits at `amountMin`. Both bars render
 * with CSS transitions so dragging the linked sliders animates the
 * change.
 *
 * The card includes two-way bound sliders that mirror the form's
 * number inputs — dragging them updates form state via the
 * `onAmountMinChange` / `onAmountMaxChange` / `onCollateralAmountChange`
 * setters. Slider bounds re-anchor around `2 ×` the current value, so
 * the user can wiggle freely around whatever they typed.
 *
 * Bails gracefully when:
 *  - either leg isn't an ERC-20 (NFT loans don't have a meaningful HF),
 *  - the collateral asset has no oracle / no risk-profile entry, or
 *  - the user hasn't typed enough numeric input to compute a value.
 */
interface OfferRiskPreviewProps {
  lendingAsset: string;
  collateralAsset: string;
  amountMin: string;
  /** Empty string → single-value mode (preview uses amountMin only). */
  amountMax: string;
  collateralAmount: string;
  lendingAssetType: string;
  collateralAssetType: string;
  /** Render the upper-bound `amountMax` slider. Driven from the same
   *  governance-flag + Advanced-mode gate that shows the upper-bound
   *  text input above. */
  showAmountRange: boolean;
  onAmountMinChange: (v: string) => void;
  onAmountMaxChange: (v: string) => void;
  onCollateralAmountChange: (v: string) => void;
}

interface PriceSnapshot {
  raw: bigint;
  decimals: number;
  /** Convenience float — `raw / 10**decimals`. */
  usd: number;
}

interface RiskInputs {
  lendingPrice: PriceSnapshot;
  collateralPrice: PriceSnapshot;
  liqThresholdBps: number;
  isLiquidCollateral: boolean;
}

export function OfferRiskPreview({
  lendingAsset,
  collateralAsset,
  amountMin,
  amountMax,
  collateralAmount,
  lendingAssetType,
  collateralAssetType,
  showAmountRange,
  onAmountMinChange,
  onAmountMaxChange,
  onCollateralAmountChange,
}: OfferRiskPreviewProps) {
  const diamondRead = useDiamondRead();
  const [risk, setRisk] = useState<RiskInputs | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const bothErc20 =
    lendingAssetType === 'erc20' && collateralAssetType === 'erc20';
  const haveAddrs =
    /^0x[0-9a-fA-F]{40}$/.test(lendingAsset) &&
    /^0x[0-9a-fA-F]{40}$/.test(collateralAsset);
  const enabled = bothErc20 && haveAddrs;

  useEffect(() => {
    if (!enabled) {
      setRisk(null);
      setLoadErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [lendingRes, collateralRes, riskProfile] = await Promise.all([
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
          return {
            raw: price,
            decimals: dec,
            usd: Number(price) / 10 ** dec,
          };
        };
        const profile = Array.isArray(riskProfile)
          ? {
              isSupported: riskProfile[0] as boolean,
              liqThresholdBps: Number(riskProfile[3]),
            }
          : (riskProfile as {
              isSupported: boolean;
              liqThresholdBps: bigint | number;
            });
        const liqBps = Number(
          (profile as { liqThresholdBps: bigint | number }).liqThresholdBps,
        );
        if (cancelled) return;
        setRisk({
          lendingPrice: decode(lendingRes),
          collateralPrice: decode(collateralRes),
          liqThresholdBps: liqBps,
          isLiquidCollateral: Boolean(
            (profile as { isSupported: boolean }).isSupported,
          ),
        });
        setLoadErr(null);
      } catch (err) {
        if (cancelled) return;
        setRisk(null);
        setLoadErr(
          err instanceof Error
            ? err.message
            : 'Oracle / risk-profile unavailable.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, diamondRead, lendingAsset, collateralAsset]);

  const projection = useMemo(() => {
    if (!risk) return null;
    if (risk.liqThresholdBps === 0) return null;
    const minLending = parseFloatSafe(amountMin);
    const maxLending =
      amountMax.trim() === '' ? minLending : parseFloatSafe(amountMax);
    const collFloat = parseFloatSafe(collateralAmount);
    if (
      minLending <= 0 ||
      maxLending <= 0 ||
      collFloat <= 0 ||
      risk.lendingPrice.usd <= 0 ||
      risk.collateralPrice.usd <= 0
    ) {
      return null;
    }
    const collateralUsd = collFloat * risk.collateralPrice.usd;
    const debtUsdMin = minLending * risk.lendingPrice.usd;
    const debtUsdMax = maxLending * risk.lendingPrice.usd;
    const liqMul = risk.liqThresholdBps / 10000;
    const hfBest = (collateralUsd * liqMul) / debtUsdMin;
    const hfWorst = (collateralUsd * liqMul) / debtUsdMax;
    const ltvBest = (debtUsdMin / collateralUsd) * 100;
    const ltvWorst = (debtUsdMax / collateralUsd) * 100;
    const isRange = Math.abs(maxLending - minLending) > 1e-12;
    const dropToLiq =
      hfWorst > 0 ? Math.max(0, (1 - 1 / hfWorst) * 100) : 0;
    return {
      hfBest,
      hfWorst,
      ltvBest,
      ltvWorst,
      isRange,
      dropToLiq,
      collateralUsd,
      debtUsdMin,
      debtUsdMax,
    };
  }, [risk, amountMin, amountMax, collateralAmount]);

  if (!enabled) {
    return null;
  }

  if (loadErr) {
    return (
      <div
        className="card"
        style={{
          marginTop: 12,
          borderLeft: '4px solid var(--accent-orange, #f59e0b)',
        }}
      >
        <div className="card-title">Risk preview</div>
        <div className="data-row">
          <span
            className="data-value"
            style={{ fontSize: '0.82rem', opacity: 0.75 }}
          >
            Oracle or risk-profile unavailable for this asset pair — HF/LTV
            preview off. The on-chain `LoanFacet.initiateLoan` HF check
            still gates loan creation.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{ marginTop: 12, borderLeft: '4px solid var(--brand)' }}
    >
      <div className="card-title">Risk preview</div>

      {projection ? (
        <>
          <div className="data-row" style={{ alignItems: 'center' }}>
            <span className="data-label">
              Health Factor{projection.isRange ? ' (range)' : ''}
            </span>
            <span
              className="data-value"
              style={{ display: 'flex', gap: 12, alignItems: 'center' }}
            >
              {projection.isRange ? (
                <>
                  <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                    worst
                  </span>
                  <HealthFactorGauge value={projection.hfWorst} />
                  <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                    best
                  </span>
                  <HealthFactorGauge value={projection.hfBest} />
                </>
              ) : (
                <HealthFactorGauge value={projection.hfBest} />
              )}
            </span>
          </div>

          <div className="data-row" style={{ alignItems: 'center' }}>
            <span className="data-label">
              LTV{projection.isRange ? ' (range)' : ''}
            </span>
            <span
              className="data-value"
              style={{ display: 'flex', gap: 12, alignItems: 'center' }}
            >
              {projection.isRange ? (
                <>
                  <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                    best
                  </span>
                  <LTVBar percent={projection.ltvBest} />
                  <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                    worst
                  </span>
                  <LTVBar percent={projection.ltvWorst} />
                </>
              ) : (
                <LTVBar percent={projection.ltvBest} />
              )}
            </span>
          </div>

          {projection.hfWorst < 1.5 && (
            <div className="data-row">
              <span
                className="data-value"
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--accent-orange, #f59e0b)',
                }}
              >
                ⚠ Worst-case HF is below 1.5 — at the upper end of the
                range, `initiateLoan` would revert with `HFTooLow`. Add
                collateral or tighten the amount ceiling.
              </span>
            </div>
          )}

          <div className="data-row">
            <span className="data-label">Collateral can drop</span>
            <span className="data-value" style={{ fontSize: '0.85rem' }}>
              <strong>{projection.dropToLiq.toFixed(1)}%</strong>
              <span style={{ opacity: 0.7, marginLeft: 6 }}>
                (worst case) before liquidation
              </span>
            </span>
          </div>
        </>
      ) : (
        <div className="data-row">
          <span
            className="data-value"
            style={{ fontSize: '0.82rem', opacity: 0.7 }}
          >
            Enter lending and collateral amounts above (or drag the
            sliders) to see the projected Health Factor and LTV.
          </span>
        </div>
      )}

      {/* Two-way bound sliders. Bounds re-anchor at 2× the current
          form value so the user can wiggle freely around whatever
          they typed. Setting a value via the slider also bumps the
          number input above (one form-state source of truth). */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={{ fontSize: '0.82rem', opacity: 0.8, marginBottom: 8 }}>
          Adjust amounts
        </div>

        <SliderRow
          label={showAmountRange ? 'Lending amount (min)' : 'Lending amount'}
          value={amountMin}
          onChange={onAmountMinChange}
        />
        {showAmountRange && (
          <SliderRow
            label="Lending amount (max)"
            value={amountMax}
            onChange={onAmountMaxChange}
            anchorFallback={amountMin}
          />
        )}
        <SliderRow
          label="Collateral amount"
          value={collateralAmount}
          onChange={onCollateralAmountChange}
        />
      </div>

      <div
        style={{
          marginTop: 8,
          fontSize: '0.72rem',
          opacity: 0.6,
        }}
      >
        Live oracle prices and the collateral asset's liquidation
        threshold ({((risk?.liqThresholdBps ?? 0) / 100).toFixed(1)}%).
        The on-chain HF floor at loan init is 1.5; offers whose worst
        case dips below that will only fill at lower amounts.
      </div>
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Fallback anchor when `value` is empty — used by the amountMax
   *  slider so it picks up amountMin's scale before the user has
   *  typed an upper bound. */
  anchorFallback?: string;
}

function SliderRow({ label, value, onChange, anchorFallback }: SliderRowProps) {
  const numeric = parseFloatSafe(value);
  const fallback = parseFloatSafe(anchorFallback ?? '');
  const anchor = numeric > 0 ? numeric : fallback > 0 ? fallback : 100;
  const sliderMax = anchor * 2;
  const sliderStep = sliderMax > 100 ? 1 : sliderMax > 1 ? 0.01 : 0.0001;
  const display = numeric > 0 ? numeric : 0;

  return (
    <div className="data-row" style={{ alignItems: 'center' }}>
      <span className="data-label">{label}</span>
      <span
        className="data-value"
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          fontSize: '0.82rem',
          flex: 1,
          justifyContent: 'flex-end',
        }}
      >
        <input
          type="range"
          min={0}
          max={sliderMax}
          step={sliderStep}
          value={display}
          onChange={(e) => {
            const v = Number(e.target.value);
            // Format to a reasonable precision based on slider step
            // so the form input doesn't become "1.2300000000004".
            const formatted =
              sliderStep >= 1
                ? String(Math.round(v))
                : sliderStep >= 0.01
                  ? v.toFixed(2)
                  : v.toFixed(4);
            onChange(formatted);
          }}
          style={{ width: 160 }}
        />
        <span style={{ minWidth: 70, textAlign: 'right' }}>
          {display > 0
            ? display.toLocaleString(undefined, { maximumFractionDigits: 4 })
            : '—'}
        </span>
      </span>
    </div>
  );
}

function parseFloatSafe(raw: string): number {
  if (!raw) return 0;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? n : 0;
}
