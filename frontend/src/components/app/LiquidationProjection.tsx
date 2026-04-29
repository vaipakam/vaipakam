import { useEffect, useMemo, useState } from 'react';
import { useDiamondRead } from '../../contracts/useDiamond';
import { AssetSymbol } from './AssetSymbol';

interface LiquidationProjectionProps {
  loan: {
    principal: bigint;
    collateralAmount: bigint;
    principalAsset: string;
    collateralAsset: string;
    /** Lender-opt-in gate snapshotted from the source offer at loan
     *  init. When true, the borrower can call `repayPartial` on this
     *  loan, so the partial-repay projection slider is meaningful and
     *  rendered. When false (default), the slider is hidden because
     *  any partial-repay attempt would revert with
     *  `PartialRepayNotAllowed`. See
     *  `LibVaipakam.Offer.allowsPartialRepay` for the consent
     *  mechanics across both offer sides. */
    allowsPartialRepay: boolean;
  };
  /** Current on-chain HF scaled to 1e18 from `RiskFacet.calculateHealthFactor`.
   *  `null` while loading, unavailable on illiquid loans or missing oracle. */
  hfScaled: number | null;
  collateralDecimals: number;
  principalDecimals: number;
}

/**
 * Phase 8a.2 — Liquidation-price projection + what-if controls.
 *
 * Derives everything from the current on-chain HF: because the protocol
 * liquidates at HF < 1.0, the collateral can lose `1 - 1/HF` of its
 * value before hitting the threshold. Oracle prices give the actual
 * dollar price at which that trigger fires. What-if sliders recompute
 * the projected HF under three scenarios: adding collateral, making a
 * partial repayment, and a collateral-price drop simulation.
 *
 * Pure UI math — no contract changes. Gracefully degrades when the HF
 * or oracle prices aren't available (NFT-rental loans, illiquid
 * collateral, stale feed).
 */
