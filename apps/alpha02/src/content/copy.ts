/**
 * Every user-facing string in alpha02, in one module.
 *
 * Why centralized: (1) the naive-user wording rules from
 * docs/DesignsAndPlans/BasicUserUXSimplification.md are enforceable in
 * one place; (2) localization later becomes a matter of swapping this
 * module for an i18n catalog without touching pages.
 *
 * Wording rules encoded here (do not violate when editing):
 *   - No protocol jargon in Basic strings: no "matcher share", "bps",
 *     "canonical tier cache", "standing intent", "fill mode".
 *   - Never present lender yield as guaranteed ("expected interest if
 *     the borrower repays on time").
 *   - VPFI is optional fee utility — never a prerequisite, never
 *     "staking yield", never sold by the protocol.
 *   - Errors are written as next steps, not failures.
 *   - No internal rollout language ("Phase 1", "pending diamond") on
 *     action-blocking surfaces.
 */

export const copy = {
  app: {
    name: 'Vaipakam',
    tagline: 'Lend, borrow, and rent NFTs — directly with other people.',
  },

  home: {
    title: 'What would you like to do?',
    lede: 'Pick a job to get started. You can switch to Advanced mode any time in Settings.',
    jobs: {
      borrow: {
        title: 'Borrow assets',
        blurb: 'Lock collateral you own, receive the tokens you need.',
      },
      lend: {
        title: 'Earn by lending',
        blurb: 'Offer your tokens to borrowers and earn interest if they repay.',
      },
      rent: {
        title: 'Rent or lend an NFT',
        blurb: 'Earn fees from an NFT you own, or get temporary use of one.',
      },
      manage: {
        title: 'Manage my positions',
        blurb: 'See your loans and rentals, repay, add collateral, or claim.',
      },
    },
  },

  wallet: {
    connect: 'Connect wallet',
    connectFirst: 'Connect a wallet to continue.',
    unsupportedNetwork: (chainNames: string) =>
      `This network isn’t supported. Vaipakam is available on ${chainNames}. Switch networks to continue.`,
    switchNetwork: 'Switch network',
  },

  checks: {
    walletConnected: 'Wallet connected',
    supportedChain: 'On a supported network',
    balanceSufficient: (asset: string) => `Enough ${asset} in your wallet`,
    tokenValid: 'Asset recognised as a token',
    consent: 'Risk disclosures and terms accepted',
  },

  receipt: {
    heading: 'Review before you sign',
    youReceive: 'You receive',
    youLock: 'You lock',
    youMayOwe: 'You may owe',
    youCanLose: 'You can lose',
    fees: 'Fees',
    whenThisEnds: 'When this ends',
    gasNote: 'Network gas is separate from Vaipakam protocol fees.',
  },

  consentLabel: 'I understand and agree to the Risk Disclosures and Vaipakam Terms.',

  match: {
    borrowTitle: 'Lenders ready to fund you now',
    borrowLede:
      'These offers match your asset. Accepting one opens the loan immediately — you take the offer’s full amount and terms.',
    lendTitle: 'Borrowers waiting for funding',
    lendLede:
      'These requests match your asset. Funding one opens the loan immediately at the request’s terms.',
    wholeOfferNote: 'Offers are taken whole — the amount shown is what the loan will be.',
    choose: 'Choose',
    emptyBorrow: 'No matching offers right now.',
    emptyLend: 'No matching requests right now.',
    orPostBorrow: 'Post my own borrow request instead',
    orPostLend: 'Post my own lending offer instead',
    unavailable:
      'We couldn’t load matching offers right now. You can still post your own below.',
    loanOpened: 'Loan opened',
    borrowerNext:
      'The funds are in your Vaipakam Vault and your collateral is locked. Repay by the due date to get it back — everything is under My positions.',
    lenderNext:
      'Your funds are lent and the borrower’s collateral is locked. Track repayment under My positions; you’ll claim your funds back after they repay.',
    wrongSide:
      'That link points to the other side of the market — a lending offer is accepted from Borrow, a borrow request from Lend.',
    wrongKind:
      'That offer involves an NFT — open it from the NFT Rental page instead.',
    ownOffer:
      'That’s your own offer — you can cancel it from My positions, but you can’t accept it yourself.',
    offerGone:
      'That offer is no longer open. Browse current matches below or post your own.',
    counterpartyBlocked:
      'The other side of this offer can’t transact right now (compliance flag), so it can’t be accepted. Nothing was sent.',
    offerNotFound:
      'We couldn’t find that offer — the link may be old, or the data source is catching up. Browse current offers below.',
    wrongChainLink: (chainName: string) =>
      `That link points to an offer on ${chainName}. Switch to that network (top of the page), then open the link again — offer numbers repeat across networks, so we won’t guess.`,
    termsChanged:
      'This offer’s terms changed since you reviewed it. Nothing was sent — please review the updated offer.',
    illiquidWarning:
      'One side of this deal isn’t priced by the protocol. If it ends in default, the entire collateral transfers directly — there is no automatic price-based liquidation. Only proceed if you accept that.',
    interestModeFullTerm:
      'Interest is full-term: the whole term’s interest applies even if the loan is repaid early.',
    interestModeProRata:
      'Interest accrues day by day — repaying early costs less.',
    interestModeProRataLender:
      'Interest accrues day by day — if the borrower repays early, you earn less.',
    liquidityChecking:
      'Checking how these assets are priced by the protocol…',
    liquidityCheckFailed:
      'We couldn’t check how these assets are priced, and that check decides an important warning — signing stays paused until it succeeds.',
  },

  borrow: {
    title: 'Borrow assets',
    lede: 'Tell us what you need and what you can lock as collateral. We’ll show you exactly what you’d owe before anything is signed.',
    postRequest: 'Post borrow request',
    posted: 'Borrow request posted',
    postedNext:
      'Your collateral is locked while the request is open. Funds arrive only when a lender accepts — we’ll show the loan under My positions.',
    collateralWarning:
      'If you do not repay on time, the lender can receive your collateral.',
    lockNow:
      'Your collateral is locked when you post this request. You can cancel before a lender accepts to unlock it.',
  },

  lend: {
    title: 'Earn by lending',
    lede: 'Choose what to lend and the return you want. Lending is choosing a risk, not just a yield — you’ll see the downside before you sign.',
    postOffer: 'Post lending offer',
    posted: 'Lending offer posted',
    postedNext:
      'Your tokens are locked while the offer is open. When a borrower accepts, the loan appears under My positions. You can cancel before acceptance to unlock your tokens.',
    yieldNotGuaranteed: 'Expected interest if the borrower repays on time.',
    defaultOutcome:
      'If the borrower defaults, your recovery depends on their collateral.',
  },

  rent: {
    title: 'Rent or lend an NFT',
    lede: 'NFT rentals give temporary use rights — never ownership. The NFT stays locked in its owner’s vault for the whole rental.',
    ownPath: 'I own an NFT to rent out',
    ownPathBlurb: 'Set a daily fee — renters prepay the whole rental up front.',
    wantPath: 'I want to rent an NFT',
    wantPathBlurb: 'Pay up front, use the NFT until the rental ends.',
    custodyNote:
      'The NFT never leaves vault custody. The renter receives temporary use rights only — not ownership.',
    postListing: 'Post rental listing',
    listingPosted: 'Rental listing posted',
    listingPostedNext:
      'Your NFT is held in your vault while the listing is open. When a renter accepts, the rental appears under My positions; cancel the listing any time before that to get the NFT back.',
    acceptRental: 'Rent this NFT',
    rentalOpened: 'Rental started',
    rentalOpenedNext:
      'You now hold the use rights until the rental ends — the NFT itself stays in the owner’s vault. Your prepaid fees cover the whole term; close on time and the buffer comes back to you.',
    bufferNote: (pct: string) =>
      `Renters prepay the full term plus a ${pct} refundable buffer. Close the rental on time and the buffer is returned.`,
    checkOwnNft: 'You own this NFT',
    checkNotOwner:
      'The connected wallet doesn’t own this NFT — check the contract address and token id.',
    browseTitle: 'NFTs available to rent',
    browseEmpty: 'No rental listings right now.',
    browseUnavailable:
      'We couldn’t load rental listings right now. Please try again in a moment.',
    notDebt:
      'A rental is not a loan: there’s nothing to repay — your fees are prepaid and your rights simply end when the term does.',
    no4907Warning:
      'Heads up: this NFT collection doesn’t support the on-chain rental standard (ERC-4907). Renting still works — Vaipakam tracks the renter’s use rights in your vault — but apps and games outside Vaipakam won’t recognise the renter.',
    no4907Unknown:
      'We couldn’t check whether this NFT collection supports the on-chain rental standard (ERC-4907). If it doesn’t, apps outside Vaipakam won’t recognise the renter — renting inside Vaipakam still works.',
    vpfiPrepayListing:
      'This listing asks to be paid in VPFI, which rentals don’t allow — it can’t be accepted. Please pick a different listing.',
    vpfiCheckRetry:
      'We couldn’t verify this listing’s payment asset just now — nothing was sent or approved. Please try again in a moment.',
    vpfiPrepayNotAllowed:
      'VPFI can’t be used as the rental payment asset — pick another token.',
  },

  preclose: {
    title: 'Close this loan early',
    blurb:
      'Pay everything now and close the loan today — your collateral is released immediately after.',
    fullTermNote:
      'This loan uses full-term interest, so closing early still pays the whole term’s interest.',
    proRataNote:
      'This loan accrues interest day by day, so closing early pays only what has accrued.',
    action: 'Close early',
    confirm: 'Confirm — pay and close now',
    done:
      'Loan closed early. Your collateral is ready — claim it below or from the Claim Center.',
    checking: 'Checking whether this loan can close early…',
    checkFailed:
      'We couldn’t read this loan’s close-early cost right now — retrying. Repaying normally stays available below.',
  },

  refinance: {
    title: 'Refinance this loan',
    blurb:
      'Post a request for a new loan on better terms. The moment a lender accepts it, your current loan is paid off and closed automatically in the same transaction — your collateral moves to the new loan without ever unlocking.',
    rateLabel: 'Highest yearly rate you’d accept',
    durationLabel: 'New loan length (days)',
    action: 'Review refinance request',
    confirm: 'Confirm — post refinance request',
    // The payoff wording is deliberately ALWAYS full-term: the
    // contract pays the exiting lender principal + full-term interest
    // on the remaining committed term REGARDLESS of the loan's stored
    // interest mode, and no rate shortfall applies (it was removed —
    // full-term is the lender's maximum entitlement).
    payoffNote:
      'The old loan’s payoff is always principal plus the full remaining term’s interest — even if the loan normally accrues day by day. That is the exiting lender’s fixed entitlement on an early exit.',
    walletNote: (topUp: string) =>
      `The payoff is pulled from your wallet automatically at the moment a lender accepts. The new loan’s money arrives in the same transaction, so keep about ${topUp} spare in your wallet (the interest portion plus the new loan’s initiation fee) while the request is open.`,
    shortIsSafe:
      'If your wallet is short when a lender tries to accept, the acceptance simply fails — nothing is taken and your current loan continues unchanged.',
    periodicWarning:
      'This loan pays interest on a periodic schedule. If a payment period becomes overdue while the request is open, a lender’s acceptance will fail until the period is settled — keep the loan’s payments current.',
    done:
      'Refinance request posted. When a lender accepts it, this loan closes automatically — you don’t need to do anything else. You can cancel the request below any time before that.',
    pending: (offerId: string) =>
      `Refinance request #${offerId} is live. When a lender accepts it, this loan closes automatically in the same transaction.`,
    pendingAccepted:
      'Your refinance request was accepted — this loan is being replaced by the new one. Refresh in a moment to see the final state.',
    cancel: 'Cancel refinance request',
    cancelled: 'Refinance request cancelled — this loan continues unchanged.',
    checking: 'Checking this loan’s refinance details…',
    checkFailed:
      'We couldn’t read this loan’s refinance details right now — retrying.',
    guardrailNote:
      'Your request carries on-chain guardrails: it can only complete at or below the rate you set here, and only for a new loan ending within the window you reviewed.',
  },

  positions: {
    title: 'My positions',
    lede: 'Your loans and rentals, with the one action each needs right now.',
    emptyTitle: 'No active positions yet',
    emptyBody: 'Borrow or lend to get started.',
    unavailable:
      'We couldn’t load your positions right now. Your funds are unaffected — please try again in a moment.',
    roleBorrower: 'You borrowed',
    roleLender: 'You lent',
    whatIfNothingBorrower: (collateral: string) =>
      `If you do nothing and the loan passes its due date and grace period, the lender can receive your ${collateral} collateral.`,
    whatIfNothingLender:
      'If the borrower does not repay by the due date plus grace period, you can claim their collateral.',
  },

  claims: {
    title: 'Claim Center',
    lede: 'Money and assets that are ready for you to collect.',
    empty: 'Nothing to claim right now.',
    unavailable:
      'We couldn’t load your claims right now. Your funds are unaffected — please try again in a moment.',
    claim: 'Claim',
    claimed: 'Claim complete.',
  },

  offers: {
    title: 'Offer Book',
    lede: 'Open lending offers and borrow requests from other users.',
    emptyTitle: 'No open offers right now',
    emptyBody: 'Create your own offer and let the other side come to you.',
    unavailable:
      'We couldn’t load the offer book right now. Please try again in a moment.',
    lenderOffer: 'Lending offer',
    borrowerOffer: 'Borrow request',
  },

  vpfi: {
    title: 'VPFI fee discounts',
    optional:
      'Optional: hold VPFI in your vault to reduce protocol fees on eligible loans. You never need VPFI to use Vaipakam.',
    noGasDiscount: 'Your VPFI discount does not reduce network gas.',
    withdrawWarning: 'Withdrawing VPFI can lower future fee discounts.',
    notOnThisChain: (chain: string) =>
      `VPFI deposits aren’t available on ${chain} yet. Everything else on Vaipakam works without VPFI.`,
    tokenChanged:
      'The VPFI token configuration changed since you reviewed. Nothing was approved — please check the updated numbers and try again.',
    tokenCheckRetry:
      'We couldn’t confirm the VPFI token just now — nothing was approved. Please try again in a moment.',
  },

  errors: {
    needMore: (asset: string) => `You need more ${asset} to continue.`,
    partialOverPrincipal:
      'That covers the loan’s whole remaining principal. Use “Repay this loan” instead — it settles the loan properly and releases your collateral.',
    notAToken:
      'That address doesn’t look like a token on this network. Double-check it or pick a suggested asset.',
    txRejected: 'You cancelled in your wallet. Nothing was sent.',
    txFailed:
      'The transaction didn’t go through. Nothing was taken beyond network gas. Please try again.',
    sanctionsBlocked:
      'This wallet is flagged by the sanctions oracle, so new positions and payouts are blocked. Nothing was sent. Repaying and closing existing positions stays open.',
    sanctionsCheckRetry:
      'We couldn’t run the compliance check just now — nothing was sent. Please try again in a moment.',
    checkRetry:
      'We couldn’t verify this on-chain just now — nothing was sent. Please try again in a moment.',
    assetPaused:
      'One of this deal’s assets is temporarily paused by the protocol, so this action can’t go through right now. Nothing was sent — please try again later.',
    positionMoved:
      'This position is no longer held by the connected wallet (it may have been transferred or already claimed). Nothing was sent — refresh to see the current state.',
    collateralNotPriced:
      'This loan’s collateral isn’t currently priced by the protocol, so collateral top-ups aren’t available for it. Nothing was sent.',
    pastGrace:
      'This loan is past its due date and grace window, so repayment is closed on-chain — the default process applies now. Nothing was sent.',
    loanAlreadySettled:
      'This loan looks already settled on-chain — nothing was sent. Refresh in a moment to see its final state.',
    precloseMatured:
      'This loan is past its due date, so closing early no longer applies — nothing was sent. Use Repay instead; it settles the loan including any late fees.',
    refinanceMatured:
      'This loan is past its due date, so it can no longer be refinanced — nothing was sent. Use Repay to settle it, including any late fees.',
    lenderBlockedPartial:
      'The lender’s wallet can’t receive a direct partial payment right now (compliance flag). Repaying the loan in full stays open — that path holds the funds for a screened claim instead.',
  },

  fees: {
    // Fee percentages come from the LIVE protocol config
    // (data/fees.ts) — governance can retune them, and the receipt a
    // user signs against must quote the deployed values.
    borrowerLIF: (pct: string) =>
      `Vaipakam charges a ${pct} loan initiation fee on the borrowed amount.`,
    lenderYieldFee: (pct: string) =>
      `Vaipakam keeps ${pct} of the interest you earn.`,
    // The late-fee ladder tracks contract CONSTANTS (no governance
    // setter), so a static string is accurate here.
    lateFee:
      'Late repayment adds 1% of the outstanding amount after day one, growing 0.5% per day, capped at 5%.',
  },

  vault: {
    title: 'Your Vaipakam Vault',
    lede: 'Your own on-chain account. Only your wallet controls it — Vaipakam never pools user funds.',
    noVaultYet:
      'Your vault is created automatically with your first offer, loan, or deposit. Nothing to set up.',
    unavailable:
      'We couldn’t read your vault right now. Your funds are unaffected — please try again in a moment.',
    lockedHint:
      'Locked amounts back your open offers, active loans, and rentals. They free up when those close.',
  },

  activity: {
    title: 'Activity',
    lede: 'Everything your wallet has done on Vaipakam, newest first.',
    empty: 'No activity yet. It appears here as you use Vaipakam.',
    unavailable:
      'We couldn’t load your activity right now. Please try again in a moment.',
    truncatedNote:
      'Showing recent activity only — the protocol feed is busy and older events may not be listed.',
    truncatedEmpty:
      'Nothing of yours in recent protocol activity. Older events may exist that we couldn’t scan right now.',
  },

  rewards: {
    title: 'Interaction rewards',
    blurb:
      'VPFI rewards from your lending and borrowing activity. They become claimable after a loan closes and the reward day finalizes.',
    empty: 'No rewards yet. Rewards appear after lending or borrowing activity.',
    waiting:
      'Your rewards are being finalized — a reward day closes across all chains before it can be claimed. Check back soon.',
    claim: 'Claim rewards',
  },

  sanctions: {
    title: 'This wallet is listed by the compliance oracle.',
    line1:
      'The connected address appears on the on-chain sanctions oracle Vaipakam screens against.',
    line2:
      'New positions (offers, loans, rentals, deposits) are blocked and will not go through.',
    line3:
      'Repaying and closing existing positions stays open so your counterparties can be made whole, but claims and payouts to this wallet are blocked while it is flagged. If you believe this is an error, contact the oracle provider (Chainalysis).',
  },

  risk: {
    notPriced:
      'This loan’s assets aren’t priced by the protocol, so there is no automatic liquidation — the collateral transfers as-is on default.',
    healthy: 'Healthy',
    watch: 'Watch closely',
    danger: 'Close to liquidation',
    liquidatable: 'Can be liquidated now',
    explain:
      'If the collateral’s value falls too far against the borrowed amount, the loan can be liquidated. Adding collateral makes it safer.',
  },

  notFound: {
    title: 'This page doesn’t exist',
    body: 'The link may be old or mistyped. Nothing is lost — your positions are safe.',
    backHome: 'Back to Home',
  },
} as const;
