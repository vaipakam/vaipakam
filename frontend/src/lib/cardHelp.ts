/**
 * Centralized registry of card-level help content. Each entry maps a
 * stable `id` (`<page>.<card>` convention) to a short tooltip blurb +
 * an optional "Learn more →" link to the canonical documentation.
 *
 * Why a registry instead of inline strings on each card?
 *
 *   - Single place to audit / edit copy, so non-engineers can update
 *     descriptions without touching JSX.
 *   - The same blurbs feed multiple surfaces in Phase 3+: Features /
 *     How It Works on the landing page can pull the same `summary`
 *     for high-visibility concepts; an in-app `/help/<id>` route
 *     could render the long-form `learnMoreHref` content directly.
 *   - Missing entries return null gracefully — adding a `<CardInfo
 *     id="..."/>` to a card before its content is drafted just hides
 *     the icon, no broken render.
 *
 * Naming convention: `<page>.<card-slug>`
 *   page       — pathname segment ("dashboard", "offer-book", "create-offer", …)
 *   card-slug  — short kebab-case identifier for the card on that page
 *
 * `learnMoreHref` points at GitHub-rendered README / TokenomicsTechSpec
 * sections for now. When the dedicated docs site lands (Phase 3), each
 * URL gets swapped for the in-app `/help/<id>` route — single edit per
 * entry, no JSX touched.
 */

export interface CardHelpEntry {
  /** 1–2 sentence tooltip summary. Plain text — no HTML / markdown.
   *  Shown inside the InfoTip bubble. Keep under ~240 chars so the
   *  bubble stays compact at the 320px max-width clamp. */
  summary: string;
  /** Optional URL the "Learn more →" link points at. External (GitHub
   *  README / spec for now) opens in a new tab. Omit when the
   *  summary is self-contained. */
  learnMoreHref?: string;
}

const README = 'https://github.com/vaipakam/vaipakam/blob/main/README.md';
const TOKENOMICS =
  'https://github.com/vaipakam/vaipakam/blob/main/docs/TokenomicsTechSpec.md';

export const CARD_HELP: Record<string, CardHelpEntry> = {
  // ── Dashboard ──────────────────────────────────────────────────────────
  'dashboard.your-escrow': {
    summary:
      'Your dedicated UUPS-proxy escrow contract on this chain. ' +
      'Every user gets one. All collateral, lent assets, and locked VPFI ' +
      'live here — never commingled with other users.',
    learnMoreHref: `${README}#3-offer-creation`,
  },
  'dashboard.your-loans': {
    summary:
      'Every loan you are part of on this chain — as lender, borrower, ' +
      'or both. Each row links to the full position page with HF, LTV, ' +
      'collateral, repay, and claim controls.',
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  'dashboard.vpfi-panel': {
    summary:
      'VPFI is the protocol token. This card shows your wallet + escrow ' +
      'balance on this chain, your share of circulating supply, and the ' +
      'remaining mintable cap. Canonical chain mints/burns; mirror chains ' +
      'lock/release via LayerZero OFT.',
    learnMoreHref: `${TOKENOMICS}#1-token-overview`,
  },
  'dashboard.fee-discount-consent': {
    summary:
      'Opt-in for the protocol to pay discounted fees in VPFI from your ' +
      'escrow. Discount scales with your escrow VPFI balance: 10% at Tier 1 ' +
      '(≥100 VPFI), 15% Tier 2 (≥1k), 20% Tier 3 (≥5k), 24% Tier 4 (>20k).',
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },
};

/** Lookup helper. Returns `undefined` (not an error) when the id has
 *  no registered entry yet — `<CardInfo id="..."/>` then renders null
 *  so the card displays without a help icon during content rollout. */
export function getCardHelp(id: string): CardHelpEntry | undefined {
  return CARD_HELP[id];
}
