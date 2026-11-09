/**
 * #3205 — `ProtectedAccountFacet.getProtectedAccount`, as consumers index it.
 *
 * #3318 retired protected mode's NFT queue and renamed its two struct fields
 * in place (`protectNfts` → `retiredProtectNfts`, `pendingNftOffAt` →
 * `retiredPendingNftOffAt`), so the generated ABI decodes them under the new
 * names. A pre-#3205 Diamond still sets them; a standalone one never does
 * (they read false / 0). Every reader passes the decoded record through
 * {@link protectedAccountFromView} ONCE, at the point it is read, and indexes
 * the old names, so a consumer can never read `undefined` for them (#3318
 * Codex r2: a keeper `BigInt(undefined)` aborted its whole pass).
 *
 * TODO(#3321 positionNft-legacy-removal): once every chain is standalone the
 * two fields carry nothing; drop them from consumers with the legacy mode.
 */

/** The two fields under the names consumers use. */
export interface ProtectedAccountNftFields {
  protectNfts: boolean;
  pendingNftOffAt: bigint;
}

/** `raw` with the two NFT-queue fields under their consumer names. Accepts
 *  either decoding (new `retired*` names or the old ones). Other fields are
 *  passed through unchanged. */
export function protectedAccountFromView<T extends object>(
  raw: T,
): Omit<T, 'retiredProtectNfts' | 'retiredPendingNftOffAt'> & ProtectedAccountNftFields {
  const r = raw as Record<string, unknown>;
  const { retiredProtectNfts, retiredPendingNftOffAt, ...rest } = r;
  const protectNfts = 'retiredProtectNfts' in r ? retiredProtectNfts : r.protectNfts;
  const pending = 'retiredPendingNftOffAt' in r ? retiredPendingNftOffAt : r.pendingNftOffAt;
  return {
    ...(rest as Omit<T, 'retiredProtectNfts' | 'retiredPendingNftOffAt'>),
    protectNfts: Boolean(protectNfts),
    pendingNftOffAt: BigInt((pending as bigint | number | string | undefined) ?? 0),
  };
}
