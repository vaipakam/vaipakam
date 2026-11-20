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
 *
 * #3836 changed all four while the platform is prelive: each now ends
 * with the hash of a request key only the requesting browser holds.
 */

import { keccak256 } from 'viem';
import { DOMAIN_DOT, PLAIN } from './telegramAlerts/plainText';

/** Replay window — a signed alert request whose signature recovers to
 *  the wallet's own key is rejected when older than this, and every
 *  request when further in the future. Mirrors the erasure endpoints. */
export const LINK_SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

/**
 * #3836 — the longer window for a request only a CONTRACT approved: a
 * smart account whose ERC-1271 / ERC-6492 check passes on the signed
 * chain (a Safe, typically). The timestamp goes into the message before
 * the wallet is asked, and a Safe returns the signature only once
 * enough owners have approved, which routinely takes longer than ten
 * minutes; every such request used to be refused as stale. The window
 * is one-sided: a timestamp in the future is held to
 * `LINK_SIGNATURE_MAX_AGE_SECONDS` for every wallet, and a signature
 * that recovers to the wallet's own key keeps the ten minutes whatever
 * code sits at the address.
 *
 * What makes the longer window safe, all in the agent: each request
 * names a request key only the requesting browser holds, each signed
 * request is accepted once, and a request older than the newest one
 * already applied for the same change is refused.
 */
export const LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * #3836 — the request key. The app draws a random secret for each
 * request, the signed text carries its hash, and the request body
 * carries the secret, so only the browser that made the request can
 * present it, however the wallet's approval is published. The secret
 * is 32 random bytes as 0x-prefixed hex; the hash is its keccak-256.
 */
const REQUEST_KEY_RE = /^0x[0-9a-f]{64}$/;

/** True for a well-shaped request key (lower-case 0x-prefixed hex, 32
 *  bytes). */
export function isRequestKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && REQUEST_KEY_RE.test(value);
}

/** A fresh request key, from the platform's secure random source. */
export function newRequestKey(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The hash the signed text names for `requestKey`. */
export function requestKeyHash(requestKey: `0x${string}`): `0x${string}` {
  return keccak256(requestKey);
}

/** The lines every alert message ends with: who, where, when, and the
 *  request key's hash. */
function trailer(wallet: string, chainId: number, issuedAt: number, keyHash: string): string[] {
  return [
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
    `Request key hash (only the requesting browser holds the key): ${keyHash.toLowerCase()}`,
  ];
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
    ...trailer(wallet, chainId, issuedAt, keyHash),
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
  keyHash: string,
): string {
  return [
    'Vaipakam — Unlink Telegram alerts',
    '',
    'I request that Telegram alert delivery for the wallet below be',
    'disconnected. Signing this message proves ownership of the',
    'wallet. It is not a transaction and costs no gas.',
    '',
    ...trailer(wallet, chainId, issuedAt, keyHash),
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
  keyHash: string,
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
    ...trailer(wallet, chainId, issuedAt, keyHash),
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
  keyHash: string,
): string {
  return [
    'Vaipakam — Send a test alert',
    '',
    'I request one test alert be sent to the Telegram chat linked to',
    'the wallet below, to confirm delivery works. Signing this message',
    'proves ownership of the wallet. It is not a transaction and costs',
    'no gas.',
    '',
    ...trailer(wallet, chainId, issuedAt, keyHash),
  ].join('\n');
}

// ─── #3346 — the alert phrase ─────────────────────────────────────────────

/** Fewest and most characters (Unicode code points) an alert phrase may
 *  have. */
export const ALERT_PHRASE_MIN = 3;
export const ALERT_PHRASE_MAX = 32;

/**
 * The phrase as the owner will sign it, from what they typed: Unicode NFC,
 * with no space at either end. Nothing else is changed: a phrase that still
 * breaks the rule is refused by name (`alertPhraseProblem`), never cleaned,
 * so the owner signs exactly the phrase the bot will show.
 */
export function normaliseAlertPhrase(raw: string): string {
  return raw.normalize('NFC').trim();
}

/** Why a phrase is refused, or null when it is acceptable as it stands. The
 *  characters are the bot's free-text rule (`telegramAlerts/plainText`): no
 *  `/`, `:` or `@`, and no dot before a letter, so a phrase can never form a
 *  link or a handle. */
export function alertPhraseProblem(phrase: string): 'too-short' | 'too-long' | 'bad-characters' | 'not-normalised' | null {
  if (normaliseAlertPhrase(phrase) !== phrase) return 'not-normalised';
  if (![...phrase].every((ch) => PLAIN.test(ch)) || new RegExp(DOMAIN_DOT.source, 'u').test(phrase)) return 'bad-characters';
  const length = [...phrase].length;
  if (length < ALERT_PHRASE_MIN) return 'too-short';
  if (length > ALERT_PHRASE_MAX) return 'too-long';
  return null;
}

/** The fixed tag the fingerprint starts with, so it can never equal a hash
 *  made for anything else from the same key. */
export const ALERT_PHRASE_FINGERPRINT_TAG = 'Vaipakam alert phrase v1';

/**
 * The phrase's fingerprint, which the signed text names in place of the
 * phrase: the keccak-256 of the fixed tag, the request key's 32 bytes and the
 * phrase's UTF-8 bytes (the phrase already NFC). The phrase itself never goes
 * in the signed text, because a contract wallet's approval of that text is
 * public (#3836). A plain hash of a short phrase could be guessed by trying
 * phrases; the request key, fresh and random for each request and held only
 * by the requesting browser, stops that.
 */
export function alertPhraseFingerprint(requestKey: `0x${string}`, phrase: string): `0x${string}` {
  const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();
  return keccak256(`0x${hex(enc.encode(ALERT_PHRASE_FINGERPRINT_TAG))}${requestKey.slice(2)}${hex(enc.encode(phrase))}`);
}

/**
 * Set or change the wallet's alert phrase (#3346): the words every alert the
 * bot sends to the wallet's private Telegram chat leads with, so a message
 * without them is not ours. The text names only the phrase's fingerprint
 * (`alertPhraseFingerprint`); the agent recomputes it from the request.
 */
export function buildAlertPhraseMessage(
  wallet: string,
  chainId: number,
  fingerprint: string,
  issuedAt: number,
  keyHash: string,
): string {
  return [
    'Vaipakam — Set the alert phrase',
    '',
    "I request that this wallet's alert phrase be set. The phrase is",
    'not in this message; the line below is its fingerprint. Signing',
    'this message proves ownership of the wallet. It is not a',
    'transaction and costs no gas.',
    '',
    `Phrase fingerprint: ${fingerprint.toLowerCase()}`,
    '',
    ...trailer(wallet, chainId, issuedAt, keyHash),
  ].join('\n');
}

/** Remove the wallet's alert phrase (#3346): its own headline and body, so
 *  no signature for another action can stand for it. */
export function buildAlertPhraseClearMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
  keyHash: string,
): string {
  return [
    'Vaipakam — Remove the alert phrase',
    '',
    "I request that this wallet's alert phrase be removed, so alerts no",
    'longer lead with it. Signing this message proves ownership of the',
    'wallet. It is not a transaction and costs no gas.',
    '',
    ...trailer(wallet, chainId, issuedAt, keyHash),
  ].join('\n');
}
