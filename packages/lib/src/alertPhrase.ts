/**
 * The owner's anti-phishing phrase (#3346): a short phrase the owner picks,
 * which every Telegram alert we send them starts with. A message without it
 * did not come from us.
 *
 * ONE rule for what a phrase may be, shared by the app (which checks it as
 * the owner types) and the agent (which refuses anything else), and one
 * rendering of the line that carries it.
 *
 * Only letters, digits, spaces and a little punctuation are accepted, so a
 * phrase can never be a link, a handle or markup. It is kept off-chain, in
 * the agent's private state, and never put on a public surface. Push
 * notifications never carry it: they are not private to the owner.
 */

/** Shortest and longest phrase, in characters (code points). */
export const ALERT_PHRASE_MIN = 3;
export const ALERT_PHRASE_MAX = 32;

const ALLOWED = /^[\p{L}\p{M}\p{N} .,'!?-]+$/u;

/**
 * The phrase as stored, or null when `raw` is not an acceptable phrase.
 * Normalised to NFC, trimmed, and runs of spaces collapsed to one, so the
 * same phrase typed twice is stored the same way.
 */
export function normaliseAlertPhrase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const n = [...p].length;
  if (n < ALERT_PHRASE_MIN || n > ALERT_PHRASE_MAX) return null;
  if (!ALLOWED.test(p)) return null;
  // At least one letter or digit: a phrase of punctuation alone is no check.
  if (!/[\p{L}\p{N}]/u.test(p)) return null;
  return p;
}

/** The first line of every Telegram alert to an owner with a phrase. */
export function alertPhraseLine(phrase: string): string {
  return `Your Vaipakam phrase: ${phrase}`;
}

/** `text` with the owner's phrase line in front, or unchanged when the owner
 *  set none. */
export function withAlertPhrase(text: string, phrase: string | null | undefined): string {
  return phrase ? `${alertPhraseLine(phrase)}\n\n${text}` : text;
}
