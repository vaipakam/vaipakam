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

import { bytesToHex, keccak256 } from 'viem';

/** Replay window — a signed alert request older (or further in the
 *  future) than this is rejected. Mirrors the erasure endpoints. */
export const LINK_SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

/**
 * The longer window a KEYED request (see {@link REQUEST_KEYED_NOTE}) gets
 * when its signature verified through the wallet's contract, not a key.
 * A multi-signature wallet gathers its approvals over hours, so ten
 * minutes is too short.
 */
export const KEYED_CONTRACT_SIGNATURE_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * REQUEST KEYS (#3770). A signed request whose ANSWER goes back to whoever
 * sent it — the link code, the status read pass — carries a commitment to a
 * secret only the asking device holds. The device makes 32 random bytes,
 * signs their keccak-256 hash inside the message (`Request key: 0x…`), and
 * sends the secret beside the signature; the agent refuses a request whose
 * secret does not hash to the signed value, so the answer goes only to the
 * device that asked. The rule applies to every wallet type.
 */
export const REQUEST_KEYED_NOTE = 'request key';

const WORD = /^0x[0-9a-fA-F]{64}$/;

/** True for a 0x-prefixed 32-byte hex string: the shape of a request key's
 *  secret and of its hash. */
export function isRequestKeyWord(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && WORD.test(v);
}

/** A fresh request key: 32 bytes from the platform's cryptographic random
 *  source. The asking device keeps it until the request is answered and
 *  sends it beside the signature; it is never signed itself. */
export function newRequestKey(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** The keccak-256 hash of a request key, the value the message carries. */
export function requestKeyHash(requestKey: string): `0x${string}` {
  if (!isRequestKeyWord(requestKey)) throw new Error('request key must be 32 bytes of hex');
  return keccak256(requestKey.toLowerCase() as `0x${string}`);
}

function requestKeyLine(keyHash: string): string {
  if (!isRequestKeyWord(keyHash)) throw new Error('request key hash must be 32 bytes of hex');
  return `Request key: ${keyHash.toLowerCase()}`;
}

/**
 * Link: authorises Telegram delivery for the wallet to whichever chat
 * completes the one-time code the agent issues.
 */
export function buildTelegramLinkMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
  keyHash: string,
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
    requestKeyLine(keyHash),
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
 * - `vaultOutflowAlerts` (#3434): an alert for every movement out of the
 *   owner's vault — `on`, `off`, or `default` (on while the owner's
 *   protected mode is on, off otherwise).
 */
export interface AlertSettingsChange {
  bands?: { warnHf: number; alertHf: number; criticalHf: number };
  dueDateReminders?: boolean;
  pushAlerts?: true;
  vaultOutflowAlerts?: 'on' | 'off' | 'default';
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
  const { bands, dueDateReminders, pushAlerts, vaultOutflowAlerts } = change;
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
    // #3434 — written ONLY when the save sets it, so a message signed by an
    // app that predates the setting is the same text the agent rebuilds.
    ...(vaultOutflowAlerts === undefined
      ? []
      : [
          `Vault outflow alerts: ${
            vaultOutflowAlerts === 'default' ? 'on while protected mode is on (default)' : vaultOutflowAlerts
          }`,
        ]),
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

/**
 * Set or remove the alert phrase (#3346). The message names the phrase it
 * sets, so the signature authorises that phrase and no other, and its own
 * headline, so it can never be replayed as another alert action. `phrase`
 * is the normalised phrase (`normaliseAlertPhrase`), or null to remove it.
 * The phrase is shown in the owner's own wallet only; the agent keeps no
 * copy of the message, only its digest for the one-use check.
 */
export function buildAlertPhraseMessage(
  wallet: string,
  chainId: number,
  phrase: string | null,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Set my alert phrase',
    '',
    'I request that every Telegram alert for the wallet below start with',
    'the phrase below, or that the phrase be removed. Signing this message',
    'proves ownership of the wallet. It is not a transaction and costs no',
    'gas.',
    '',
    `Phrase: ${phrase === null ? 'remove' : `"${phrase}"`}`,
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * Show my Telegram alert status (#3573). Signed before the agent answers
 * whether a chat is linked and whether a removal or move is pending, and
 * issues a short-lived read pass so the app can refresh that answer without
 * asking for another signature. Whether a wallet has Telegram alerts, and
 * when a protected owner's chat is about to change, is the owner's own
 * business, so the read is not open.
 */
export function buildTelegramStatusMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
  keyHash: string,
): string {
  return [
    'Vaipakam — Show my Telegram alert status',
    '',
    'I request to see whether a Telegram chat is linked for the wallet',
    'below, and whether a removal or move of that chat is pending. Signing',
    'this message proves ownership of the wallet. It is not a transaction',
    'and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
    requestKeyLine(keyHash),
  ].join('\n');
}
