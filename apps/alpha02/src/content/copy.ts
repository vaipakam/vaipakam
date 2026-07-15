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
    testnetNudge: (chainName: string) =>
      `You’re on ${chainName}, a test network. Get free test assets to try things out →`,
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

  tokenSecurity: {
    pickerBlock: (reasons: string[]) =>
      `Danger — an independent security check flags this token: ${reasons.join('; ')}. The flows will not let a deal with this token proceed.`,
    pickerWarn: (reasons: string[]) =>
      `Caution — an independent security check reports: ${reasons.join('; ')}. You can continue, but read these carefully first.`,
    pickerUnknown:
      'The independent security check could not verify this token right now. Deals with unverified tokens are held back until the check succeeds.',
    pickerUnsupported:
      'The independent security check does not cover this network (test networks are not indexed). Extra care: only use tokens you deployed or trust.',
    gateBlock: (leg: string, reasons: string[]) =>
      `This deal's ${leg} failed an independent security check: ${reasons.join('; ')}. Accepting it is disabled — a token like this can be impossible to sell or transfer no matter what the deal terms say.`,
    gateUnknown: (leg: string) =>
      `The independent security check for this deal's ${leg} could not run. Try again in a moment — accepting is held back until the token can be verified.`,
    gateUnsupported: (leg: string) =>
      `The independent security check does not cover this network (test networks are not indexed), so this deal's ${leg} was not screened. Extra care: only accept tokens you trust.`,
    gateWarn: (leg: string, reasons: string[]) =>
      `Heads up on this deal's ${leg}: ${reasons.join('; ')}. Make sure you understand these before you continue.`,
    gateChanged: (leg: string) =>
      `The security check on this deal's ${leg} reports new findings since you reviewed it. Nothing was signed. The review above now shows the update — read it and tick the consent box again if you still want to proceed.`,
    retry: 'Check again',
    // Browsing-surface badges (#1036) — early warning on the book and
    // the guided-match cards; the accept review stays the enforcement
    // point and repeats the full reasons there.
    badge: {
      block: {
        label: 'Risk flagged',
        title:
          'An independent security check flags a token in this offer as dangerous (for example impossible to sell). The review will not let this deal proceed.',
      },
      warn: {
        label: 'Caution',
        title:
          'An independent security check reports owner powers or taxes on a token in this offer. The review shows the details before you sign anything.',
      },
      unchecked: {
        label: 'Not screened',
        title:
          'A token in this offer could not be checked by the independent security screen. Treat it with extra care.',
      },
    },
    matchesHidden: (n: number) =>
      n === 1
        ? '1 matching offer is hidden because an independent security check flagged one of its tokens as dangerous.'
        : `${n} matching offers are hidden because an independent security check flagged one of their tokens as dangerous.`,
    // CoinGecko reputation soft-signal (#1036 fallback layer) — only
    // on networks with market data; never a block, never a gate.
    reputationListedTop: (name: string, symbol: string | null, rank: number) =>
      `Market listing found: ${name}${symbol ? ` (${symbol})` : ''}, ranked #${rank} by market size. Check that this matches the token you meant.`,
    reputationListedDeep: (name: string, symbol: string | null) =>
      `Market listing found: ${name}${symbol ? ` (${symbol})` : ''} — outside the top 200 by market size. Smaller tokens move harder and disappear faster; double-check the project.`,
    reputationUnlisted:
      'No market listing found for this address — the wider market doesn’t know this token. That alone doesn’t make it bad, but verify the contract address with the project before dealing in it.',
  },
  signing: {
    intro: (n: number) =>
      n === 1
        ? 'One wallet confirmation finishes this:'
        : `You'll confirm ${n} times in your wallet, in this order:`,
    introUpTo: (n: number) => `Up to ${n} wallet confirmations, in this order:`,
    approveUnknown:
      'Approve the token — one confirmation, or two if your wallet needs an older approval reset to zero first (still checking).',
    sign: 'Sign the terms you just read — a free signature, no gas.',
    approve:
      'Approve the token — you allow the protocol to take the amount shown above. This is a transaction.',
    approveReset:
      'Approve the token — two confirmations here: your wallet needs an older approval reset to zero before the new amount can be set.',
    post: 'Post the offer — the final transaction.',
    accept: 'Open the deal — the final transaction.',
    approveNft:
      'Allow the protocol to move NFTs from this collection — a one-time transaction per collection.',
    postListing: 'Post the listing — the final transaction.',
    acceptRental: 'Start the rental — the final transaction.',
    phaseSign: (c: number, t: number) => `Signing terms… (${c} of ${t})`,
    phaseApprove: (c: number, t: number) => `Approving… (${c} of ${t})`,
    phasePermit: (c: number, t: number) =>
      `Signing the permission… (${c} of ${t}) — free, no gas`,
    phaseSend: (c: number, t: number) => `Submitting… (${c} of ${t})`,
  },
  killSwitch: {
    disabled:
      'This action is switched off right now — the operators have paused it as a precaution while something is looked into. Anything already yours is unaffected: repayments, claims, and withdrawals all stay open.',
  },
  alerts: {
    title: 'Alerts',
    lede: 'Get a Telegram message about your positions while the site is closed — deadlines and risk don’t wait for you to open a tab.',
    notConfigured:
      'Alerts aren’t set up in this build. The operator hasn’t pointed it at an alerts backend, so nothing here would work — rather than pretend, this section stays off.',
    connectFirst: 'Connect your wallet to set up alerts for it.',
    privacy:
      'Linking stores your wallet address, your alert preferences from this card, and your Telegram chat id on Vaipakam’s alert service, plus a small delivery record per alert it sends (which loan, which level, when) so you’re never messaged twice about the same thing. Unlink removes the Telegram connection.',
    linkButton: 'Link Telegram',
    linkSignNote:
      'Your wallet will first ask you to sign a short message — it’s free, it’s not a transaction, and it proves this request really comes from you.',
    linkIssued:
      'Open our bot and press Start — or send it this code as a message. That connects this wallet to your Telegram.',
    openBot: 'Open Telegram',
    // UX-012 — replace the old self-attested "I’ve done it" (which set
    // "linked" with no proof and silently dropped alerts on a fumbled
    // handshake) with a real round-trip.
    testAlertButton: 'Send a test alert',
    testAlertNote:
      'Once you’ve sent the code to the bot, tap this — we’ll push one message to your Telegram to prove it’s connected. Your wallet signs a short, free message first.',
    testAlertSending: 'Sending your test alert…',
    testAlertSent:
      'Test alert sent — check Telegram. Your alerts for this wallet are now on.',
    // UX-012 / Codex #1175 — the not-linked message points at BOTH the
    // send-the-code path (if still valid) and the start-over path (codes
    // expire after 10 minutes, so a stale code is otherwise a dead end).
    testAlertNotLinked:
      'We couldn’t find your Telegram chat yet. Open the bot and send it the code above, then tap “Send a test alert” again. If the code has expired, tap “Start over” for a fresh one.',
    testAlertError:
      'Couldn’t send the test alert just now. Please try again in a moment.',
    // UX-012 — abandon the current (possibly expired) code and return to
    // the Link step to request a new one.
    startOver: 'Start over',
    linked: 'Telegram linked — alerts for this wallet go to your chat.',
    unlink: 'Unlink',
    // UX-043 — a clear labelled action, not an ambiguous centered link.
    unlinkElsewhereTitle: 'Linked this wallet on another device?',
    unlinkElsewhereBody:
      'Its Telegram link lives on our server, not just this browser. Disconnect it here — it stops messages everywhere.',
    unlinkElsewhere: 'Unlink this wallet',
    unlinked: 'Unlinked. No more Telegram messages for this wallet.',
    toggleRepayDue: 'Message me before an interest payment comes due',
    toggleRisky: 'Message me if my loan gets risky',
    riskyOffNote:
      'Even switched off, you’ll still be warned right before a loan would be liquidated.',
    advancedBands:
      'Risk thresholds (health factor): a message is sent when a loan crosses each level.',
    bandsInvalid:
      'The three levels must decrease — warn above alert, alert above critical, and critical above 1.00.',
    saved: 'Saved.',
    pushTitle: 'Prefer app push instead?',
    pushBody:
      'The same alerts are published to Vaipakam’s Push Protocol channel — subscribe there with your wallet and any Push-compatible app delivers them.',
    pushEnable: 'Enable Push delivery',
    pushEnabled: 'Push delivery is on for this wallet.',
    pushButton: 'Open the Push channel',
    loanNudge: 'Want a Telegram warning if this loan gets risky? Set up alerts in Settings.',
  },
  errorBoundary: {
    title: 'Something went wrong on this page',
    body:
      'The page hit an unexpected error and stopped rendering. Your funds and on-chain positions are unaffected — this is a display-side fault, and a transaction you just signed may still have gone through (check My positions after reloading). Reloading usually clears it.',
    reload: 'Reload page',
    home: 'Back to Home',
  },

  /** #1028 item 4 — the Support drawer: connection health + report a
   *  problem. Statuses are honest and next-step-shaped; the report
   *  never carries the full wallet address. */
  diagnostics: {
    open: 'Support and connection check',
    title: 'Support',
    lede:
      'A quick health check of the connections this app depends on, and a way to report a problem.',
    close: 'Close',
    network: 'Network',
    wallet: 'Wallet',
    walletNotConnected: 'Not connected',
    rpc: 'Blockchain connection',
    rpcOk: (block: string) => `Working — latest block ${block}`,
    rpcChecking: 'Checking…',
    rpcFailing:
      'Not responding — the app can’t reach the blockchain right now. Reloading, or switching networks and back, often clears it.',
    indexer: 'Market data cache',
    indexerOk: (age: string) => `Up to date (refreshed ${age} ago)`,
    indexerStale: (age: string) =>
      `Running behind (last refreshed ${age} ago) — market lists may lag; your own positions still load directly from the chain.`,
    indexerUnreachable:
      'Unreachable right now — market lists may not load until it recovers. Your own positions still load directly from the chain.',
    indexerNoCursor:
      'Reachable, but no data has been recorded for this network yet — it will fill as activity arrives.',
    indexerNotConfigured:
      'Not configured on this build — market lists can’t load here. Your own positions still load directly from the chain.',
    networkUnsupported: (walletChainId: string, readName: string, readChainId: number) =>
      `Wallet is on an unsupported network (chain id ${walletChainId}) — data shown comes from ${readName} (${readChainId}). Switch networks to transact.`,
    build: 'App version',
    lastErrorTitle: 'Last error on this device',
    noError: 'No errors recorded in this session.',
    report: 'Report an issue on GitHub',
    reportHint:
      'Opens a pre-filled GitHub issue with the details above and the last recorded error. Your full wallet address is never included.',
    copyDetails: 'Copy details',
    copied: 'Copied.',
  },
  support: {
    title: 'Contact support',
    lede: 'Send a message to the team — you get a ticket number back right away.',
    notConfigured:
      'The support inbox isn’t connected in this build, so in-app messages can’t be sent from here. Email works instead:',
    messageLabel: 'What happened?',
    messagePlaceholder:
      'Tell us what you were doing and what went wrong, in your own words.',
    emailLabel: 'Email for a reply (optional)',
    emailHint:
      'Leave it empty if you’d rather follow up yourself — the ticket number below is all support needs.',
    attach:
      'Attach the health details shown above (recommended — they usually hold the cause)',
    privacy:
      'Sending stores your message, the page you sent it from and the network you were on, the reply address if you gave one, and — only if you ticked the box — the health details above, on Vaipakam’s support service under your ticket number. The team is notified that a ticket arrived (its number and context flags — never your message text or email). Your full wallet address is never included in the health details.',
    send: 'Send to support',
    sending: 'Sending…',
    sent: (id: string) =>
      `Sent. Your ticket number is ${id} — keep it; quoting it connects any follow-up to this report.`,
    mailHint: 'Prefer email, or want to add more? Write to us quoting the ticket number:',
    mailButton: 'Email support@vaipakam.com',
    invalidMessage: 'Write a few words about what happened first.',
    invalidEmail:
      'That email doesn’t look complete — fix it or clear the field (it’s optional).',
    rateLimited: 'A few messages went out just now — wait a minute and try again.',
    unavailable:
      'The support inbox couldn’t take the message right now. Nothing was lost on your side — email us instead:',
    failed: 'The message didn’t go through. Try again in a moment, or email us:',
    helpTitle: 'Need a human?',
    helpBody:
      'Open the Support panel (the round button in the corner of every page) to send the team a message with one click — it can attach the app’s own health details, which usually hold the cause. Or email us directly:',
  },
  wallet: {
    connect: 'Connect wallet',
    connectFirst: 'Connect a wallet to continue.',
    unsupportedNetwork: (chainNames: string) =>
      `This network isn’t supported. Vaipakam is available on ${chainNames}. Switch networks to continue.`,
    switchNetwork: 'Switch network',
    // UX2-005 — named-target variant for surfaces that know exactly
    // which chain has what the user came for (faucet mocks, VPFI
    // deposits): offer the remedy, don't just describe it.
    switchToChain: (chain: string) => `Switch to ${chain}`,
  },

  checks: {
    walletConnected: 'Wallet connected',
    supportedChain: 'On a supported network',
    balanceSufficient: (asset: string) => `Enough ${asset} in your wallet`,
    tokenValid: 'Asset recognised as a token',
    consent: 'Risk disclosures and terms accepted',
    // UX-010 — the inline remedy on a failing balance check (testnets
    // with deployed mocks only).
    getTestAssets: 'Get test assets',
    // UX-014 — surfaced on the first step so the wallet requirement
    // isn't a surprise at the final review.
    connectEarly:
      'Connect your wallet to continue — you’ll need it to sign, so it’s easiest to connect now.',
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

  /** #1028 item 2 — the free pre-sign dry run under the review. Advisory
   *  only: it informs, it never blocks the sign button. */
  simulation: {
    running: 'Doing a free dry run of this transaction…',
    passed: 'Dry run passed — this transaction should go through as reviewed.',
    wouldFail:
      'Heads up — this transaction would fail if you signed it now. Nothing was sent and no gas was spent.',
    wouldFailNote:
      'You can adjust the details above and try again in a moment, or sign anyway.',
    approvalNeeded:
      'A token approval will be requested first — the dry run can’t see that step yet, so this is expected, not a problem.',
    unavailable:
      'The free dry run isn’t available right now. You can still continue — this check is only an extra heads-up.',
  },

  /** Help page (#1030). `disclaimer` is the EXACT wording the spec
   *  mandates (WebsiteReadme §29) — don't paraphrase or trim; the
   *  fork-tier spec asserts the full string. `risks` is the
   *  plain-language disclosure list the consent checkbox links to. */
  help: {
    disclaimer:
      'Vaipakam is a decentralized, non-custodial protocol. No KYC is required. Users are responsible for their own regulatory compliance.',
    risksTitle: 'Risk disclosures',
    risks: [
      'Borrowing: if you don’t repay by the due date plus the grace period, your locked collateral goes to the lender. Collateral without a live market price transfers in full.',
      'Borrowing: collateral with a live market price can be sold automatically (liquidated) before the due date if its value falls too far.',
      'Lending: interest is earned only if the borrower repays. On default, your recovery is whatever the locked collateral turns out to be worth.',
      'NFT rentals: renters receive temporary use rights, never ownership; the NFT stays in the owner’s vault. Rental fees are prepaid, with a small refundable buffer.',
      'Smart-contract risk: Vaipakam is code on a public network. Bugs, network failures, or extreme market conditions can cause loss — never commit funds you cannot afford to lose.',
    ],
  },

  /** Rendered by components/ConsentLabel.tsx with the two phrases as
   *  INLINE LINKS (#1030) — risk → /help#risks, terms → the marketing
   *  site's Terms. Kept in parts so the wording lives here while the
   *  link structure lives in the component. */
  consentParts: {
    prefix: 'I understand and agree to the ',
    risk: 'Risk Disclosures',
    mid: ' and ',
    terms: 'Vaipakam Terms',
    suffix: '.',
  },

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
    // "Not priced" is broader than "no feed exists" — the protocol also
    // treats an asset as unpriced when its feed is stale/unhealthy or
    // its market is too thin to sell into (Codex #1166 r1).
    illiquidWarning:
      'One side of this deal isn’t priced by the protocol — it has no usable market price or deep-enough trading market right now. If it ends in default, the entire collateral transfers directly to the lender — nobody sells it for a fair market price first, and there is no automatic price-based liquidation. Only proceed if you accept that.',
    interestModeFullTerm:
      'Interest is full-term: the whole term’s interest applies even if the loan is repaid early.',
    interestModeProRata:
      'Interest accrues day by day — repaying early costs less.',
    interestModeProRataLender:
      'Interest accrues day by day — if the borrower repays early, you earn less.',
    // Linked-loan offers (position sales, preclose offsets) settle or
    // transfer an already-running loan — the fresh-loan review above
    // does NOT describe their real terms (a sale vehicle shows 0
    // collateral and a term that already partly elapsed), so accepting
    // them here is BLOCKED, not warned-past. See issue #951 / #927.
    linkedLoanAcceptBlocked: (loanId: string) =>
      `This offer is tied to already-running loan #${loanId} — accepting it would settle or transfer that loan's position, not start the fresh loan reviewed above. This app can't yet show you the real terms of that kind of deal, so accepting it here is disabled for now.`,
    // #986 P3 — the honest buy-a-running-loan review. Sale vehicles get
    // a REAL review (loan-derived numbers) instead of the block above;
    // preclose-offset links keep the block.
    saleVehicleBanner: (loanId: string) =>
      `This is a position sale: you'd be buying the lender side of already-running loan #${loanId}, not starting a new loan. The borrower and their repayment obligations don't change — only the lender does. The numbers below come from that loan, live.`,
    saleLoanChecking:
      'Reading the running loan behind this listing — the review must show its real numbers before you can sign.',
    saleLoanCheckFailed:
      'We couldn’t read the running loan behind this listing, and the review must show its real numbers — signing stays paused until it succeeds.',
    saleLoanNotActive:
      'The loan behind this listing is no longer active, so this purchase can’t complete. Nothing was sent or approved.',
    saleSellerNotCovered:
      'The seller’s standing settlement approval no longer covers completing this sale, so the purchase would fail on-chain. Nothing was sent or approved — the seller needs to restore their approval (their listing card shows a restore action).',
    saleMaturityPassed:
      'This loan has reached its due date — the position can no longer be bought. Nothing was sent or approved.',
    saleBought: 'Position bought',
    saleBuyerNext: (loanId: string) =>
      `You\u2019re now the lender of loan #${loanId} \u2014 the loan keeps running unchanged for the borrower, and their repayment comes to you. Track it under My positions; when they repay you claim the principal and the remaining interest.`,
    saleSelfBuy:
      'You are the borrower of this loan, so you can\u2019t also buy its lender side \u2014 the protocol rejects that. Repaying or closing early from My positions are your moves instead. Nothing was sent or approved.',
    liquidityChecking:
      'Checking how these assets are priced by the protocol…',
    liquidityCheckFailed:
      'We couldn’t check how these assets are priced, and that check decides an important warning — signing stays paused until it succeeds.',
    linkedLoanCheckFailed:
      'We couldn’t check whether this offer is a position sale of a running loan, and that check decides an important disclosure — signing stays paused until it succeeds.',
    graceChecking:
      'Confirming the repayment grace window this deal is judged against…',
    graceCheckFailed:
      'We couldn’t confirm the repayment grace window, and the review must show the real one — signing stays paused until it succeeds.',
    riskGateBlocked:
      'The protocol’s risk-access rules block this acceptance for your wallet right now — it needs a standing on-chain acknowledgement or access level this app can’t collect yet. Nothing was sent or approved.',
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
    // #1112 — early inline lead-in shown above the terms-step "Continue"
    // button when a read-only pre-check finds the borrow under-collateralised,
    // so the user learns it here instead of only at the final review. The
    // specific next-step copy follows (decoded from the contract's own revert).
    collateralPrecheck: 'Before you continue —',
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
    // UX-047 — a direct browse action on the otherwise-sparse landing.
    browseCta: 'Browse NFTs available to rent',
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
    // UX-023 — the empty browse list points at the other side of the
    // market instead of dead-ending (the path switch sits right above
    // this flow).
    browseEmptyCta:
      'Own an NFT? Use the switch above to list it for rent instead — renters prepay the whole rental up front, so an empty market is an opportunity.',
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
    // #1235 — closing stays open through the grace window (the
    // contract charges the same late fee repaying does there), so the
    // in-grace card must say the quote already includes that fee and
    // that the door closes when grace ends.
    graceNote:
      'This loan is past its due date. The amount below already includes the late fee for being late (it grows a little each day), and closing this way stays possible only until the grace window ends.',
    graceFeeReceiptNote:
      'The late fee for being past due is included in this amount — the same fee a normal repayment would charge.',
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
      'Refinance request posted. When a lender accepts it, this loan closes automatically — you don’t need to do anything else. You can cancel the request below (cancellation opens a few minutes after posting).',
    pending: (offerId: string) =>
      `Refinance request #${offerId} is live. When a lender accepts it, this loan closes automatically in the same transaction.`,
    pendingChecking: (offerId: string) =>
      `Checking the state of refinance request #${offerId}…`,
    pendingExpires: (date: string) =>
      `The request expires on ${date} if nobody accepts it.`,
    pendingAccepted:
      'Your refinance request was accepted — this loan is being replaced by the new one. Refresh in a moment to see the final state.',
    pendingLoanClosed:
      'This loan has since closed another way, so the request can no longer complete — cancel it to also remove its standing payoff approval.',
    pendingExpired: (date: string) =>
      `This refinance request expired on ${date} — no lender can accept it any more, and it no longer holds up your other actions here. Cancel it below to also remove its standing payoff approval; the loan continues unchanged.`,
    cancel: 'Cancel refinance request',
    cancelSoon:
      'Cancellation opens a few minutes after posting — try again shortly.',
    cancelled:
      'Refinance request cancelled and the payoff approval removed — this loan continues unchanged. If you have other listings or requests using the same token, restore their approvals from their cards.',
    cancelledRevokeFailed:
      'Refinance request cancelled — this loan continues unchanged. The standing payoff approval couldn’t be removed automatically; you can revoke it from your wallet’s token-approvals view.',
    allowanceShort:
      'The payoff approval no longer covers everything this request could pull — a lender’s acceptance could fail (an acceptance after the due date also pulls the late fee and extra interest). Restore it below or cancel the request.',
    balanceShort: (topUp: string) =>
      `Your wallet holds less than the ~${topUp} spare this request needs — a lender’s acceptance would fail right now. Top up your wallet or cancel the request.`,
    reapprove: 'Restore the payoff approval',
    reapproved: 'Payoff approval restored — the request can complete again.',
    reapproveAborted:
      'This request is no longer completable (accepted, cancelled, or the loan closed) — nothing was approved. Refresh to see the latest state.',
    guardrailNote:
      'Your request carries its own expiry and on-chain guardrails: it can only complete at or below the rate you set here, and never after the expiry you see in this review.',
    // #1236 — a refinance can complete inside the grace window, and
    // the accept-time payoff then includes the same late fee repaying
    // charges. The disclosure and the past-due banner keep the quoted
    // figures honest; the approval covers the fee so a grace-window
    // acceptance can't fail on a short allowance.
    graceNote:
      'This loan is past its due date. A lender can still accept this request until the grace window ends, and the payoff already includes the late fee for being late (it grows a little each day).',
    lateFeeDisclosure: (maxGrowth: string) =>
      `If a lender accepts after the loan’s due date, the payoff grows — the late fee for being late plus interest that keeps accruing — by up to ~${maxGrowth} more for this request. The approval you grant covers that too, so a late acceptance can’t fail on it.`,
    expiresAtGraceEnd: (date: string) =>
      `when it expires with this loan’s grace window (${date}) — a refinance request can’t outlive the loan it replaces`,
    pendingPastGrace:
      'This loan has passed its due date and grace window, so no lender can accept this request any more — it no longer holds up your other actions here. Cancel it below to also remove its standing payoff approval.',
    cadenceChangeNote:
      'Your current loan pays interest on a schedule. The replacement loan will NOT — its interest settles when it closes. Make sure that cash-flow change is what you want.',
    multiStepNote:
      'Posting takes up to three wallet confirmations (guardrails, payoff approval, the request itself). If you stop partway, the earlier steps stay in place on-chain until you finish posting or cancel — cancelling also removes the approval.',
    partialBlockedByPending:
      'A refinance request is live for this loan. A partial repayment would change the amount and make that request permanently unacceptable — cancel the refinance request first.',
    precloseBlockedByPending:
      'A refinance request is live for this loan. Closing early now would strand it — cancel the refinance request first.',
    repayWarnPending:
      'A refinance request is still live for this loan. Repaying settles the loan, after which the request can never complete — cancel it from its card afterwards (that also removes its standing payoff approval); until then it just sits until it expires.',
  },

  approvals: {
    title: 'Standing token approvals',
    blurb:
      'These are the spending permissions your wallet has granted Vaipakam’s contract for tokens your loans and offers touch. Some flows set them on purpose (a refinance request’s payoff, a sale listing’s settlement); anything left over from an abandoned attempt can be removed here.',
    revokeWarning:
      'Careful: if a live refinance request or sale listing depends on a token’s approval, revoking it makes that flow fail until you restore it from its card — the card will warn you within moments.',
    scopeNote:
      'This list covers tokens seen in your Vaipakam loans and offers on this network. Approvals granted to other apps or for other tokens aren’t shown — your wallet’s own token-approvals view remains the complete picture.',
    none: 'No standing approvals to Vaipakam found for your known tokens.',
    loading: 'Reading your standing approvals…',
    unavailable:
      'We couldn’t read your approvals right now — please try again in a moment.',
    sourcesUnavailable:
      'We couldn’t load your loans and offers just now, so this list can’t be built completely — rather than show a partial picture, try again in a moment.',
    revoke: 'Revoke',
    staleNote:
      'We couldn’t refresh this list just now — the rows shown may be slightly stale. Revoking still works.',
    revoked: (symbol: string) =>
      `Approval removed for ${symbol}. If a live request or listing needed it, its card will warn and offer a restore.`,
  },

  nftVerifier: {
    title: 'NFT verifier',
    lede:
      'Vaipakam position NFTs carry real claim rights — whoever holds one controls that side of its loan. Check any token id before trusting it.',
    placeholder: 'Position NFT token id',
    check: 'Check',
    chainNote: (chain: string) =>
      `Checked on ${chain}. Token ids repeat across networks — a token that exists here says nothing about other networks.`,
    checking: 'Checking this token on-chain…',
    checkFailed: 'We couldn’t check this token right now — please try again in a moment.',
    liveTitle: (id: string) => `Token #${id} is live on this network`,
    ownerLabel: 'Current holder',
    roleLabel: 'Side it controls',
    roleLender: 'Lender side — its holder collects the repayment or recovery.',
    roleBorrower: 'Borrower side — its holder repays and reclaims the collateral.',
    roleUnknown: 'We couldn’t read this token’s role details right now.',
    loanLabel: 'Linked loan',
    offerLabel: 'Created for offer',
    offerValue: (offerId: string) =>
      `#${offerId} — this token was minted for an offer that hasn’t become a loan yet.`,
    lockUnrecognized:
      'Transfer-locked for a reason this app version doesn’t recognise — it can’t be transferred until that flow completes or is cancelled.',
    lockUnknown:
      'We couldn’t read whether this token is transfer-locked right now — don’t rely on it being transferable until this reads clean.',
    positionRowLabel: 'Your position NFT',
    positionRowNote: (role: string) =>
      `— holds this loan’s ${role} rights; verify any position NFT before trusting it.`,
    lockLabel: 'Transfer lock',
    lockPrecloseOffset:
      'Locked for a preclose-by-offset — it can’t be transferred until that completes or is cancelled.',
    lockSale:
      'Locked for a position sale listing — it can’t be transferred until the sale completes or the listing is cancelled.',
    lockPrepayListing:
      'Locked for a collateral listing — it can’t be transferred while that listing stands.',
    sanctionsLabel: 'Compliance status',
    sanctionsFlagged:
      'The current holder is compliance-flagged: this NFT cannot be transferred in or out of their wallet, and its claims stay frozen until the flag clears. Do not buy this token expecting delivery.',
    sanctionsUnknown:
      'We couldn’t check the holder’s compliance status right now — a flagged holder would mean the token can’t be transferred, so re-check before relying on it.',
    inKindLabel: 'Default payout',
    inKindNote:
      'If the borrower of the linked loan defaults, this claim pays out the loan’s raw collateral in kind — the protocol does not price or sell it for you. Value what you would actually receive before buying this position.',
    liveNote:
      'Live means exactly this: the token exists here and its holder controls the linked position. It does not vouch for the loan’s health or the other side’s behaviour.',
    goneTitle: (id: string) => `Token #${id} does not currently exist on this network`,
    goneBody:
      'Either its claim was completed and the token was retired, or it was never minted here at all — the network doesn’t record which. Treat any offer to sell or transfer this token id as worthless on this network.',
  },

  keepers: {
    title: 'Keeper permissions',
    blurb:
      'Keepers are third-party services (or your own bot) you can allow to run specific loan actions FOR you — start an early close, finish a refinance you set up, list a position for sale. Everything here is off until you turn it on, and three switches must all agree before a keeper can act: the master switch, the action on that keeper, and a per-loan switch on each loan’s page.',
    safetyNote:
      'A keeper can never receive your money — payouts always go to whoever holds the position. You can revoke any keeper (or flip the master switch off) at any time, the protocol can pause all keepers at once, and refinances are additionally bounded by the guardrails you set per loan. If a position changes hands, these permissions apply to the new holder’s settings, not yours.',
    masterLabel:
      'Allow my approved keepers to act (master switch — nothing runs while this is off)',
    addressPlaceholder: '0x… keeper address',
    // One entry per grantable action, keyed by name so the bit table
    // in data/keepers.ts can never drift by reordering.
    actions: {
      initPreclose: {
        label: 'Start closing a loan early for me',
        side: 'acts on loans you borrowed',
        blurb:
          'Begin any early-close path on a loan where you are the borrower. The payoff still comes from your wallet under your standing approvals.',
      },
      refinance: {
        label: 'Complete a refinance for me',
        side: 'acts on loans you borrowed',
        blurb:
          'Finish a refinance you set up, bounded by the guardrails (rate ceiling, end date) you approved — and the protocol’s own keeper kill switch.',
      },
      completeOffset: {
        label: 'Finish an offset close for me',
        side: 'acts on loans you borrowed',
        blurb: 'Complete a preclose-by-offset once its offer has been accepted.',
      },
      extend: {
        label: 'Extend a loan in place for me',
        side: 'acts on loans you borrowed',
        blurb:
          'Extend a loan without reopening it — only when BOTH sides have opted into extension limits.',
      },
      initEarlyWithdraw: {
        label: 'List my loan position for sale',
        side: 'acts on loans you funded',
        blurb:
          'Start a lender early exit by listing a loan you funded. The proceeds still pay only you.',
      },
      completeLoanSale: {
        label: 'Finish a position sale for me',
        side: 'acts on loans you funded',
        blurb:
          'Complete an accepted position sale, moving the loan to its buyer. The payment still routes only to you.',
      },
    },
    enabledOn:
      'Keeper access enabled. Keepers can now act where you granted permissions AND the loan’s own switch is on.',
    enabledOff:
      'Keeper access disabled — no keeper can act for you anywhere while this stays off.',
    addTitle: 'Approve a keeper',
    add: 'Approve keeper',
    added: 'Keeper approved. Remember: it can only act on loans where you also flip that loan’s keeper switch.',
    alreadyListed:
      'That keeper is already approved — edit its permissions above instead.',
    save: 'Save permissions',
    updated: 'Keeper permissions updated.',
    revoke: 'Revoke',
    revoked: 'Keeper revoked — it can no longer act for you anywhere.',
    maskUnreadable:
      'We couldn’t read this keeper’s current permissions, so editing is disabled (saving now could silently overwrite them). Retry in a moment; revoking still works.',
    extraBitsNote:
      'This keeper also holds advanced permissions not shown here — they are preserved unchanged when you save.',
    atCap: (max: number) =>
      `You’ve reached the maximum of ${max} approved keepers — revoke one to add another.`,
    perLoanReminder:
      'Approving a keeper here is not enough by itself: each loan’s page has a per-loan keeper switch that must also be on.',
    loading: 'Loading your keeper settings…',
    staleWarning:
      'We couldn’t refresh your keeper settings just now — what’s shown may be slightly stale. Revoking and saving still work.',
    unavailable:
      'We couldn’t load your keeper settings right now — please try again in a moment.',
    loanTitle: 'Keepers for this loan',
    loanBlurb:
      'Your approved keepers can act on this loan only while its switch is on. Actions stay bounded by the permissions you granted in Settings.',
    loanToggleOn: 'Keeper enabled for this loan.',
    loanToggleOff: 'Keeper disabled for this loan.',
    loanEnablesUnavailable:
      'We couldn’t read this loan’s keeper switches right now — the toggles are paused until the read succeeds (their shown state may be stale).',
    loanNoKeepers:
      'You haven’t approved any keepers yet — set them up under Settings → Keeper permissions.',
    loanMasterOff:
      'Your keeper master switch is off, so nothing can run even with this loan’s switch on — turn it on under Settings → Keeper permissions.',
  },

  earlyExit: {
    title: 'Exit this loan early',
    blurb:
      'Sell your side of this loan to another lender with a matching open lending offer. You’re paid immediately from their already-locked funds — nothing to approve, nothing to claim afterwards — and the borrower’s terms don’t change at all.',
    pickerLead: 'Open lending offers that can buy you out:',
    none:
      'No matching lending offers right now. An offer must match this loan’s assets, cover its remaining amount, and fit inside its remaining time — check back later.',
    unavailable:
      'We couldn’t load matching offers right now — please try again in a moment.',
    rowReceive: (amount: string) => `you’d receive ~${amount} now`,
    shortfallWarn:
      'This buyer expects a higher rate than your loan pays, and for this candidate that rate difference (not the accrued interest — you pay the larger of the two, never both) is what sets your payout.',
    forfeitNote:
      'Exiting early forfeits the interest accrued so far: it covers the protocol’s cut and, when the buyer’s rate is higher, helps bridge the difference. The figure shown already accounts for this.',
    action: 'Review exit',
    confirm: 'Confirm — sell my position',
    done:
      'Position sold — the payout is already in your wallet, and this loan now belongs to the new lender. Nothing more to do here.',
    loadingOffers: 'Looking for matching lending offers…',
    figureMoved:
      'The payout figure moved with time, so the review closed — open it again to confirm against the current number.',
    moreOffers: (n: number) =>
      `${n} more matching offer${n === 1 ? '' : 's'} pay${n === 1 ? 's' : ''} less than the ones shown.`,
    checking: 'Checking whether this loan can be exited early…',
    checkFailed:
      'We couldn’t read this loan’s exit details right now — retrying.',
  },

  loanSale: {
    title: 'List this position for sale',
    blurb:
      'Set the yearly rate a buyer would earn for the loan’s remaining time and list your position publicly. When a buyer accepts, you receive the full outstanding amount in that same transaction. (If a matching offer above already pays enough, the instant exit is simpler — listing is for naming your own price and waiting.)',
    rateLabel: 'Yearly rate the buyer earns',
    action: 'Review listing',
    confirm: 'Confirm — list my position',
    // Spec rule (WebsiteReadme "borrower preclose flow" analog): the
    // NFT lock must be disclosed BEFORE confirmation.
    lockWarning:
      'Listing locks your lender position NFT — it can’t be transferred until the sale completes or you cancel the listing. Your claim rights are unaffected.',
    approvalNote: (amount: string) =>
      `Listing sets a standing approval of up to ${amount} — sized to cover settling the sale any time through the loan’s term plus a month’s headroom (the larger of interest accrued by acceptance or the rate difference). Only the actual amount is pulled, in the buyer’s own transaction; if the listing somehow outlives the headroom, the listing card warns and offers to top the approval up.`,
    sweetenNote:
      'A rate above the loan’s own rate attracts buyers faster, but the difference for the remaining term comes out of your wallet at completion.',
    done:
      'Position listed. When a buyer accepts, the sale settles automatically — keep the standing approval (and enough balance for the settlement figure) in place until then, or cancel the listing below.',
    pending: (offerId: string) =>
      `Sale listing #${offerId} is live and your lender NFT is locked while it stands. When a buyer accepts, you’re paid the outstanding amount and the settlement is pulled in the same transaction.`,
    pendingNoId:
      'This position is listed for sale (listed from another device, so cancelling here isn’t available — cancel where it was listed). Your lender NFT is locked while the listing stands.',
    allowanceShort:
      'The standing settlement approval (or your wallet balance) no longer covers what a buyer’s acceptance would pull — the sale would fail right now. Restore it below or cancel the listing.',
    restore: 'Restore the settlement approval',
    restored: 'Settlement approval restored — the listing can complete again.',
    cancel: 'Cancel listing',
    cancelled:
      'Listing cancelled — your lender NFT is unlocked and the settlement approval was removed (if you have other listings or requests using the same token, restore their approvals from their cards). The loan continues unchanged.',
    cancelledRevokeFailed:
      'Listing cancelled and your lender NFT unlocked. The standing settlement approval couldn’t be removed automatically — you can revoke it from your wallet’s token-approvals view.',
    cancelSoon:
      'Cancellation opens a few minutes after listing — try again shortly.',
    restoreAborted:
      'This listing is no longer standing (sold, cancelled, or unlocked) — nothing was approved. Refresh to see the latest state.',
    loanSettledWhileListed:
      'This loan has settled, so the sale listing can never complete — cancel it to unlock your lender NFT and remove the standing approval.',
    fundingUnknown:
      'We couldn’t identify this listing’s offer record from this device, so we can’t verify its settlement funding here — manage it from the device that listed it, or keep a generous approval and balance in place.',
    ended:
      'Your sale listing is no longer active. If a buyer accepted it, the payout is already in your wallet and the settlement was pulled via the standing approval; any remaining approval can be revoked from your wallet’s token-approvals view.',
    // Issue #951 — the on-chain listing entry point is broken; the
    // form is feature-gated off until the contract fix lands.
    listingUnavailable:
      'Listing your position at your own price isn’t available yet — the on-chain step it needs is being fixed. The instant exit above works: it sells into a matching open offer right away.',
    partialBlockedByListing:
      'The lender has this position listed for sale at its current outstanding amount. Partial repayment is paused while the listing stands — it would change that amount and mislead a buyer. You can still repay in full or close early at any time.',
  },

  positions: {
    title: 'My positions',
    lede: 'Your loans and rentals, with the one action each needs right now.',
    emptyTitle: 'No active positions yet',
    emptyBody: 'Borrow or lend to get started.',
    unavailable:
      'We couldn’t load your positions right now. Your funds are unaffected — please try again in a moment.',
    sourcesDegraded:
      'One of this page\u2019s data sources is temporarily unavailable. Your current positions are shown from the remaining source and recently changed items may take a moment to appear.',
    roleBorrower: 'You borrowed',
    roleLender: 'You lent',
    // UX-030 — "grace period" glossed inline, with the concrete window
    // length when the live read has it.
    whatIfNothingBorrower: (collateral: string, grace?: string) =>
      `If you do nothing and the loan passes its due date and the ${grace ? `${grace} ` : ''}grace period (a short extra window to repay before the lender can take the collateral), the lender can receive your ${collateral} collateral.`,
    whatIfNothingLender: (grace?: string) =>
      `If the borrower does not repay by the due date plus the ${grace ? `${grace} ` : ''}grace period (a short extra repayment window), you can claim their collateral.`,
    // #1166 live-review follow-up — a wallet holding neither position
    // must not be addressed as a party ("you can claim…").
    whatIfNothingViewer: (grace?: string) =>
      `If the borrower does not repay by the due date plus the ${grace ? `${grace} ` : ''}grace period (a short extra repayment window), the lender can claim the collateral.`,
    // UX-024 — the list groups by what needs the user, and rows with a
    // pending claim say so instead of a bare status badge.
    groupAttention: 'Needs your attention',
    groupActive: 'Active loans',
    groupEnded: 'Ended loans',
    claimWaiting: 'Claim waiting',
    // UX-050 — surface the full history for Basic users, who don't see
    // Activity in the nav.
    seeActivity: 'See your full activity history →',
    // UX-004 — past-due escalation banner with the live countdown.
    graceCountdownBorrower: (remaining: string) =>
      `This loan is past due. Repay within about ${remaining} — after that the lender can take the collateral.`,
    graceCountdownLender: (remaining: string) =>
      `This loan is past due. If the borrower does not repay within about ${remaining}, you can claim their collateral.`,
    graceCountdownViewer: (remaining: string) =>
      `This loan is past due. If it isn’t repaid within about ${remaining}, the lender can claim the collateral.`,
    graceOverViewer:
      'The grace period has ended — the loan can now be marked defaulted, and the collateral goes to the lender.',
    // Codex #1166 r3 — a failed grace-window read must not silence the
    // warning at the exact moment collateral is at risk: fall back to
    // an unknown-deadline alert instead of hiding the banner.
    graceUnknownBorrower:
      'This loan is past due and the grace window may be running out — we couldn’t read the exact deadline right now. Repay as soon as possible, before the lender can take the collateral.',
    graceUnknownLender:
      'This loan is past due — we couldn’t read the exact grace deadline right now. Once the grace window ends and the default is recorded, the collateral claim appears here.',
    graceUnknownViewer:
      'This loan is past due. Once its grace window ends, the lender can claim the collateral.',
    // Codex #1166 r1 — past graceEnd the contracts REJECT ordinary
    // repayment (RepayFacet RepaymentPastGracePeriod; only a
    // fallback-pending cure is exempt), so never suggest a repay race.
    graceOverBorrower:
      'The grace period has ended — the protocol no longer accepts repayment, and the lender can take the collateral at any moment. Once they claim it, the outcome will show here.',
    // Codex #1166 r2 — alpha02 has no in-app markDefaulted action, so
    // never promise the lender an immediate step on this page: the
    // keeper records the default, then the claim appears.
    graceOverLender:
      'The grace period has ended — this loan can now be marked defaulted. That normally happens automatically shortly after; once the default is recorded, the collateral claim appears here.',
    // Codex #1166 r2 — fallback_pending is the post-grace failed-
    // default state: the cure (full repayment) is still accepted, but
    // only until the lender finalizes the default.
    fallbackCureBorrower:
      'This loan is past its grace period and a default is being settled. You can still repay in full to cure it and get your collateral back — but only until the lender finalizes the default, which can happen at any moment.',
    // UX-001 — a loan that is already over must never show a live
    // obligation or a live default warning: contradictory state on a
    // money page erodes trust in every other number.
    owedRepaid: (principal: string) =>
      `Nothing — ${principal} plus interest was repaid in full.`,
    owedDefaulted:
      'Nothing to repay anymore — this loan ended in default and the collateral covers it.',
    owedDefaultedNoCollateral:
      'Nothing to repay anymore — this loan ended in default and was settled.',
    owedClosed: 'Nothing — this loan is closed and settled.',
    whatNextRepaidBorrower:
      'You repaid this loan. Nothing else can happen to it — claim your collateral back below if you haven’t yet.',
    whatNextRepaidLender:
      'The borrower repaid. Nothing else can happen to this loan — claim your funds below if you haven’t yet.',
    // Viewer-neutral variants: a wallet that holds neither side (or a
    // side whose claim already consumed its position NFT) must never
    // be told to "claim your funds" when no action renders for it.
    whatNextRepaidViewer:
      'The borrower repaid. Nothing else can happen to this loan — any remaining claims belong to the position holders.',
    whatNextDefaultedBorrower:
      'This loan already ended in default. Any remainder after settlement is claimable (it may be zero).',
    whatNextDefaultedLender:
      'This loan already ended in default — what it recovered is claimable in the Claim Center.',
    whatNextDefaultedViewer:
      'This loan already ended in default — the settlement’s recovery belongs to the position holders.',
    whatNextInternalMatchBorrower:
      'This loan closed by internal matching. Collect any residual and VPFI rebate below (either may be zero).',
    whatNextInternalMatchLender:
      'This loan closed by internal matching — collect your funds below if you haven’t yet.',
    whatNextInternalMatchViewer:
      'This loan closed by internal matching — any residual claims belong to the position holders.',
    // Reserved for `settled` ONLY: that status means the claims are
    // already consumed, so "nothing left to do" is literally true.
    whatNextClosed: 'This loan is fully settled — there is nothing left to do.',
    whatNextRentalEnded:
      'This rental has ended. Any earned fees or refundable buffer can be claimed below by the position holders — nothing else can change it.',
    // OBS-2 (#988) — shown when the page's live on-chain read is ahead
    // of the position lists (stalled/lagging indexer).
    settledAhead:
      'This position has already closed on-chain — the status here is live. Your lists may take a moment to catch up.',
  },

  // UX-026 — orientation for a Basic-mode user landing on a power
  // surface by URL: name what it is, offer the guided path back, and
  // offer the mode switch. Dismissible; never shown in Advanced.
  powerSurface: {
    body: 'This is a power-user screen — raw offers and live rates with less hand-holding. The guided Borrow and Lend flows cover the same actions with step-by-step explanations.',
    // Both guided flows offered (Codex #1168 r1) — a lender routed
    // into /borrow is the wrong money direction.
    guidedBorrow: 'Guided Borrow',
    guidedLend: 'Guided Lend',
    enableAdvanced: 'I know what I’m doing — enable Advanced mode',
    dismiss: 'Dismiss',
  },

  claims: {
    title: 'Claims',
    lede: 'Money and assets that are ready for you to collect.',
    empty: 'Nothing to claim right now.',
    // UX-023 — an empty Claim Center points forward instead of
    // dead-ending.
    emptyBody:
      'When a loan or rental you are part of ends, anything owed to you appears here automatically.',
    emptyCta: 'See my positions',
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
    // F-20260703-003 (#988) — shown by MarketFreshnessNote when the
    // indexer cursor has stalled, on every market-list surface.
    staleList: (age: string) =>
      `This list last updated ${age} ago and may be behind — new offers may exist that aren’t shown yet. Check back shortly.`,
    unavailable:
      'We couldn’t load the offer book right now. Please try again in a moment.',
    lenderOffer: 'Lending offer',
    borrowerOffer: 'Borrow request',
  },

  // Rate Desk (#1129) — the advanced-only trading terminal for the
  // offer book. Vocabulary is rate-first per the #166 ADR: the price
  // column is always "Rate (APR %)", never "price"; exact bps live in
  // tooltips only.
  desk: {
    title: 'Rate Desk',
    lede: 'The order book for one market — read the rates, post or amend limit-rate offers, and watch your open orders and positions in one place.',
    marketLabel: 'Market',
    tenorLabel: 'Term',
    customPair: 'Custom pair…',
    customLend: 'Loan asset address',
    customCollateral: 'Collateral asset address',
    marketsUnavailable:
      'The markets list couldn’t load right now, so pair discovery is limited — enter a pair manually and the book itself can still load.',
    marketsEmpty:
      'No live markets right now. Pick a pair and post the first offer with the ticket.',
    pickPair: 'Pick a market to load its book.',
    lastFill: 'Last fill',
    quotedMid: 'Quoted mid',
    spread: 'Spread',
    crossed: 'crossed',
    statUnknown: '—',
    bookTitle: 'Order book',
    rateHeading: 'Rate (APR %)',
    sizeHeading: 'Size',
    cumHeading: 'Depth',
    asksHeading: 'Lender offers (asks)',
    bidsHeading: 'Borrow requests (bids)',
    bookEmpty: 'No open offers for this market yet — yours can be the first.',
    bookUnavailable:
      'We couldn’t load the order book right now. Please try again in a moment.',
    bookIndexedCopy:
      'Live chain read unavailable — showing the indexed copy of the book, which can lag the chain.',
    yourOrderMark: 'Your order at this rate',
    takeAsk: 'Borrow this',
    takeBid: 'Lend to this',
    rowPrefills:
      'Tap a rate to pre-fill the ticket. Taking the top of the book goes through the same guided review as Borrow/Lend.',
    tapeTitle: 'Recent fills',
    tapeEmpty: 'No fills yet for this market.',
    tapeUnavailable: 'We couldn’t load recent fills right now.',
    // #1131 slice B — the crossable-band previewMatch strip. Shown ONLY
    // when the contract's own previewMatch says Ok (§5.2 honesty rule:
    // bid >= ask alone is NOT matchable — range constraints can still
    // fail) and the partial-fill master flag is on.
    match: {
      matchable: (rate: string) => `Matchable at ${rate}`,
      body: 'These top-of-book offers can cross. Anyone can execute this match and earn the matcher fee — you pay the network gas to execute it.',
      amount: (amount: string, symbol: string) =>
        `${amount} ${symbol} would match.`,
      execute: 'Execute match',
      executing: 'Matching…',
      executed: 'Match executed — the crossed offers settled into a loan.',
      // Pre-write live recheck failed (Codex #1145 round-5): the book
      // moved between render and click — the pair the band showed is no
      // longer contract-confirmed matchable. Nothing was sent.
      noLongerMatchable:
        'These offers can no longer cross — the book moved before the match was sent. Nothing was sent.',
      // Pre-write live master-flag recheck failed (Codex #1145
      // round-6): governance switched offer matching off after the
      // band rendered — the honest reason is the kill switch, not a
      // book move. Nothing was sent.
      matchingDisabled:
        'Offer matching was just switched off by protocol governance, so this match can’t be sent right now. Nothing was sent.',
    },
    // #1131 slice D — gasless signed orders merged into the ladder.
    signed: {
      badge: 'Signed',
      badgeTooltip:
        'Gasless signed order from the off-chain book — the maker signed it without a transaction, and it fills in a single on-chain transaction by whoever takes it. Signed rows always come from the order-book service, never the chain, until they fill.',
      partialBadgeTooltip:
        'Partially matched signed order — its remainder still counts as depth and fills through the permissionless matcher, but a direct fill is no longer possible.',
      rangedBadgeTooltip:
        'Range-sized signed order — its size still counts as depth, but only the permissionless matcher can consume it in slices; there is no whole-order direct fill.',
      fill: 'Fill',
      confirmTitle: 'Fill signed order',
      confirmLede:
        'You execute the whole fill in one transaction: your side moves from your wallet, the maker’s side from their vault, and the loan starts immediately.',
      payCollateral: (amount: string, symbol: string) =>
        `You lock ${amount} ${symbol} as collateral and receive the loan principal.`,
      payPrincipal: (amount: string, symbol: string) =>
        `You fund the ${amount} ${symbol} loan principal.`,
      rateLine: (rate: string, days: string) => `${rate} APR · ${days}`,
      gone: 'This signed order is no longer fillable (filled, cancelled, or expired). The book will catch up shortly. Nothing was sent.',
      makerNotFunded:
        'The maker’s vault doesn’t currently cover this order, so the fill would fail on-chain. Nothing was sent — the maker must top up their vault first.',
      illiquid:
        'One of this order’s assets isn’t priced by the protocol right now, and this compact confirm can’t walk you through the in-kind default terms that implies. Nothing was sent.',
      // Shown only on deploys with tiered identity verification
      // enforced (never on this retail deploy, where enforcement is
      // off and the preflight passes through).
      kycBlocked:
        'This deployment’s identity-verification rules don’t cover one side of this order at this value, so the fill would fail on-chain. Nothing was sent or approved.',
      // Shown only on deploys with the progressive risk-access gate
      // enabled (never on this retail deploy, where the gate is off
      // and the preflight passes through after one read).
      riskBlocked:
        'This deployment’s risk-access rules block one side of this order right now — the maker or your wallet needs an on-chain access level or standing consent this compact confirm can’t collect. Nothing was sent or approved.',
      accept: 'Fill order',
      accepting: 'Filling…',
      accepted: 'Signed order filled — the loan is live.',
    },
    chart: {
      title: 'Executed rates',
      loading: 'Loading chart…',
      // §5.3 rule 5 — the header shows the last executed print, never
      // a %-change ticker.
      lastFill: (rate: string, ago: string) => `last fill: ${rate} · ${ago}`,
      lastFillNone: 'no fills yet',
      // Two empty states (Codex #1139 round-1 P3, tightened round 4):
      // `empty` may only claim "never filled" when the evidence covers
      // the whole history (range = all, or a confirmed-empty tape) AND
      // the tape holds no fill — a tape-proven fill always gets the
      // range-scoped line, even at range = all (the 60 s candle-cache
      // skew window after a first fill). See chartEmptyKind.
      empty:
        'No fills yet for this market — the chart draws only executed rates.',
      emptyRange: 'No fills in this range — try a longer range.',
      unavailable: 'We couldn’t load the rate history right now.',
      retry: 'Retry',
      quotedMid: 'quoted mid',
      quotedMidHint:
        'Dashed line = the book’s current quoted mid — a resting quote, not an executed rate.',
      sparseNote: (n: number) =>
        `Sparse market — ${n} fill${n === 1 ? '' : 's'} in this range, drawn individually. Candles appear once there’s enough tape to mean something.`,
      intervalLabel: 'Interval',
      rangeLabel: 'Range',
      attribution: 'Charts by TradingView',
      tooltipFills: (n: number) => `${n} fill${n === 1 ? '' : 's'}`,
      mobileBook: 'Book',
      mobileChart: 'Chart',
      mobileViewLabel: 'Desk view',
    },
    history: {
      tab: 'History',
      caption:
        'Everything this wallet ever traded on the desk — every market, every status. Repaid, claimed, and transferred positions stay listed.',
      empty: 'No desk history for this wallet yet.',
      unavailable: 'We couldn’t load your history right now.',
      loadMore: 'Load more',
      loadingMore: 'Loading…',
      loading: 'Loading your history…',
      roleLender: 'Lender',
      roleBorrower: 'Borrower',
      started: 'started',
    },
    ticket: {
      title: 'Order ticket',
      sideLend: 'Lend',
      sideBorrow: 'Borrow',
      amountLend: 'Amount to lend',
      amountBorrow: 'Amount to borrow',
      rateLend: 'Rate — minimum you’ll accept (APR %)',
      rateBorrow: 'Rate — maximum you’ll pay (APR %)',
      collateralRequire: 'Collateral you require',
      collateralLock: 'Collateral you lock',
      collateralFixedNote:
        'Set by the selected market — switch markets in the header to post against a different collateral asset.',
      expiryLabel: 'Expiry',
      expiryGtc: 'GTC',
      expiryCustom: 'Custom…',
      expiryInvalid: 'The custom expiry must be a future date and time.',
      expiryTooFar:
        'The custom expiry can be at most one year ahead — the protocol caps offer expiry at 365 days out.',
      fillModeLabel: 'Fill mode',
      fillPartial: 'Partial',
      fillAon: 'AON',
      fillIoc: 'IOC',
      fillPartialHint: 'Partial: the offer can fill in pieces down to a minimum.',
      fillAonHint: 'All-or-nothing: fills only as one whole loan at the full amount.',
      fillIocHint: 'Immediate-or-cancel: rests only until its expiry — an expiry is required.',
      iocNeedsExpiry: 'IOC orders need an expiry — pick 24h, 7d, or a custom time.',
      tenorNote: (label: string) =>
        `Posting into the selected ${label} market — change the term with the chips above.`,
      overDurationCap: (max: number) =>
        `The protocol currently caps offer duration at ${max} days — pick a shorter term above.`,
      post: 'Post order',
      posting: 'Posting…',
      posted: 'Order posted',
      postedNext:
        'Your offer is live on the book. Manage it under Open orders below — amend or cancel any time before it fills.',
      // #1131 slice D — gasless posting mode.
      modeLabel: 'Posting',
      modeOnchain: 'On-chain',
      modeGasless: 'Gasless (sign only)',
      modeOnchainHint:
        'Post the offer as a transaction — funds are escrowed in your vault now.',
      modeGaslessHint:
        'Sign the order off-chain and post it to the book — no transaction, no gas. Funds move only when a taker fills it.',
      gaslessEscrowNote:
        'Nothing is escrowed when you sign — a taker’s fill pulls from your vault’s free balance at that moment. Cancelling later is an on-chain transaction (unlike posting).',
      gaslessNeedsIndexer:
        'Gasless posting needs the order-book service, which isn’t configured right now. On-chain posting still works.',
      // #1145 round-2 — signed lender orders carry a single collateral
      // requirement, so partial slices can’t keep the contract’s
      // constant collateral-to-principal ratio; only a full fill can
      // consume them. Shown as the fill-mode note (and the disabled
      // Partial chip’s tooltip) in gasless lender mode.
      gaslessLenderAonNote:
        'Gasless lend orders fill only as one whole loan — a signed lender order can’t be sliced on-chain, so it posts all-or-nothing. Partial stays available with on-chain posting.',
      gaslessPost: 'Sign & post to the book',
      gaslessPosting: 'Signing…',
      gaslessConsentRequired:
        'Review and accept the risk disclosures and terms first — for a gasless order, your signature is what records that consent.',
      gaslessPosted:
        'Signed order posted to the book — no gas spent. It fills when a taker accepts it.',
      gaslessFundsWarn: (amount: string, symbol: string) =>
        `Heads up: your vault’s free balance is below the ${amount} ${symbol} this order commits. The fill will fail if the funds aren’t there when a taker accepts — deposit to your vault to keep the order fillable.`,
      gaslessRejected: (reason: string) =>
        `The book rejected this order (${reason}). Nothing was posted.`,
      gaslessUnavailable:
        'We couldn’t reach the order book right now — the order was NOT posted. Please try again in a moment.',
      securityBlocked: (leg: string, reasons: string[]) =>
        `Posting is held: an independent security check flags the ${leg} (${reasons.join('; ')}).`,
      securityUnknown: (leg: string) =>
        `Posting is held until the independent security check for the ${leg} succeeds.`,
      // UX-009 — the FIRST unmet gate, shown under the disabled Post
      // button so the greyed state always says why (the ticket has no
      // review checklist like the guided flow's).
      blockNetwork: 'Switch to a supported network to post.',
      blockNoMarket: 'Pick a market in the header first.',
      blockAmount: 'Enter the amount above.',
      blockRate: 'Enter a rate between 0 and 100%.',
      blockCollateral: 'Enter the collateral amount above.',
      blockLoading: 'Loading market details — one moment.',
      blockConsent: 'Review and accept the risk terms above to post.',
      blockGaslessService:
        'Gasless posting needs the order-book service, which isn’t available right now — switch Posting to On-chain.',
      // UX-016 — consent auto-clears whenever a term changes; say so
      // beside the cleared box so the un-tick doesn't read as a bug.
      consentRecheck: 'Terms changed — please re-confirm.',
      // UX-027 — Max chip + a fee/commitment summary before consent.
      max: 'Max',
      feePreviewTitle: 'Fees & commitment',
      escrowNow: (amount: string, symbol: string) =>
        `You escrow now: ${amount} ${symbol}.`,
      commitAtFill: (amount: string, symbol: string) =>
        `You commit ${amount} ${symbol} — pulled from your vault only when a taker fills.`,
      lockNow: (amount: string, symbol: string) =>
        `You lock now: ${amount} ${symbol} as collateral.`,
      lockAtFill: (amount: string, symbol: string) =>
        `You commit ${amount} ${symbol} collateral — locked only when a taker fills.`,
      netYield: (net: string, feePct: string) =>
        `Net yield ≈ ${net}% APR after the ${feePct}% protocol fee on the interest you earn.`,
      lifNote: (feePct: string, amount: string, symbol: string) =>
        `Loan initiation fee: ${feePct}% of principal (≈ ${amount} ${symbol}), charged when the loan starts.`,
    },
    orders: {
      tab: 'Open orders',
      empty: 'No open orders. Post one with the ticket.',
      unavailable: 'We couldn’t load your open orders right now.',
      heldNotCreated: 'Held — managed by its creator',
      cancel: 'Cancel',
      cancelling: 'Cancelling…',
      cancelCooldown: (secs: number) =>
        `Cancel available in ${secs}s — new unfilled offers have a short protocol cooldown.`,
      amend: 'Amend',
      amendTitle: 'Amend in place — same offer, same position, one transaction.',
      amendLoadFailed:
        'We couldn’t read this offer’s live values, and amending must start from them. Please try again.',
      amendMinAmount: 'Min amount',
      amendMaxAmount: 'Max amount',
      amendAmountAon: 'Amount (all-or-nothing)',
      amendRate: 'Rate (APR %)',
      amendRateMax: 'Rate max (APR %)',
      amendCollateral: 'Collateral',
      amendCollateralMax: 'Collateral max',
      amendNoChange: 'Nothing changed yet.',
      amendMalformed:
        'Enter plain decimal numbers only — digits with an optional decimal point.',
      amendInvalid: 'Each minimum must be at or below its maximum, and neither maximum can drop below what’s already filled.',
      amendPositive: 'Amounts and collateral must be greater than zero.',
      amendGrowNote: (amount: string, symbol: string) =>
        `Growing this order locks ${amount} ${symbol} more from your wallet — it needs a token approval first.`,
      amendAllowanceLost:
        'The token approval for this grow is no longer sufficient — nothing was changed. Please approve again.',
      approveFirst: 'Approve first',
      approving: 'Approving…',
      save: 'Save changes',
      saving: 'Amending…',
      amended: 'Order amended.',
      // #1131 slice D — the wallet's own gasless signed orders.
      signedTitle: 'Signed orders (this market)',
      signedNote:
        'Gasless signed orders you posted for the selected market. Orders for other markets don’t show here — switch the market in the header to manage them.',
      signedCancel: 'Cancel on-chain',
      signedCancelling: 'Cancelling…',
      signedCancelNote:
        'Posting was free, but cancelling costs gas: the only way to revoke a signature the book already holds is an on-chain transaction.',
      signedCancelled: 'Signed order cancelled on-chain.',
    },
    positions: {
      tab: 'Positions',
      empty: 'No open positions in this wallet.',
      unavailable: 'We couldn’t load your positions right now.',
      health: 'Health',
      notPriced: 'No auto-liquidation',
      manage: 'Manage',
      allPositions: 'All positions →',
    },
  },

  vpfi: {
    title: 'VPFI discounts',
    optional:
      'Optional: hold VPFI in your vault to reduce protocol fees on eligible loans. You never need VPFI to use Vaipakam.',
    noGasDiscount: 'Your VPFI discount does not reduce network gas.',
    withdrawWarning: 'Withdrawing VPFI can lower future fee discounts.',
    // UX-035 — the below-first-threshold band, stated so a small holder
    // isn't left guessing. The threshold is admin-tunable, so the note
    // is derived from the LIVE first tier threshold (Codex #1175) rather
    // than a hardcoded number that could contradict the table above.
    belowMinNote: (floor: string) =>
      `Holding under ${floor} VPFI earns no fee discount.`,
    notOnThisChain: (chain: string) =>
      `VPFI deposits aren’t available on ${chain} yet. Everything else on Vaipakam works without VPFI.`,
    tokenChanged:
      'The VPFI token configuration changed since you reviewed. Nothing was approved — please check the updated numbers and try again.',
    tokenCheckRetry:
      'We couldn’t confirm the VPFI token just now — nothing was approved. Please try again in a moment.',
    addToWallet: 'Add VPFI to MetaMask',
    addedToWallet: 'Asked your wallet to track VPFI.',
  },

  errors: {
    // F-20260703-005 (#988) — say HOW MUCH more whenever the caller can
    // compute the shortfall; the amount-less form is the fallback for
    // sites that can't (e.g. unknown decimals).
    needMore: (asset: string, shortBy?: string) =>
      shortBy
        ? `You need about ${shortBy} more ${asset} to continue.`
        : `You need more ${asset} to continue.`,
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
    nothingToClaim:
      'There’s nothing for this side to claim on-chain right now — the payout may be zero or already collected. Nothing was sent.',
    preclosePastGrace:
      'This loan is past its due date and grace window, so closing early is no longer possible — nothing was sent. The default process applies now.',
    refinancePastGrace:
      'This loan is past its due date and grace window, so it can no longer be refinanced — nothing was sent. The default process applies now.',
    saleListingMatured:
      'This loan is past its due date, so the position can no longer be listed for sale — nothing was sent.',
    refinanceNotOriginalBorrower:
      'This position changed hands since the loan began, so its collateral can’t carry over into a refinance — nothing was sent. Repaying or closing early stays available.',
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
    // Help's fee FAQ (question + full answer). Centralised so the lazy
    // live-value card and Help's static-default fallback render the same
    // wording (UX2-008 — the live fee read pulls the Diamond ABI, so it
    // lives in a lazy chunk with a default-value fallback; these strings
    // are ABI-free and shared by both).
    faqQuestion: 'What fees does Vaipakam charge?',
    faqAnswer: (lifPct: string, yieldPct: string) =>
      `Vaipakam charges a ${lifPct} loan initiation fee on the borrowed amount. Vaipakam keeps ${yieldPct} of the interest you earn. Late repayment adds 1% of the outstanding amount after day one, growing 0.5% per day, capped at 5%. Network gas is separate and goes to the blockchain, not to Vaipakam.`,
    // Non-committal variant for the disconnected /help fallback — the
    // exact loan-initiation and yield-fee percentages are live,
    // governance-tunable config (a wallet-free RPC read pulls the ABI,
    // which /help stays clear of on first paint, UX2-008). Quoting a
    // hardcoded default here could publish a stale rate if governance
    // has retuned it (Codex #1200 r2), so this states the fee STRUCTURE
    // and directs the user to connect for the exact current numbers.
    faqAnswerGeneric:
      'Vaipakam charges a loan initiation fee on the amount borrowed and keeps a share of the interest a lender earns. Late repayment adds 1% of the outstanding amount after day one, growing 0.5% per day, capped at 5%. Network gas is separate and goes to the blockchain, not to Vaipakam. Connect your wallet to see the exact current rates.',
  },

  faucet: {
    title: 'Get test assets',
    lede: 'Mint mock tokens and a test NFT so you can try borrowing, lending, and renting on a test network — no real value, no cost beyond gas.',
    // Shown when someone lands on /faucet on a network without mocks
    // (any mainnet, or a testnet we haven't seeded).
    notTestnetTitle: 'Test assets aren’t available here',
    notTestnetBody: (chainName: string) =>
      `The faucet only works on our test networks. You’re on ${chainName}, which uses real assets — switch to a test network to mint practice tokens.`,
    // A testnet we support but haven't seeded with faucet assets yet.
    noMocksBody: (chainName: string) =>
      `Test assets haven’t been set up on ${chainName} yet. Try a different test network, or check back soon.`,
    backHome: 'Back to home',
    testnetNote: (chainName: string) =>
      `You’re on ${chainName}, a test network. These tokens exist only for testing and have no real value.`,
    switchTitle: (chainName: string) =>
      `Switch your wallet to ${chainName} to mint test assets.`,
    minting: 'Minting…',
    viewTx: 'View transaction',
    // UX-023 — the mint-success banner carries the next hop so the
    // guided faucet→first-offer path doesn't break after hop one.
    nextSteps: 'Next: put it to work —',
    nextBorrow: 'Borrow against it',
    nextLend: 'Lend it out',
    // NFT mints route to the RENTAL flow, not the ERC-20 lend flow
    // (Codex #1168 r1) — NFTs aren't loan principal here.
    nextRent: 'List it for rent',
    footer:
      'Minted assets land in your wallet. Use “My vault” and the Borrow, Lend, and NFT Rental screens to put them to work.',
    mintedTokens: (units: number, symbol: string) =>
      `Minted ${units.toLocaleString()} ${symbol} to your wallet.`,
    // The full token ID matters: the NFT Rental listing form needs the
    // EXACT id, so the success banner shows it whole with a copy button
    // (never truncated — a random 256-bit id can't be retyped).
    mintedNft:
      'Minted a test rental NFT to your wallet. Its token ID — you’ll need it to list the rental:',
    copyTokenId: 'Copy token ID',
    copiedTokenId: 'Copied.',
    liquid: {
      title: 'Liquid test token (tLIQ)',
      blurb:
        'Priced by a test oracle, so it behaves like a liquid asset — health factor, liquidation, and refinancing all work with it. Pair it with mWETH (one as the loan, one as collateral) when a flow needs two different liquid tokens.',
      action: (units: number) => `Mint ${units.toLocaleString()} tLIQ`,
    },
    liquid2: {
      // Symbol is resolved from the token's live on-chain symbol() (#1103).
      // During the window where the bundled deployment still points this slot
      // at the pre-relabel token (before an operator reruns the mock deploy +
      // deployment sync), the row shows the ACTUAL ticker a click will mint
      // instead of a stale "mUSDC". Until the read resolves (or if it errors)
      // the symbol is `null` and we show a GENERIC label — never asserting a
      // specific ticker we haven't confirmed, which would re-open the exact
      // stale-label window this resolves (Codex #1109 P2).
      title: (symbol: string | null) =>
        symbol ? `Mock USD Coin (${symbol})` : 'Mock USD Coin (test stablecoin)',
      blurb:
        'A test USDC priced at $1 by a test oracle — a second, distinct liquid token so you can run a deal where both the loan and the collateral are liquid (with a realistic price spread against tLIQ / mWETH) without pairing a token against itself.',
      action: (units: number, symbol: string | null) =>
        symbol
          ? `Mint ${units.toLocaleString()} ${symbol}`
          : `Mint ${units.toLocaleString()} test stablecoin`,
    },
    mweth: {
      title: 'Mock wrapped ETH (mWETH)',
      blurb:
        'An oracle-priced test token that plays the “wrapped ETH” role in demos. It is NOT real WETH — it mints for free and has no value.',
      action: (units: number) => `Mint ${units.toLocaleString()} mWETH`,
    },
    nft2: {
      title: 'Second rentable test NFT (vART)',
      blurb:
        'Another ERC-4907 collection — handy when you want to list one NFT and rent a different one, or run several rentals at once.',
      action: 'Mint a vART NFT',
    },
    addToWallet: (symbol: string) => `Add ${symbol} to MetaMask`,
    addedToWallet: 'Asked your wallet to track it.',
    illiquid: {
      title: 'Illiquid test token (tILQ)',
      blurb:
        'No price feed, so it behaves like an illiquid asset — both sides must consent, and default transfers the collateral in kind.',
      action: (units: number) => `Mint ${units.toLocaleString()} tILQ`,
    },
    illiquid2: {
      title: 'Second illiquid test token (tILQ2)',
      blurb:
        'Also unpriced. Pair it with tILQ (one as the loan, one as collateral) to try a deal where NEITHER side has a price — both parties must consent, no health factor applies, and default hands the collateral over in kind.',
      action: (units: number) => `Mint ${units.toLocaleString()} tILQ2`,
    },
    nft: {
      title: 'Rental test NFT (vRENT)',
      blurb: 'An ERC-4907 rentable NFT for trying the NFT rental flows.',
      action: 'Mint a test NFT',
    },
  },

  vault: {
    title: 'My vault',
    lede: 'Your own on-chain account. Only your wallet controls it — Vaipakam never pools user funds.',
    noVaultYet:
      'Your vault is created automatically with your first offer, loan, or deposit. Nothing to set up.',
    // UX-023 — both vault empty states point forward instead of
    // dead-ending.
    emptyCta: 'Get started',
    emptyCtaFaucet: 'Get test assets',
    unavailable:
      'We couldn’t read your vault right now. Your funds are unaffected — please try again in a moment.',
    lockedHint:
      'Locked amounts back your open offers, active loans, and rentals. They free up when those close.',
  },

  activity: {
    title: 'Activity',
    lede: 'Everything your wallet has done on Vaipakam, newest first.',
    empty: 'No activity yet. It appears here as you use Vaipakam.',
    // UX2-007 — the empty feed hands over the first move instead of
    // pointing nowhere (the UX-023 forward-CTA pattern).
    emptyCtaBorrow: 'Borrow something',
    emptyCtaLend: 'Lend something',
    unavailable:
      'We couldn’t load your activity right now. Please try again in a moment.',
    truncatedNote:
      'Showing recent activity only — the protocol feed is busy and older events may not be listed.',
    // UX2-007 tail — states the page's recent-only scope without
    // asserting that older events DO exist (which read as an unnecessary
    // hedge for genuinely-new wallets). True whether the wallet is new
    // or has history older than the recent scan window (#1200).
    truncatedEmpty:
      'Nothing of yours in recent protocol activity. This page lists recent activity only, so anything older isn’t shown here.',
    // UX-008 — one substantive sub-line per row.
    plusMore: (n: number) => ` · +${n} more in this transaction`,
    viewTx: 'View transaction',
    loadMore: 'Load older activity',
    loadingMore: 'Loading…',
    // UX-050 — when the indexer is degraded, the event feed can't
    // render, but the user's positions are chain-authoritative — point
    // there instead of dead-ending.
    unavailableFallback: 'Your current loans and rentals are always available on',
    positionsLink: 'My positions',
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
    // Codex #1166 r1 — while the list's health read is loading or
    // errored, a green time badge would silently re-assert the
    // false-safe state UX-003 removed; the badge goes neutral instead.
    listChecking: 'checking health',
    listCheckingTitle:
      'This loan’s health hasn’t been read yet, so the badge stays neutral. Liquidation protection still applies on-chain.',
    // UX-030 — the advanced numbers carry their own one-clause
    // definitions; a bare "HF 1.42 / LTV 51%" is noise to anyone who
    // hasn't already internalized the jargon.
    advancedDetail: (ratio: string, ltvPct: string, drop: string | null) =>
      `(Health factor ${ratio} — the collateral’s value measured against what’s owed; below 1.00 the loan can be liquidated. Loan-to-value ${ltvPct} — the borrowed amount as a share of the collateral’s value.${drop ? ` Roughly, liquidation begins if the collateral’s value falls about ${drop}.` : ''})`,
  },

  notFound: {
    title: 'This page doesn’t exist',
    body: 'The link may be old or mistyped. Nothing is lost — your positions are safe.',
    backHome: 'Back to Home',
  },
} as const;
