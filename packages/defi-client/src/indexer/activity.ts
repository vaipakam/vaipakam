import type { ActivityFilters, ActivityPage, IndexedActivityEvent } from '../types/activity.js';
import { fetchOffersByCreator } from './offers.js';
import { fetchLoansByBorrower, fetchLoansByLender } from './loans.js';
import { fetchIndexerJson } from './client.js';

export async function fetchActivity(
  indexerOrigin: string | undefined,
  chainId: number,
  filters: ActivityFilters = {},
): Promise<ActivityPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (filters.actor) params.set('actor', filters.actor.toLowerCase());
  if (filters.loanId !== undefined) params.set('loanId', String(filters.loanId));
  if (filters.offerId !== undefined) params.set('offerId', String(filters.offerId));
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.before) params.set('before', filters.before);
  return fetchIndexerJson<ActivityPage>(indexerOrigin, `/activity?${params}`);
}

function activityKey(event: IndexedActivityEvent): string {
  return `${event.blockNumber}:${event.logIndex}`;
}

function mergeActivityEvents(...lists: IndexedActivityEvent[][]): IndexedActivityEvent[] {
  const byKey = new Map<string, IndexedActivityEvent>();
  for (const list of lists) {
    for (const event of list) {
      byKey.set(activityKey(event), event);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });
}

/**
 * Wallet activity feed: actor-scoped rows plus loan/offer timelines where the
 * wallet is a participant but not the indexed actor (e.g. lender on OfferAccepted).
 */
export async function fetchWalletActivity(
  indexerOrigin: string | undefined,
  chainId: number,
  wallet: string,
  filters: ActivityFilters = {},
): Promise<ActivityPage | null> {
  const normalized = wallet.toLowerCase();
  const limit = filters.limit ?? 25;

  const actorPage = await fetchActivity(indexerOrigin, chainId, {
    ...filters,
    actor: normalized,
    limit,
  });
  if (!actorPage) return null;

  // Pagination continues on the actor cursor only; participant enrichment runs once.
  if (filters.before) return actorPage;

  const [lenderLoans, borrowerLoans, creatorOffers] = await Promise.all([
    fetchLoansByLender(indexerOrigin, chainId, normalized, { limit: 50 }),
    fetchLoansByBorrower(indexerOrigin, chainId, normalized, { limit: 50 }),
    fetchOffersByCreator(indexerOrigin, chainId, normalized, { limit: 50 }),
  ]);

  const loanIds = new Set<number>();
  for (const loan of lenderLoans?.loans ?? []) loanIds.add(loan.loanId);
  for (const loan of borrowerLoans?.loans ?? []) loanIds.add(loan.loanId);
  const offerIds = new Set((creatorOffers?.offers ?? []).map((o) => o.offerId));

  const timelinePages = await Promise.all([
    ...[...loanIds].slice(0, 25).map((loanId) =>
      fetchActivity(indexerOrigin, chainId, { loanId, limit: 15 }),
    ),
    ...[...offerIds].slice(0, 25).map((offerId) =>
      fetchActivity(indexerOrigin, chainId, { offerId, limit: 15 }),
    ),
  ]);

  const participantEvents = timelinePages.flatMap((page) => page?.events ?? []);
  const events = mergeActivityEvents(actorPage.events, participantEvents).slice(0, limit);

  return { ...actorPage, events };
}