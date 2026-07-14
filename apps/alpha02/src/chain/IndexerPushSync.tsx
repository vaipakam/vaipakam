/**
 * #757 Phase B — indexer realtime push for alpha02.
 *
 * Opens ONE WebSocket to the indexer's per-chain ingest Durable Object
 * (`GET /ws/chain/:chainId`). After each ingest write the DO pushes a
 * coarse invalidation frame; we map it to react-query invalidations of
 * the INDEXER-FED caches, so everyone else's actions (a new offer on
 * the book, an activity row) reflect within seconds of ingest instead
 * of on the 30–60s poll. Complements LiveChainSync, which watches
 * BLOCKS and keeps the chain-read caches fresh — this channel is the
 * indexer-side counterpart.
 *
 * Same invariants as apps/defi's RealtimePushContext (the proven
 * consumer of this channel):
 *   - ADDITIVE, never load-bearing: frames carry a SIGNAL only; the
 *     refetch goes through the existing REST surface, and the normal
 *     poll keeps running underneath as the backstop. No socket → the
 *     app is exactly as fresh as before this file existed.
 *   - Cheap when idle: bursts coalesce into one debounced pass;
 *     frames arriving in a hidden tab defer to one flush on focus.
 *   - Honest about absence: a reachable channel whose `hello` says
 *     ingest is off closes and retries dormantly — no hammering.
 *
 * Renders nothing; mount once inside the app shell.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useActiveChain } from './useActiveChain';
import { indexerWsOrigin } from '../data/indexer';

/** Server→client frames (mirror of apps/indexer chainIngestDO PushFrame).
 *  The `cursor` heartbeat + the hello `cursor`/`scanCadenceSec` fields land
 *  with RPC read-diet PR 0 (indexer-side); this client tolerates their
 *  absence (older worker) and — until PR A's rail-health helper consumes
 *  them — ignores the heartbeat. Unknown frame kinds are always ignored,
 *  so the two sides can deploy independently. */
type ServerFrame =
  | {
      t: 'hello';
      chainId: number | null;
      ingestActive: boolean;
      cursor?: { lastBlock: number; updatedAt: number } | null;
      scanCadenceSec?: number | null;
    }
  | { t: 'invalidate'; chainId: number; keys: string[]; scannedTo: string }
  | {
      t: 'cursor';
      chainId: number;
      lastBlock: string;
      updatedAt: number;
      scanCadenceSec: number;
    };

/** Coarse DO invalidation key → the react-query key ROOTS it dirties.
 *  Only INDEXER-fed caches belong here — chain-read caches are
 *  LiveChainSync's per-block job, and double-invalidating them would
 *  just burn RPC.
 *
 *  Exported for the unit test (src/chain/pushKeyMap.test.ts): the fork
 *  e2e harness has no WebSocket rail (spec 15 pins that posture), so
 *  the desk-root registrations (#1131 slice A) are pinned here in CI
 *  and observed live on the production WS rail per COVERAGE.md. */
export const KEY_MAP: Record<string, string[]> = {
  // desk* roots (#1131): markets/book/amend-seed are offer-fed views.
  'offer.created': [
    'activeOffers',
    'myOffers',
    'offer',
    'deskMarkets',
    'deskBook',
    'deskAmendSource',
  ],
  'offer.changed': [
    'activeOffers',
    'myOffers',
    'offer',
    'deskMarkets',
    'deskBook',
    'deskAmendSource',
    // Signed-book LIFECYCLE flips (fill / cancel / nonce burn) are
    // on-chain events the ingest scan folds into this same coarse key
    // (chainIndexer.signedOfferUpdates → offer.changed; Codex #1145 r8
    // P3) — without this a WS client keeps showing a cancelled signed
    // row until the 30s poll. Gasless POSTS still can't be pushed
    // (they never touch the chain); their freshness stays the poll +
    // the post path's own targeted invalidation.
    'deskSignedBook',
  ],
  // A fill prints on the tape/candles/history and moves the markets
  // stats. The accept also consumes offer principal, but the indexer
  // counts that as an offer statusUpdate/detailRefresh, so the SAME
  // frame carries 'offer.changed' (chainIngestDO derives both keys
  // from one scan's counts) — deskBook/deskAmendSource ride that key
  // rather than being duplicated here.
  'loan.created': [
    'myLoans',
    'loan',
    'deskTape',
    'deskCandles',
    'deskHistory',
    'deskMarkets',
  ],
  // Loan status transitions (repaid / defaulted / …) restate history rows.
  // RPC read-diet PR 0: this key now ALSO fires on data-only entitlement
  // changes (partial repay/match, the FallbackPending partial-rescue class,
  // collateral top-up, extension, periodic-interest advance) — and it maps
  // onto `vaultAssets`, because loan settlement/interest events are exactly
  // the event class that moves escrow into a party's vault (design §4.1.2:
  // the one existing key that corresponds to a vault-balance change).
  'loan.updated': ['myLoans', 'loan', 'claimables', 'deskHistory', 'vaultAssets'],
  // RPC read-diet PR 0 (design §4.0.1) — a position NFT changed hands
  // (secondary trade, claim-burn, borrower migration). Own-position lists,
  // claimables, and the detail-page owner/role gates are holder-keyed, so
  // an ownership flip must dirty them from the push rail: PR A removes the
  // per-block blanket that today masks this key's absence, and §7(c) of the
  // design verifies this frame arrives live before that demotion ships.
  'ownership.changed': [
    'myLoans',
    'myOffers',
    'claimables',
    'positionOwners',
    'loan',
    'offer',
  ],
  'activity.appended': ['activity'],
  // NOT mapped on purpose: 'deskSymbols' (token metadata is immutable).
};

