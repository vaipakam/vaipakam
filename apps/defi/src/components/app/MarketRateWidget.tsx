import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, HandCoins, Coins } from 'lucide-react';
import { parseUnits, type Address } from 'viem';
import { useMarketRateMinCollateral } from '../../hooks/useMarketRateMinCollateral';
import { useAssetLiquidity } from '../../hooks/useAssetLiquidity';
import { useLiquidityPreflight } from '../../hooks/useLiquidityPreflight';
import { useReadChain } from '../../contracts/useDiamond';
import { AssetSymbol } from './AssetSymbol';
import { LiquidityPreflightBanner } from './LiquidityPreflightBanner';

/** Worker origin for the 0x/1inch quote proxies — same env var
 *  CreateOffer reads. Null disables the preflight banner (the widget
 *  still works, you just don't get the aggregator-confirmed slippage
 *  hint before you deep-link). */
const PREFLIGHT_WORKER_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_AGENT_ORIGIN ?? null;

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
 *    init-gate (via `useMarketRateMinCollateral`) — `HF ≥ 1.5` in the
 *    legacy regime, or `LTV ≤ min(maxLtvBps, tierMaxInitLtvBps[tier])`
 *    + `HF ≥ 1.0` once governance flips `depthTieredLtvEnabled` on
 *    this chain. The hook resolves the binding constraint internally;
 *    the widget just surfaces the result so the user sees the floor
 *    *before* leaving the page,
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

  // Coarse on-chain liquidity check on the collateral for *this* chain
  // (`OracleFacet.checkLiquidity`). `collateralUnsupported` (no oracle /
  // risk-profile) is the stronger "can't compute a min" case; this
  // catches the "has a profile but the pool depth is below the floor"
  // case too. Either ⇒ the "thin here" hint. The aggregator-confirmed
  // preflight below covers the third case (chain says Liquid but
  // 0x/1inch can't route the user's specific size at ≤6%).
  const collateralChainLiquidity = useAssetLiquidity(collateralAsset);
  const thinOnThisChain =
    collateralUnsupported || collateralChainLiquidity === 'illiquid';

  // Aggregator-confirmed slippage preflight — same hook CreateOffer
  // uses. Mirrors the liquidator's path (sell collateral for principal
  // through the worker's /quote/0x + /quote/1inch proxy) at the
  // auto-computed min collateral, so the user sees the *realized*
  // slippage at their size before they leave the page. The hook fails
  // gracefully (`'unavailable'` when no diamond, no workerOrigin, or
  // `collateralAmount == 0`); the banner suppresses idle/loading in
  // compact mode and only surfaces a `thin` or `no-route` outcome.
  // Decimals default to 18 (matches CreateOffer's wiring) — a 6-dec
  // collateral (USDC/USDT) gets queried at 1e12× the intended size
  // and usually classifies as `no-route` — a documented false-negative
  // the downstream CreateOffer + real on-chain flow correct for.
  const chain = useReadChain();
  let preflightAmount: bigint = 0n;
  try {
    if (minCollateral && !collateralUnsupported) {
      preflightAmount = parseUnits(minCollateral, 18);
    }
  } catch {
    preflightAmount = 0n;
  }
  const preflight = useLiquidityPreflight({
    collateralAsset: (collateralAsset || null) as Address | null,
    principalAsset: (lendingAsset || null) as Address | null,
    collateralAmount: preflightAmount,
    collateralAssetType: 'erc20',
    chainId: chain.chainId,
    diamond: (chain.diamondAddress ?? null) as Address | null,
    workerOrigin: PREFLIGHT_WORKER_ORIGIN,
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
          {/* Auto-min-collateral hint (or the "thin on this chain"
              hint, which covers both no-oracle and pool-below-floor). */}
          <div className="market-rate-widget-hint">
            {thinOnThisChain ? (
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

      {/* Aggregator-confirmed slippage preflight — only surfaces when
          0x/1inch say the user's size routes thin or has no route at
          all. Idle/loading/liquid render nothing (compact mode). */}
      <LiquidityPreflightBanner result={preflight} compact />

      <p className="market-rate-widget-footnote">
        {t('marketRateWidget.footnote')}
      </p>
    </div>
  );
}
