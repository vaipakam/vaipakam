import { AlertTriangle, Info, CheckCircle, Loader2 } from "lucide-react";
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
        <span>Checking on-chain liquidity for this pair…</span>
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
        <span>
          0x can't find a route for this collateral → principal pair at
          the requested size. Liquidations would fall back to the
          claim-time full-collateral path. Pick a different collateral
          asset, or proceed knowing the lender's recovery is the raw
          collateral instead of principal proceeds.
        </span>
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
          0x routed this pair, but with high price impact
          {result.priceImpactPct !== null
            ? ` (~${result.priceImpactPct.toFixed(2)}%)`
            : ""}{" "}
          — above the protocol's 6% slippage cap. Liquidations may
          revert and fall back to the claim-time path. Consider
          smaller collateral amounts or a more liquid asset.
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
          Liquidity preflight unavailable
          {result.errorMessage ? ` (${result.errorMessage})` : ""}. The
          on-chain liquidity gate still applies.
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
      <span>
        0x can route this collateral → principal pair within the
        protocol's slippage cap. Liquidations should settle without
        falling back.
      </span>
    </div>
  );
}
