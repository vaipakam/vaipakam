/**
 * The connected half of the Terms gate (#1961, review round 2 P2).
 *
 * Split out of `LegalGate` and loaded LAZILY. The gate wraps the routed
 * `<Outlet />`, so it sits in the shell's entry graph; importing the
 * Terms hook from there dragged `DIAMOND_ABI_VIEM` — a 1.59 MB chunk —
 * into the modulepreload of every first paint, including a disconnected
 * visit to Home or Help. That undid the adjacent lazy-`SanctionsBanner`
 * optimisation, whose whole purpose is avoiding exactly that download.
 *
 * Nothing here is needed for a visitor with no wallet, which is the only
 * case that matters for first paint: the gate passes them through
 * without reading anything. So the contract-touching half loads when a
 * wallet is connected and a decision is actually required.
 */
import { ExternalLink, FileText, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useTosAcceptance } from '../contracts/useTosAcceptance';
import { tosGateVerdict } from '../contracts/tosGate';
import { LEGAL_URLS } from '../lib/legalUrls';
import { TermsStatusCard } from './TermsStatusCard';

export function LegalGateActive({ children }: { children: ReactNode }) {
  const { address, onSupportedChain } = useActiveChain();
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

  if (verdict === 'checking') return <TermsStatusCard />;

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

        {/* Disabled off a supported chain. `NetworkBanner` already sits
            ABOVE this card (outside the gate, so a held user still sees
            it) and carries the switch action; leaving the button live
            would send that user into `useDiamondWrite`'s "connect a
            wallet" error, which names the wrong problem. The remedy is
            one banner up, not in a second copy here. */}
        <div className="legal-gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void accept()}
            disabled={submitting || !onSupportedChain}
          >
            {submitting ? copy.legalGate.signing : copy.legalGate.signAccept}
          </button>
        </div>

        <p className="legal-gate-footnote">{copy.legalGate.footnote}</p>
      </div>
    </div>
  );
}
