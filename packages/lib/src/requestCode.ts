/**
 * The short code shown beside every protected-account request (a queued
 * payout or position transfer), so an owner can match an alert, a chat
 * message and the app's pending list to one request.
 *
 * The contract derives it (`VaultPayoutFacet.requestCode(id)`): 30 bits of
 * keccak256(chainId, Diamond, id). This module is the ONE rendering of those
 * bits, so the app, the agent's alerts and the keeper all print the same six
 * characters: base32 (RFC 4648 alphabet), most significant five bits first.
 * A value that is not a 30-bit integer renders as null, never as a code, so a
 * misread cannot print a plausible but wrong code.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Six base32 characters for a 30-bit request code, or null if `code` is
 *  not an integer in [0, 2^30). */
export function formatRequestCode(code: number | bigint): string | null {
  const n = typeof code === 'bigint' ? code : BigInt(Number.isInteger(code) ? code : -1);
  if (n < 0n || n >= 1n << 30n) return null;
  let out = '';
  for (let shift = 25n; shift >= 0n; shift -= 5n) {
    out += ALPHABET[Number((n >> shift) & 31n)];
  }
  return out;
}
