/**
 * Risk-disclosure copy shown to a user whenever they commit to a position
 * whose downside is captured by the fallback-execution rules (liquidation-
 * swap failure for liquid collateral, default on illiquid-asset loans).
 *
 * Shown at three touch points today:
 *   - Create Offer — offer creator opts in before posting.
 *   - Offer Book accept-review modal — offer acceptor opts in before
 *     pairing.
 *   - Lender Early Withdrawal — acquirer opts in before inheriting the
 *     position mid-loan.
 *
 * The copy is deliberately downside-only — no mention of the happy-path
 * flow — and structured point-by-point so a user reading under time
 * pressure still absorbs the worst case. Rendered by
 * `<RiskDisclosures>` in `components/app/RiskDisclosures.tsx`.
 */

export const FALLBACK_CONSENT_TITLE = "Risk Disclosures";

export const FALLBACK_CONSENT_CHECKBOX_LABEL =
  "I have read and agree to the Risk Disclosures above.";

export interface RiskSection {
  /** Section heading — displayed as a subtitle above the points. */
  heading: string;
  /** One-line points, rendered as an ordered list. Each point must
   *  stand on its own; the component doesn't support nested structure. */
  points: readonly string[];
}

export const FALLBACK_CONSENT_SECTIONS: readonly RiskSection[] = [
  {
    heading:
      "If liquidation of liquid collateral fails (like in Abnormal Market conditions, when slippage > 6%, thin liquidity, DEX revert, or any other runtime failure)",
    points: [
      "Lender receive the collateral in-kind — NOT the lending asset.",
      "If collateral value < amount due: you receive ALL collateral; the borrower receives nothing; no shortfall top-up.",
      "If collateral value ≥ amount due: you receive collateral equal to the amount owed at oracle price; remainder returns to the borrower after charges.",
    ],
  },
  {
    heading:
      "If the borrower defaults on a loan with illiquid assets (illiquid lending asset, illiquid collateral, or both)",
    points: [
      "Full collateral transfers to you in-kind, regardless of its market value.",
      'No partition between "amount owed" and "remainder" — Lender takes ALL collateral.',
      "The asset received may be worth materially more or less than the amount owed. No warranty on value, liquidity, or resaleability.",
    ],
  },
  {
    heading: "Acknowledgement",
    points: [
      "Recovery may be materially less than the asset you lent. You may receive assets other than the one lent. No further claim on the borrower, the protocol, its contributors, or any third party.",
      "Proceeding records your binding agreement on-chain against your wallet for the full life of this position.",
    ],
  },
];

/**
 * Flattened single-paragraph form kept for any legacy consumer still
 * rendering the old inline paragraph. New call sites should mount
 * `<RiskDisclosures />` instead.
 */
export const FALLBACK_CONSENT_BODY = FALLBACK_CONSENT_SECTIONS.flatMap((s) => [
  s.heading + ":",
  ...s.points.map((p) => `• ${p}`),
]).join(" ");
