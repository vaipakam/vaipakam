import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, HandCoins, Coins } from 'lucide-react';
import { useMarketRateMinCollateral } from '../../hooks/useMarketRateMinCollateral';
import { AssetSymbol } from './AssetSymbol';

/**
 * "Lend / Borrow at market rate" widget — a shortcut on the OfferBook,
 * shown for the pair the filters select. It is *only* a smart prefilled
 * deep-link to Create Offer — there is no one-click post path, and the
 * buttons are never disabled (per the design in
 * `docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md` §2).
 *
 * What it does:
 *  - takes a lending amount,
 *  - auto-fills the *minimum* collateral that clears the on-chain
 *    `HF ≥ MIN_HEALTH_FACTOR` (~1.5) gate (via `useMarketRateMinCollateral`)
 *    so the user sees the floor *before* leaving the page,
 *  - shows the current Market anchor rate (the mid of recent matches
 *    for this pair) as a hint — or "no market rate yet" when the book
 *    is empty for the pair,
 *  - on click → `navigate("/create-offer?from=market-widget&side=…&
 *    lendingAsset=…&collateralAsset=…&amount=…&collateralAmount=<auto-min>&
 *    durationDays=<bucket-if-set>&interestRate=<anchor%-if-set>")`.
 *    Create Offer reads `from=market-widget` to show the right banner
 *    (posting-at-market-rate / first-offer-for-this-pair / illiquid),
 *    re-validates, and blocks decreasing below the suggested minimum.
 *
 * Illiquid collateral (`collateralUnsupported` from the hook — no oracle
 * / risk profile): the buttons still deep-link, but with `collateralAmount`
 * omitted (no auto-min — can't be computed without a price) and a note
 * that terms must be set manually; Create Offer's banner explains.
 */
interface MarketRateWidgetProps {
  /** The pair the OfferBook filters currently select. Both required —
   *  the parent only renders the widget when both are set. */
  lendingAsset: string;
  collateralAsset: string;
  /** The duration-bucket filter, or `''` for "any". When set it's
   *  forwarded to Create Offer; when `''` Create Offer uses its
   *  default bucket. */
  durationDays: string;
  /** The market anchor rate (bps) — the mid of recent matched offers
   *  for this pair, or `null` when there's no prior match. */
  anchorRateBps: bigint | null;
}

type Side = 'lender' | 'borrower';

export function MarketRateWidget({
  lendingAsset,
  collateralAsset,
  durationDays,
  anchorRateBps,
}: MarketRateWidgetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lendingAmount, setLendingAmount] = useState('');

  const {
    minCollateral,
    loading: collLoading,
    collateralUnsupported,
  } = useMarketRateMinCollateral({
    lendingAsset,
    collateralAsset,
    lendingAmount,
  });

  const anchorPct = useMemo(
    () => (anchorRateBps !== null ? Number(anchorRateBps) / 100 : null),
    [anchorRateBps],
  );

  const amountValid = useMemo(() => {
    const n = Number(lendingAmount);
    return isFinite(n) && n > 0;
  }, [lendingAmount]);

  const go = (side: Side) => {
    const p = new URLSearchParams();
    p.set('from', 'market-widget');
    p.set('side', side);
    p.set('lendingAsset', lendingAsset);
    p.set('collateralAsset', collateralAsset);
    if (amountValid) p.set('amount', lendingAmount.trim());
    // Only forward an auto-min when we could actually compute one — for
    // an illiquid collateral asset (`collateralUnsupported`) there's no
    // oracle price, so the user sets the collateral on the offer page.
    if (minCollateral && !collateralUnsupported) p.set('collateralAmount', minCollateral);
    if (durationDays) p.set('durationDays', durationDays);
    if (anchorPct !== null) p.set('interestRate', String(anchorPct));
    navigate(`/create-offer?${p.toString()}`);
  };

  return (
    <div className="card market-rate-widget" style={{ marginTop: 12 }}>
      <div className="card-title">{t('marketRateWidget.title')}</div>

      <div className="market-rate-widget-row">
        <label className="market-rate-widget-amount">
          <span className="form-label">{t('marketRateWidget.lendingAmountLabel')}</span>
          <input
            className="form-input"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={lendingAmount}
            onChange={(e) => setLendingAmount(e.target.value)}
            aria-label={t('marketRateWidget.lendingAmountLabel')}
          />
        </label>

        <div className="market-rate-widget-meta">
          {/* Market anchor rate hint */}
          <div className="market-rate-widget-hint">
            {anchorPct !== null
              ? t('marketRateWidget.marketRateHint', {
                  rate: anchorPct.toLocaleString(undefined, { maximumFractionDigits: 2 }),
                })
              : t('marketRateWidget.noMarketRateHint')}
          </div>
          {/* Auto-min-collateral hint */}
          <div className="market-rate-widget-hint">
            {collateralUnsupported ? (
              t('marketRateWidget.illiquidCollateralHint')
            ) : amountValid && minCollateral ? (
              <>
                {t('marketRateWidget.minCollateralHint', { amount: minCollateral })}{' '}
                <AssetSymbol address={collateralAsset} />
              </>
            ) : amountValid && collLoading ? (
              t('marketRateWidget.computingMinCollateral')
            ) : (
              t('marketRateWidget.minCollateralPrompt')
            )}
          </div>
        </div>

        <div className="market-rate-widget-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => go('lender')}
          >
            <HandCoins size={14} /> {t('marketRateWidget.lendButton')}{' '}
            <ArrowUpRight size={12} />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => go('borrower')}
          >
            <Coins size={14} /> {t('marketRateWidget.borrowButton')}{' '}
            <ArrowUpRight size={12} />
          </button>
        </div>
      </div>

      <p className="market-rate-widget-footnote">
        {t('marketRateWidget.footnote')}
      </p>
    </div>
  );
}
