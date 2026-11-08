/**
 * The loans the index files under one wallet for a set of event kinds
 * (`/activity?actor=…&kind=…`), newest first, walked to its end or to the
 * cap. The index only names candidates: every caller reads each loan from
 * the chain before it states or offers anything, so a loan named here that
 * holds nothing for the wallet is dropped by the chain read, never shown.
 * Throws when the index does not answer, so the surface states that instead
 * of an empty list.
 */
import type { IndexerClient } from './indexerClient';

type Hex = `0x${string}`;

/** How far a discovery walks the wallet's history (pages of 100). */
export const ACTOR_LOANS_MAX_PAGES = 10;

export async function discoverActorLoans(
  indexer: IndexerClient,
  chainId: number,
  actor: Hex,
  kinds: readonly string[],
  maxPages = ACTOR_LOANS_MAX_PAGES,
): Promise<{ loanIds: bigint[]; complete: boolean }> {
  const ids = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ chainId: String(chainId), actor, kind: kinds.join(','), limit: '100' });
    if (before) q.set('before', before);
    const res: { events?: { loanId: number | string | null }[]; nextBefore?: string | null } = await indexer.getJson(`/activity?${q.toString()}`);
    for (const e of res.events ?? []) if (e.loanId !== null && e.loanId !== undefined) ids.add(String(e.loanId));
    if (!res.nextBefore) return { loanIds: [...ids].map((s) => BigInt(s)), complete: true };
    before = res.nextBefore;
  }
  return { loanIds: [...ids].map((s) => BigInt(s)), complete: false };
}
