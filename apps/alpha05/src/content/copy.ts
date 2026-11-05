/**
 * The copy catalog. English lives here as the single source of truth and
 * reaches i18next as per-key default values (`useCopy`); locale bundles
 * override per key. Every entry is declared through a tier helper
 * (RB-TIERS), which is how `scripts/check-word-budget.mjs` finds the inline
 * tier-B sentences it budgets and the help panel finds the tier-C
 * explanation for a key. A `{{name}}` is a placeholder `format` fills.
 */
import { A, B, C } from '../shared/copy/tiers';

export const copy = {
  shell: {
    brand: B('Vaipakam'),
    modeBasic: B('Basic'),
    modeAdvanced: B('Advanced'),
    mode: B('Mode: {{mode}}.'),
    modeWhy: C(
      'Basic shows the capabilities most people need. Advanced adds the exit and settlement tools, automation, signed orders, keeper posture and accounting detail. Switching modes never hides a consent, a blocker or a remedy.',
      'advanced-mode',
    ),
    underConstruction: A(
      'This is the next version of the Vaipakam app, being built page by page. Nothing here signs or sends anything yet. Your positions, claims and vault are untouched and are served by the current app.',
    ),
    build: B('Build {{hash}} · {{time}}'),
  },
  help: {
    why: B('Why?'),
    close: B('Close'),
    guideLink: B('Read more in the user guide'),
  },
  wallet: {
    connect: B('Connect wallet'),
    connecting: B('Connecting…'),
    account: B('{{address}} on {{chain}}'),
    accountWhy: C(
      'The app reads your positions, vault and claims through your wallet\'s own connection to the network first, and through the read-only proxy only when the wallet offers none, so your own state costs you nothing and is never read from the index. The address and network shown are the ones every figure on this page belongs to.',
      'wallet',
    ),
    unsupported: A(
      'Your wallet is on a network this app does not serve, so nothing of yours is shown and no action is offered until it moves. Supported: {{chains}}.',
    ),
    switchTo: B('Switch to {{chain}}'),
    switchFailed: A('The wallet did not switch: {{reason}}'),
    noProvider: B('Reading your state through the proxy: this wallet offers no direct connection.'),
  },
  notBuilt: {
    a: A('This page is not built yet in the new app. Nothing you own is affected; the current app still serves it.'),
    b: B('Use the current app for this job until this page ships.'),
    none: B('The current app has no page for this job; it arrives with this page.'),
    open: B('Open it in the current app'),
  },
  capability: {
    reading: B('Checking what this deployment supports.'),
    routed: B('Chain {{chain}}: {{count}} routed functions read from the protocol contract.'),
    rereading: B('(re-reading now)'),
    unreadable: A(
      'The routed functions of the protocol contract could not be read, so this build cannot tell which actions the deployment supports. No signing step is offered until it can.',
    ),
    why: C(
      'The app binds to one protocol contract per chain and reads the list of functions it routes before offering any action. After an upgrade that list changes; reading it, rather than assuming it, is what lets the app name what changed instead of failing on a missing function.',
      'deployments',
    ),
  },
  rail: {
    at: B('Index at block {{block}}, {{age}} ago.'),
    stale: A('The index has not advanced for {{age}}; world figures may be behind the chain.'),
    unavailable: A('The index could not be read ({{reason}}). World figures are unavailable, not empty.'),
    unknown: B('Index position unknown: {{reason}}'),
    halted: A('World figures will fall behind the chain: {{reason}}. The last scan is shown below.'),
    refreshFailed: A('The index could not be re-read ({{reason}}). World figures are from its last answer, aged below, and may be behind the chain.'),
    pushLive: B('Push live.'),
    pushConnecting: B('Push connecting.'),
    pushInactive: B('Push off for this chain, polling.'),
    pushStalled: B('Push stalled (no scan reported in time), polling.'),
    pushUnavailable: B('Push unavailable, polling.'),
    pushOff: B('No push rail in this build.'),
    refresh: B('Refresh'),
    source: B('Where world figures come from.'),
    why: C(
      'World figures (the offer book, other people\'s loans, metrics) come from the index, which scans each chain on a rotation of a few minutes and announces changes over a push rail. Every figure carries the block and age of the scan it came from; your own positions never come from the index, they are read from the chain through your wallet.',
      'data-freshness',
    ),
  },
  receipt: {
    unknown: B('Unknown'),
    consequences: B('What you can lose'),
    prompts: B('Wallet prompts: {{count}}.'),
    readAt: B('Figures read {{age}} ago.'),
  },
  finish: {
    title: B('Outcome'),
    done: A('Done: every part of this action is confirmed on the chain.'),
    partialFailed: A('Partly done: some parts are confirmed on the chain and the rest did not land. Each is listed below with its reason.'),
    partialUnknown: A('Partly done: some parts are confirmed on the chain; the rest could not be read back, so they are counted neither as landed nor as failed. Each is listed below.'),
    partialMixed: A('Partly done: some parts are confirmed on the chain, some did not land, and some could not be read back. Each is listed below with what is known.'),
    notDone: A('Not done: nothing changed on the chain. Each part is listed below with its reason.'),
    unknown: A('Outcome unknown: the transaction was included but its effect could not be read back. Nothing is assumed.'),
    legDone: B('done'),
  },
  action: {
    withheld: B('not offered until its inputs are read'),
    reopens: B('May reopen at {{when}}.'),
  },
} as const;
