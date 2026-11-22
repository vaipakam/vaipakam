/**
 * The canonical EIP-191 messages a user signs to authorise the four
 * alert-family actions — link, unlink, save settings, test-alert.
 *
 * ONE source of truth, by design (#2014, the shape #2008 established
 * for the erasure family): the wallet prompt the connected app shows
 * and the reconstruction the agent Worker recovers the signer from
 * MUST be byte-identical, or recovery yields a different address and
 * every request is rejected. These four lived DUPLICATED between
 * `apps/agent/src/linkAuth.ts` and `apps/app/src/data/alerts.ts`,
 * held identical only by comments saying they must be — a one-sided
 * edit rejects every affected signed request in production, with
 * nothing catching it before deploy. #2013's scope-neutral unlink
 * rewording had to land as two synchronised edits for exactly this
 * reason; after this move the next such rewording is single-sided.
 *
 * Every message differs in headline AND body text, so a signature
 * captured for one action can never be replayed as another. Each is
 * FROZEN from its first release — the byte-pinning test in
 * `alertsMessage.test.ts` holds them verbatim. (The one retirement, the
 * mute-only due-date message, went with #2754 while the platform was
 * prelive: every settings save is now signed over the settings message.) The wallet is
 * lower-cased so a checksummed and an all-lowercase spelling of the
 * same address produce the same message.
 */

/** Replay window — a signed alert request older (or further in the
 *  future) than this is rejected. Mirrors the erasure endpoints. */
export const LINK_SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

/**
 * Link: authorises Telegram delivery for the wallet to whichever chat
 * completes the one-time code the agent issues.
 */
export function buildTelegramLinkMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Link Telegram alerts',
    '',
    'I authorise Telegram alert delivery for the wallet below to the',
    'chat that completes this link code. Signing this message proves',
    'ownership of the wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * Unlink: the counterpart, with a deliberately different headline and
 * body so a signature captured for one action can never authorise the
 * other.
 *
 * The wording is SCOPE-NEUTRAL (#2013 round 4 P1): it does not say
 * "everywhere", because the effect's scope follows the signer's
 * authority — an ECDSA key (the universal controller) clears the
 * wallet everywhere, while a smart account's chain-verified approval
 * clears only the chain the message names. The signed `Chain id`
 * line is the scope the signer can always vouch for; clearing MORE
 * on an ECDSA signature is privacy-protective over-delivery. The
 * handler reports which scope applied and the app confirms
 * accordingly.
 */
export function buildTelegramUnlinkMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Unlink Telegram alerts',
    '',
    'I request that Telegram alert delivery for the wallet below be',
    'disconnected. Signing this message proves ownership of the',
    'wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * What one alert-settings save changes (#2754). Every field is
 * optional, and an absent field means "keep the saved value", the
 * same contract the agent's `PUT /thresholds` has always applied:
 *
 * - `bands`: the three health-factor bands, all together or not at
 *   all (they are one lane state);
 * - `dueDateReminders`: the payment due-date reminder switch;
 * - `pushAlerts`: `true` when the save switches Push alerts on. There
 *   is no way to switch Push off through this save, so there is no
 *   `false`.
 */
export interface AlertSettingsChange {
  bands?: { warnHf: number; alertHf: number; criticalHf: number };
  dueDateReminders?: boolean;
  pushAlerts?: true;
}

/**
 * Save alert settings (#2754): signed for EVERY settings write, not
 * only an opt-out. The message names exactly what the save changes,
 * so the signature authorises those values and no others, and the
 * agent rebuilds it from the request body it is about to store.
 *
 * It replaced the mute-only message (#1056 round 6), which proved
 * ownership for an opt-out and left every other write trusting the
 * wallet named in the body: a caller with a spoofed Origin could
 * rewrite any wallet's bands and Push opt-in.
 *
 * Numbers are written with `String(n)`, which gives the same text for
 * the same number on both sides.
 */
export function buildAlertSettingsMessage(
  wallet: string,
  chainId: number,
  change: AlertSettingsChange,
  issuedAt: number,
): string {
  const { bands, dueDateReminders, pushAlerts } = change;
  return [
    'Vaipakam — Save alert settings',
    '',
    'I request that the alert settings below be saved for the wallet',
    'below. A setting marked unchanged keeps its saved value. Signing',
    'this message proves ownership of the wallet. It is not a',
    'transaction and costs no gas.',
    '',
    `Health-factor alerts: ${
      bands
        ? `warn at ${String(bands.warnHf)}, alert at ${String(bands.alertHf)}, critical at ${String(bands.criticalHf)}`
        : 'unchanged'
    }`,
    `Due-date payment reminders: ${
      dueDateReminders === undefined ? 'unchanged' : dueDateReminders ? 'on' : 'off'
    }`,
    `Push alerts: ${pushAlerts ? 'switch on' : 'unchanged'}`,
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * Test alert (UX-012): signed before the Worker pushes a one-off
 * "your alerts are working" message to the linked chat. Sending a
 * Telegram message is an outbound side-effect, so it gets the same
 * ownership proof as link / unlink — without it a spoofed-Origin
 * caller who knows a linked wallet's (public) address could spam that
 * user's Telegram with test messages.
 */
export function buildTelegramTestMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Send a test alert',
    '',
    'I request one test alert be sent to the Telegram chat linked to',
    'the wallet below, to confirm delivery works. Signing this message',
    'proves ownership of the wallet. It is not a transaction and costs',
    'no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}
