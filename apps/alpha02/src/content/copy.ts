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
    connected: 'Connected',
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
    offerGone:
      'That offer is no longer open. Browse current matches below or post your own.',
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
  },

  errors: {
    needMore: (asset: string) => `You need more ${asset} to continue.`,
    approveFirst: (asset: string) =>
      `Approve ${asset} so Vaipakam can use it for this action.`,
    notAToken:
      'That address doesn’t look like a token on this network. Double-check it or pick a suggested asset.',
    txRejected: 'You cancelled in your wallet. Nothing was sent.',
    txFailed:
      'The transaction didn’t go through. Nothing was taken beyond network gas. Please try again.',
  },

  fees: {
    borrowerLIF:
      'Vaipakam charges a 0.1% loan initiation fee on the borrowed amount.',
    lenderYieldFee: 'Vaipakam keeps 1% of the interest you earn.',
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
      'Winding down existing positions — repaying, closing, claiming — stays open. If you believe this is an error, contact the oracle provider (Chainalysis).',
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
