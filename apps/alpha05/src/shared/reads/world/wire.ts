/**
 * Whole numbers as the index sends them: a safe JSON integer or a decimal
 * string. Anything else throws, so a malformed row is refused by the reader
 * that called these and counted as unread, never shown as zero.
 */

/** A whole number small enough for a JavaScript number (ids, seconds). */
export function wireWhole(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  throw new Error('not a whole number');
}

/** A whole number of any size (amounts, rates, ids). */
export function wireBig(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error('not a whole number');
}
