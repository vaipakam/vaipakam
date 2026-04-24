import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ShieldCheck, ExternalLink } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';
import { useTosAcceptance } from '../../hooks/useTosAcceptance';
import { ErrorAlert } from './ErrorAlert';
import './LegalGate.css';

/**
 * `/app/*` route gate: only renders `children` once the connected wallet
 * has signed a ToS acceptance for the current on-chain version.
 *
 * Behaviour:
 *   - Not connected: passes through (wallet-prompt UI already lives
 *     inside the app and it's cleaner to show it there than double-
 *     gating).
 *   - Gate disabled on-chain (currentTosVersion == 0): passes through.
 *   - Gate enabled + wallet not accepted: renders the acceptance modal.
 *   - Gate enabled + wallet accepted: passes through.
 *
 * This is the Phase 4.1 deliverable. The modal renders a short
 * summary + a link out to the full ToS page; the tx payload signs the
 * on-chain version + hash pair, so the user's acceptance is anchored
 * to the exact text they saw.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const { address } = useWallet();
  const {
    hasAccepted,
    currentVersion,
    currentHash,
    loading,
    error,
    accept,
    submitting,
  } = useTosAcceptance();

  // No wallet → no gate. Downstream pages handle the unconnected state.
  if (!address) return <>{children}</>;
  // Still loading the on-chain state — don't flash a modal.
  if (loading) return <>{children}</>;
  // Gate disabled or already accepted.
  if (hasAccepted) return <>{children}</>;

  return (
    <div className="legal-gate">
      <div className="legal-gate-card">
        <div className="legal-gate-head">
          <div className="legal-gate-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h2 className="legal-gate-title">One-time Terms acceptance</h2>
            <p className="legal-gate-body">
              Before using the Vaipakam app you need to review and accept
              the protocol's Terms of Service. This is a one-time signed
              transaction — your acceptance is recorded on-chain,
              anchored to your wallet, and only has to be re-signed if
              the Terms change.
            </p>
          </div>
        </div>

        <div className="legal-gate-detail">
          <div className="legal-gate-row">
            <span className="legal-gate-label">Current version</span>
            <span className="legal-gate-value">v{currentVersion}</span>
          </div>
          <div className="legal-gate-row">
            <span className="legal-gate-label">Content hash</span>
            <span className="legal-gate-value mono">
              {`${currentHash.slice(0, 10)}…${currentHash.slice(-6)}`}
            </span>
          </div>
        </div>

        <div className="legal-gate-links">
          <Link
            to="/terms"
            target="_blank"
            rel="noreferrer"
            className="legal-gate-link"
          >
            <FileText size={14} /> Read the full Terms of Service
            <ExternalLink size={12} />
          </Link>
          <Link
            to="/privacy"
            target="_blank"
            rel="noreferrer"
            className="legal-gate-link"
          >
            <FileText size={14} /> Privacy Policy
            <ExternalLink size={12} />
          </Link>
        </div>

        {error && <ErrorAlert message={error} />}

        <div className="legal-gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void accept()}
            disabled={submitting}
          >
            {submitting ? 'Signing…' : 'Sign & Accept'}
          </button>
        </div>

        <p className="legal-gate-footnote">
          Signing costs a small on-chain fee. You will be asked to
          approve one transaction from your wallet.
        </p>
      </div>
    </div>
  );
}