export function LiquidationProjection({
  loan,
  hfScaled,
  collateralDecimals,
  principalDecimals,
}: LiquidationProjectionProps) {
  const diamondRead = useDiamondRead();
  const [collPriceUsd, setCollPriceUsd] = useState<number | null>(null);
  const [priceErr, setPriceErr] = useState<string | null>(null);

  // Projection input state
  const [addColl, setAddColl] = useState<string>('');
  const [partialRepay, setPartialRepay] = useState<string>('');
  const [dropPct, setDropPct] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await diamondRead.getAssetPrice(loan.collateralAsset)) as
          | [bigint, number]
          | { price?: bigint; decimals?: number };
        let price: bigint;
        let dec: number;
        if (Array.isArray(res)) {
          price = res[0];
          dec = Number(res[1]);
        } else {
          price = res.price ?? 0n;
          dec = Number(res.decimals ?? 8);
        }
        if (cancelled) return;
        setCollPriceUsd(Number(price) / 10 ** dec);
        setPriceErr(null);
      } catch (err) {
        if (!cancelled) {
          setPriceErr(
            err instanceof Error
              ? err.message
              : 'Oracle unavailable — liquidation-price projection off.',
          );
          setCollPriceUsd(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamondRead, loan.collateralAsset]);

  const projection = useMemo(() => {
    if (hfScaled === null || !isFinite(hfScaled) || hfScaled <= 0) return null;
    const addCollWei = safeParseAmount(addColl, collateralDecimals);
    const repayWei = safeParseAmount(partialRepay, principalDecimals);

    const newCollAmount = loan.collateralAmount + addCollWei;
    // If the user types a repay larger than principal, clamp to zero
    // (for display purposes; the real repay would partial-clear the loan
    // via a different code path, but the UI projection is still useful).
    const newDebt =
      repayWei >= loan.principal ? 0n : loan.principal - repayWei;

    // HF scales linearly in collateral, inversely in debt. Derived from
    // HF = (collUSD * liqBps / 1e4) / debtUSD without needing liqBps.
    const addCollMultiplier =
      loan.collateralAmount === 0n
        ? 1
        : Number(newCollAmount) / Number(loan.collateralAmount);
    const repayMultiplier =
      newDebt === 0n
        ? Number.POSITIVE_INFINITY
        : Number(loan.principal) / Number(newDebt);
    const dropMultiplier = Math.max(0, 1 - dropPct / 100);

    const projectedHf =
      hfScaled * addCollMultiplier * repayMultiplier * dropMultiplier;

    // Liquidation-price projection assumes all adjustments except price drop
    // land first, then solves for the collateral price that would push HF
    // to exactly 1.0. Equals currentPrice * dropMultiplier when the drop
    // slider is 0.
    const hfWithoutDrop = hfScaled * addCollMultiplier * repayMultiplier;
    const dropToLiquidationPct =
      hfWithoutDrop > 0 && isFinite(hfWithoutDrop)
        ? Math.max(0, (1 - 1 / hfWithoutDrop) * 100)
        : null;
    const liquidationPriceUsd =
      collPriceUsd !== null && hfWithoutDrop > 0 && isFinite(hfWithoutDrop)
        ? collPriceUsd / hfWithoutDrop
        : null;

    return {
      projectedHf,
      dropToLiquidationPct,
      liquidationPriceUsd,
      hfIsInfinite: !isFinite(projectedHf),
    };
  }, [
    hfScaled,
    addColl,
    partialRepay,
    dropPct,
    loan.collateralAmount,
    loan.principal,
    collateralDecimals,
    principalDecimals,
    collPriceUsd,
  ]);

  if (hfScaled === null) {
    // HF unavailable (illiquid loan / NFT rental / oracle gap); no
    // projection is meaningful. Silently skip the panel.
    return null;
  }

  if (!projection) return null;

  return (
    <div
      className="card"
      style={{ marginTop: 12, borderLeft: '4px solid var(--brand)' }}
    >
      <div className="card-title">Liquidation-price projection</div>

      {/* Summary: current liquidation price + drop tolerance. */}
      <div className="data-row">
        <span className="data-label">Liquidates if</span>
        <span className="data-value" style={{ fontSize: '0.88rem' }}>
          <AssetSymbol address={loan.collateralAsset} /> drops{' '}
          <strong>
            {projection.dropToLiquidationPct !== null
              ? `${projection.dropToLiquidationPct.toFixed(1)}%`
              : '—'}
          </strong>
          {collPriceUsd !== null && projection.liquidationPriceUsd !== null && (
            <span style={{ opacity: 0.75 }}>
              {' '}(from ${collPriceUsd.toFixed(2)} to $
              {projection.liquidationPriceUsd.toFixed(2)})
            </span>
          )}
        </span>
      </div>
      {priceErr && (
        <div className="data-row">
          <span
            className="data-value"
            style={{ fontSize: '0.78rem', opacity: 0.7 }}
          >
            {priceErr}
          </span>
        </div>
      )}

      {/* What-if inputs. All three compose multiplicatively. */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={{ fontSize: '0.82rem', opacity: 0.8, marginBottom: 8 }}>
          What-if scenarios
        </div>

        <div className="data-row" style={{ alignItems: 'center' }}>
          <span className="data-label">
            Add collateral (
            <AssetSymbol address={loan.collateralAsset} />)
          </span>
          <input
            type="number"
            min="0"
            step="any"
            value={addColl}
            onChange={(e) => setAddColl(e.target.value)}
            placeholder="0"
            className="form-input"
            style={{ width: 140 }}
          />
        </div>

        {/* Partial-repay slider gated on the loan's lender-opt-in flag
            (snapshotted from the source offer at loan init). When the
            lender didn't opt in, hiding the slider matches the on-
            chain truth — any `repayPartial` attempt would revert with
            `PartialRepayNotAllowed`. See
            `LibVaipakam.Offer.allowsPartialRepay` for the consent
            mechanics across both offer sides. */}
        {loan.allowsPartialRepay && (
          <div className="data-row" style={{ alignItems: 'center' }}>
            <span className="data-label">
              Partial repay (
              <AssetSymbol address={loan.principalAsset} />)
            </span>
            <input
              type="number"
              min="0"
              step="any"
              value={partialRepay}
              onChange={(e) => setPartialRepay(e.target.value)}
              placeholder="0"
              className="form-input"
              style={{ width: 140 }}
            />
          </div>
        )}

        <div className="data-row" style={{ alignItems: 'center' }}>
          <span className="data-label">
            Collateral price drop — slider
          </span>
          <span
            className="data-value"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              fontSize: '0.82rem',
            }}
          >
            <input
              type="range"
              min="0"
              max="99"
              step="1"
              value={dropPct}
              onChange={(e) => setDropPct(Number(e.target.value))}
              style={{ width: 120 }}
            />
            {/* Show the resulting absolute price alongside the percent —
                a raw "30%" doesn't tell users what the collateral would
                actually be worth. Skips the dollar-side when the oracle
                is unavailable (collPriceUsd === null) so the row
                degrades to percent-only rather than "30% — $—". */}
            <span style={{ minWidth: 40 }}>
              {dropPct}%
              {collPriceUsd !== null && (
                <span style={{ opacity: 0.7, marginLeft: 4 }}>
                  · ${(collPriceUsd * (1 - dropPct / 100)).toFixed(2)}
                </span>
              )}
            </span>
          </span>
        </div>

        {/* Projected outcome row. */}
        <div className="data-row">
          <span className="data-label">Projected HF</span>
          <span
            className="data-value"
            style={{
              fontSize: '0.9rem',
              fontWeight: 600,
              color:
                projection.projectedHf < 1
                  ? 'var(--accent-red)'
                  : projection.projectedHf < 1.5
                    ? 'var(--accent-orange, #f59e0b)'
                    : 'var(--accent-green, #10b981)',
            }}
          >
            {projection.hfIsInfinite
              ? '∞ (debt cleared)'
              : projection.projectedHf.toFixed(3)}
            {projection.projectedHf < 1 && !projection.hfIsInfinite && (
              <span style={{ marginLeft: 8, fontSize: '0.78rem' }}>
                ⚠ liquidation would trigger
              </span>
            )}
          </span>
        </div>
        {!projection.hfIsInfinite &&
          projection.dropToLiquidationPct !== null &&
          (addColl !== '' || partialRepay !== '' || dropPct > 0) && (
            <div className="data-row">
              <span className="data-label">New drop tolerance</span>
              <span
                className="data-value"
                style={{ fontSize: '0.85rem', opacity: 0.85 }}
              >
                {projection.dropToLiquidationPct.toFixed(1)}% further drop
                before liquidation
                {collPriceUsd !== null &&
                  projection.liquidationPriceUsd !== null && (
                    <span style={{ opacity: 0.75 }}>
                      {' '}(down to ${projection.liquidationPriceUsd.toFixed(2)})
                    </span>
                  )}
              </span>
            </div>
          )}
      </div>

      <div
        style={{
          marginTop: 8,
          fontSize: '0.72rem',
          opacity: 0.6,
        }}
      >
        Projection assumes current market data. Oracle prices are read
        on page load; refresh to get live numbers. Your actual
        liquidation price will move with the on-chain oracle.
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Parse a user-typed decimal amount (`"1.5"`) into a bigint at the
 *  given decimals. Returns 0n for empty, invalid, or negative input so
 *  the projection math never panics. */
function safeParseAmount(raw: string, decimals: number): bigint {
  if (!raw) return 0n;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0n;
  try {
    // Round to nearest unit to avoid floating-point drift on large inputs.
    const scaled = Math.round(n * 10 ** Math.min(decimals, 18));
    // Re-scale back up to native decimals if > 18.
    if (decimals <= 18) return BigInt(scaled);
    return BigInt(scaled) * 10n ** BigInt(decimals - 18);
  } catch {
    return 0n;
  }
}

