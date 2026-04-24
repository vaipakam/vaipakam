import { AlertTriangle } from 'lucide-react';
import {
  FALLBACK_CONSENT_SECTIONS,
  FALLBACK_CONSENT_TITLE,
} from '../../lib/fallbackTerms';
import './RiskDisclosures.css';

/**
 * Pure presentation component that renders the Risk-Disclosure copy
 * defined in `lib/fallbackTerms.ts`. No logic beyond layout — callers
 * own any "I agree" checkbox state next to it (see CreateOffer, the
 * Accept-Review modal in OfferBook, and LenderEarlyWithdrawal).
 *
 * The sections are deliberately downside-only: the card should read as
 * a disclaimer, not as documentation of normal behaviour. Happy-path
 * flow lives elsewhere in the UI (and in `docs/`).
 */
export function RiskDisclosures() {
  return (
    <div className="risk-disclosures" role="note">
      <div className="risk-disclosures-head">
        <AlertTriangle size={16} aria-hidden />
        <span>{FALLBACK_CONSENT_TITLE}</span>
      </div>
      {FALLBACK_CONSENT_SECTIONS.map((section, i) => (
        <section key={i} className="risk-disclosures-section">
          <h4 className="risk-disclosures-heading">{section.heading}</h4>
          <ol className="risk-disclosures-points">
            {section.points.map((p, j) => (
              <li key={j}>{p}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
