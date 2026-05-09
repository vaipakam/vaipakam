import { AlertTriangle, Info, CheckCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UseLiquidityPreflightResult } from "../../hooks/useLiquidityPreflight";

interface Props {
  result: UseLiquidityPreflightResult;
  /** Render as an inline alert (CreateOffer / OfferBook review modal).
   *  When `compact` is set, we drop the loading + idle states entirely
   *  so the banner only appears when there's genuine information for
   *  the user. */
  compact?: boolean;
}

/**
 * Phase 7b.1 — surfaces the result of the 0x-based liquidity
 * preflight check. The on-chain `OracleFacet.checkLiquidity` gate
 * (3-V3-clone OR-logic) is the actual security boundary; this is
 * a UX guard that warns the user before they commit to an offer
 * that 0x can't route at acceptable slippage.
 *
 * State table:
 *   - `idle` / `unavailable`        → render nothing (caller's
 *                                     happy-path UI takes over).
 *   - `loading`                     → quiet inline loader (skipped
 *                                     when `compact`).
 *   - `liquid`                      → green inline confirmation.
 *   - `thin`                        → orange warning banner — submit
 *                                     allowed but flagged.
 *   - `no-route`                    → red blocker banner.
 *   - `error`                       → grey informational fallback.
 */
export function LiquidityPreflightBanner({ result, compact }: Props) {
  const { t } = useTranslation();
  if (result.status === "idle" || result.status === "unavailable") return null;
  if (result.status === "loading" && compact) return null;

  if (result.status === "loading") {
    return (
      <div
        className="alert"
        style={{
          marginTop: 8,
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: "0.85rem",
        }}
      >
        <Loader2 size={16} className="spin" />
        <span>{t('banners.preflightChecking')}</span>
      </div>
    );
  }

  if (result.status === "no-route") {
    return (
      <div
        className="alert alert-error"
        style={{ marginTop: 8, fontSize: "0.85rem" }}
      >
        <AlertTriangle size={16} />
        <span>{t('banners.preflightNoRoute')}</span>
      </div>
    );
  }

  if (result.status === "thin") {
    return (
      <div
        className="alert alert-warning"
        style={{ marginTop: 8, fontSize: "0.85rem" }}
      >
        <AlertTriangle size={16} />
        <span>
          {t('banners.preflightThinPrefix')}
          {result.priceImpactPct !== null
            ? ` (~${result.priceImpactPct.toFixed(2)}%)`
            : ""}
          {t('banners.preflightThinSuffix')}
        </span>
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div
        className="alert"
        style={{
          marginTop: 8,
          fontSize: "0.82rem",
          opacity: 0.8,
        }}
      >
        <Info size={14} />
        <span>
          {t('banners.preflightErrorPrefix')}
          {result.errorMessage ? ` (${result.errorMessage})` : ""}
          {t('banners.preflightErrorSuffix')}
        </span>
      </div>
    );
  }

  // status === 'liquid'
  return (
    <div
      className="alert"
      style={{
        marginTop: 8,
        fontSize: "0.82rem",
        borderColor: "var(--accent-green, #10b981)",
        background: "rgba(16, 185, 129, 0.05)",
      }}
    >
      <CheckCircle size={14} style={{ color: "var(--accent-green, #10b981)" }} />
      <span>{t('banners.preflightLiquid')}</span>
    </div>
  );
}
