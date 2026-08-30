/**
 * The canonical EIP-191 messages a user signs to authorise the four
 * alert-family actions — link, unlink, mute-due-date, test-alert.
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
 * `alertsMessage.test.ts` holds them verbatim. The wallet is
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
 * Mute due-date reminders: required when a `/thresholds` write sets
 * `notify_maturity_approaching` to false, since that silences BOTH
 * due-date warning lanes (agent reminder + keeper pre-grace) — an
 * unsigned opt-out would be alert suppression through a side door.
 */
export function buildDueDateOptOutMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Mute due-date payment reminders',
    '',
    'I request that payment due-date reminders for the wallet below',
    'be switched off. Signing this message proves ownership of the',
    'wallet. It is not a transaction and costs no gas.',
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
