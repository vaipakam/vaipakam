/**
 * Connected-route Terms-of-Service gate (#1961).
 *
 * Renders `children` only once the connected wallet has accepted the ToS
 * version currently in force. The retired `apps/defi` app had this; the
 * successor shipped without it, which meant governance could activate a
 * ToS version and no user would ever be asked to accept it — the
 * contracts delegate this enforcement to the client and have no
 * per-action backstop, so an absent gate is a bypass rather than a
 * missing convenience.
 *
 * Behaviour, and every branch of it is deliberate:
 *
 *   - Not connected → pass through. There is nothing to gate: the write
 *     flows already refuse an unconnected wallet, and double-gating
 *     would replace each page's own "connect first" affordance with a
 *     worse one.
 *   - Read in flight → hold CLOSED, neutral status. NOT a pass-through:
 *     "no ToS in force" and "we have not read yet" are different
 *     answers, and only the first may open the gate (#822).
 *   - Read failed → hold CLOSED with a retry. Failing open on an RPC
 *     error would be the bypass this component exists to prevent, and
 *     RPC errors are ordinary.
 *   - Read succeeded and says accepted (which includes "no ToS is in
 *     force") → pass through.
 *   - Read succeeded and says not accepted → the acceptance card.
 */
import type { ReactNode } from 'react';
import { ExternalLink, FileText, ShieldCheck } from 'lucide-react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useTosAcceptance } from '../contracts/useTosAcceptance';
import { tosGateVerdict } from '../contracts/tosGate';
import { LEGAL_URLS } from '../lib/legalUrls';

export function LegalGate({ children }: { children: ReactNode }) {
  const { address } = useActiveChain();
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

  // One decision, taken in `tosGate.ts` and exhaustively tested there —
  // the branches below only render it. Deciding inline is how a gate
  // acquires an untested fifth case.
  const verdict = tosGateVerdict({
    connected: Boolean(address),
    readOk,
    loading,
    accepted: hasAccepted,
  });

  if (verdict === 'pass-unconnected' || verdict === 'pass') return <>{children}</>;

  if (verdict === 'checking') {
    return (
      <div className="legal-gate">
        <div className="card legal-gate-card">
          <p className="legal-gate-status">
            <ShieldCheck size={18} aria-hidden="true" />
            {copy.legalGate.verifying}
          </p>
        </div>
      </div>
    );
  }

  if (verdict === 'unavailable') {
    return (
      <div className="legal-gate">
        <div className="card legal-gate-card">
          <h2 className="card-title">
            <ShieldCheck size={18} aria-hidden="true" />
            {copy.legalGate.readErrorTitle}
          </h2>
          <p className="legal-gate-body">{copy.legalGate.readErrorBody}</p>
          {error ? (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          ) : null}
          <div className="legal-gate-actions">
            <button type="button" className="btn btn-primary" onClick={() => void reload()}>
              {copy.legalGate.retry}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="legal-gate">
      <div className="card legal-gate-card">
        <h2 className="card-title">
          <ShieldCheck size={18} aria-hidden="true" />
          {copy.legalGate.title}
        </h2>
        <p className="legal-gate-body">{copy.legalGate.body}</p>

        {/* The version and hash the acceptance will be signed against,
            shown so the user can tell that a re-prompt is a NEW version
            rather than the same one asking twice. */}
        <dl className="legal-gate-detail">
          <div className="legal-gate-row">
            <dt>{copy.legalGate.currentVersion}</dt>
            <dd>v{currentVersion}</dd>
          </div>
          <div className="legal-gate-row">
            <dt>{copy.legalGate.contentHash}</dt>
            <dd className="mono">
              {`${currentHash.slice(0, 10)}…${currentHash.slice(-6)}`}
            </dd>
          </div>
        </dl>

        {/* The terms live on the marketing site, which is a separate
            origin — so these are external links, not routes. A gated
            user must be able to READ what they are accepting without
            first getting past the gate. */}
        <div className="legal-gate-links">
          <a
            href={LEGAL_URLS.terms}
            target="_blank"
            rel="noreferrer"
            className="legal-gate-link"
          >
            <FileText size={14} aria-hidden="true" />
            {copy.legalGate.readTerms}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <a
            href={LEGAL_URLS.privacy}
            target="_blank"
            rel="noreferrer"
            className="legal-gate-link"
          >
            <FileText size={14} aria-hidden="true" />
            {copy.legalGate.privacyPolicy}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>

        {error ? (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        ) : null}

        <div className="legal-gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void accept()}
            disabled={submitting}
          >
            {submitting ? copy.legalGate.signing : copy.legalGate.signAccept}
          </button>
        </div>

        <p className="legal-gate-footnote">{copy.legalGate.footnote}</p>
      </div>
    </div>
  );
}
