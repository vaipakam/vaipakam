/**
 * The request reference (#3922, TroubleshootingPictureDesign §4.6): a short
 * random code that ties a failure the user saw to the service's record of it.
 *
 * Who makes it:
 *   - a WRITE (any method other than GET, HEAD and OPTIONS) carries the app's
 *     own reference in `x-request-ref`. Writes are preflighted already, so the
 *     header costs nothing extra;
 *   - a READ carries none, and the service makes one. A custom header on a
 *     plain GET would turn every read into a preflighted one, which roughly
 *     doubles the indexer's requests.
 *
 * Either way the service returns the reference in the same header, and the app
 * shows the reference the response carries. The reference is random each
 * time, is not derived from anything about the user, and the app keeps it in
 * memory only, never in browser storage.
 *
 * Browser-safe: no Worker or Node types, so the apps import it as they are.
 */

/** The header the reference travels in, both ways. */
export const REQUEST_REF_HEADER = 'x-request-ref';

/** Crockford base32: no I, L, O or U, so a reference read out loud is unambiguous. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Ten characters, 50 random bits. */
export const REQUEST_REF_LENGTH = 10;

const REFERENCE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** True for a well-formed reference. Anything else is treated as absent. */
export function isRequestReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE.test(value);
}

/**
 * A new random reference. `random` fills a byte array (the platform's
 * `crypto.getRandomValues` by default); each byte gives one character from its
 * low five bits, so every character is uniform.
 */
export function newRequestReference(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => {
    crypto.getRandomValues(b);
  },
): string {
  const bytes = new Uint8Array(REQUEST_REF_LENGTH);
  random(bytes);
  let out = '';
  for (let i = 0; i < REQUEST_REF_LENGTH; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Whether the app sends its own reference with a request of this method. */
export function appSendsReference(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** The reference a response carries, or null when it carries none (or a malformed one). */
export function readRequestReference(res: { headers: { get(name: string): string | null } }): string | null {
  const value = res.headers.get(REQUEST_REF_HEADER);
  return isRequestReference(value) ? value : null;
}
