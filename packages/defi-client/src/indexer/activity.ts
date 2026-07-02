import type { ActivityFilters, ActivityPage, IndexedActivityEvent } from '../types/activity.js';
import {
  fetchOffersByCreator,
  fetchOffersByCurrentHolder,
} from './offers.js';
import {
  fetchLoansByBorrower,
  fetchLoansByCurrentHolder,
  fetchLoansByLender,
} from './loans.js';
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

/** Keep every actor row; fill remaining slots with participant-only events. */
export function mergeWalletActivityEvents(
  actorEvents: IndexedActivityEvent[],
  participantEvents: IndexedActivityEvent[],
  limit: number,
): IndexedActivityEvent[] {
  const actorKeys = new Set(actorEvents.map(activityKey));
  const participantOnly = participantEvents.filter((event) => !actorKeys.has(activityKey(event)));
  const sortedExtras = mergeActivityEvents(participantOnly);

  // Reserve slots for participant-only rows so a full actor page does not hide them.
  const participantReserve =
    sortedExtras.length > 0
      ? Math.min(Math.max(1, Math.floor(limit / 4)), sortedExtras.length, Math.max(0, limit - 1))
      : 0;
  const actorBudget = Math.max(1, limit - participantReserve);
  const actorSlice =
    actorEvents.length > actorBudget ? actorEvents.slice(0, actorBudget) : actorEvents;
  const room = limit - actorSlice.length;
  return mergeActivityEvents(actorSlice, sortedExtras.slice(0, room));
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

  const [lenderLoans, borrowerLoans, holderLoans, creatorOffers, holderOffers] =
    await Promise.all([
      fetchLoansByLender(indexerOrigin, chainId, normalized, { limit: 50 }),
      fetchLoansByBorrower(indexerOrigin, chainId, normalized, { limit: 50 }),
      fetchLoansByCurrentHolder(indexerOrigin, chainId, normalized, { limit: 50 }),
      fetchOffersByCreator(indexerOrigin, chainId, normalized, { limit: 50 }),
      fetchOffersByCurrentHolder(indexerOrigin, chainId, normalized, { limit: 50 }),
    ]);

  const loanIds = new Set<number>();
  for (const loan of lenderLoans?.loans ?? []) loanIds.add(loan.loanId);
  for (const loan of borrowerLoans?.loans ?? []) loanIds.add(loan.loanId);
  for (const loan of holderLoans?.loans ?? []) loanIds.add(loan.loanId);

  const offerIds = new Set<number>();
  for (const offer of creatorOffers?.offers ?? []) offerIds.add(offer.offerId);
  for (const offer of holderOffers?.offers ?? []) offerIds.add(offer.offerId);

  const timelinePages = await Promise.all([
    ...[...loanIds].slice(0, 25).map((loanId) =>
      fetchActivity(indexerOrigin, chainId, { loanId, limit: 15 }),
    ),
    ...[...offerIds].slice(0, 25).map((offerId) =>
      fetchActivity(indexerOrigin, chainId, { offerId, limit: 15 }),
    ),
  ]);

  const participantEvents = timelinePages.flatMap((page) => page?.events ?? []);
  const events = mergeWalletActivityEvents(actorPage.events, participantEvents, limit);

  return { ...actorPage, events };
}