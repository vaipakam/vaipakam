/**
 * Every user-facing string in alpha02, in one module.
 *
 * Why centralized: (1) the naive-user wording rules from
 * docs/DesignsAndPlans/BasicUserUXSimplification.md are enforceable in
 * one place; (2) localization later becomes a matter of swapping this
 * module for an i18n catalog without touching pages — which is now
 * wired: the exported `copy` is an i18n-aware Proxy over the English
 * source below (see src/i18n/reactiveCopy.ts). English strings here
 * remain the single source of truth; locale bundles in
 * src/i18n/locales/<code>.json override per key, missing keys fall
 * back to the English text. Editing a string here is still all it
 * takes for the English app — plus re-running
 * `pnpm --filter @vaipakam/alpha02 i18n:template` so translators see
 * the new key (a vitest drift check enforces this).
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

import { createTranslatedCopy } from '../i18n/reactiveCopy';
import { tmpl } from '../i18n/tmpl';

const copySource = {
  app: {
    name: 'Vaipakam',
    tagline: 'Lend, borrow, and rent NFTs — directly with other people.',
  },

  /** App chrome — nav labels + settings screen strings (extracted
   *  from AppShell/Settings inline JSX when i18n landed, so the
   *  highest-visibility chrome is translatable). */
  chrome: {
    skipToContent: 'Skip to content',
    connectedTo: tmpl('Connected to {{chain}}', ['chain']),
    loading: 'Loading…',
    more: 'More',
    navPrimaryAria: 'Primary',
    navQuickAria: 'Quick navigation',
    moreSheetAria: 'More destinations',
    modeSwitchAria: 'Interface mode',
    modeBasic: 'Basic',
    modeAdvanced: 'Advanced',
    nav: {
      home: 'Home',
      borrow: 'Borrow',
      lend: 'Lend',
      rent: 'NFT Rental',
      positions: 'My positions',
      positionsShort: 'Positions',
      claims: 'Claims',
      vault: 'My vault',
      faucet: 'Get test assets',
      offers: 'Offer Book',
      desk: 'Rate Desk',
      vpfi: 'VPFI discounts',
      activity: 'Activity',
      nftVerifier: 'NFT verifier',
      settings: 'Settings',
      help: 'Help',
    },
    settings: {
      language: 'Language',
      languageHint:
        'Languages without a finished translation show English text for now.',
      languagePickerAria: 'Display language',
    },
  },

  /** Per-route search-result metadata (title + ~155-char description),
   *  consumed by SeoMeta. Same wording rules as the rest of this file
   *  apply — descriptions are what a stranger reads on a Google result
   *  page, so no jargon and never guaranteed-yield phrasing. */
  seo: {
    home: {
      title: 'Vaipakam — P2P lending, borrowing & NFT rental',
      description:
        'Lend, borrow, and rent NFTs directly with other people. Set your own terms — your assets stay in your own on-chain vault, with no pool and no middleman.',
    },
    borrow: {
      title: 'Borrow assets — Vaipakam',
      description:
        'Lock collateral you own and receive the tokens you need. Direct person-to-person loans on terms you choose, from your own on-chain vault.',
    },
    lend: {
      title: 'Earn by lending — Vaipakam',
      description:
        'Offer your tokens to borrowers and earn interest if they repay. Your assets stay in your own on-chain vault until a borrower accepts your terms.',
    },
    rent: {
      title: 'NFT rental — Vaipakam',
      description:
        'Earn fees from an NFT you own, or get temporary use of one. Ownership never moves — the NFT stays locked in the owner’s vault for the rental term.',
    },
    offers: {
      title: 'Offer Book — Vaipakam',
      description:
        'Browse every open lending and borrowing offer on the network — assets, rates, durations, and collateral terms, live from the chain.',
    },
    desk: {
      title: 'Rate Desk — Vaipakam',
      description:
        'Live person-to-person lending rates by asset pair and duration, executed-rate history, and the signed-offer book.',
    },
    vpfi: {
      title: 'VPFI fee discounts — Vaipakam',
      description:
        'Optional: hold VPFI in your vault to reduce protocol fees. Never required to lend, borrow, or rent.',
    },
    nftVerifier: {
      title: 'NFT rental verifier — Vaipakam',
      description:
        'Check whether an NFT rental listed on Vaipakam is genuine, and see the token’s current rental status straight from the chain.',
    },
    help: {
      title: 'Help — Vaipakam',
      description:
        'Plain-language answers about lending, borrowing, NFT rentals, fees, and the risks — plus build and contract info for this deployment.',
    },
    // Wallet-gated, per-user surfaces — carried for the browser tab
    // title only; SeoMeta marks all of these noindex.
    positions: { title: 'My positions — Vaipakam' },
    claims: { title: 'Claims — Vaipakam' },
    vault: { title: 'My vault — Vaipakam' },
    activity: { title: 'Activity — Vaipakam' },
    settings: { title: 'Settings — Vaipakam' },
    faucet: { title: 'Test assets — Vaipakam' },
    notFound: { title: 'Page not found — Vaipakam' },
  },

  home: {
    assetsNote:
      'Your assets sit in your own on-chain vault — Vaipakam never pools or holds them for you.',
    title: 'What would you like to do?',
    lede: 'Pick a job to get started. You can switch to Advanced mode any time in Settings.',
    // Migrated to tmpl (translatable interpolation). Call:
    // copy.home.testnetNudge({ chainName }).
    testnetNudge: tmpl(
      'You’re on {{chainName}}, a test network. Get free test assets to try things out →',
      ['chainName'],
    ),
    // The home "you have N active positions" nudge — extracted from
    // ActivePositionsBanner (was inline JSX the guardrail couldn't see).
    // Plural via i18next count. Call: copy.home.activePositions({ count }).
    activePositions: tmpl(
      'You have {{count}} active positions. View them under My positions.',
      ['count'],
      { one: 'You have {{count}} active position. View them under My positions.' },
    ),
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
    pickerBlock: tmpl(
      `Danger — an independent security check flags this token: {{reasons}}. The flows will not let a deal with this token proceed.`,
      ['reasons'],
    ),
    pickerWarn: tmpl(
      `Caution — an independent security check reports: {{reasons}}. You can continue, but read these carefully first.`,
      ['reasons'],
    ),
    pickerUnknown:
      'The independent security check could not verify this token right now. Deals with unverified tokens are held back until the check succeeds.',
    pickerUnsupported:
      'The independent security check does not cover this network (test networks are not indexed). Extra care: only use tokens you deployed or trust.',
    gateBlock: tmpl(
      `This deal's {{leg}} failed an independent security check: {{reasons}}. Accepting it is disabled — a token like this can be impossible to sell or transfer no matter what the deal terms say.`,
      ['leg', 'reasons'],
    ),
    gateUnknown: tmpl(
      `The independent security check for this deal's {{leg}} could not run. Try again in a moment — accepting is held back until the token can be verified.`,
      ['leg'],
    ),
    gateUnsupported: tmpl(
      `The independent security check does not cover this network (test networks are not indexed), so this deal's {{leg}} was not screened. Extra care: only accept tokens you trust.`,
      ['leg'],
    ),
    gateWarn: tmpl(
      `Heads up on this deal's {{leg}}: {{reasons}}. Make sure you understand these before you continue.`,
      ['leg', 'reasons'],
    ),
    gateChanged: tmpl(
      `The security check on this deal's {{leg}} reports new findings since you reviewed it. Nothing was signed. The review above now shows the update — read it and tick the consent box again if you still want to proceed.`,
      ['leg'],
    ),
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
    matchesHidden: tmpl(
      '{{count}} matching offers are hidden because an independent security check flagged one of their tokens as dangerous.',
      ['count'],
      { one: '1 matching offer is hidden because an independent security check flagged one of its tokens as dangerous.' },
    ),
    // CoinGecko reputation soft-signal (#1036 fallback layer) — only
    // on networks with market data; never a block, never a gate.
    reputationListedTop: tmpl(
      `Market listing found: {{name}}{{symbolSuffix}}, ranked #{{rank}} by market size. Check that this matches the token you meant.`,
      ['name', 'symbolSuffix', 'rank'],
    ),
    reputationListedDeep: tmpl(
      `Market listing found: {{name}}{{symbolSuffix}} — outside the top 200 by market size. Smaller tokens move harder and disappear faster; double-check the project.`,
      ['name', 'symbolSuffix'],
    ),
    reputationUnlisted:
      'No market listing found for this address — the wider market doesn’t know this token. That alone doesn’t make it bad, but verify the contract address with the project before dealing in it.',
  },
  signing: {
    intro: tmpl(
      "You'll confirm {{count}} times in your wallet, in this order:",
      ['count'],
      { one: 'One wallet confirmation finishes this:' },
    ),
    introUpTo: tmpl(`Up to {{n}} wallet confirmations, in this order:`, ['n']),
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
    phaseSign: tmpl(`Signing terms… ({{c}} of {{t}})`, ['c', 't']),
    phaseApprove: tmpl(`Approving… ({{c}} of {{t}})`, ['c', 't']),
    phasePermit: tmpl(
      `Signing the permission… ({{c}} of {{t}}) — free, no gas`,
      ['c', 't'],
    ),
    phaseSend: tmpl(`Submitting… ({{c}} of {{t}})`, ['c', 't']),
  },
  killSwitch: {
    disabled:
      'This action is switched off right now — the operators have paused it as a precaution while something is looked into. Anything already yours is unaffected: repayments, claims, and withdrawals all stay open.',
  },
  alerts: {
    bandWarn: 'Warn',
    bandAlert: 'Alert',
    bandCritical: 'Critical',
    bandsSave: 'Save',
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
    // Rollout-window failure surfaced to the user when the agent can't
    // yet store a due-date-reminder opt-out (thrown, shown as the card's
    // error line).
    optoutUnavailable:
      'That switch can’t be saved right now — the alert service is being upgraded. Please try again in a little while.',
    pushTitle: 'Prefer app push instead?',
    pushBody:
      'The same alerts are published to Vaipakam’s Push Protocol channel — subscribe there with your wallet and any Push-compatible app delivers them.',
    pushEnable: 'Enable Push delivery',
    pushEnabled: 'Push delivery is on for this wallet.',
    pushButton: 'Open the Push channel',
    loanNudge: 'Want a Telegram warning if this loan gets risky? Set up alerts in Settings.',
  },
  notifications: {
    // The in-app inbox (#1213). Free, wallet-native — the same events the
    // paid Telegram/Push channels deliver, shown right here without any
    // setup. Naive-user wording: outcomes, not event names.
    bellLabel: 'Notifications',
    title: 'Notifications',
    // Shown while the first page is still loading.
    loading: 'Loading your notifications…',
    // Shown when a wallet is connected but the inbox is empty.
    empty: 'Nothing yet. Updates about your loans show up here.',
    // Indexer unavailable — honest, matches the app-wide "cache not oracle"
    // posture (never a fake empty).
    unavailable: 'Couldn’t load your notifications just now. They’ll be here when the connection is back.',
    connectFirst: 'Connect your wallet to see updates about your loans.',
    // The row's headline, by outcome kind. Each row deep-links to the
    // position, which re-verifies the exact state on chain.
    line: {
      loan_matched: 'Your loan is now active.',
      partial_repay: 'A repayment came in on your loan.',
      loan_repaid: 'A loan was fully repaid — see what you can claim.',
      loan_defaulted: 'A loan defaulted — see what you can claim.',
      internal_matched: 'A loan of yours closed by matching — see what you can claim.',
      // Calendar rows (#1213 PR 2) — time-derived reminders from the
      // indexer's cron sweep, covering illiquid loans too. Each line must
      // stay TRUE FOREVER as an inbox history entry (Codex #1298 r1+r2):
      // every reminder states the fact AS OF the notice ("was …") and
      // points at the position page — the authority for the loan's live
      // state — so a loan extended/repaid/closed after the row was minted
      // can't be misrepresented by old inbox history.
      maturity_7d: 'A loan was a week from its due date — open it to see where it stands.',
      maturity_1d: 'A loan was a day from its due date — open it to see where it stands.',
      grace_entered: 'A loan went past its due date — open it to see where it stands.',
      // HF-band rows (#1213 PR 2b) — the keeper's loan-health crossings.
      // Same durable-history rule: each states the dip AS OF the notice
      // ("dipped") and defers the live number to the position page.
      hf_warn: 'A loan’s health dipped below 1.5 — open it to see where it stands.',
      hf_alert: 'A loan’s health dipped below 1.2 — open it to see where it stands.',
      hf_critical:
        'A loan’s health dipped below 1.05, close to the 1.0 liquidation line — open it to act.',
      // Fallback for any future kind the client doesn't know yet.
      generic: 'There’s an update on your loan.',
    } as Record<string, string>,
    // Secondary line — shown only for a loan-linked (tappable) row.
    loanRef: tmpl(`Loan #{{loanId}} · tap to view`, ['loanId']),
    unreadBadgeTitle: tmpl('{{count}} unread notifications', ['count'], {
      one: '1 unread notification',
    }),
  },
  errorBoundary: {
    detailAria: 'Error detail',
    glosses: {
      '185': 'Maximum update depth exceeded — a component is updating state on every render. This is an infinite render loop.',
      '300': 'Rendered fewer hooks than expected — a hook was skipped by a conditional return.',
      '301': 'Too many re-renders — a state setter is being called during render.',
      '310': 'Rules of Hooks violation — a hook was called conditionally or out of order.',
      '321': 'Invalid hook call — hooks can only run inside a React function component.',
      '418': 'Hydration mismatch — server and client rendered different markup.',
    },
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
    rpcOk: tmpl(`Working — latest block {{block}}`, ['block']),
    rpcChecking: 'Checking…',
    rpcFailing:
      'Not responding — the app can’t reach the blockchain right now. Reloading, or switching networks and back, often clears it.',
    indexer: 'Market data cache',
    indexerOk: tmpl(`Up to date (refreshed {{age}} ago)`, ['age']),
    indexerStale: tmpl(

        `Running behind (last refreshed {{age}} ago) — market lists may lag; your own positions still load directly from the chain.`,

        ['age'],

      ),
    indexerUnreachable:
      'Unreachable right now — market lists may not load until it recovers. Your own positions still load directly from the chain.',
    indexerNoCursor:
      'Reachable, but no data has been recorded for this network yet — it will fill as activity arrives.',
    indexerNotConfigured:
      'Not configured on this build — market lists can’t load here. Your own positions still load directly from the chain.',
    networkUnsupported: tmpl(
      `Wallet is on an unsupported network (chain id {{walletChainId}}) — data shown comes from {{readName}} ({{readChainId}}). Switch networks to transact.`,
      ['walletChainId', 'readName', 'readChainId'],
    ),
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
    sent: tmpl(
      `Sent. Your ticket number is {{id}} — keep it; quoting it connects any follow-up to this report.`,
      ['id'],
    ),
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
    unsupportedNetwork: tmpl(
      `This network isn’t supported. Vaipakam is available on {{chainNames}}. Switch networks to continue.`,
      ['chainNames'],
    ),
    switchNetwork: 'Switch network',
    // UX2-005 — named-target variant for surfaces that know exactly
    // which chain has what the user came for (faucet mocks, VPFI
    // deposits): offer the remedy, don't just describe it.
    switchToChain: tmpl(`Switch to {{chain}}`, ['chain']),
  },

  checks: {
    sanctionsChecking: 'Checking compliance status…',
    walletConnected: 'Wallet connected',
    supportedChain: 'On a supported network',
    balanceSufficient: tmpl(`Enough {{asset}} in your wallet`, ['asset']),
    tokenValid: 'Asset recognised as a token',
    // Live payment-asset check row: "<Asset> recognised (SYMBOL)".
    recognised: tmpl('{{label}} recognised ({{symbol}})', ['label', 'symbol']),
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
    title: 'Help',
    lede: 'Quick answers in plain language.',
    buildLabel: 'Build',
    buildDevFallback: 'dev',
    faq: {
      assetsHeld: {
        q: 'Where are my assets held?',
        a: 'In your own Vaipakam Vault — an on-chain account that only your wallet controls. Vaipakam never pools user funds and cannot spend them for you.',
      },
      missedRepayment: {
        q: 'What happens if I don’t repay a loan?',
        a: 'After the due date plus a grace period, the lender can receive your locked collateral. If the collateral has a live market price, it can also be sold automatically when its value falls too far — repaying on time avoids both.',
      },
      lenderInterest: {
        q: 'Is the interest I see guaranteed when I lend?',
        a: 'No. It is what you earn if the borrower repays on time. If they default, your recovery depends on the collateral they locked — the review screen spells this out before you sign.',
      },
      nftRental: {
        q: 'What is an NFT rental?',
        a: 'The NFT stays locked in its owner’s vault; the renter gets temporary use rights, never ownership. Rental fees are prepaid, with a small refundable buffer.',
      },
      vpfi: {
        q: 'Do I need VPFI?',
        a: 'No. VPFI is optional — holding it in your vault can reduce protocol fees on eligible loans. It never reduces network gas, and you never need it to borrow, lend, or rent.',
      },
      modes: {
        q: 'What’s the difference between Basic and Advanced mode?',
        a: 'Basic keeps the guided Borrow, Lend, and NFT-rental journeys front and centre. Advanced additionally reveals the power surfaces — the Offer Book, the Rate Desk order book, VPFI discounts, and your full activity history. Switch any time from the mode toggle in the navigation; it never moves your positions.',
      },
      alerts: {
        q: 'How do I get alerts before a deadline or liquidation?',
        a: 'On the alerts card you can link Telegram (and enable browser push) to be warned as a loan nears its due date or a position’s health drops. Linking is a one-time signature; sending yourself a test alert confirms the channel actually works before you rely on it.',
      },
      claimCenter: {
        q: 'What is the Claim Center for?',
        a: 'When a loan you’re part of settles — a repayment you’re owed, or collateral from a default — the funds wait for you to claim them. The Claims page lists exactly what’s claimable and for which position, verified against the protocol’s own record, so nothing is stranded.',
      },
      wrongNetwork: {
        q: 'It says I’m on the wrong network — what do I do?',
        a: 'Offers, your vault, and the faucet are all per-network. If your wallet is on a chain Vaipakam isn’t deployed to, a banner offers a one-click switch to a supported network; the app never acts on an unsupported chain.',
      },
      nftVerifier: {
        q: 'How do I check a position NFT before buying it off-platform?',
        a: 'The NFT verifier (in the navigation) reads any Vaipakam position NFT straight from the chain and shows its real loan terms and status — so you can confirm what a listing actually represents before you trust a secondary-market sale.',
      },
    },
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
    wrongChainLink: tmpl(

        `That link points to an offer on {{chainName}}. Switch to that network (top of the page), then open the link again — offer numbers repeat across networks, so we won’t guess.`,

        ['chainName'],

      ),
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
    linkedLoanAcceptBlocked: tmpl(

        `This offer is tied to already-running loan #{{loanId}} — accepting it would settle or transfer that loan's position, not start the fresh loan reviewed above. This app can't yet show you the real terms of that kind of deal, so accepting it here is disabled for now.`,

        ['loanId'],

      ),
    // #986 P3 — the honest buy-a-running-loan review. Sale vehicles get
    // a REAL review (loan-derived numbers) instead of the block above;
    // preclose-offset links keep the block.
    saleVehicleBanner: tmpl(
      `This is a position sale: you'd be buying the lender side of already-running loan #{{loanId}}, not starting a new loan. The borrower and their repayment obligations don't change — only the lender does. The numbers below come from that loan, live.`,
      ['loanId'],
    ),
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
    saleBuyerNext: tmpl(
      `You\u2019re now the lender of loan #{{loanId}} \u2014 the loan keeps running unchanged for the borrower, and their repayment comes to you. Track it under My positions; when they repay you claim the principal and the remaining interest.`,
      ['loanId'],
    ),
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
    // Rent browse-row sub-lines.
    browseRowPriced: tmpl(
      '{{daily}} {{pay}}/day · {{duration}} · {{total}} {{pay}} up front (incl. buffer)',
      ['daily', 'pay', 'duration', 'total'],
    ),
    browseRowUnpriced: tmpl('{{duration}} · listing #{{id}}', ['duration', 'id']),
    perDaySuffix: tmpl(' ({{symbol}} per day)', ['symbol']),
    // Duration field hint when the picked term exceeds the protocol cap.
    durationCap: tmpl(
      'The protocol currently caps listings at {{max}} — pick a shorter length.',
      ['max'],
    ),
    // Review-receipt lines (extracted from Rent.tsx inline templates).
    receiptListYouReceive: tmpl(
      '~{{fees}} in rental fees for the full {{term}} term — the renter prepays everything up front.',
      ['fees', 'term'],
    ),
    receiptListYouLock: tmpl(
      'Your NFT {{nft}} moves into your vault and stays there for the whole listing and rental.',
      ['nft'],
    ),
    receiptRentYouReceive: tmpl(
      'Use rights of {{nft}} for {{duration}}, starting now.',
      ['nft', 'duration'],
    ),
    receiptRentYouLock: tmpl(
      '{{total}} prepaid — the full term’s fees plus a {{buffer}} refundable buffer.',
      ['total', 'buffer'],
    ),
    receiptRentYouCanLose: tmpl(
      'The {{buffer}} buffer if the rental isn’t closed on time. Your use rights end at expiry either way.',
      ['buffer'],
    ),
    receiptRentWhenEnds: tmpl(
      'Rights reset automatically after {{duration}}. Close the rental on time from its detail page to get the buffer back.',
      ['duration'],
    ),
    stepYourNft: 'Your NFT & price',
    stepChooseNft: 'Choose an NFT',
    stepReview: 'Review & sign',
    stepDone: 'Done',
    nftTypeLabel: 'NFT type',
    nftTypeErc721: 'Single NFT (ERC-721)',
    nftTypeErc1155: 'Multi-edition NFT (ERC-1155)',
    contractLabel: 'NFT contract address',
    contractHint: 'Single NFTs that support ERC-4907 give renters use rights other apps can see; other NFTs still rent, tracked inside Vaipakam.',
    tokenIdLabel: 'Token id',
    quantityLabel: 'Quantity',
    prepayAssetLabel: 'Asset renters pay you in',
    prepayAssetHint: 'Renters prepay the whole rental in this token.',
    dailyFeeLabel: 'Daily fee',
    durationLabel: 'Rental length',
    continueToReview: 'Continue to review',
    beforeYouSign: 'Before you sign',
    preparingReview: 'Preparing your review…',
    back: 'Back',
    waitingForWallet: 'Waiting for wallet…',
    viewTransaction: 'View the transaction',
    viewPositions: 'View my positions',
    liveFeesLoaded: 'Live fee terms loaded',
    liveFeesLoading: 'Loading live fee terms…',
    liveRentalLoaded: 'Live rental terms loaded',
    liveRentalLoading: 'Loading live rental terms…',
    paymentAssetCheckFailed: 'We couldn’t verify the payment asset just now — please retry in a moment.',
    paymentAssetRecognised: 'Payment asset recognised',
    nothing: 'Nothing.',
    listYouCanLose: 'Temporary use of the NFT while it is rented — the renter can never transfer or sell it.',
    listWhenEnds: 'When the rental ends, the renter’s rights reset automatically; you claim your fees and reclaim the NFT from the rental’s detail page.',
    rentYouMayOwe: 'Nothing more — fees are prepaid.',
    rentFeesNote: 'The price shown is the rental fee; Vaipakam’s cut comes out of the owner’s earnings, not on top of yours.',
    listingsLoading: 'Loading rental listings…',
    tryAgain: 'Try again',
    title: 'Rent or lend an NFT',
    lede: 'NFT rentals give temporary use rights — never ownership. The NFT stays locked in its owner’s vault for the whole rental.',
    ownPath: 'I own an NFT to rent out',
    ownPathBlurb: 'Set a daily fee — renters prepay the whole rental up front.',
    wantPath: 'I want to rent an NFT',
    wantPathBlurb: 'Pay up front, use the NFT until the rental ends.',
    // "‹other path›? Switch" toggle beneath the chosen rent/lend path.
    switchPrompt: tmpl('{{path}}? Switch', ['path']),
    // Fallback label for the prepayment token in the security-gate banners.
    prepaymentTokenLabel: 'prepayment token',
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
    bufferNote: tmpl(
      `Renters prepay the full term plus a {{pct}} refundable buffer. Close the rental on time and the buffer is returned.`,
      ['pct'],
    ),
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
    // Composed receipt lines (extracted from RefinanceFlow.tsx); catalog
    // refs (payoffNote, walletNote, guardrailNote, …) stay composed at
    // the call site.
    receiptYouMayOwe: tmpl(
      '~{{payoff}} to pay off this loan, pulled automatically when a lender accepts.',
      ['payoff'],
    ),
    feesTreasuryNote: tmpl(
      'The protocol’s {{cut}} cut of the payoff interest settles inside the payoff.',
      ['cut'],
    ),
    whenEndsComposed: tmpl(
      'When a lender accepts your request, when you cancel it, or {{branch}}.',
      ['branch'],
    ),
    expiresAfterDays: tmpl('when it expires {{days}} days after posting', ['days']),
    durationRange: tmpl('Between 1 and {{max}} days.', ['max']),
    consentLabel: 'I understand the payoff and wallet-balance terms below and agree to them.',
    receiptReceive: 'A new loan at your chosen terms the moment a lender accepts — your collateral moves to it automatically and this loan closes in the same transaction.',
    receiptLock: 'Nothing new — your existing collateral carries over to the new loan without ever unlocking.',
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
    walletNote: tmpl(
      `The payoff is pulled from your wallet automatically at the moment a lender accepts. The new loan’s money arrives in the same transaction, so keep about {{topUp}} spare in your wallet (the interest portion plus the new loan’s initiation fee) while the request is open.`,
      ['topUp'],
    ),
    shortIsSafe:
      'If your wallet is short when a lender tries to accept, the acceptance simply fails — nothing is taken and your current loan continues unchanged.',
    periodicWarning:
      'This loan pays interest on a periodic schedule. If a payment period becomes overdue while the request is open, a lender’s acceptance will fail until the period is settled — keep the loan’s payments current.',
    done:
      'Refinance request posted. When a lender accepts it, this loan closes automatically — you don’t need to do anything else. You can cancel the request below (cancellation opens a few minutes after posting).',
    pending: tmpl(
      `Refinance request #{{offerId}} is live. When a lender accepts it, this loan closes automatically in the same transaction.`,
      ['offerId'],
    ),
    pendingChecking: tmpl(
      `Checking the state of refinance request #{{offerId}}…`,
      ['offerId'],
    ),
    pendingExpires: tmpl(
      `The request expires on {{date}} if nobody accepts it.`,
      ['date'],
    ),
    pendingAccepted:
      'Your refinance request was accepted — this loan is being replaced by the new one. Refresh in a moment to see the final state.',
    pendingLoanClosed:
      'This loan has since closed another way, so the request can no longer complete — cancel it to also remove its standing payoff approval.',
    pendingExpired: tmpl(
      `This refinance request expired on {{date}} — no lender can accept it any more, and it no longer holds up your other actions here. Cancel it below to also remove its standing payoff approval; the loan continues unchanged.`,
      ['date'],
    ),
    cancel: 'Cancel refinance request',
    cancelSoon:
      'Cancellation opens a few minutes after posting — try again shortly.',
    cancelled:
      'Refinance request cancelled and the payoff approval removed — this loan continues unchanged. If you have other listings or requests using the same token, restore their approvals from their cards.',
    cancelledRevokeFailed:
      'Refinance request cancelled — this loan continues unchanged. The standing payoff approval couldn’t be removed automatically; you can revoke it from your wallet’s token-approvals view.',
    allowanceShort:
      'The payoff approval no longer covers everything this request could pull — a lender’s acceptance could fail (an acceptance after the due date also pulls the late fee and extra interest). Restore it below or cancel the request.',
    balanceShort: tmpl(
      `Your wallet holds less than the ~{{topUp}} spare this request needs — a lender’s acceptance would fail right now. Top up your wallet or cancel the request.`,
      ['topUp'],
    ),
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
    lateFeeDisclosure: tmpl(
      `If a lender accepts after the loan’s due date, the payoff grows — the late fee for being late plus interest that keeps accruing — by up to ~{{maxGrowth}} more for this request. The approval you grant covers that too, so a late acceptance can’t fail on it.`,
      ['maxGrowth'],
    ),
    expiresAtGraceEnd: tmpl(
      `when it expires with this loan’s grace window ({{date}}) — a refinance request can’t outlive the loan it replaces`,
      ['date'],
    ),
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
    // #1247 PAG-006 — the checked-token window's widen affordance.
    // Same one-click honesty as lists.showMore.
    checkMore: tmpl(`Check {{count}} more tokens`, ['count'], {
      one: `Check {{count}} more token`,
    }),
    checkMoreUnchecked: tmpl(
      `Check {{next}} more tokens ({{total}} unchecked)`,
      ['next', 'total'],
    ),
    loading: 'Reading your standing approvals…',
    unavailable:
      'We couldn’t read your approvals right now — please try again in a moment.',
    sourcesUnavailable:
      'We couldn’t load your loans and offers just now, so this list can’t be built completely — rather than show a partial picture, try again in a moment.',
    revoke: 'Revoke',
    staleNote:
      'We couldn’t refresh this list just now — the rows shown may be slightly stale. Revoking still works.',
    revoked: tmpl(
      `Approval removed for {{symbol}}. If a live request or listing needed it, its card will warn and offer a restore.`,
      ['symbol'],
    ),
  },

  nftVerifier: {
    title: 'NFT verifier',
    lede:
      'Vaipakam position NFTs carry real claim rights — whoever holds one controls that side of its loan. Check any token id before trusting it.',
    placeholder: 'Position NFT token id',
    check: 'Check',
    chainNote: tmpl(

        `Checked on {{chain}}. Token ids repeat across networks — a token that exists here says nothing about other networks.`,

        ['chain'],

      ),
    checking: 'Checking this token on-chain…',
    checkFailed: 'We couldn’t check this token right now — please try again in a moment.',
    liveTitle: tmpl(`Token #{{id}} is live on this network`, ['id']),
    ownerLabel: 'Current holder',
    roleLabel: 'Side it controls',
    roleLender: 'Lender side — its holder collects the repayment or recovery.',
    roleBorrower: 'Borrower side — its holder repays and reclaims the collateral.',
    roleUnknown: 'We couldn’t read this token’s role details right now.',
    loanLabel: 'Linked loan',
    offerLabel: 'Created for offer',
    offerValue: tmpl(
      `#{{offerId}} — this token was minted for an offer that hasn’t become a loan yet.`,
      ['offerId'],
    ),
    lockUnrecognized:
      'Transfer-locked for a reason this app version doesn’t recognise — it can’t be transferred until that flow completes or is cancelled.',
    lockUnknown:
      'We couldn’t read whether this token is transfer-locked right now — don’t rely on it being transferable until this reads clean.',
    positionRowLabel: 'Your position NFT',
    positionRowNote: tmpl(
      `— holds this loan’s {{role}} rights; verify any position NFT before trusting it.`,
      ['role'],
    ),
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
    goneTitle: tmpl(`Token #{{id}} does not currently exist on this network`, ['id']),
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
    atCap: tmpl(
      `You’ve reached the maximum of {{max}} approved keepers — revoke one to add another.`,
      ['max'],
    ),
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
    receiptYouReceive: tmpl(
      '~{{toSeller}}, paid straight to your wallet in the same transaction — selling to offer #{{offerId}} at {{rate}} yearly. Nothing to claim afterwards.',
      ['toSeller', 'offerId', 'rate'],
    ),
    receiptLockNothing: 'Nothing.',
    receiptOweNothing: 'Nothing — you approve nothing and pay nothing out of pocket.',
    receiptCanLose: 'The LARGER of the interest accrued so far or the rate difference for the remaining term — never both. Already reflected in the figure above; the exact amount is re-read live when you confirm.',
    receiptFees: 'The protocol’s cut comes out of the forfeited interest — never out of your payout beyond the figure shown.',
    receiptEnds: 'Immediately — your position transfers to the buyer and you’re done with this loan. The borrower’s rate and due date don’t change.',
    title: 'Exit this loan early',
    blurb:
      'Sell your side of this loan to another lender with a matching open lending offer. You’re paid immediately from their already-locked funds — nothing to approve, nothing to claim afterwards — and the borrower’s terms don’t change at all.',
    pickerLead: 'Open lending offers that can buy you out:',
    none:
      'No matching lending offers right now. An offer must match this loan’s assets, cover its remaining amount, and fit inside its remaining time — check back later.',
    unavailable:
      'We couldn’t load matching offers right now — please try again in a moment.',
    rowReceive: tmpl(`you’d receive ~{{amount}} now`, ['amount']),
    offerRowLine: tmpl('Offer #{{id}} · {{rate}} yearly · {{duration}}', ['id', 'rate', 'duration']),
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
    moreOffers: tmpl(
      '{{count}} more matching offers pay less than the ones shown.',
      ['count'],
      { one: '{{count}} more matching offer pays less than the ones shown.' },
    ),
    checking: 'Checking whether this loan can be exited early…',
    checkFailed:
      'We couldn’t read this loan’s exit details right now — retrying.',
  },

  loanSale: {
    // Review-receipt / hint lines (extracted from LoanSaleFlow.tsx +
    // LoanSalePendingCard.tsx inline templates).
    receiptYouReceive: tmpl(
      '{{principal}} — the full outstanding amount, paid to your wallet the moment a buyer accepts.',
      ['principal'],
    ),
    receiptYouMayOwe: tmpl(
      'At acceptance, the settlement is pulled from your wallet: the LARGER of the interest accrued by then or the rate difference for the remaining term — never both. Right now that would be ~{{amount}} {{sym}}.',
      ['amount', 'sym'],
    ),
    allowanceShortDetail: tmpl(
      '(a buyer’s acceptance would pull ~{{amount}} {{symbol}} right now)',
      ['amount', 'symbol'],
    ),
    consentLabel: 'I understand the lock, the settlement pull, and the standing approval below and agree to them.',
    receiptLock: 'Your lender position NFT, until the sale completes or you cancel the listing. Nothing else.',
    receiptCanLose: 'If your balance or the standing approval goes short, a buyer’s acceptance simply fails — nothing is taken, but the listing sits unfillable until you restore it or cancel.',
    receiptFees: 'The protocol’s cut comes out of the settlement figure — nothing beyond it.',
    receiptEnds: 'When a buyer accepts (everything settles in their transaction) or when you cancel the listing. It does not expire on its own.',
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
    approvalNote: tmpl(
      `Listing sets a standing approval of up to {{amount}} — sized to cover settling the sale any time through the loan’s term plus a month’s headroom (the larger of interest accrued by acceptance or the rate difference). Only the actual amount is pulled, in the buyer’s own transaction; if the listing somehow outlives the headroom, the listing card warns and offers to top the approval up.`,
      ['amount'],
    ),
    sweetenNote:
      'A rate above the loan’s own rate attracts buyers faster, but the difference for the remaining term comes out of your wallet at completion.',
    done:
      'Position listed. When a buyer accepts, the sale settles automatically — keep the standing approval (and enough balance for the settlement figure) in place until then, or cancel the listing below.',
    pending: tmpl(
      `Sale listing #{{offerId}} is live and your lender NFT is locked while it stands. When a buyer accepts, you’re paid the outstanding amount and the settlement is pulled in the same transaction.`,
      ['offerId'],
    ),
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
    // Row sub-lines (extracted from LoanRow.tsx).
    rowRental: tmpl('Rental #{{id}} · fees prepaid', ['id']),
    rowLoan: tmpl('Loan #{{id}} · {{rate}} yearly interest', ['id', 'rate']),
    details: {
      // Interpolated receipt / summary lines (extracted from
      // PositionDetails.tsx inline templates).
      collateralBackAfterRepay: tmpl(
        '{{collateral}} collateral back — claimable right after repayment settles.',
        ['collateral'],
      ),
      collateralBackAfterClose: tmpl(
        '{{collateral}} collateral back — claimable right after closing.',
        ['collateral'],
      ),
      collateralBackPlain: tmpl('{{collateral}} collateral back.', ['collateral']),
      owedPrincipalPlusInterest: tmpl(
        "{{principal}} + this loan's interest. For full-term loans (the protocol default) the whole term's interest applies even when repaying early; day-by-day loans charge only what has accrued. The exact amount is read live when you confirm; the approval carries small headroom that is never spent.",
        ['principal'],
      ),
      youRent: tmpl('You rent {{nft}}', ['nft']),
      youBorrowed: tmpl('You borrowed {{principal}}', ['principal']),
      youLent: tmpl('You lent {{principal}}', ['principal']),
      paidNow: tmpl('~{{amount}} {{symbol}}, paid now.', ['amount', 'symbol']),
      exactAmountNote:
        'The exact amount is read live when you confirm; the approval carries small headroom that is never spent.',
      toppingUp: tmpl(
        'Topping up your {{symbol}} collateral makes the loan safer and moves liquidation further away.',
        ['symbol'],
      ),
      principalPlusInterest: tmpl('{{principal}} plus the earned interest.', ['principal']),
      loanAssetFallback: 'the loan asset',
      recoveredSummary: tmpl(
        'What this loan recovered: sale proceeds in {{asset}}, or the {{collateral}} collateral itself, depending on how the default settled.',
        ['asset', 'collateral'],
      ),
      nftRentedOut: tmpl('Your {{nft}} is rented out', ['nft']),
      nftRentalBetween: tmpl('A rental of {{nft}} between two other wallets', ['nft']),
      loanBetween: tmpl('A loan of {{principal}} between two other wallets', ['principal']),
      nftStaysVault: tmpl('{{nft}} stays in the owner’s vault{{collateralSuffix}}', [
        'nft',
        'collateralSuffix',
      ]),
      vaultCollateralSuffix: tmpl(', plus {{collateral}} collateral', ['collateral']),
      // Fallback name for the collateral asset when its symbol is unknown,
      // used in the "what happens if nothing is repaid" default-payout line.
      lockedSymbolFallback: 'locked',
      // Loan/rental detail receipt lines (extracted from
      // PositionDetails.tsx inline template literals — previously
      // hardcoded English in every locale).
      lockedCollateralBorrower: tmpl('{{collateral}} collateral (borrower’s)', ['collateral']),
      owedPrincipalUpToInterest: tmpl('{{principal}} + up to ~{{interest}} interest', [
        'principal',
        'interest',
      ]),
      termsRental: tmpl('{{duration}} · ends {{date}}', ['duration', 'date']),
      termsLoan: tmpl('{{rate}} yearly · {{duration}} · due {{date}}', [
        'rate',
        'duration',
        'date',
      ]),
      confirmAction: tmpl('Confirm — {{action}}', ['action']),
      addCollateralReceipt: tmpl(
        '{{amount}} {{symbol}} more collateral, returned with the rest when the loan closes properly.',
        ['amount', 'symbol'],
      ),
      partialOwe: tmpl(
        '{{amount}} {{symbol}} now, plus the interest accrued so far (pulled together in this payment). The due date doesn’t move.',
        ['amount', 'symbol'],
      ),
      loadingLoan: 'Loading the loan…',
      notFound: 'We couldn’t find this loan right now. It may be new (still indexing) or the link may be old.',
      titleLoan: 'Loan',
      titleRental: 'Rental',
      noCollateral: 'No collateral',
      owedRentalPrepaid: 'Nothing to repay — rental fees were prepaid (late fees only if closed past the due date).',
      healthChecking: 'Checking this loan’s health…',
      healthReadFailed: 'We couldn’t read this loan’s health right now — retrying. Liquidation protection still applies on-chain.',
      whatIfNothingRentalRenter: 'Your use rights end at the due date and the prepaid buffer goes to the owner — close on time to get it back.',
      whatIfNothingRentalOwner: 'The renter’s rights reset after the due date and grace period; your fees stay claimable here.',
      whatIfNothingRentalViewer: 'The renter’s use rights end at the due date; the owner’s fees and buffer settle per the rental terms.',
      roleUnverified: 'We couldn’t verify who currently holds this position, so actions are hidden for now. Please try again in a moment.',
      connectToAct: 'Connect the wallet that holds this loan’s position to act on it.',
      confirmingRole: 'Confirming your role…',
      backToPositions: '← Back to my positions',
      labels: {
        locked: 'Locked',
        owed: 'Owed',
        terms: 'Terms',
        health: 'Health',
        whatNext: 'What happens next',
        ifNothing: 'If nothing happens',
      },
      done: {
        rentalClosed: 'Rental closed. Any refundable buffer is ready — claim it from the Claim Center.',
        repaid: 'Repayment confirmed. Your collateral is ready — claim it below or from the Claim Center.',
        collateralAdded: 'Collateral added — the loan is safer now.',
        partialRepaid: 'Partial repayment confirmed — you now owe less.',
      },
      actions: {
        closeRental: 'Close this rental',
        repay: 'Repay this loan',
        claimBuffer: 'Claim my buffer back',
        claimCollateral: 'Claim my collateral',
        claimResidual: 'Claim what’s left (if anything)',
        claimFeesNft: 'Claim fees & reclaim NFT',
        claimFunds: 'Claim my funds',
        claimRecovered: 'Claim what this loan recovered',
      },
      receipt: {
        nothing: 'Nothing.',
        nothingNew: 'Nothing new.',
        feesNone: 'None.',
        bufferBack: 'Any refundable buffer back — claimable right after closing.',
        bufferBackShort: 'Your refundable buffer back.',
        noCollateralBack: 'Nothing extra back — this loan has no collateral to release.',
        oweRentalPrepaid: 'Nothing more — fees were prepaid (late fees only if past the due date).',
        loseNothingBeyondOwed: 'Nothing beyond what you owe.',
        loseNothingBeyondPay: 'Nothing beyond what you pay.',
        feesRepay: 'No extra Vaipakam fee to repay — the protocol’s cut comes out of the lender’s interest.',
        feesPreclose: 'No extra Vaipakam fee to close early — the protocol’s cut comes out of the lender’s interest.',
        feesYield: 'The protocol’s yield fee comes out of the interest before payout.',
        feesRental: 'The protocol’s cut comes out of the rental fees before payout.',
        endsRepay: 'Immediately — the loan settles and your side is released.',
        endsPreclose: 'Immediately — the loan settles today and your collateral is released.',
        endsClaim: 'The claim pays out immediately and this position closes for you.',
        owedNoCollateral: 'Whatever this side is still owed (this loan had no collateral, so there may be nothing).',
        internalResidual: 'Any residual the internal match left for you, plus any VPFI rebate (may be zero).',
        liquidationResidual: 'Anything left after liquidation (may be zero).',
        rentalFeesAndNft: 'Your earned rental fees, plus your NFT back.',
        recoveredNoCollateral: 'Whatever this loan recovered (it had no collateral, so there may be nothing).',
      },
      addCollateral: {
        title: 'Add collateral',
        amountAria: 'Collateral amount to add',
        button: 'Add',
        confirm: 'Confirm — add collateral',
        receiveFallbackCure: 'A chance to bring the loan back to health — ONLY if this top-up restores the required health level (see the warning above).',
        receiveSafer: 'Nothing now — a safer loan (liquidation moves further away).',
        oweNothingMore: 'Nothing more — this doesn’t change what you owe.',
        loseFallback: 'The added amount joins the collateral at stake — if the top-up doesn’t fully cure, the lender can still claim it all.',
        loseNormal: 'The added amount joins the existing collateral — it’s at stake the same way if the loan defaults.',
        endsImmediately: 'The top-up applies immediately.',
        fallbackWarn: 'This loan is in a failed-liquidation state. Adding collateral only brings it back to Active if the top-up restores the required health level — otherwise the lender can still claim, and the added collateral is at stake too. Repaying in full always cures. If unsure, repay instead.',
      },
      partial: {
        title: 'Repay part of the loan',
        blurb: 'This loan allows partial repayment. Payments go to interest first, then reduce the amount you owe — the due date never moves.',
        amountAria: 'Amount to repay now',
        button: 'Repay part',
        confirm: 'Confirm — repay part',
        receiveSmallerDebt: 'Nothing now — a smaller debt.',
        loseNothingBeyondPayment: 'Nothing beyond the payment.',
        feesAccrued: 'The protocol’s cut of the accrued interest settles inside the payment.',
        endsPrincipalDrops: 'Your remaining principal drops immediately; interest keeps accruing on the smaller amount.',
      },
      phase: {
        approving: 'Approving in your wallet…',
        submitting: 'Submitting…',
        waiting: 'Waiting for wallet…',
      },
    },
    loading: 'Loading your positions…',
    openOffers: 'Open offers',
    getStarted: 'Get started',
    offerRow: {
      youNft: tmpl('Your NFT {{addr}} #{{id}}', ['addr', 'id']),
      waitingAccept: tmpl('Offer #{{id}} · waiting for the other side to accept', ['id']),
      yourLendingOffer: 'Your lending offer',
      yourBorrowRequest: 'Your borrow request',
      yourNftListing: 'Your NFT listing',
      held: 'Held — managed by its creator',
      cancel: 'Cancel offer',
      keep: 'Keep the offer',
      confirmCancel: 'Confirm — cancel & unlock my assets',
      cancelling: 'Cancelling…',
      receiptNothing: 'Nothing.',
      receiptUnlocked: tmpl(
        '{{locked}} back — unlocked from this offer immediately.',
        ['locked'],
      ),
      receiptLose: 'Nothing — cancelling an open offer has no penalty.',
      receiptFees: 'None (network gas only).',
      receiptEnds: 'Immediately — the offer leaves the book and can’t be accepted anymore. Post a new offer any time.',
    },
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
    whatIfNothingBorrower: tmpl(
      `If you do nothing and the loan passes its due date and the {{grace}}grace period (a short extra window to repay before the lender can take the collateral), the lender can receive your {{collateral}} collateral.`,
      ['collateral', 'grace'],
    ),
    whatIfNothingLender: tmpl(
      `If the borrower does not repay by the due date plus the {{grace}}grace period (a short extra repayment window), you can claim their collateral.`,
      ['grace'],
    ),
    // #1166 live-review follow-up — a wallet holding neither position
    // must not be addressed as a party ("you can claim…").
    whatIfNothingViewer: tmpl(
      `If the borrower does not repay by the due date plus the {{grace}}grace period (a short extra repayment window), the lender can claim the collateral.`,
      ['grace'],
    ),
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
    graceCountdownBorrower: tmpl(
      `This loan is past due. Repay within about {{remaining}} — after that the lender can take the collateral.`,
      ['remaining'],
    ),
    graceCountdownLender: tmpl(
      `This loan is past due. If the borrower does not repay within about {{remaining}}, you can claim their collateral.`,
      ['remaining'],
    ),
    graceCountdownViewer: tmpl(
      `This loan is past due. If it isn’t repaid within about {{remaining}}, the lender can claim the collateral.`,
      ['remaining'],
    ),
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
    owedRepaid: tmpl(
      `Nothing — {{principal}} plus interest was repaid in full.`,
      ['principal'],
    ),
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
    checking: 'Checking for claims…',
    row: {
      // Interpolated claim-row "what you get" lines (extracted from
      // Claims.tsx). The " + rebate" / held-proceeds suffixes are
      // composed at the call site from these catalog pieces.
      rebateAmount: tmpl('{{amount}} VPFI rebate', ['amount']),
      heldProceedsSuffix: ' + held proceeds',
      amountWithSuffix: tmpl('{{amount}}{{suffix}}', ['amount', 'suffix']),
      feesNftBack: tmpl('{{amount}} fees + your {{nft}} back', ['amount', 'nft']),
      rentalFeesNftBack: tmpl('Rental fees + your {{nft}} back', ['nft']),
      bufferBack: tmpl('{{amount}} buffer back', ['amount']),
      principalPlusInterest: tmpl('{{amount}} {{symbol}} + interest', ['amount', 'symbol']),
      collateralLabel: tmpl('{{collateral}} collateral', ['collateral']),
      recoveredFromDefault: tmpl(
        '{{amount}}{{held}} recovered from the default',
        ['amount', 'held'],
      ),
      defaultRecovery: tmpl('Default recovery — {{collateral}}', ['collateral']),
      collateralBack: tmpl('{{collateral}} collateral back', ['collateral']),
      collateralBackWithAmount: tmpl(
        '{{amount}} collateral back{{rebateSuffix}}',
        ['amount', 'rebateSuffix'],
      ),
      rental: 'Rental',
      loan: 'Loan',
      prepaidBufferBack: 'Your prepaid buffer back',
      heldProceeds: 'Held proceeds for this loan',
      repaidFunds: 'Repaid funds',
      heldProceedsDefault: 'Held proceeds recovered from the default',
      surplusAfterLiquidation: 'Anything left after liquidation',
      residualAfterMatch: 'Anything left after the internal match',
      whyRentalEnded: 'The rental ended — collect your earned fees and reclaim the NFT.',
      whyRentalClosed: 'The rental closed — the refundable buffer is released.',
      whyRepaidLender: 'The borrower repaid this loan.',
      whyInternalMatchLender: 'This loan closed by internal matching — collect your funds.',
      whyFallbackPending: 'An automatic liquidation didn’t complete — claiming finalizes the recovery yourself.',
      whyDefaultLender: 'The loan defaulted — collect what the default settlement recovered for you.',
      whyDefaultBorrower: 'This loan defaulted. If the liquidation left a surplus, you can claim it.',
      whyInternalMatchBorrower: 'This loan closed by internal matching — collect any residual left for you.',
      whyRepaidBorrower: 'You repaid this loan, so your collateral is released.',
    },
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
    // #1268 / E-10 — one-signature Claim-All.
    allTitle: 'Claim everything at once',
    allBlurb:
      'Collect every ready payout in a single wallet signature instead of one at a time.',
    allButton: tmpl('Claim {{count}} items', ['count'], { one: 'Claim {{count}} item' }),
    allEmpty: 'Nothing is batchable right now.',
    allTooMany: tmpl(
      `Select up to {{max}} at once — claim the rest in a second batch.`,
      ['max'],
    ),
    allVpfiNote:
      'Withdrawing parked VPFI lowers your fee-discount tier — off by default.',
    allResidualNote:
      'Anything that wasn’t ready is still listed below to claim on its own.',
    allRewardsUnavailable:
      'We couldn’t check your rewards, so they’re not in this batch — claim them separately.',
    allVpfiUnavailable:
      'We couldn’t check your vault VPFI, so it’s not in this batch.',
    allWorking: 'Waiting for wallet…',
  },

  offers: {
    rentalListing: 'NFT rental',
    dailyFeeLoading: 'daily fee loading…',
    perDayInline: tmpl('{{amount}} {{symbol}}/day', ['amount', 'symbol']),
    feesPrepaid: 'fees prepaid',
    yearly: 'yearly',
    collateralLabel: 'collateral',
    collateralNone: 'none',
    byCreator: 'by',
    advancedPartialRepayOk: 'partial repay OK',
    advancedNoPartialRepay: 'no partial repay',
    advancedNoExpiry: 'no expiry',
    // Offer/order expiry sub-line: "expires <date>".
    expiresLabel: tmpl('expires {{date}}', ['date']),
    ctaRent: 'Rent this NFT',
    ctaBuyPosition: 'Buy this loan position',
    ctaBorrow: 'Borrow this',
    ctaFund: 'Fund this request',
    badgeLender: 'Lender',
    badgeBorrower: 'Borrower',
    filters: {
      showLabel: 'Show',
      sideAll: 'Everything',
      sideLending: 'Lending offers (borrow from these)',
      sideBorrowing: 'Borrow requests (lend to these)',
      sideRentals: 'NFT rentals',
      sortLabel: 'Sort by',
      sortNewest: 'Newest first',
      sortRateLow: 'Rate — low to high',
      sortRateHigh: 'Rate — high to low',
      sortDurationShort: 'Duration — shortest first',
      sortDurationLong: 'Duration — longest first',
      assetLabel: 'Filter by asset address',
      assetPlaceholder: '0x… (any leg: principal, collateral, payment)',
      clear: 'Clear filters',
    },
    loading: 'Loading the offer book…',
    filteredEmptyTitle: 'No offers match these filters',
    filteredEmptyBody: 'Loosen the filters above — the offer book itself has open offers.',
    createOffer: 'Create an offer',
    footerParts: {
      lead: 'Taking an offer here — “Borrow this”, “Fund this request”, or “Buy this loan position” — walks you through the same review-and-sign steps as the guided ',
      borrowLink: 'Borrow',
      mid: ' and ',
      lendLink: 'Lend',
      tail: ' flows.',
    },
    title: 'Offer Book',
    lede: 'Open lending offers and borrow requests from other users.',
    emptyTitle: 'No open offers right now',
    emptyBody: 'Create your own offer and let the other side come to you.',
    // F-20260703-003 (#988) — shown by MarketFreshnessNote when the
    // indexer cursor has stalled, on every market-list surface.
    // Human-units rule (2026-07-22): {{min}}/{{max}}/{{pct}} receive
    // PRE-FORMATTED percent strings ("9%"), never raw bps numbers.
    rateBand: tmpl('rate band {{min}}–{{max}}', ['min', 'max']),
    rateInline: tmpl('rate {{pct}}', ['pct']),
    staleList: tmpl(

        `This list last updated {{age}} ago and may be behind — new offers may exist that aren’t shown yet. Check back shortly.`,

        ['age'],

      ),
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
    // Tenor-tab + mid tooltips (extracted from DeskHeader.tsx).
    tenorLiveTitle: tmpl('{{tenor}} — live offers on the book', ['tenor']),
    walletBalanceTitle: tmpl('In your wallet: {{amount}} {{symbol}}', ['amount', 'symbol']),
    healthLtvTitle: tmpl('Health factor {{ratio}} · LTV {{ltv}}', ['ratio', 'ltv']),
    rateLadderTitle: tmpl(
      '{{rate}} bps · {{count}} offers{{ownMark}} — tap to pre-fill this rate',
      ['rate', 'count', 'ownMark'],
      { one: '{{rate}} bps · {{count}} offer{{ownMark}} — tap to pre-fill this rate' },
    ),
    tenorNoOffersTitle: tmpl('{{tenor}} — no live offers yet', ['tenor']),
    midQuotedTitle: tmpl('{{bps}} bps (quoted, not executed)', ['bps']),
    marketsLoading: 'Loading markets…',
    loadMarket: 'Load market',
    bookLoading: 'Loading the order book…',
    cumHeadingTitle: 'Cumulative depth from the top of the side',
    oneSidedBook: 'one-sided book',
    // --- Rate-Desk tooltip / row scaffolds (i18n burn-down). Each
    //     composes a raw bps figure with a loan id or status; the words
    //     around the numbers are what need translating.
    lastFillTitle: tmpl('{{bps}} bps · loan #{{loanId}}', ['bps', 'loanId']),
    tapeLoading: 'Loading recent fills…',
    tapeRowTitle: tmpl('{{bps}} bps · loan #{{loanId}} · {{status}}', ['bps', 'loanId', 'status']),
    ladderMidTitle: tmpl('{{bps}} bps quoted mid', ['bps']),
    // The desk mid-row: "mid {rate}" plus an optional " · spread {spread}"
    // suffix — two pieces so the connector translates without the render
    // code rebuilding the whole string.
    ladderMid: tmpl('mid {{rate}}', ['rate']),
    ladderSpread: tmpl(' · spread {{spread}}', ['spread']),
    // Raw indexer loan-status → localized label for the tape tooltip —
    // the one desk surface that shows the unmapped lifecycle status
    // (Positions / History collapse it through loanStateLabel instead).
    loanStatus: {
      active: 'active',
      repaid: 'repaid',
      defaulted: 'defaulted',
      liquidated: 'liquidated',
      settled: 'settled',
      fallback_pending: 'settling',
      internal_matched: 'matched',
    },
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
    // #1247 PAG-010 — discovery serves the deepest markets only.
    marketsTruncated:
      'Showing the most active markets — smaller markets aren’t listed here, but you can load any pair with “Custom pair…”.',
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
      matchable: tmpl(`Matchable at {{rate}}`, ['rate']),
      pairTitle: tmpl(
        '{{rate}} bps · offers #{{lenderId}} × #{{borrowerId}}',
        ['rate', 'lenderId', 'borrowerId'],
      ),
      body: 'These top-of-book offers can cross. Anyone can execute this match and earn the matcher fee — you pay the network gas to execute it.',
      amount: tmpl(
        `{{amount}} {{symbol}} would match.`,
        ['amount', 'symbol'],
      ),
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
      payCollateral: tmpl(
        `You lock {{amount}} {{symbol}} as collateral and receive the loan principal.`,
        ['amount', 'symbol'],
      ),
      payPrincipal: tmpl(
        `You fund the {{amount}} {{symbol}} loan principal.`,
        ['amount', 'symbol'],
      ),
      rateLine: tmpl(`{{rate}} APR · {{days}}`, ['rate', 'days']),
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
      close: 'Close',
    },
    chart: {
      title: 'Executed rates',
      loading: 'Loading chart…',
      // §5.3 rule 5 — the header shows the last executed print, never
      // a %-change ticker.
      lastFill: tmpl(`last fill: {{rate}} · {{ago}}`, ['rate', 'ago']),
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
      sparseNote: tmpl(
        'Sparse market — {{count}} fills in this range, drawn individually. Candles appear once there’s enough tape to mean something.',
        ['count'],
        { one: 'Sparse market — {{count}} fill in this range, drawn individually. Candles appear once there’s enough tape to mean something.' },
      ),
      // #1247 PAG-009 — the server scans the newest 10,000 fills; a
      // busy market's oldest history falls off. Say so instead of
      // letting an "all" chart read as complete.
      truncatedNote:
        'Long history — showing the most recent fills only. The oldest candles are not drawn.',
      intervalLabel: 'Interval',
      rangeLabel: 'Range',
      attribution: 'Charts by TradingView',
      tooltipFills: tmpl('{{count}} fills', ['count'], { one: '{{count}} fill' }),
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
      rateBpsNote: 'Rates are stored in basis points (1% = 100 bps)',
      selfCollateral: 'Collateral can’t be the same token as the loan asset.',
      collateralAmount: 'Collateral amount',
      expiryGtcTitle: 'Good-til-cancelled — rests until you cancel it',
      expiryGttTitle: 'Good-til-time — lapses on its own at the deadline',
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
      tenorNote: tmpl(
        `Posting into the selected {{label}} market — change the term with the chips above.`,
        ['label'],
      ),
      overDurationCap: tmpl(
        `The protocol currently caps offer duration at {{max}} days — pick a shorter term above.`,
        ['max'],
      ),
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
      gaslessFundsWarn: tmpl(
        `Heads up: your vault’s free balance is below the {{amount}} {{symbol}} this order commits. The fill will fail if the funds aren’t there when a taker accepts — deposit to your vault to keep the order fillable.`,
        ['amount', 'symbol'],
      ),
      gaslessRejected: tmpl(
        `The book rejected this order ({{reason}}). Nothing was posted.`,
        ['reason'],
      ),
      gaslessUnavailable:
        'We couldn’t reach the order book right now — the order was NOT posted. Please try again in a moment.',
      // Leg labels interpolated into securityBlocked / securityUnknown
      // (#1360). Display-only — the ticket never matches on these, so
      // localizing them carries no gate-recheck hazard.
      legLoanAsset: 'loan asset',
      legCollateral: 'collateral',
      securityBlocked: tmpl(
        `Posting is held: an independent security check flags the {{leg}} ({{reasons}}).`,
        ['leg', 'reasons'],
      ),
      securityUnknown: tmpl(
        `Posting is held until the independent security check for the {{leg}} succeeds.`,
        ['leg'],
      ),
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
      escrowNow: tmpl(
        `You escrow now: {{amount}} {{symbol}}.`,
        ['amount', 'symbol'],
      ),
      commitAtFill: tmpl(
        `You commit {{amount}} {{symbol}} — pulled from your vault only when a taker fills.`,
        ['amount', 'symbol'],
      ),
      lockNow: tmpl(
        `You lock now: {{amount}} {{symbol}} as collateral.`,
        ['amount', 'symbol'],
      ),
      lockAtFill: tmpl(
        `You commit {{amount}} {{symbol}} collateral — locked only when a taker fills.`,
        ['amount', 'symbol'],
      ),
      netYield: tmpl(
        `Net yield ≈ {{net}}% APR after the {{feePct}}% protocol fee on the interest you earn.`,
        ['net', 'feePct'],
      ),
      lifNote: tmpl(
        `Loan initiation fee: {{feePct}}% of principal (≈ {{amount}} {{symbol}}), charged when the loan starts.`,
        ['feePct', 'amount', 'symbol'],
      ),
    },
    orders: {
      loading: 'Loading your open orders…',
      tab: 'Open orders',
      empty: 'No open orders. Post one with the ticket.',
      // Partial-fill row sub-line + fill-bar tooltip.
      fillSummary: tmpl(
        ' · filled {{filled}} ({{pct}}) · {{remaining}} left',
        ['filled', 'pct', 'remaining'],
      ),
      filledTooltip: tmpl('{{pct}} filled', ['pct']),
      unavailable: 'We couldn’t load your open orders right now.',
      heldNotCreated: 'Held — managed by its creator',
      cancel: 'Cancel',
      cancelling: 'Cancelling…',
      cancelCooldown: tmpl(
        `Cancel available in {{secs}}s — new unfilled offers have a short protocol cooldown.`,
        ['secs'],
      ),
      amend: 'Amend',
      amendTitle: 'Amend in place — same offer, same position, one transaction.',
      amendLoadFailed:
        'We couldn’t read this offer’s live values, and amending must start from them. Please try again.',
      // Shown while the amend form reads the offer's current values.
      readingValues: 'Reading the offer’s live values…',
      // Unit hint on the rate / rate-max amend inputs.
      rateUnit: 'bps stored on-chain',
      // The amend form's dismiss button.
      close: 'Close',
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
      amendGrowNote: tmpl(
        `Growing this order locks {{amount}} {{symbol}} more from your wallet — it needs a token approval first.`,
        ['amount', 'symbol'],
      ),
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
      // #1247 PAG-011 — the wallet-scoped book read is still capped
      // per side; never let a clipped page read as the full set.
      signedTruncated:
        'You have more signed orders in this market than we can list at once — this is not the complete set.',
    },
    positions: {
      loading: 'Loading your positions…',
      tab: 'Positions',
      empty: 'No open positions in this wallet.',
      unavailable: 'We couldn’t load your positions right now.',
      health: 'Health',
      notPriced: 'No auto-liquidation',
      manage: 'Manage',
      allPositions: 'All positions →',
      // Row sub-line: remaining-days and partial-repay marker. "d" is the
      // day-unit abbreviation and stays put; the surrounding words move.
      daysLeft: tmpl('{{days}}d left', ['days']),
      daysOverdue: tmpl('{{days}}d overdue', ['days']),
      partialRepayOk: ' · partial repay OK',
    },
  },

  // #1355 — the Full VPFI fee-entitlement tariff surface. Copy rules
  // (RL-6 §A.4 + rev-15 frozen wording): Full is a FEE-DISCOUNT
  // mechanism, described as deterministic bookkeeping over fees — never
  // yield, income, or a VPFI purchase/price; it NEVER waives the asset
  // fees (dual-fee honesty); and the tariff is non-refundable, priced
  // on the full term at open.
  tariff: {
    // ── The opt-in control on accept / fill review screens ──
    optInTitle: 'Full VPFI tariff (optional)',
    optInLabel:
      'Pay this loan’s Full VPFI tariff from my Vaipakam Vault for a deeper discount on my own side’s fees.',
    quoteLine: tmpl(
      'Current tariff quote: {{amount}} VPFI — non-refundable, priced on the loan’s full term.',
      ['amount'],
    ),
    quoteLoading: 'Fetching the tariff quote…',
    quoteUnavailable:
      'This loan’s tariff can’t be quoted right now, so the Full option isn’t available for it.',
    fullUnavailableNow:
      'The Full option isn’t available for this loan right now — it can’t complete at open, so it can’t be authorized.',
    creatorFullBlocked:
      'This offer carries its creator’s Full tariff commitment, which can’t complete right now, so the acceptance would be rejected on-chain. Try again later or choose another offer.',
    saleDisclosureChecking: 'Checking this position’s fee records…',
    saleDisclosureFailed:
      'We couldn’t read this position’s fee records right now — the sale options return once the check succeeds.',
    dualFeeNote:
      'Full never replaces the normal fees — the loan’s asset fees still apply in full. Paying the tariff adds an extra 10% discount on your own side’s fees, on top of any vault-holding discount, up to the overall 50% cap.',
    nonRefundNote:
      'The tariff is priced on the loan’s full term when it opens and is not refunded if the loan closes early.',
    maxCStarLabel: 'Highest tariff I authorize (VPFI)',
    maxCStarHelp:
      'The exact tariff is re-priced at the moment the loan opens; it can never exceed this ceiling. Set it a little above the quote so a small move between now and then doesn’t block you.',
    maxCStarRequired:
      'Set the highest tariff you authorize (in VPFI) before opting in — a Full opt-in without a ceiling can’t be signed.',
    balanceShort: tmpl(
      'Your vault holds {{balance}} VPFI free — below the {{needed}} VPFI quote, so the Full opt-in would fail when the loan opens.',
      ['balance', 'needed'],
    ),
    downgradeLabel: 'If the Full tariff can’t complete, open the loan without it',
    downgradeHelpAllow:
      'If the tariff can’t be charged when the loan opens (above your ceiling, vault balance short, or the option switched off), the loan still opens — without Full, and without charging any tariff.',
    downgradeHelpStrict:
      'If the tariff can’t be charged when the loan opens, the whole acceptance is rejected and nothing moves. Tick the box above if you’d rather the loan open without Full in that case.',
    // ── Maker-side control on standing offers ──
    armButton: 'Full tariff',
    armTitle: 'Full VPFI tariff on this offer',
    makerNote:
      'While this is on, an accepted fill opens the loan with your Full opt-in: the tariff is charged from your vault at that moment, within your ceiling, for a deeper discount on your own side’s fees.',
    armEnableLabel: 'Opt this offer into the Full tariff',
    armDarkNote:
      'The Full tariff option is currently switched off protocol-wide. You can clear an existing opt-in here; new opt-ins are unavailable until it is switched on.',
    armSave: 'Save',
    armSaving: 'Saving…',
    armSaved: 'Saved — the offer now carries your Full opt-in.',
    armClearedSaved: 'Saved — the offer no longer carries a Full opt-in.',
    // ── Loan Details / Claim Center display ──
    sectionTitle: 'VPFI fee modes on this loan',
    borrowerModeLabel: 'Borrower',
    lenderModeLabel: 'Lender',
    modeNone: 'standard fees',
    modeHold: 'vault-holding discount',
    modeFull: 'Full tariff paid',
    tariffPaidLine: tmpl('{{amount}} VPFI tariff absorbed', ['amount']),
    precloseNoRefundWarn:
      'This loan carries a paid Full tariff. It was priced on the full term when the loan opened and is not refunded on an early close.',
    nftTravelNote:
      'The lender’s Full fee mode is tied to the position itself — it travels with the position NFT to a buyer of this position.',
  },

  vpfi: {
    nothing: 'Nothing.',
    // Interpolated receipt / hint lines (extracted from Vpfi.tsx inline
    // templates so they translate).
    depositYouLock: tmpl(
      '{{amt}} moves from your wallet into your Vaipakam Vault.',
      ['amt'],
    ),
    withdrawYouReceive: tmpl('{{amt}} back in your wallet.', ['amt']),
    checkingAvailability: tmpl('Checking VPFI availability on {{chain}}…', ['chain']),
    availabilityCheckFailed: tmpl(
      'We couldn’t check VPFI availability on {{chain}} right now. Please try again in a moment.',
      ['chain'],
    ),
    walletBalanceHint: tmpl('In your wallet: {{amount}} VPFI', ['amount']),
    withdrawableHint: tmpl(
      'Withdrawable now: {{free}} VPFI of {{vault}} in your vault',
      ['free', 'vault'],
    ),
    receiptDeposit: {
      youReceive: 'Nothing now — a growing fee discount on eligible loans over time.',
      youCanLose: 'Nothing — free VPFI in your vault stays withdrawable.',
      fees: 'No Vaipakam fee on deposits.',
      whenThisEnds: 'Withdraw your free VPFI whenever you like.',
    },
    receiptWithdraw: {
      youCanLoseLead: 'Future fee discounts —',
      fees: 'No Vaipakam fee on withdrawals.',
      whenThisEnds: 'Immediately — your remaining balance keeps earning discount history.',
    },
    depositDone: 'Deposit confirmed. Your discount history starts building from now.',
    withdrawDone: 'Withdrawal confirmed. The VPFI is back in your wallet.',
    optOutSyncFailed: 'Your opt-out is saved on this network, but syncing it to other networks didn’t go through — it will sync with your next VPFI action, or try toggling again.',
    educationTitle: 'How the discount works',
    educationBody: 'Hold VPFI in your Vaipakam Vault and the protocol fee on eligible loans shrinks. The discount uses your average holding over the last 30 days — topping up today grows your discount gradually, not instantly.',
    offFeesSuffix: 'off eligible protocol fees',
    noSellNote: 'Vaipakam does not sell VPFI and pays no holding yield — you acquire it on the open market.',
    statusTitle: 'Your discount status',
    inYourVault: 'In your vault',
    inYourWallet: 'In your wallet',
    depositToActivate: ' — deposit to activate',
    activeDiscount: 'Active discount',
    noneRightNow: 'None right now',
    warmingUp: 'Warming up',
    // "Warming up" explainer: the balance earns a bigger discount than the
    // 30-day average currently grants. `tier` = tierOff/higherTier below;
    // `currently` = currentlyClause (or empty when no discount applies yet).
    warmingUpBody: tmpl(
      'Your balance qualifies for {{tier}}{{currently}}, but discounts use your 30-day average — keep the balance and your active discount catches up.',
      ['tier', 'currently'],
    ),
    tierOff: tmpl('{{discount}} off', ['discount']),
    higherTier: 'a higher tier',
    currentlyClause: tmpl(' (currently {{rate}})', ['rate']),
    consentToggle: 'Use my vaulted VPFI for fee discounts',
    consentToggleSub: 'Without this, holding VPFI gives no discount.',
    switchToChange: 'Switch to a supported network to change this.',
    vaultActionLabel: 'Vault action',
    deposit: 'Deposit',
    withdraw: 'Withdraw',
    amountLabelDeposit: 'VPFI to move into your vault',
    amountLabelWithdraw: 'VPFI to take back to your wallet',
    max: 'Max',
    overMaxHint: ' — that’s more than you have.',
    reviewDeposit: 'Review deposit',
    reviewWithdraw: 'Review withdraw',
    phaseApproving: 'Approving VPFI…',
    phasePermitting: 'Signing the permission… — free, no gas',
    phaseSubmitting: 'Submitting…',
    phaseWaiting: 'Waiting for wallet…',
    depositCta: 'Deposit VPFI',
    withdrawCta: 'Withdraw VPFI',
    title: 'VPFI discounts',
    optional:
      'Optional: hold VPFI in your vault to reduce protocol fees on eligible loans. You never need VPFI to use Vaipakam.',
    noGasDiscount: 'Your VPFI discount does not reduce network gas.',
    withdrawWarning: 'Withdrawing VPFI can lower future fee discounts.',
    // UX-035 — the below-first-threshold band, stated so a small holder
    // isn't left guessing. The threshold is admin-tunable, so the note
    // is derived from the LIVE first tier threshold (Codex #1175) rather
    // than a hardcoded number that could contradict the table above.
    belowMinNote: tmpl(
      `Holding under {{floor}} VPFI earns no fee discount.`,
      ['floor'],
    ),
    notOnThisChain: tmpl(
      `VPFI deposits aren’t available on {{chain}} yet. Everything else on Vaipakam works without VPFI.`,
      ['chain'],
    ),
    tokenChanged:
      'The VPFI token configuration changed since you reviewed. Nothing was approved — please check the updated numbers and try again.',
    tokenCheckRetry:
      'We couldn’t confirm the VPFI token just now — nothing was approved. Please try again in a moment.',
    addToWallet: 'Add VPFI to MetaMask',
    addedToWallet: 'Asked your wallet to track VPFI.',
  },

  // #1247 (PAG-001…008) — the shared list-window affordance. Every
  // chain/indexer-fed list renders a bounded window with this button;
  // the count keeps it honest about what is still unrendered.
  lists: {
    // The label promises what ONE click reveals; when more is still
    // hidden beyond that page, say so (Codex #1265 r1 — "Show 475
    // more" revealing 25 would mislead on exactly the big-list path).
    showMore: tmpl(`Show {{next}} more`, ['next']),
    showMoreHidden: tmpl(`Show {{next}} more ({{total}} hidden)`, ['next', 'total']),
  },

  errors: {
    // F-20260703-005 (#988) — say HOW MUCH more whenever the caller can
    // compute the shortfall; the amount-less form is the fallback for
    // sites that can't (e.g. unknown decimals).
    needMore: tmpl(`You need more {{asset}} to continue.`, ['asset']),
    needMoreBy: tmpl(
      `You need about {{shortBy}} more {{asset}} to continue.`,
      ['shortBy', 'asset'],
    ),
    // Fallback name for the {{asset}} slot in needMore(By) when the token's
    // on-chain symbol can't be read (preflights.ts).
    requiredAssetFallback: 'the required asset',
    partialOverPrincipal:
      'That covers the loan’s whole remaining principal. Use “Repay this loan” instead — it settles the loan properly and releases your collateral.',
    notAToken:
      'That address doesn’t look like a token on this network. Double-check it or pick a suggested asset.',
    // Pre-submit guard errors (thrown by the contract hooks when a
    // precondition the UI normally enforces is somehow unmet). Routed
    // through the catalog so they translate wherever a flow surfaces
    // err.message raw rather than through submitErrorText.
    walletConnectFirst: 'Connect a wallet on a supported network first.',
    walletNotConnected: 'Wallet not connected',
    walletClientUnavailable: 'Wallet client not available',
    publicClientUnavailable: 'Public client not available',
    noRpcClient: 'No RPC client for the active chain.',
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
    borrowerLIF: tmpl(
      `Vaipakam charges a {{pct}} loan initiation fee on the borrowed amount.`,
      ['pct'],
    ),
    lenderYieldFee: tmpl(
      `Vaipakam keeps {{pct}} of the interest you earn.`,
      ['pct'],
    ),
    lenderRentalFee: tmpl(
      `Vaipakam keeps {{pct}} of the rental fees you earn.`,
      ['pct'],
    ),
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
    faqAnswer: tmpl(
      `Vaipakam charges a {{lifPct}} loan initiation fee on the borrowed amount. Vaipakam keeps {{yieldPct}} of the interest you earn. Late repayment adds 1% of the outstanding amount after day one, growing 0.5% per day, capped at 5%. Network gas is separate and goes to the blockchain, not to Vaipakam.`,
      ['lifPct', 'yieldPct'],
    ),
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
    notTestnetBody: tmpl(
      `The faucet only works on our test networks. You’re on {{chainName}}, which uses real assets — switch to a test network to mint practice tokens.`,
      ['chainName'],
    ),
    // A testnet we support but haven't seeded with faucet assets yet.
    noMocksBody: tmpl(
      `Test assets haven’t been set up on {{chainName}} yet. Try a different test network, or check back soon.`,
      ['chainName'],
    ),
    backHome: 'Back to home',
    testnetNote: tmpl(
      `You’re on {{chainName}}, a test network. These tokens exist only for testing and have no real value.`,
      ['chainName'],
    ),
    switchTitle: tmpl(
      `Switch your wallet to {{chainName}} to mint test assets.`,
      ['chainName'],
    ),
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
    mintedTokens: tmpl(
      `Minted {{units, number}} {{symbol}} to your wallet.`,
      ['units', 'symbol'],
    ),
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
      action: tmpl(`Mint {{units, number}} tLIQ`, ['units']),
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
      title: tmpl(`Mock USD Coin ({{symbol}})`, ['symbol']),
      titleGeneric: 'Mock USD Coin (test stablecoin)',
      blurb:
        'A test USDC priced at $1 by a test oracle — a second, distinct liquid token so you can run a deal where both the loan and the collateral are liquid (with a realistic price spread against tLIQ / mWETH) without pairing a token against itself.',
      action: tmpl(`Mint {{units, number}} {{symbol}}`, ['units', 'symbol']),
      actionGeneric: tmpl(`Mint {{units, number}} test stablecoin`, ['units']),
    },
    mweth: {
      title: 'Mock wrapped ETH (mWETH)',
      blurb:
        'An oracle-priced test token that plays the “wrapped ETH” role in demos. It is NOT real WETH — it mints for free and has no value.',
      action: tmpl(`Mint {{units, number}} mWETH`, ['units']),
    },
    nft2: {
      title: 'Second rentable test NFT (vART)',
      blurb:
        'Another ERC-4907 collection — handy when you want to list one NFT and rent a different one, or run several rentals at once.',
      action: 'Mint a vART NFT',
    },
    addToWallet: tmpl(`Add {{symbol}} to MetaMask`, ['symbol']),
    addedToWallet: 'Asked your wallet to track it.',
    illiquid: {
      title: 'Illiquid test token (tILQ)',
      blurb:
        'No price feed, so it behaves like an illiquid asset — both sides must consent, and default transfers the collateral in kind.',
      action: tmpl(`Mint {{units, number}} tILQ`, ['units']),
    },
    illiquid2: {
      title: 'Second illiquid test token (tILQ2)',
      blurb:
        'Also unpriced. Pair it with tILQ (one as the loan, one as collateral) to try a deal where NEITHER side has a price — both parties must consent, no health factor applies, and default hands the collateral over in kind.',
      action: tmpl(`Mint {{units, number}} tILQ2`, ['units']),
    },
    nft: {
      title: 'Rental test NFT (vRENT)',
      blurb: 'An ERC-4907 rentable NFT for trying the NFT rental flows.',
      action: 'Mint a test NFT',
    },
  },

  // Locale-aware duration / relative-time primitives consumed by
  // lib/format.ts (formatDurationDays / formatTimeAgo). The English
  // one/other forms reproduce the previous hardcoded output exactly;
  // translated bundles get locale-correct plural categories from
  // i18next. Number placeholders use `{{count, number}}` so the count
  // is locale-formatted too.
  units: {
    durationDay: tmpl('{{count, number}} days', ['count'], { one: '1 day' }),
    durationMonth: tmpl('{{count, number}} months', ['count'], { one: '1 month' }),
    durationYear: tmpl('{{count, number}} years', ['count'], { one: '1 year' }),
    timeJustNow: 'just now',
    timeMinutesAgo: tmpl('{{count}}m ago', ['count']),
    timeHoursAgo: tmpl('{{count}}h ago', ['count']),
    timeDaysAgo: tmpl('{{count}}d ago', ['count']),
  },
  vault: {
    unreadableCount: tmpl('{{count}} assets', ['count'], { one: 'one asset' }),
    unreadableWarn: tmpl(
      'We couldn’t read {{assets}} just now ({{list}}) — the list below may be missing balances. This usually clears on the next refresh.',
      ['assets', 'list'],
    ),
    noBalancesInWindow: tmpl(
      'No balances among the first {{count}} tokens checked — widen the scan below to keep looking.',
      ['count'],
    ),
    loading: 'Reading your vault…',
    addressLabel: 'Vault address:',
    // Chain suffix after the vault address ("… on Base Sepolia").
    onChain: tmpl('on {{chain}}', ['chain']),
    noVaultTitle: 'No vault yet',
    emptyTitle: 'Nothing in your vault yet',
    emptyBody: 'Assets appear here when you post offers, open loans, or deposit VPFI.',
    badgePartlyLocked: 'Partly locked',
    badgeFree: 'Free',
    lockedFreeBreakdown: tmpl('{{locked}} locked · {{free}} free', ['locked', 'free']),
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

  /** Claim-All batch preview labels (data/claimAll.ts). The pure builder
   *  picks which phrase applies per loan/role/status; these are the
   *  translatable strings it composes into each row's label. */
  claimAll: {
    loanNoun: 'Loan',
    rentalNoun: 'Rental',
    itemLabel: tmpl(`{{noun}} #{{id}} — {{what}}`, ['noun', 'id', 'what']),
    lenderProceeds: 'your proceeds',
    lenderRentalFeesNft: 'fees + your NFT back',
    borrowerBufferBack: 'your buffer back',
    borrowerSurplus: 'surplus after liquidation, if any',
    borrowerResidual: 'residual after the internal match',
    borrowerCollateralBack: 'collateral back',
    rewardsLabel: tmpl(`Interaction rewards — {{amount}} VPFI`, ['amount']),
    vaultVpfiLabel: tmpl(`Vault VPFI — {{amount}} VPFI`, ['amount']),
  },

  /** Plain-language loan-state badge labels (lib/loanState.ts). The pure
   *  module derives which key applies from the indexer row; these are the
   *  translatable strings it resolves to via loanStateLabel(). */
  loanState: {
    repaid: 'Repaid',
    defaulted: 'Defaulted',
    closed: 'Closed',
    beingSettled: 'Being settled',
    pastDue: 'Past due',
    dueToday: 'Due today',
    dueInDays: tmpl('Due in {{count}} days', ['count'], { one: 'Due in {{count}} day' }),
  },

  activity: {
    loading: 'Loading your activity…',
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
    // #1023 (Codex #1287 r1) — a wallet with more loan history than
    // one participation read returns filters against a partial id
    // set, which can drop even RECENT events tied to its oldest
    // loans; say "may be missing", not merely "older not shown".
    participantTruncatedNote:
      'This wallet has more loan history than we can check at once — some events tied to its oldest loans may be missing here.',
    // UX2-007 tail — states the page's recent-only scope without
    // asserting that older events DO exist (which read as an unnecessary
    // hedge for genuinely-new wallets). True whether the wallet is new
    // or has history older than the recent scan window (#1200).
    truncatedEmpty:
      'Nothing of yours in recent protocol activity. This page lists recent activity only, so anything older isn’t shown here.',
    // UX-008 — one substantive sub-line per row.
    plusMore: tmpl(` · +{{n}} more in this transaction`, ['n']),
    // Row context refs — the loan / offer a row belongs to.
    loanRef: tmpl(`Loan #{{loanId}}`, ['loanId']),
    offerRef: tmpl(`Offer #{{offerId}}`, ['offerId']),
    viewTx: 'View transaction',
    loadMore: 'Load older activity',
    loadingMore: 'Loading…',
    // UX-008 — readable, translatable labels for each feed row, keyed by
    // the raw contract event kind. The pure lib/activityView.ts module
    // owns each kind's category + coalescing priority (and an English
    // label used only as the ultimate fallback); the DISPLAY label is
    // translated here. The component prefers this map and falls back to
    // the module's humanizeKind result for a kind the app doesn't know
    // yet (English — unavoidable for an unmapped event). A unit test
    // (lib/activityView.test.ts) asserts every ACTIVITY_LABELS key has a
    // matching entry here so the two can't drift.
    labels: {
      OfferCreated: 'Offer created',
      OfferAccepted: 'Offer accepted',
      OfferCanceled: 'Offer cancelled',
      OfferClosed: 'Offer closed',
      OfferModified: 'Offer amended',
      OfferMatched: 'Offers matched',
      OfferConsumedBySale: 'Offer used for a sale',
      LoanInitiated: 'Loan started',
      LoanInitiatedDetails: 'Loan started',
      LoanRepaid: 'Loan repaid',
      PartialRepaid: 'Partial repayment',
      LoanSettled: 'Loan settled',
      LoanSettlementBreakdown: 'Loan settled',
      LoanDefaulted: 'Loan defaulted',
      LoanLiquidated: 'Loan liquidated',
      BackstopAbsorbedLoan: 'Loan absorbed by backstop',
      LoanExtended: 'Loan extended',
      LoanRefinanced: 'Loan refinanced',
      LoanPreclosedDirect: 'Loan closed early',
      LenderFundsClaimed: 'Funds claimed',
      BorrowerFundsClaimed: 'Collateral claimed',
      BorrowerLifRebateClaimed: 'Fee rebate claimed',
      OffsetCompleted: 'Loan offset',
      OffsetOfferCreated: 'Offset offer created',
      LoanSold: 'Loan sold',
      LoanSaleCompleted: 'Loan sale completed',
      LoanSaleOfferLinked: 'Loan listed for sale',
      LoanObligationTransferred: 'Loan position transferred',
      IntentLoanRolled: 'Loan rolled over',
      CollateralAdded: 'Collateral added',
      InternalMatchExecuted: 'Loan matched internally',
      PrepayListingPosted: 'Collateral listed for sale',
      PrepayListingMatched: 'Collateral sale matched',
      PrepayListingUpdated: 'Collateral listing updated',
      PrepayListingCanceled: 'Collateral listing cancelled',
      PrepayCollateralSaleSettled: 'Collateral sale settled',
      SwapToRepayExecuted: 'Repaid via collateral swap',
      SwapToRepayPartialExecuted: 'Partial repay via swap',
      SwapToRepayIntentCommitted: 'Swap-to-repay set up',
      SwapToRepayIntentFilled: 'Swap-to-repay filled',
      SwapToRepayIntentCancelled: 'Swap-to-repay cancelled',
      SwapToRepayIntentForceCancelled: 'Swap-to-repay cancelled',
      PeriodicInterestSettled: 'Interest settled',
      PeriodicInterestAutoLiquidated: 'Auto-liquidated for interest',
      RepayPartialPeriodAdvanced: 'Interest period advanced',
      PeriodicSlippageOverBuffer: 'Interest settled with slippage',
      SignedOfferFilled: 'Signed offer filled',
      SignedOfferMatched: 'Signed offers matched',
      SignedOfferCancelled: 'Signed offer cancelled',
      SignedOfferNonceBurned: 'Signed offer voided',
      InteractionRewardsClaimed: 'Rewards claimed',
      RewardDeliveredToVault: 'Rewards delivered to your vault',
      VPFIDepositedToVault: 'VPFI deposited to vault',
      VPFIWithdrawnFromVault: 'VPFI withdrawn from vault',
      VaultVpfiDebited: 'VPFI spent from vault',
      Transfer: 'Transfer',
      Approval: 'Approval',
    } as Record<string, string>,
    // UX-050 — when the indexer is degraded, the event feed can't
    // render, but the user's positions are chain-authoritative — point
    // there instead of dead-ending.
    unavailableFallback: 'Your current loans and rentals are always available on',
    positionsLink: 'My positions',
  },

  rewards: {
    unavailable: 'We couldn’t check your rewards right now — please try again in a moment.',
    title: 'Interaction rewards',
    blurb:
      'VPFI rewards from your lending and borrowing activity. They become claimable after a loan closes and the reward day finalizes.',
    empty: 'No rewards yet. Rewards appear after lending or borrowing activity.',
    waiting:
      'Your rewards are being finalized — a reward day closes across all chains before it can be claimed. Check back soon.',
    claim: 'Claim rewards',
    readyToClaim: tmpl('{{amount}} VPFI ready to claim.', ['amount']),
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
    // Health badge tooltip (extracted from LoanRow.tsx).
    healthTitle: tmpl('Health {{ratio}} — 1.00 is the liquidation line', ['ratio']),
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
    advancedDetail: tmpl(
      `(Health factor {{ratio}} — the collateral’s value measured against what’s owed; below 1.00 the loan can be liquidated. Loan-to-value {{ltvPct}} — the borrowed amount as a share of the collateral’s value.{{dropClause}})`,
      ['ratio', 'ltvPct', 'dropClause'],
    ),
    advancedDetailDrop: tmpl(
      ` Roughly, liquidation begins if the collateral’s value falls about {{drop}}.`,
      ['drop'],
    ),
  },

  notFound: {
    title: 'This page doesn’t exist',
    body: 'The link may be old or mistyped. Nothing is lost — your positions are safe.',
    backHome: 'Back to Home',
  },
  offerFlow: {
    // Duration field hint when the picked term exceeds the protocol cap.
    durationCap: tmpl(
      'The protocol currently caps offers at {{max}} — pick a shorter duration.',
      ['max'],
    ),
    // Review-receipt lines (extracted from OfferFlow.tsx). Prose +
    // interpolated values; catalog refs (lend.defaultOutcome,
    // borrow.collateralWarning, match.illiquidWarning, interest-mode
    // notes) stay composed at the call site.
    receipts: {
      buyYouReceive: tmpl(
        'The lender position of running loan #{{loanId}}: up to ~{{interest}} interest from now to the due date if the borrower repays on time, plus the full {{principal}} principal back.',
        ['loanId', 'interest', 'principal'],
      ),
      buyYouLock: tmpl(
        '{{principal}} paid now to the exiting lender — the loan itself doesn’t change for the borrower.',
        ['principal'],
      ),
      buyCollateralLocked: tmpl('Their {{collateral}} is already locked.', ['collateral']),
      buyWhenEnds: tmpl(
        'Repayment is due by {{due}} (grace period: {{grace}}). You then claim your funds.',
        ['due', 'grace'],
      ),
      borrowerYouReceiveNow: tmpl(
        '{{principal}} now (minus the {{lif}} initiation fee).',
        ['principal', 'lif'],
      ),
      borrowerYouReceiveOnAccept: tmpl(
        '{{principal}} when a lender accepts your request.',
        ['principal'],
      ),
      borrowerYouLockNow: tmpl('{{collateral}} as collateral, now.', ['collateral']),
      borrowerYouLockStarting: tmpl(
        '{{collateral}} as collateral, starting now.',
        ['collateral'],
      ),
      borrowerYouMayOwe: tmpl(
        '{{principal}} plus up to ~{{interest}} interest by the due date.',
        ['principal', 'interest'],
      ),
      borrowerYouCanLose: tmpl(
        'Your {{collateral}} collateral if you do not repay on time.',
        ['collateral'],
      ),
      borrowerWhenEndsAccept: tmpl(
        'Repay within {{duration}} (grace period: {{grace}}), then claim your collateral back.',
        ['duration', 'grace'],
      ),
      borrowerWhenEndsPost: tmpl(
        'Repay within {{duration}} of acceptance (grace period: {{grace}}), then claim your collateral back.',
        ['duration', 'grace'],
      ),
      lenderYouReceive: tmpl(
        'Up to ~{{interest}} interest if the borrower repays on time, plus your {{principal}} back.',
        ['interest', 'principal'],
      ),
      lenderYouLockAccept: tmpl('{{principal}} lent to the borrower, now.', ['principal']),
      lenderYouLockPost: tmpl(
        '{{principal}} now, until your offer is accepted or you cancel it.',
        ['principal'],
      ),
      lenderCollateralLock: tmpl('They lock {{collateral}}.', ['collateral']),
      lenderCollateralMustLock: tmpl('They must lock {{collateral}}.', ['collateral']),
      lenderWhenEndsAccept: tmpl(
        'Repayment is due within {{duration}} (grace period: {{grace}}). You then claim your funds.',
        ['duration', 'grace'],
      ),
      lenderWhenEndsPost: tmpl(
        'Repayment is due {{duration}} after a borrower accepts (grace period: {{grace}}). You then claim your funds.',
        ['duration', 'grace'],
      ),
      youLockCollateral: tmpl('you lock {{collateral}} as collateral', ['collateral']),
      theyLockCollateral: tmpl('they lock {{collateral}} as collateral', ['collateral']),
      rateOutOfRange: tmpl(
        'Enter a number between 0 and {{max}} — the protocol caps rates at {{max}}% yearly.',
        ['max'],
      ),
    },
    lender: {
      assetLabel: 'Asset to lend',
      amountLabel: 'How much do you want to lend?',
      amountHint: 'This amount is locked while your offer is open. Cancel any time before acceptance.',
      rateLabel: 'Yearly interest rate you want (%)',
      collateralLabel: 'Collateral you require from the borrower',
      collateralHint: 'The borrower must lock this before they get your tokens.',
      acceptSubmitLabel: 'Fund this borrower',
    },
    borrower: {
      assetLabel: 'Asset to borrow',
      amountLabel: 'How much do you want to borrow?',
      amountHint: 'We’ll look for lenders offering close to this amount.',
      rateLabel: 'Highest yearly interest rate you’ll accept (%)',
      rateHint: 'Lenders offering at or below this rate can fund you.',
      collateralLabel: 'Collateral you will lock',
      acceptSubmitLabel: 'Borrow this now',
    },
    steps: {
      details: 'Details',
      offers: 'Offers',
      terms: 'Your terms',
      review: 'Review & sign',
      done: 'Done',
    },
    rowBorrow: 'Borrow',
    rowLend: 'Lend',
    // Offer-row main line: "Lend 100 mUSDC at 5% yearly" (the risk badge
    // renders after this text). action = rowLend/rowBorrow.
    rowMainLine: tmpl('{{action}} {{amount}} at {{rate}} yearly', ['action', 'amount', 'rate']),
    // Offer id chip in the offer-row sub-line ("· offer #40").
    offerNumber: tmpl('offer #{{id}}', ['id']),
    // Accept-mode banner opener — which side the caller is taking, with
    // the offer id in the template so each locale places it naturally.
    acceptingLendingOffer: tmpl('You’re accepting lending offer #{{id}}.', ['id']),
    fundingBorrowRequest: tmpl('You’re funding borrow request #{{id}}.', ['id']),
    // Security-leg labels interpolated into the token-security banner via
    // tokenSecurity.gate*(leg): "The loan asset …" / "The collateral …".
    securityLegLoanAsset: 'loan asset',
    securityLegCollateral: 'collateral',
    counterAssetBorrowed: 'Borrowed asset',
    counterAssetCollateral: 'Collateral asset',
    liveFeesLoaded: 'Live fee terms loaded',
    liveFeesLoading: 'Loading live fee terms…',
    durationLabel: 'Duration',
    seeMatches: 'See matching offers',
    lookingForMatches: 'Looking for matches…',
    back: 'Back',
    selfCollateralError: 'The collateral must be a different asset than the one being borrowed — the protocol rejects same-asset offers.',
    collateralAmountLabel: 'Collateral amount',
    advancedOptions: 'Advanced options',
    allowPartialRepay: 'Allow the borrower to repay in parts',
    proRataInterest: 'Charge interest only for time used (pro-rata) instead of the full term',
    continueToReview: 'Continue to review',
    retry: 'Retry',
    beforeYouSign: 'Before you sign',
    preparingReview: 'Preparing your review…',
    waitingForWallet: 'Waiting for wallet…',
    receiptOweNothing: 'Nothing — the borrower owes you.',
    viewTransaction: 'View the transaction',
    viewPositions: 'View my positions',
    postAnother: 'Post another',
  },
  loanRow: {
    youRent: 'You rent',
    youRentOut: 'You rent out',
  },
  settingsPage: {
    title: 'Settings',
    lede: 'Appearance, experience level, and more.',
    theme: {
      title: 'Theme',
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },
    experience: {
      title: 'Experience level',
      basic: 'Basic',
      advanced: 'Advanced',
      hint: 'Basic keeps every screen to the essentials. Advanced reveals more controls and market detail on the same pages — the rules of the protocol are identical in both.',
    },
    more: {
      title: 'More',
      claimsSub: 'Collect repayments, collateral, and rewards',
      offersSub: 'Browse every open offer on this network',
      vaultSub: 'Where your assets sit — totals, locked, and free',
      vpfiSub: 'Optional — reduce protocol fees by holding VPFI',
      activitySub: 'Everything your wallet has done on Vaipakam',
      helpSub: 'Plain-language answers and build info',
    },
  },
  common: {
    back: 'Back',
    tryAgain: 'Try again',
    waitingForWallet: 'Waiting for wallet…',
    // Fallback chain label when a chain id has no known name (offer-row,
    // rental prepay). "#42" style, so the number reads as an id.
    networkFallback: tmpl('network #{{id}}', ['id']),
    // Fallback shown when a value (e.g. the connected chain id) is not known.
    unknown: 'unknown',
  },
  stepNav: {
    progressAria: 'Progress',
    // Compact one-line step indicator (phones): "Step 2 of 4 — Review".
    progress: tmpl('Step {{current}} of {{total}} — {{label}}', ['current', 'total', 'label']),
  },
  checklist: {
    ready: 'Ready',
    needsAttention: 'Needs attention',
    checking: 'Checking',
  },
  assetPicker: {
    placeholder: 'Choose an asset…',
    pasteOption: 'Paste a token address…',
    faucetBadge: 'Faucet test token',
    invalidAddress: 'Enter a valid contract address — “0x” followed by 40 hex characters.',
    // aria-label for the contract-address field, prefixed by the asset label.
    contractAddressAria: tmpl('{{label}} contract address', ['label']),
  },
  copyAddress: {
    copyAria: tmpl('Copy address {{address}}', ['address']),
    viewAria: tmpl('View {{address}} on the block explorer', ['address']),
    copied: 'Address copied',
  },
} as const;

export type CopySource = typeof copySource;

/** The raw English catalog — consumed by the i18n template exporter
 *  (`scripts/export-i18n-template.ts`) and its vitest drift check.
 *  App code should import `copy` below, never this. */
export { copySource };

/** i18n-aware view over the catalog. Same shape and types as the
 *  source; string leaves resolve through i18next at access time with
 *  the English text as fallback. See src/i18n/reactiveCopy.ts. */
export const copy: CopySource = createTranslatedCopy(copySource);
