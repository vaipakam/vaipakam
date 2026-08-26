/**
 * RPC read-diet PR D (Alpha02RpcReadDietDesign §4.2.2) — the client
 * half of scoped push hints: decide whether a frame's invalidations
 * may skip the OWN-position roots for this tab.
 *
 * Relevance rule (design §2.2): refetch own roots when
 *   (a) an affected loanId is already one of the wallet's rows, OR
 *   (b) an affected offerId is one of the wallet's offers, OR
 *   (c) a causative link names the wallet — its offer was consumed or
 *       it is a party on the new loan (this is what distinguishes
 *       "counterparty accepted MY offer" — a new, unknown loanId that
 *       is nonetheless mine — from a foreign create; a bare
 *       unknown-id⇒refetch rule would defeat scoping entirely).
 *
 * Narrowing is allowed ONLY on a provably complete picture. Coarse
 * (return roots unchanged) whenever: hints are absent (older worker) or
 * malformed; `truncated !== false`; the wallet is unknown; or either
 * own-id set could not be derived from cache. Degraded never wrong —
 * scoping may only ever REMOVE redundant work, never suppress a
 * refetch the tab needed.
 */

/** The own-position roots scoping may drop from a frame's invalidation
 *  set. Shared/browse roots (activeOffers, desk*, activity, …) and the
 *  id-keyed detail roots stay untouched — their refetch is indexer-HTTP
 *  and active-only, and detail relevance is per-id, not per-wallet. */
export const OWN_SCOPED_ROOTS: ReadonlySet<string> = new Set([
  'myLoans',
  'myOffers',
  'claimables',
  'vaultAssets',
  // The in-app notification feed is `GET /notifications/:addr` — strictly
  // this wallet's rows — so a loan frame that doesn't involve the wallet
  // never adds one and must not refetch it (#1213, Codex #1295 r2). The
  // relevance rule keeps it refetching when the wallet IS a party (own
  // loan id, or a causative link naming the wallet on a fresh loan).
  'notifications',
]);

export interface FrameHints {
  loanIds?: unknown;
  offerIds?: unknown;
  links?: unknown;
  truncated?: unknown;
}

const numArray = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (v as number[])
    : null;

export function scopeInvalidationRoots(opts: {
  roots: string[];
  hints: FrameHints | undefined;
  /** Lowercased connected address; null = disconnected/unknown. */
  address: string | null;
  /** Wallet's cached loan/offer ids; null = underivable → never narrow. */
  myLoanIds: ReadonlySet<number> | null;
  myOfferIds: ReadonlySet<number> | null;
}): string[] {
  const { roots, hints, address, myLoanIds, myOfferIds } = opts;
  if (!hints || hints.truncated !== false) return roots;
  if (!address || !myLoanIds || !myOfferIds) return roots;
  const loanIds = numArray(hints.loanIds);
  const offerIds = numArray(hints.offerIds);
  const links = Array.isArray(hints.links) ? hints.links : null;
  if (!loanIds || !offerIds || !links) return roots; // malformed ⇒ coarse

  const relevant =
    loanIds.some((id) => myLoanIds.has(id)) ||
    offerIds.some((id) => myOfferIds.has(id)) ||
    links.some((l) => {
      if (typeof l !== 'object' || l === null) return true; // malformed ⇒ relevant
      const link = l as Record<string, unknown>;
      if (typeof link.offerId === 'number' && myOfferIds.has(link.offerId)) {
        return true;
      }
      // ANY named party matching the wallet makes the frame ours —
      // covers creator (own offer created elsewhere) and newLender/
      // newBorrower (a position just acquired), whose ids can't be in
      // this tab's cache yet (Codex #1244 r1).
      return Object.values(link).some(
        (v) => typeof v === 'string' && v.toLowerCase() === address,
      );
    });
  if (relevant) return roots;
  return roots.filter((r) => !OWN_SCOPED_ROOTS.has(r));
}
