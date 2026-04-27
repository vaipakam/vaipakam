/**
 * Centralized registry of card-level help content. Each entry maps a
 * stable `id` (`<page>.<card>` convention) to an i18n key (or a pair
 * of role-keyed i18n keys) for the InfoTip summary, plus an optional
 * "Learn more →" link to the canonical documentation.
 *
 * Why a registry instead of inline strings on each card?
 *
 *   - Single place to audit / edit copy, so non-engineers can update
 *     descriptions without touching JSX.
 *   - All summaries live under the `cardHelp.*` namespace in the
 *     locale JSON files (en.json + 9 translated locales) — adding a
 *     locale is one file edit, no code changes.
 *   - Missing entries return undefined gracefully — adding a `<CardInfo
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

/** Role-keyed summary variant. Used on cards in the Create Offer flow
 *  where lender and borrower see the same physical card but the action
 *  framing differs. The CreateOffer call site passes
 *  `role={form.offerType}` to <CardInfo>, which picks the right
 *  variant and appends `:lender` / `:borrower` to the docs anchor. */
export interface RoleKeyedI18nKey {
  lender: string;
  borrower: string;
}

export interface CardHelpEntry {
  /** i18n key under the `cardHelp.*` namespace, or — for role-keyed
   *  cards — a `{ lender, borrower }` pair of i18n keys. CardInfo
   *  resolves via `t(...)` when rendering. */
  summary: string | RoleKeyedI18nKey;
  /** Optional URL the "Learn more →" link points at. External (GitHub
   *  README / spec for now) opens in a new tab. Omit when the
   *  summary is self-contained. */
  learnMoreHref?: string;
}

const README = "https://github.com/vaipakam/vaipakam/blob/main/README.md";
const TOKENOMICS =
  "https://github.com/vaipakam/vaipakam/blob/main/docs/TokenomicsTechSpec.md";

