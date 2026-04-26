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

/** Role-keyed summary variant. Used on cards in the Create Offer flow
 *  where lender and borrower see the same physical card but the action
 *  framing differs (lender "you offer X" vs borrower "you request X"
 *  on Lending Asset; lender "ask the borrower to lock" vs borrower
 *  "lock yourself" on Collateral). The CreateOffer call site passes
 *  `role={form.offerType}` to <CardInfo>, which picks the right
 *  variant and appends `:lender` / `:borrower` to the docs anchor. */
export interface RoleKeyedSummary {
  lender: string;
  borrower: string;
}

export interface CardHelpEntry {
  /** 1–2 sentence tooltip summary. Plain text — no HTML / markdown.
   *  Shown inside the InfoTip bubble. Keep under ~240 chars so the
   *  bubble stays compact at the 320px max-width clamp.
   *
   *  Plain string — same copy regardless of viewer role.
   *  Role-keyed object — picked by <CardInfo role={...}>; falls back
   *  to lender variant when role is not supplied so a stray usage
   *  still renders something meaningful. */
  summary: string | RoleKeyedSummary;
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
    summary:
      "Your dedicated UUPS-proxy escrow contract on this chain. " +
      "Every user gets one. All collateral, lent assets, and locked VPFI " +
      "live here — never commingled with other users.",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "dashboard.your-loans": {
    summary:
      "Every loan you are part of on this chain — as lender, borrower, " +
      "or both. Each row links to the full position page with HF, LTV, " +
      "collateral, repay, and claim controls.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "dashboard.vpfi-panel": {
    summary:
      "VPFI is the protocol token. This card shows your wallet + escrow " +
      "balance on this chain, your share of circulating supply, and the " +
      "remaining mintable cap. Canonical chain mints/burns; mirror chains " +
      "lock/release via LayerZero OFT.",
    learnMoreHref: `${TOKENOMICS}#1-token-overview`,
  },
  "dashboard.fee-discount-consent": {
    summary:
      "Opt-in for the protocol to pay discounted fees in VPFI from your " +
      "escrow. Discount scales with your escrow VPFI balance: 10% at Tier 1 " +
      "(≥100 VPFI), 15% Tier 2 (≥1k), 20% Tier 3 (≥5k), 24% Tier 4 (>20k).",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Offer Book ─────────────────────────────────────────────────────────
  "offer-book.filters": {
    summary:
      "Narrow the market lists below by asset, side, status, and other " +
      "criteria. Filters apply to Lender / Borrower offers — your own " +
      "active offers (shown above) are always visible regardless.",
    learnMoreHref: `${README}#4-offer-book-display`,
  },
  "offer-book.your-active-offers": {
    summary:
      "Offers YOU created on this chain that haven't been filled yet. " +
      "Cancel any time before someone accepts; once accepted, the loan " +
      'lifecycle moves to "Your Loans" on the Dashboard.',
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "offer-book.lender-offers": {
    summary:
      "Offers posted by lenders ready to lend. A borrower accepting one " +
      "initiates a loan: the borrower's collateral is locked, the principal " +
      "asset arrives in the borrower's wallet, and interest accrues until " +
      "repayment. HF must be ≥ 1.5 at initiation.",
    learnMoreHref: `${README}#5-loan-initiation`,
  },
  "offer-book.borrower-offers": {
    summary:
      "Offers posted by borrowers who've locked their collateral and are " +
      "waiting for a lender. A lender accepting one funds the loan with " +
      "the principal asset; the lender earns the offer's rate over the " +
      "duration, less the 1% treasury cut on interest.",
    learnMoreHref: `${README}#5-loan-initiation`,
  },

  // ── Create Offer ───────────────────────────────────────────────────────
  "create-offer.offer-type": {
    summary:
      "Pick a side of the market: Lender (lender supplies the principal " +
      "asset and earns interest) or Borrower (borrower locks collateral and " +
      "requests principal). Rental sub-type lets NFT owners rent out " +
      "ERC-721 / ERC-1155-rentable NFTs for a daily fee instead of a loan.",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.lending-asset": {
    summary: {
      lender:
        "The principal asset and amount that you are willing to offer, plus " +
        "the interest rate (APR in %) and duration in days. Rate is fixed at " +
        "offer time; duration sets the grace window before the loan can " +
        "default.",
      borrower:
        "The principal asset and amount that you want from the lender, " +
        "plus the interest rate (APR in %) and duration in days. Rate is " +
        "fixed at offer time; duration sets the grace window before the " +
        "loan can default.",
    },
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.nft-details": {
    summary:
      "The NFT being rented out + the daily rental fee. ERC-4907 (ERC-721 " +
      "rentable) and ERC-1155-rentable standards are supported; the renter " +
      "pre-pays duration × daily-fee × (1 + 5% buffer) on accept.",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "create-offer.collateral": {
    summary: {
      lender:
        "How much you want the borrower to lock to secure the loan. Liquid " +
        "ERC-20s (Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math; " +
        "illiquid ERC-20s and NFTs have no on-chain valuation and require " +
        "both parties to consent to a full-collateral-on-default outcome.",
      borrower:
        "How much you are willing to lock to secure the loan. Liquid ERC-20s " +
        "(Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math; illiquid " +
        "ERC-20s and NFTs have no on-chain valuation and require both " +
        "parties to consent to a full-collateral-on-default outcome.",
    },
    learnMoreHref: `${README}#1-supported-assets-and-networks-phase-1`,
  },
  "create-offer.risk-disclosures": {
    summary:
      "Acknowledge the risks before signing. Smart-contract risk, oracle " +
      "risk (Chainlink staleness / liquidity drift), liquidation slippage " +
      "risk, and the no-recourse nature of illiquid-collateral defaults all " +
      "apply. Vaipakam is non-custodial — there is no support desk to undo " +
      "a bad position.",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "create-offer.advanced-options": {
    summary:
      "Fine-tune the offer parameters most users leave at defaults: offer " +
      "expiry, fee-discount opt-in, and any role-specific options the " +
      "protocol exposes. Safe to skip on a first offer.",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Claim Center ──────────────────────────────────────────────────────
  "claim-center.claims": {
    summary:
      "Funds become claimable after a loan settles — repaid, defaulted, or " +
      "liquidated. Lender claims unlock principal + interest (less the 1% " +
      "treasury cut). Borrower claims unlock returned collateral on full " +
      "repayment, or any unused VPFI rebate from the Loan Initiation Fee. " +
      "Each claim consumes the holder's Vaipakam position NFT.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Refinance ─────────────────────────────────────────────────────────
  "refinance.overview": {
    summary:
      "Roll your existing loan into a new one without unwinding collateral. " +
      "You post a Borrower offer for the refinance terms; once a lender " +
      "accepts, the protocol atomically pays off the old loan and opens the " +
      "new one in a single transaction. HF must be ≥ 1.5 on the new terms " +
      "for the swap to land.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "refinance.position-summary": {
    summary:
      "Snapshot of the loan you're refinancing — outstanding principal, " +
      "interest accrued, current HF/LTV, and the collateral that stays " +
      "locked across the swap. Use these numbers to size the new offer.",
  },
  "refinance.step-1-post-offer": {
    summary:
      "Step 1 — post a Borrower offer for the new terms (asset, amount, APR, " +
      "duration, collateral). Other lenders see this in the Offer Book; the " +
      "old loan stays open and accruing until a lender accepts.",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "refinance.step-2-complete": {
    summary:
      "Step 2 — once a lender accepts your refinance offer, complete the " +
      "swap. The protocol atomically (a) repays the old loan from the new " +
      "principal, (b) opens the new loan, (c) keeps your collateral in " +
      "escrow throughout. No window where the position is unsecured.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Preclose ──────────────────────────────────────────────────────────
  "preclose.overview": {
    summary:
      "Close your loan early — before the duration ends. Two paths: Direct " +
      "(repay the full outstanding balance now) or Offset (sell some collateral " +
      "to cover the balance, get the remainder back). Useful when you no " +
      "longer want the position open or to free collateral early.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "preclose.position-summary": {
    summary:
      "Snapshot of the loan you're closing early — outstanding principal, " +
      "interest accrued so far, current HF/LTV. Pre-Phase-5 a flat early-" +
      "close penalty applied; in Phase 5 the time-weighted VPFI rebate / " +
      "fee math handles it without a separate penalty.",
  },
  "preclose.in-progress": {
    summary:
      "An offset preclose is mid-flight — collateral is being sold via the " +
      "swap router. You can complete (settles the loan from the proceeds) " +
      "or, if the price moved, cancel and try again at a fresh quote.",
  },
  "preclose.choose-path": {
    summary:
      "Direct: pay the full outstanding balance now from your wallet. " +
      "Offset: sell part of your collateral on a DEX, use the proceeds to " +
      "repay, get whatever is left back. Direct is cheaper if you have the " +
      "cash; Offset is the path when you don't.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Early Withdrawal ──────────────────────────────────────────────────
  "early-withdrawal.overview": {
    summary:
      "Lender-side early-exit. Sell the loan's claim NFT through the protocol " +
      "before the duration ends. The position NFT (which represents the " +
      "right to repayment + interest) is auctioned to a buyer; you receive " +
      "the sale proceeds, the buyer takes over the lender side.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "early-withdrawal.position-summary": {
    summary:
      "Snapshot of the lender position you're exiting — principal, accrued " +
      "interest, time remaining, current HF/LTV of the borrower. These " +
      "numbers anchor the price the buyer is willing to pay.",
  },
  "early-withdrawal.initiate-sale": {
    summary:
      "Step 1 — initiate the sale. The protocol lists your lender NFT for " +
      "the asking price you set; once a buyer accepts, the proceeds settle " +
      "to your wallet and the buyer becomes the new lender of record. You " +
      "can cancel before a buyer accepts.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Public Dashboard / Analytics ──────────────────────────────────────
  "public-dashboard.overview": {
    summary:
      "Aggregated protocol metrics derived entirely from on-chain contract " +
      "state and event logs across every supported chain. No wallet required, " +
      "no off-chain database — figures recompute live from the Diamond. ",
    learnMoreHref: README,
  },
  "public-dashboard.combined": {
    summary:
      "Top-line totals summed across every supported chain. The chains-covered " +
      "/ chains-unreachable counts tell you whether any RPC failed at fetch " +
      "time — the per-chain table below shows which.",
  },
  "public-dashboard.per-chain": {
    summary:
      "Per-chain split of the same metrics. Useful for spotting which chain " +
      "is carrying TVL or loan volume, and for confirming that mirror-chain " +
      "VPFI supplies sum to the canonical lock balance.",
  },
  "public-dashboard.vpfi-transparency": {
    summary:
      "On-chain VPFI accounting on this chain: total supply, circulating " +
      "supply (after subtracting protocol-held balances), and the live " +
      "mintable cap. Canonical chain mints/burns; mirror chains lock/release " +
      "via the OFT adapter so total cross-chain supply stays bounded.",
    learnMoreHref: `${TOKENOMICS}#1-token-overview`,
  },
  "public-dashboard.transparency": {
    summary:
      "Provenance of every figure on this page. Snapshot block, data " +
      "freshness, the Diamond address each metric was read from, and the " +
      "exact view function. You can re-derive any number on this page from " +
      "the linked block + function call.",
  },

  // ── Keeper Settings ───────────────────────────────────────────────────
  "keeper-settings.overview": {
    summary:
      "Keepers are delegated managers of your role on a loan. Approving a " +
      "keeper here delegates only your side, only for the actions you " +
      "authorise. Liquidations, repayments, adding collateral, and claiming " +
      "stay user-only — keepers cannot touch money-out paths. Up to 5 " +
      "approved keepers per wallet.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "keeper-settings.approved-list": {
    summary:
      "Each approved keeper carries a bitmask of permitted actions: complete " +
      "loan sale, complete offset, init early-withdraw, init preclose, " +
      "refinance. Edit a keeper to flip individual action bits. Removing a " +
      "keeper revokes the master entry on-chain — they instantly stop being " +
      "able to act on every loan.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── NFT Verifier ──────────────────────────────────────────────────────
  "nft-verifier.lookup": {
    summary:
      "Before buying a Vaipakam position NFT from another holder, paste the " +
      "contract address + token ID here. We confirm whether it was minted by " +
      "Vaipakam, which chain it lives on, the position's current state, and " +
      "the on-chain owner. The NFT is the bearer instrument for the loan's " +
      "claim — losing it loses the claim.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Alerts ────────────────────────────────────────────────────────────
  "alerts.overview": {
    summary:
      "Get a heads-up when your Health Factor falls toward the liquidation " +
      "threshold. An off-chain watcher polls your active loans every 5 min " +
      "and fires on band crossings — no gas, no on-chain state. Alerts fire " +
      "once per downgrade; climbing back to healthy re-arms the ladder.",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "alerts.threshold-ladder": {
    summary:
      "The HF bands that trigger alerts. Crossing into a more-dangerous band " +
      "(e.g. 1.5 → 1.2) fires once. The next alert only fires after you cross " +
      "another band. Climbing back above a band rearms it. Defaults are " +
      "tuned for liquid loans; tune higher if you carry volatile collateral.",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "alerts.delivery-channels": {
    summary:
      "Where alerts get delivered — Telegram bot DM and / or Push Protocol " +
      "wallet notifications. Both rails share the same threshold ladder " +
      "above; per-channel warn-levels are intentionally not exposed. Enable " +
      "one or both.",
  },

  // ── Allowances ────────────────────────────────────────────────────────
  "allowances.list": {
    summary:
      "Every ERC-20 approval your wallet has granted the Vaipakam Diamond on " +
      "this chain. Revoke any you no longer need in one click — sets allowance " +
      "to zero on-chain. Non-zero approvals appear first; the zero rows below " +
      "are a reference so you can confirm the list is clean.",
    learnMoreHref: `${README}#3-offer-creation`,
  },

  // ── Loan Details ──────────────────────────────────────────────────────
  "loan-details.overview": {
    summary:
      "Single-loan view. Shows terms, live HF/LTV, collateral, parties, and " +
      "every action available to you on this loan — repay, claim, liquidate, " +
      "preclose, refinance — depending on status and your role (lender / " +
      "borrower / third-party liquidator).",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
  "loan-details.terms": {
    summary:
      "Principal asset, original amount, fixed APR (bps), duration, and the " +
      "derived interest accrued so far. Terms are immutable once the loan " +
      "is initiated; refinancing creates a new loan rather than mutating this " +
      "one.",
    learnMoreHref: `${README}#5-loan-initiation`,
  },
  "loan-details.collateral-risk": {
    summary:
      "Collateral asset + amount, current Health Factor and LTV, and the " +
      "liquidation thresholds. Liquid collateral has live oracle math; " +
      "illiquid collateral (NFTs, tokens without a feed) is valued at $0 " +
      "on-chain — both parties consented to a full-transfer-on-default " +
      "outcome at offer accept.",
    learnMoreHref: `${README}#7-liquidation-and-default`,
  },
  "loan-details.parties": {
    summary:
      "Lender and borrower addresses, the per-user escrow proxies that hold " +
      "their assets, and the position NFTs each side received at loan-init. " +
      "Each NFT is the bearer instrument for that side's claim — losing it " +
      "loses the claim.",
    learnMoreHref: `${README}#3-offer-creation`,
  },
  "loan-details.actions": {
    summary:
      "All on-chain actions available on this loan from your role. Borrower " +
      "sees Repay (full / partial), Preclose, Refinance. Lender sees Claim " +
      "after settlement. Anyone (third-party liquidator included) can call " +
      "Liquidate when HF < 1 or grace expires. Disabled actions show a hover " +
      "reason.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },

  // ── Buy VPFI ──────────────────────────────────────────────────────────
  "buy-vpfi.overview": {
    summary:
      "Purchase VPFI at the fixed early-stage rate using ETH on any supported " +
      "chain. The canonical chain (Base) routes direct to the Diamond; every " +
      "other chain bridges via VPFIBuyAdapter + LayerZero round-trip. VPFI " +
      "always lands in your wallet on the chain you connected from — no chain " +
      "switch required.",
    learnMoreHref: `${TOKENOMICS}#3-vpfi-issuance--buy-flow`,
  },
  "buy-vpfi.discount-status": {
    summary:
      "Your active VPFI fee-discount tier on this chain. Tier is set by your " +
      "escrow VPFI balance: Tier 1 ≥100, Tier 2 ≥1k, Tier 3 ≥5k, Tier 4 >20k. " +
      "Discount only applies on liquid loans and only while the platform-level " +
      "consent toggle on the Dashboard is on. Escrow VPFI also counts as " +
      "staked and earns the 5% staking APR.",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },
  "buy-vpfi.buy": {
    summary:
      "Step 1 — convert ETH to VPFI. On the canonical chain you call the " +
      "Diamond directly; off-canonical you go through the buy adapter and a " +
      "LayerZero round-trip. Per-tx and rolling caps apply (see TokenomicsTechSpec). " +
      "VPFI is delivered to your wallet, not auto-deposited into escrow.",
    learnMoreHref: `${TOKENOMICS}#3-vpfi-issuance--buy-flow`,
  },
  "buy-vpfi.deposit": {
    summary:
      "Step 2 — move VPFI from your wallet into your escrow on this chain. " +
      "Always an explicit user action: the protocol never auto-funds escrow " +
      "after a buy. Required to qualify for fee discounts and the 5% staking " +
      "APR. Permit2 is used when available so a single signature replaces the " +
      "approve + transfer pair.",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },
  "buy-vpfi.unstake": {
    summary:
      "Move VPFI from your escrow back to your wallet on this chain. Reduces " +
      "your discount tier in real time — the time-weighted accumulator " +
      "re-stamps every open loan at the new (lower) balance immediately, so " +
      "an unstake is effective for fee-discount math from this moment forward.",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Rewards ───────────────────────────────────────────────────────────
  "rewards.overview": {
    summary:
      "Two reward streams accrue on this chain. Escrow-held VPFI earns a " +
      "passive 5% APR (staking pool). Every USD of interest you settle on " +
      "a loan earns you a daily share of the interaction pool. Both are " +
      "minted directly on the current chain when you claim — no bridging.",
    learnMoreHref: `${TOKENOMICS}#4-platform-interaction-rewards`,
  },
  "rewards.claim": {
    summary:
      "Mints any pending VPFI from both reward streams (staking + interaction) " +
      "into your wallet, on the current chain, in one transaction. The " +
      "interaction pool finalizes daily — pending interaction rewards become " +
      "claimable shortly after each settlement window closes.",
    learnMoreHref: `${TOKENOMICS}#4-platform-interaction-rewards`,
  },
  "rewards.withdraw-staked": {
    summary:
      "Move VPFI out of your escrow back to your wallet. Withdrawn VPFI " +
      "stops accruing the 5% staking APR and no longer counts toward your " +
      "fee-discount tier — the time-weighted accumulator immediately re-stamps " +
      "every open loan at the new (lower) balance.",
    learnMoreHref: `${TOKENOMICS}#6-fee-discounts-and-vpfi-utility`,
  },

  // ── Activity ───────────────────────────────────────────────────────────
  "activity.feed": {
    summary:
      "On-chain events involving your connected wallet on the active chain — " +
      "offers you created or accepted, loans, repayments, claims, " +
      "liquidations, NFT mints/burns, VPFI buys/stakes/unstakes. Sourced " +
      "live from Diamond event logs (no backend), grouped by transaction " +
      "and ordered newest-first.",
    learnMoreHref: `${README}#6-loan-closure--repayment`,
  },
};

/** Lookup helper. Returns `undefined` (not an error) when the id has
 *  no registered entry yet — `<CardInfo id="..."/>` then renders null
 *  so the card displays without a help icon during content rollout. */
export function getCardHelp(id: string): CardHelpEntry | undefined {
  return CARD_HELP[id];
}
