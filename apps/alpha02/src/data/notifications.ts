/**
 * react-query hook for the in-app notification inbox (#1213 / E-11).
 *
 * Follows the indexer loading contract every hook shares:
 *   - `data === undefined` → loading
 *   - `data === null`      → indexer unavailable (bell stays quiet)
 *   - `data === {...}`     → real result (empty list means truly empty)
 *
 * Read/unread is CLIENT-side — this hook only fetches the feed; the
 * unread count is derived in the component from the wallet-scoped
 * last-seen cursor (`lib/notifSeen`). The chain stays authoritative:
 * rows deep-link to Loan Details, which re-verify on chain.
 */
import { useQuery } from '@tanstack/react-query';
import { useActiveChain } from '../chain/useActiveChain';
import {
  fetchNotifications,
  indexerConfigured,
  type IndexedNotification,
} from './indexer';
import { signalAware } from '../chain/railHealth';

const REFRESH_MS = 30_000;

/** How many rows the bell fetches — one page is plenty for a dropdown;
 *  the badge shows `N+` when the newest page is full and still unread. */
export const NOTIF_PAGE = 20;

export interface NotificationsResult {
  notifications: IndexedNotification[];
  /** True when the fetched page was full — there may be older rows the
   *  bell didn't load (the unread count is then a `N+` lower bound). */
  hasMore: boolean;
}

/**
 * The connected wallet's newest inbox page on the active read chain.
 * Disabled (returns a quiet empty result) when no wallet is connected or
 * the indexer origin is unset — the bell is a convenience, never a gate.
 */
export function useNotifications() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['notifications', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && indexerConfigured(),
    // A list root, not tip-critical — push + 30s carry it (RPC read-diet
    // §4.1.2 cadence discipline).
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<NotificationsResult | null> => {
      if (!address) return { notifications: [], hasMore: false };
      const page = await fetchNotifications(readChain.chainId, address, {
        limit: NOTIF_PAGE,
      });
      if (page === null) return null;
      return {
        notifications: page.notifications,
        hasMore: page.nextBefore !== null,
      };
    },
  });
}