export const CARD_HELP: Record<string, CardHelpEntry> = {
  // ── Dashboard ──────────────────────────────────────────────────────────
  "dashboard.your-escrow": {
    summary: "cardHelp.dashboardYourEscrow",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "dashboard.your-loans": {
    summary: "cardHelp.dashboardYourLoans",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "dashboard.vpfi-panel": {
    summary: "cardHelp.dashboardVpfiPanel",
    learnMoreHref: `${TOKENOMICS}#1-token-overview`,
  },
  "dashboard.fee-discount-consent": {
    summary: "cardHelp.dashboardFeeDiscountConsent",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Offer Book ─────────────────────────────────────────────────────────
  "offer-book.filters": {
    summary: "cardHelp.offerBookFilters",
    learnMoreHref: `${README}#4-offer-book-display`,
  },
  "offer-book.your-active-offers": {
    summary: "cardHelp.offerBookYourActiveOffers",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "offer-book.lender-offers": {
    summary: "cardHelp.offerBookLenderOffers",
    learnMoreHref: `${README}#5-loan-initiation`,
  },
  "offer-book.borrower-offers": {
    summary: "cardHelp.offerBookBorrowerOffers",
    learnMoreHref: `${README}#5-loan-initiation`,
  },

  // ── Create Offer ───────────────────────────────────────────────────────
  "create-offer.offer-type": {
    summary: "cardHelp.createOfferOfferType",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.lending-asset": {
    summary: {
      lender: "cardHelp.createOfferLendingAssetLender",
      borrower: "cardHelp.createOfferLendingAssetBorrower",
    },
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.nft-details": {
    summary: "cardHelp.createOfferNftDetails",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.collateral": {
    summary: {
      lender: "cardHelp.createOfferCollateralLender",
      borrower: "cardHelp.createOfferCollateralBorrower",
    },
    learnMoreHref: `${README}#1-supported-assets-and-networks-phase-1`,
  },
  "create-offer.risk-disclosures": {
    summary: {
      lender: "cardHelp.createOfferRiskDisclosuresLender",
      borrower: "cardHelp.createOfferRiskDisclosuresBorrower",
    },
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "create-offer.advanced-options": {
    summary: "cardHelp.createOfferAdvancedOptions",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Claim Center ──────────────────────────────────────────────────────
  "claim-center.claims": {
    summary: {
      lender: "cardHelp.claimCenterClaimsLender",
      borrower: "cardHelp.claimCenterClaimsBorrower",
    },
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Refinance ─────────────────────────────────────────────────────────
  "refinance.overview": {
    summary: "cardHelp.refinanceOverview",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "refinance.position-summary": {
    summary: "cardHelp.refinancePositionSummary",
  },
  "refinance.step-1-post-offer": {
    summary: "cardHelp.refinanceStep1PostOffer",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "refinance.step-2-complete": {
    summary: "cardHelp.refinanceStep2Complete",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Preclose ──────────────────────────────────────────────────────────
  "preclose.overview": {
    summary: "cardHelp.precloseOverview",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "preclose.position-summary": {
    summary: "cardHelp.preclosePositionSummary",
  },
  "preclose.in-progress": {
    summary: "cardHelp.precloseInProgress",
  },
  "preclose.choose-path": {
    summary: "cardHelp.precloseChoosePath",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Early Withdrawal ──────────────────────────────────────────────────
  "early-withdrawal.overview": {
    summary: "cardHelp.earlyWithdrawalOverview",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "early-withdrawal.position-summary": {
    summary: "cardHelp.earlyWithdrawalPositionSummary",
  },
  "early-withdrawal.initiate-sale": {
    summary: "cardHelp.earlyWithdrawalInitiateSale",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Public Dashboard / Analytics ──────────────────────────────────────
  "public-dashboard.overview": {
    summary: "cardHelp.publicDashboardOverview",
    learnMoreHref: README,
  },
  "public-dashboard.combined": {
    summary: "cardHelp.publicDashboardCombined",
  },
  "public-dashboard.per-chain": {
    summary: "cardHelp.publicDashboardPerChain",
  },
  "public-dashboard.vpfi-transparency": {
    summary: "cardHelp.publicDashboardVpfiTransparency",
    learnMoreHref: `${TOKENOMICS}#1-token-overview`,
  },
  "public-dashboard.transparency": {
    summary: "cardHelp.publicDashboardTransparency",
  },

  // ── Keeper Settings ───────────────────────────────────────────────────
  "keeper-settings.overview": {
    summary: "cardHelp.keeperSettingsOverview",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "keeper-settings.approved-list": {
    summary: "cardHelp.keeperSettingsApprovedList",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── NFT Verifier ──────────────────────────────────────────────────────
  "nft-verifier.lookup": {
    summary: "cardHelp.nftVerifierLookup",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Alerts ────────────────────────────────────────────────────────────
  "alerts.overview": {
    summary: "cardHelp.alertsOverview",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "alerts.threshold-ladder": {
    summary: "cardHelp.alertsThresholdLadder",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "alerts.delivery-channels": {
    summary: "cardHelp.alertsDeliveryChannels",
  },

  // ── Allowances ────────────────────────────────────────────────────────
  "allowances.list": {
    summary: "cardHelp.allowancesList",
    learnMoreHref: `${README}#3-offer-creation`,
  },

  // ── Loan Details ──────────────────────────────────────────────────────
  "loan-details.overview": {
    summary: "cardHelp.loanDetailsOverview",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "loan-details.terms": {
    summary: "cardHelp.loanDetailsTerms",
    learnMoreHref: `${README}#5-loan-initiation`,
  },
  "loan-details.collateral-risk": {
    summary: {
      lender: "cardHelp.loanDetailsCollateralRiskLender",
      borrower: "cardHelp.loanDetailsCollateralRiskBorrower",
    },
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "loan-details.parties": {
    summary: "cardHelp.loanDetailsParties",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "loan-details.actions": {
    summary: {
      lender: "cardHelp.loanDetailsActionsLender",
      borrower: "cardHelp.loanDetailsActionsBorrower",
    },
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Buy VPFI ──────────────────────────────────────────────────────────
  "buy-vpfi.overview": {
    summary: "cardHelp.buyVpfiOverview",
    learnMoreHref: `${TOKENOMICS}#3-vpfi-issuance--buy-flow`,
  },
  "buy-vpfi.discount-status": {
    summary: "cardHelp.buyVpfiDiscountStatus",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },
  "buy-vpfi.buy": {
    summary: "cardHelp.buyVpfiBuy",
    learnMoreHref: `${TOKENOMICS}#3-vpfi-issuance--buy-flow`,
  },
  "buy-vpfi.deposit": {
    summary: "cardHelp.buyVpfiDeposit",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },
  "buy-vpfi.unstake": {
    summary: "cardHelp.buyVpfiUnstake",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Rewards ───────────────────────────────────────────────────────────
  "rewards.overview": {
    summary: "cardHelp.rewardsOverview",
    learnMoreHref: `${TOKENOMICS}#4-platform-interaction-rewards`,
  },
  "rewards.claim": {
    summary: "cardHelp.rewardsClaim",
    learnMoreHref: `${TOKENOMICS}#4-platform-interaction-rewards`,
  },
  "rewards.withdraw-staked": {
    summary: "cardHelp.rewardsWithdrawStaked",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Activity ───────────────────────────────────────────────────────────
  "activity.feed": {
    summary: "cardHelp.activityFeed",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
};

/** Lookup helper. Returns `undefined` (not an error) when the id has
 *  no registered entry yet — `<CardInfo id="..."/>` then renders null
 *  so the card displays without a help icon during content rollout. */
export function getCardHelp(id: string): CardHelpEntry | undefined {
  return CARD_HELP[id];
}
