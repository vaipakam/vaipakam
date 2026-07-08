import { AlertTriangle } from 'lucide-react';
import { useTxSimulation, type TxSimInput } from '../contracts/useTxSimulation';
import { isUnderCollateralRevert } from '../lib/collateralPrecheck';
import { copy } from '../content/copy';

/**
 * Early inline under-collateral warning for the borrow terms step (#1112).
 *
 * Runs the prospective `createOffer` calldata as a read-only `eth_call` (the
 * `tx` the caller builds with consent forced true, so the
 * RiskAndTermsConsentRequired gate doesn't mask the collateral/LTV revert while
 * the user is still editing amounts) and renders a warning ONLY when the revert
 * is an under-collateral one — see {@link isUnderCollateralRevert}. Every other
 * verdict (ok / approval-needed / an unrelated revert / RPC unavailable) is
 * silent here; the review-step `SimulationPreview` remains the full pre-sign
 * check. Advisory only: never gates the "Continue" button.
 */
export function CollateralPrecheck({ tx }: { tx: TxSimInput | null }) {
  const { result } = useTxSimulation(tx);
  if (!isUnderCollateralRevert(result)) return null;
  return (
    <div className="banner banner-warn" role="status" style={{ marginBottom: 12 }}>
      <AlertTriangle size={16} aria-hidden />
      <span className="banner-body">
        {copy.borrow.collateralPrecheck} {result.revertReason}
      </span>
    </div>
  );
}
