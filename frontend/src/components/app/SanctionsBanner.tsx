import { AlertOctagon } from 'lucide-react';
import { useSanctionsCheck } from '../../hooks/useSanctionsCheck';
import type { Address } from 'viem';

/**
 * Pre-signature sanctions-screening banner. When the connected wallet
 * (or, on an accept flow, the offer's creator) is flagged by the
 * configured Chainalysis-style oracle, this renders a red banner with
 * a clear explanation of why the next action will revert. The
 * underlying `useSanctionsCheck` hook fails open — no oracle
 * configured or oracle outage both render nothing, matching the
 * contract's fail-open posture.
 *
 * Callers that need to gate UI state (disable the submit button, hide
 * an action) should read `isSanctioned` from `useSanctionsCheck`
 * directly. This component is for the user-visible warning only.
 */
export function SanctionsBanner({
  address,
  label,
}: {
  address: Address | null | undefined;
  /** Short label for which wallet we're flagging — "Your wallet",
   *  "Offer creator", etc. Shown in the banner body. */
  label: string;
}) {
  const { isSanctioned, loading } = useSanctionsCheck(address);
  if (loading) return null;
  if (!isSanctioned) return null;
  return (
    <div
      className="alert alert-error"
      role="alert"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        marginBottom: 12,
      }}
    >
      <AlertOctagon size={18} style={{ flex: '0 0 auto', marginTop: 2 }} />
      <div style={{ fontSize: '0.86rem', lineHeight: 1.5 }}>
        <strong>{label}: sanctions-screening match.</strong> The on-chain
        sanctions oracle (Chainalysis) currently lists this address.
        Any offer-creation or offer-acceptance transaction will revert
        at the protocol layer. If you believe this is a mis-match,
        contact Chainalysis support — Vaipakam does not maintain its
        own sanctions list.
      </div>
    </div>
  );
}
