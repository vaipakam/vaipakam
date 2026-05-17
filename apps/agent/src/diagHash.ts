/**
 * 2026-05-17 — T-075: server-side keyed hashing for the diagnostics
 * error-capture deletion key.
 *
 * The `diag_errors` table stores a *redacted* wallet (`0x…abcd`) for
 * triage display only. That value is NOT unique — two wallets that
 * share the same leading / trailing nibbles collapse to one string —
 * so it cannot be used to identify "this user's records" for an
 * erasure request without risking deletion of an unrelated user's
 * rows on a collision.
 *
 * `walletHash` derives the real deletion key:
 *
 *     HMAC-SHA256( lowercased_full_wallet, DIAG_WALLET_HMAC_KEY )  →  hex
 *
 * Properties that make this the right primitive:
 *
 *   - **Unique per wallet** — no collisions, unlike the redaction.
 *   - **Not reversible without the server key.** A plain
 *     `SHA-256(address)` would be trivially rainbow-tabled: the set
 *     of addresses that have ever transacted on-chain is public and
 *     finite, so an unkeyed digest of an address is effectively
 *     reversible. The keyed HMAC defeats that — an attacker who
 *     dumps the D1 table still cannot map a `wallet_hash` back to an
 *     address without `DIAG_WALLET_HMAC_KEY`.
 *   - **Stable** — an erasure request recomputes the identical hash
 *     from a freshly signed wallet, so it matches every stored row.
 *
 * The full wallet address is used only transiently, in Worker
 * memory, to compute this hash; it is never written to D1. Only the
 * hash and the (non-unique) redacted display are persisted.
 *
 * Implementation note: this MUST stay server-side. The HMAC key
 * cannot be shipped to the browser — a key embedded in the frontend
 * bundle is public, which would collapse the HMAC back to an
 * unkeyed (reversible) hash. That is why the capture path sends the
 * full wallet to the Worker rather than hashing client-side.
 */

/** Strict EVM address shape: `0x` + 40 hex nibbles. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** True iff `s` is a syntactically valid EVM address string. */
export function isHexAddress(s: unknown): s is string {
  return typeof s === 'string' && ADDRESS_RE.test(s);
}

/** Lowercase hex-encode a byte buffer. */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the per-wallet deletion key.
 *
 * @param wallet  Full EVM address. Caller MUST have validated it
 *                with {@link isHexAddress} first — this function
 *                lowercases but does not re-validate.
 * @param hmacKey The server secret (`DIAG_WALLET_HMAC_KEY`). Must be
 *                non-empty; an empty key is rejected so a
 *                misconfigured Worker fails loudly instead of
 *                silently producing weakly-keyed hashes.
 * @returns 64-char lowercase hex string (SHA-256 HMAC digest).
 */
export async function walletHash(
  wallet: string,
  hmacKey: string,
): Promise<string> {
  if (!hmacKey) {
    throw new Error('DIAG_WALLET_HMAC_KEY is not configured');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Lowercase so checksummed and all-lowercase spellings of the same
  // address produce the same hash — a capture-time spelling and an
  // erasure-time spelling must always collide on purpose.
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(wallet.toLowerCase()),
  );
  return toHex(sig);
}
