import { useId, type ReactNode } from 'react';
import { RiskDisclosures, RiskConsentLabel } from './RiskDisclosures';
import './RiskCallout.css';

/**
 * Props for {@link RiskCallout}.
 */
export interface RiskCalloutProps {
  /** Current consent state (controlled). */
  consent: boolean;
  /** Setter the parent calls when the checkbox toggles. */
  onConsentChange: (next: boolean) => void;
  /** Optional className appended to the wrapper. */
  className?: string;
  /**
   * When true, the checkbox is rendered disabled. Use during a
   * submit-in-flight window so the parent state can't change underneath
   * the in-progress transaction.
   */
  disabled?: boolean;
  /**
   * Optional extra content (typically per-flow risk details, e.g. an
   * early-withdraw haircut chip or a refinance preview) rendered inside
   * the colour band, BETWEEN the localised disclosures and the consent
   * checkbox. Caller-supplied so the per-flow shape stays in the
   * consumer page, not in this shared component.
   */
  extra?: ReactNode;
}

/**
 * RiskCallout — the canonical state-mutating-confirm risk-disclosure
 * shape, per the UX direction ADR (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`,
 * Tier A.12).
 *
 * Single visual shape — a coloured-band wrapper + the localised
 * `RiskDisclosures` body + an inline consent checkbox — reused on
 * every state-mutating confirm modal across `apps/defi`. The band
 * colour matches the DEX "slippage too high, increase tolerance"
 * inline-warning idiom (yellow / orange band on a faint tint), so
 * users coming from Uniswap / 1inch see a familiar treatment.
 *
 * Replaces the nine-line pattern that four pages copied verbatim
 * pre-#215:
 *
 * ```tsx
 * <RiskDisclosures />
 * <label className="checkbox-row" style={{ marginTop: 12 }}>
 *   <input type="checkbox" checked={x} onChange={(e) => setX(e.target.checked)} />
 *   <span><RiskConsentLabel /></span>
 * </label>
 * ```
 *
 * Migration shape — consumer pages collapse the above to:
 *
 * ```tsx
 * <RiskCallout
 *   consent={form.riskAndTermsConsent}
 *   onConsentChange={(c) => setField('riskAndTermsConsent', c)}
 * />
 * ```
 *
 * Per the ADR, the four current consumers of `RiskDisclosures` —
 * `CreateOffer`, `OfferBook`, `BorrowerPreclose`, `LenderEarlyWithdrawal`
 * — migrate to `RiskCallout` in their respective per-page rework
 * cards (#204 / #205 / #211 / #212). The two future consumers
 * (`OfferDetails` confirm modal #206, `Refinance` page #210,
 * `BuyVPFI` page #218) consume it from first ship. This card
 * (#215) is the cross-cutting unblocker — it ships the component
 * alone, with no consumer migrations, so each consuming sub-card
 * lands its own minimal diff.
 *
 * Accessibility:
 * - The colour band carries `role="region"` + `aria-labelledby` so
 *   screen readers announce the block as a labelled landmark.
 * - The checkbox + label are wired via `htmlFor` / `id` (rather than
 *   wrapping the input in `<label>`) so a label-click toggles the
 *   checkbox via the standard ARIA pairing — same semantics, more
 *   robust against future DOM-structure changes.
 * - The checkbox carries `aria-required="true"` because the broader
 *   confirm-modal flow requires consent before the primary CTA
 *   enables.
 *
 * @param props {@link RiskCalloutProps}.
 */
export function RiskCallout({
  consent,
  onConsentChange,
  className,
  disabled = false,
  extra,
}: RiskCalloutProps) {
  // Stable id pair so the label's `htmlFor` and the checkbox's `id`
  // match without collision when multiple callouts mount in one tree.
  // `useId` was added in React 18 specifically for this case.
  const checkboxId = useId();
  const headingId = useId();

  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className={`risk-callout${className ? ` ${className}` : ''}`}
    >
      {/*
        Visually-hidden heading — present in the DOM so the region's
        aria-labelledby has a target, but not rendered as visible
        text (the visible heading lives inside RiskDisclosures itself).
      */}
      <span id={headingId} className="risk-callout-sr-heading">
        Risk disclosures and consent
      </span>

      <RiskDisclosures />

      {extra}

      <label htmlFor={checkboxId} className="risk-callout-consent">
        <input
          id={checkboxId}
          type="checkbox"
          checked={consent}
          disabled={disabled}
          aria-required="true"
          onChange={(e) => onConsentChange(e.target.checked)}
        />
        <span>
          <RiskConsentLabel />
        </span>
      </label>
    </div>
  );
}
