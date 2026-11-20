/**
 * #3769 — alerts for a loan the wallet does not hold
 * (FeaturesOverExistingPartsDesign.md §9).
 *
 * A wallet may watch any loan by its id: the loan's data is public, so no
 * consent from its holders is needed. The agent then tells the wallet's
 * linked Telegram chat when the loan's health level falls into a worse band,
 * when its final due date approaches, when it is repaid and when it is
 * otherwise closed. Every message says the wallet is watching and holds no
 * position in the loan (§12 test 8).
 *
 * This module is the ONE source of what both sides must agree on byte for
 * byte (the shape `alertsMessage.ts` established, #2014): the messages a
 * wallet signs to watch, stop watching and list, which the app shows in the
 * wallet prompt and the agent rebuilds to recover the signer; the default
 * limits; and the alert wording. Each signed message differs in its headline
 * and body, so a signature for one action can never be replayed as another,
 * and each names the loan, so a signature to watch loan 7 cannot watch loan 8.
 *
 * The messages are frozen from their first release; `watchedLoans.test.ts`
 * pins them verbatim.
 */

/** Default limits (§13 item 4, owner's call through the coordinator,
 *  2026-11-19). The agent reads its own configuration first. */
export const WATCH_DEFAULT_MAX_LOANS_PER_WALLET = 10;
export const WATCH_DEFAULT_MAX_CHANGES_PER_DAY = 20;

/** How long before a loan's due date the watching wallet is told. */
export const WATCH_DUE_NOTICE_SECONDS = 3 * 24 * 60 * 60;

/** The health-level bands a watched loan is classified by: the same
 *  defaults the app offers a holder for their own loans. A watcher does not
 *  set bands of their own. */
export const WATCH_BANDS = { warn: 1.5, alert: 1.2, critical: 1.05 } as const;

export type WatchBand = 'healthy' | 'warn' | 'alert' | 'critical';

/** Worse bands rank higher. */
export const WATCH_BAND_RANK: Readonly<Record<WatchBand, number>> = {
  healthy: 0,
  warn: 1,
  alert: 2,
  critical: 3,
};

/** The band a health level (1.0 = 1e18 on chain) falls in. */
export function watchBandOf(hf: number): WatchBand {
  if (hf <= WATCH_BANDS.critical) return 'critical';
  if (hf <= WATCH_BANDS.alert) return 'alert';
  if (hf <= WATCH_BANDS.warn) return 'warn';
  return 'healthy';
}

const footer = (wallet: string, chainId: number, issuedAt: number) => [
  '',
  `Wallet: ${wallet.toLowerCase()}`,
  `Chain id: ${chainId}`,
  `Issued at (unix): ${issuedAt}`,
];

/** Watch: authorises alerts about one loan the wallet need not hold. */
export function buildWatchLoanMessage(wallet: string, chainId: number, loanId: number, issuedAt: number): string {
  return [
    'Vaipakam — Watch a loan',
    '',
    'I request alerts about the loan below, sent to the Telegram chat',
    'linked to the wallet below. Watching a loan gives no rights over',
    'it. Signing this message proves ownership of the wallet. It is',
    'not a transaction and costs no gas.',
    '',
    `Loan id: ${loanId}`,
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}

/** Stop watching: the counterpart, worded differently. */
export function buildUnwatchLoanMessage(wallet: string, chainId: number, loanId: number, issuedAt: number): string {
  return [
    'Vaipakam — Stop watching a loan',
    '',
    'I request that alerts about the loan below stop for the wallet',
    'below. Signing this message proves ownership of the wallet. It is',
    'not a transaction and costs no gas.',
    '',
    `Loan id: ${loanId}`,
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}

/** List: which loans the wallet watches is the wallet's private setting,
 *  so reading it back is signed too. */
export function buildListWatchedLoansMessage(wallet: string, chainId: number, issuedAt: number): string {
  return [
    'Vaipakam — Show the loans I watch',
    '',
    'I request the list of loans the wallet below watches. Signing this',
    'message proves ownership of the wallet. It is not a transaction and',
    'costs no gas.',
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}

/** What happened to a watched loan, as the alert states it. */
export type WatchEvent =
  | { kind: 'band'; band: Exclude<WatchBand, 'healthy'>; hf: number }
  | { kind: 'due'; dueAt: number; graceEnd: number; now: number }
  | { kind: 'repaid' }
  | { kind: 'closed'; status: string };

const BAND_WORDS: Record<Exclude<WatchBand, 'healthy'>, string> = {
  warn: 'has fallen to the warning level',
  alert: 'has fallen to the alert level',
  critical: 'is close to the point where the loan can be liquidated',
};

/** A plain date and time in UTC, the same on every machine. */
export function utcStamp(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const STATUS_WORDS: Record<string, string> = {
  defaulted: 'was closed as defaulted',
  liquidated: 'was liquidated',
  settled: 'was settled and closed',
};

/**
 * One alert's text. English in every locale for now, like the periodic
 * interest reminder; the statement that the wallet holds no position is in
 * every message whatever the event.
 */
export function watchAlertText(input: {
  event: WatchEvent;
  chainName: string;
  loanId: number;
  appOrigin: string;
}): string {
  const { event, chainName, loanId, appOrigin } = input;
  let line: string;
  let ends = false;
  switch (event.kind) {
    case 'band':
      line = `Its health level ${BAND_WORDS[event.band]}: ${event.hf.toFixed(2)}.`;
      break;
    case 'due':
      line =
        event.now < event.dueAt
          ? `Its final payment is due by ${utcStamp(event.dueAt)}.`
          : `Its final payment was due by ${utcStamp(event.dueAt)}. The grace period ends ${utcStamp(event.graceEnd)}.`;
      break;
    case 'repaid':
      line = 'It has been repaid.';
      ends = true;
      break;
    case 'closed':
      line = `It ${STATUS_WORDS[event.status] ?? `was closed (${event.status})`}.`;
      ends = true;
      break;
  }
  return [
    `Vaipakam — watched loan #${loanId} on ${chainName}`,
    line,
    'You are watching this loan. Your wallet holds no position in it.',
    ends ? 'The loan has ended, so this watch has ended too.' : 'You can stop watching it in the app.',
    `${appOrigin}/loans/${loanId}`,
  ].join('\n');
}
