/**
 * Sanctions-screening banner — renders ONLY when the connected wallet
 * is flagged by the configured on-chain oracle (fail-open otherwise).
 * Per the retail-deploy policy this is the one place the full
 * three-line message appears; marketing surfaces never mention it.
 */
import { OctagonAlert } from 'lucide-react';
import { copy } from '../content/copy';
import { useSanctionsCheck } from '../data/sanctions';

export function SanctionsBanner() {
  const flagged = useSanctionsCheck();
  if (!flagged) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <OctagonAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">{copy.sanctions.title}</div>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line1}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line2}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line3}</p>
      </div>
    </div>
  );
}
