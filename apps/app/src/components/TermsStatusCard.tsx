/**
 * The neutral "checking the terms" card (#1961).
 *
 * Its own module because it is rendered from two places that must not
 * share a chunk: `LegalGateActive`, while the on-chain read is in
 * flight, and `LegalGate`'s Suspense fallback, while that component's
 * chunk is still downloading. The fallback has to be something that
 * holds the gate CLOSED — rendering the children there would open the
 * app for the length of a chunk fetch, which is the same fail-open the
 * whole component exists to prevent, arriving through the loader.
 */
import { ShieldCheck } from 'lucide-react';
import { copy } from '../content/copy';

export function TermsStatusCard() {
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
