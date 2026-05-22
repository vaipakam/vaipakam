import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
 * Per the ADR, six consuming sub-cards depend on this one:
 *
 * - `#204` — `CreateOffer.tsx` (currently uses RiskDisclosures + the
 *   duplicated checkbox-row pattern; migrates to RiskCallout).
 * - `#206` — `OfferDetails.tsx` confirm modal (new consumer; ships
 *   with RiskCallout from first paint).
 * - `#210` — `Refinance.tsx` (new consumer; ships with RiskCallout).
 * - `#211` — `BorrowerPreclose.tsx` (currently uses the duplicated
 *   pattern; migrates to RiskCallout).
 * - `#212` — `LenderEarlyWithdrawal.tsx` (currently uses the
 *   duplicated pattern; migrates to RiskCallout).
 * - `#218` — `BuyVPFI.tsx` (new consumer; ships with RiskCallout).
 *
 * `OfferBook.tsx` (which also currently uses `RiskDisclosures`) is
 * NOT a consumer of `RiskCallout` — `OfferBook` is a listing surface,
 * not a state-mutating confirm path; its disclosures stay rendered
 * via `RiskDisclosures` directly and are out of this card's scope.
 *
 * This card (#215) is the cross-cutting unblocker — it ships the
 * component alone, with no consumer migrations, so each consuming
 * sub-card lands its own minimal diff.
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
  const { t } = useTranslation();

  // Stable id pair so the label's `htmlFor` and the checkbox's `id`
  // match without collision when multiple callouts mount in one tree.
  // `useId` was added in React 18 specifically for this case. Note —
  // React's `useId` returns strings containing colons (e.g. `:r0:`);
  // tests that look the id up via `querySelector` MUST use the
  // attribute-selector form `[id="..."]` or `document.getElementById`,
  // not the `#id` selector which interprets `:` as a pseudo-class.
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
        Localised via the existing `riskDisclosures.title` i18n key so
        non-English locales don't get an English landmark in an
        otherwise-localised region.
      */}
      <span id={headingId} className="risk-callout-sr-heading">
        {t('riskDisclosures.title')}
      </span>

      <RiskDisclosures />

      {extra}

      {/*
        Consent row — the input is a SIBLING of the label (not nested),
        paired via `htmlFor` / `id`. This shape avoids nesting one
        interactive control (the checkbox) inside another (the `<a>`
        Terms link that lives inside `<RiskConsentLabel>`), which
        browsers + assistive tech handle inconsistently. The label
        click still toggles the checkbox via the standard `htmlFor`
        pairing; the Terms link's `e.stopPropagation()` (set in
        `RiskDisclosures.tsx`) prevents a click on the link from also
        toggling consent.
      */}
      <div className="risk-callout-consent">
        <input
          id={checkboxId}
          type="checkbox"
          checked={consent}
          disabled={disabled}
          aria-required="true"
          onChange={(e) => onConsentChange(e.target.checked)}
        />
        <label htmlFor={checkboxId}>
          <RiskConsentLabel />
        </label>
      </div>
    </div>
  );
}
