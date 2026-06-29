import { type ReactNode } from 'react';
import { L as Link } from '../L';
import { FileText, ShieldCheck, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useTosAcceptance } from '../../hooks/useTosAcceptance';
import { ErrorAlert } from './ErrorAlert';
import './LegalGate.css';

/**
 * Connected-app route gate: only renders `children` once the connected
 * wallet has signed a ToS acceptance for the current on-chain version.
 *
 * Behaviour:
 *   - Not connected: passes through (wallet-prompt UI already lives
 *     inside the app and it's cleaner to show it there than double-
 *     gating).
 *   - Read in flight: holds CLOSED with a neutral loading state (#822) —
 *     it does NOT pass through, because the gate is disabled only when a
 *     SUCCESSFUL read returns version 0, not while we simply don't know yet.
 *   - Read failed: holds CLOSED with a retry state (#822). The gate has no
 *     on-chain per-action backstop, so failing open on an RPC error would be
 *     a route-gate bypass.
 *   - Gate disabled on-chain (currentTosVersion == 0, read OK): passes through.
 *   - Gate enabled + wallet not accepted: renders the acceptance modal.
 *   - Gate enabled + wallet accepted: passes through.
 *
 * The modal renders a short summary + a link out to the full ToS page; the
 * tx payload signs the on-chain version + hash pair, so the user's
 * acceptance is anchored to the exact text they saw.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { address } = useWallet();
  const {
    hasAccepted,
    readOk,
    currentVersion,
    currentHash,
    loading,
    error,
    accept,
    reload,
    submitting,
  } = useTosAcceptance();

  // No wallet → no gate. Downstream pages handle the unconnected state.
  if (!address) return <>{children}</>;
  // #822 — read in flight: hold CLOSED with a neutral loader. We can't yet
  // distinguish "gate disabled" (a real version-0 read) from "not read yet",
  // so passing through here would be a fail-open bypass window.
  if (loading) {
    return (
      <div className="legal-gate">
        <div className="legal-gate-card legal-gate-card--status">
          <div className="legal-gate-icon">
            <ShieldCheck size={20} />
          </div>
          <p className="legal-gate-body">{t('legalGate.verifying')}</p>
        </div>
      </div>
    );
  }
  // #822 — read failed (or otherwise never succeeded): hold CLOSED with a
  // retry, never pass through. No on-chain backstop exists for this gate.
  if (!readOk) {
    return (
      <div className="legal-gate">
        <div className="legal-gate-card legal-gate-card--status">
          <div className="legal-gate-icon">
            <ShieldCheck size={20} />
          </div>
          <h2 className="legal-gate-title">{t('legalGate.readErrorTitle')}</h2>
          <p className="legal-gate-body">{t('legalGate.readErrorBody')}</p>
          {error && <ErrorAlert message={error} />}
          <div className="legal-gate-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void reload()}
            >
              {t('legalGate.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Gate disabled or already accepted (both require a successful read).
  if (hasAccepted) return <>{children}</>;

  return (
    <div className="legal-gate">
      <div className="legal-gate-card">
        <div className="legal-gate-head">
          <div className="legal-gate-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h2 className="legal-gate-title">{t('legalGate.title')}</h2>
            <p className="legal-gate-body">{t('legalGate.body')}</p>
          </div>
        </div>

        <div className="legal-gate-detail">
          <div className="legal-gate-row">
            <span className="legal-gate-label">{t('legalGate.currentVersion')}</span>
            <span className="legal-gate-value">v{currentVersion}</span>
          </div>
          <div className="legal-gate-row">
            <span className="legal-gate-label">{t('legalGate.contentHash')}</span>
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
            <FileText size={14} /> {t('legalGate.readTerms')}
            <ExternalLink size={12} />
          </Link>
          <Link
            to="/privacy"
            target="_blank"
            rel="noreferrer"
            className="legal-gate-link"
          >
            <FileText size={14} /> {t('legalGate.privacyPolicy')}
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
            {submitting ? t('legalGate.signing') : t('legalGate.signAccept')}
          </button>
        </div>

        <p className="legal-gate-footnote">{t('legalGate.footnote')}</p>
      </div>
    </div>
  );
}