const NUDGE_DEBOUNCE_MS = 300;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** After this many connects that never went live, treat the channel
 *  as absent on this deployment and retry only occasionally. */
const GIVE_UP_AFTER = 6;
const DORMANT_RETRY_MS = 300_000; // 5 min

export function IndexerPushSync() {
  const { readChain } = useActiveChain();
  const chainId = readChain.chainId;
  const queryClient = useQueryClient();
  const wsOrigin = indexerWsOrigin();

  useEffect(() => {
    if (!wsOrigin || !chainId) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    /** Set when `hello` reports ingest intentionally off — the next
     *  close goes dormant instead of churning the backoff ladder. */
    let intentionalInactive = false;
    /** Frames seen while the tab was hidden — flushed as ONE pass on
     *  focus so a parked tab never drives refetch traffic. */
    let hiddenDirty = new Set<string>();
    let pendingRoots = new Set<string>();

    const flush = () => {
      nudgeTimer = null;
      const roots = [...pendingRoots];
      pendingRoots = new Set();
      for (const root of roots) {
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === root,
          refetchType: 'active',
        });
      }
    };

    const scheduleNudge = (roots: string[]) => {
      if (typeof document !== 'undefined' && document.hidden) {
        for (const r of roots) hiddenDirty.add(r);
        return;
      }
      for (const r of roots) pendingRoots.add(r);
      if (nudgeTimer) return; // coalesce the burst
      nudgeTimer = setTimeout(() => {
        if (!cancelled) flush();
      }, NUDGE_DEBOUNCE_MS);
    };

    const onVisibility = () => {
      if (cancelled || document.hidden || hiddenDirty.size === 0) return;
      const roots = [...hiddenDirty];
      hiddenDirty = new Set();
      scheduleNudge(roots);
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      const dormant = intentionalInactive || attempt >= GIVE_UP_AFTER;
      intentionalInactive = false; // consumed
      const delay = dormant
        ? DORMANT_RETRY_MS
        : Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      attempt += 1;
      let socket: WebSocket;
      try {
        socket = new WebSocket(`${wsOrigin}/ws/chain/${chainId}`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.onmessage = (ev) => {
        if (cancelled) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(ev.data)) as ServerFrame;
        } catch {
          return; // ignore malformed frames
        }
        if (frame.t === 'hello') {
          if (frame.ingestActive) {
            attempt = 0; // healthy channel — reset backoff
          } else {
            // Reachable but ingest is off — no pushes will come; close
            // and retry dormantly (the operator may enable it later).
            intentionalInactive = true;
            try {
              socket.close(1000);
            } catch {
              /* already closing */
            }
          }
        } else if (frame.t === 'invalidate') {
          const roots = frame.keys.flatMap((k) => KEY_MAP[k] ?? []);
          if (roots.length > 0) scheduleNudge(roots);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        ws = null;
        scheduleReconnect();
      };
      socket.onerror = () => {
        // `onclose` always follows `onerror` — let it drive the retry.
      };
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close(1000);
        } catch {
          /* already closing */
        }
      }
    };
  }, [wsOrigin, chainId, queryClient]);

  return null;
}
