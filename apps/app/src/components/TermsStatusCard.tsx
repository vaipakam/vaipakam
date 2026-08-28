/**
 * The neutral "gate is closed, and here is why" card (#1961).
 *
 * Its own module because it is rendered from three places that must not
 * share a chunk: `LegalGateActive`, while the on-chain read is in
 * flight; `LegalGate`'s Suspense fallback, while that component's chunk
 * is still downloading; and `LegalGate`'s import-failure fallback, when
 * that chunk never arrives. Each holds the gate CLOSED — rendering the
 * children in any of them would open the app for the length of a chunk
 * fetch, which is the same fail-open the whole component exists to
 * prevent, arriving through the loader.
 *
 * Two states, and the difference matters (review round 12 P2). Without
 * `onRetry` this is a check IN PROGRESS: no control, because there is
 * nothing for the user to do but wait a moment. With it, the check
 * could not be loaded at all — a permanent state on this page, since
 * React caches a resolved lazy payload for the life of the document —
 * so it says so and offers the one thing that recovers. Reporting the
 * second as the first is a trap: a card that says "checking" forever
 * while nothing is checking.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { copy } from '../content/copy';

export function TermsStatusCard({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) {
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

  return (
    <div className="legal-gate">
      <div className="card legal-gate-card">
        <p className="legal-gate-status">
          <ShieldAlert size={18} aria-hidden="true" />
          <strong>{copy.legalGate.loadFailedTitle}</strong>
        </p>
        <p className="muted">{copy.legalGate.loadFailedBody}</p>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {copy.legalGate.reload}
        </button>
      </div>
    </div>
  );
}
