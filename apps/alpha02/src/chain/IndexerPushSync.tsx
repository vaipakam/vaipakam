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
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useActiveChain } from './useActiveChain';
import { indexerWsOrigin } from '../data/indexer';
import {
  isRailHealthy,
  railCursorSignal,
  railSocketLive,
  subscribeRailHealth,
} from './railHealth';
import { PATCHED_ROOTS } from './receiptSync';
import { bumpClaimVerdictEpoch } from '../data/claimVerdictCache';
import {
  scopeInvalidationRoots,
  type FrameHints,
} from './pushHintScope';

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
  | {
      t: 'invalidate';
      chainId: number;
      keys: string[];
      scannedTo: string;
      /** RPC read-diet PR D — bounded affected-id hints; absent on
       *  older workers. Absent-or-truncated ⇒ coarse (never narrow). */
      hints?: FrameHints;
    }
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
    // A new loan seeds loan_participants — Activity's participation
    // filter (#1023) reads that set, and its poll is signal-stretched,
    // so the push rail must dirty it or the feed filters with a stale
    // id set until net/focus (Codex #1287 r1).
    'activityParticipantIds',
    'deskMarkets',
    // A fill moves the maker's vault free/locked balances, and on a
    // signed-offer fill the TAKER executes — the maker's tabs see no
    // own receipt, so without this the maker's Vault page waits out
    // the 180s net (Codex #1228 r4).
    'vaultAssets',
    // A LoanInitiated materializes a `loan_matched` inbox row for both
    // parties (#1213); the bell's feed is signal-stretched, so the push
    // rail must dirty it or the unread badge lags to the 180s net
    // (Codex #1295 r1).
    'notifications',
  ],
  // Loan status transitions (repaid / defaulted / …) restate history rows.
  // RPC read-diet PR 0: this key now ALSO fires on data-only entitlement
  // changes (partial repay/match, the FallbackPending partial-rescue class,
  // collateral top-up, extension, periodic-interest advance) — and it maps
  // onto `vaultAssets`, because loan settlement/interest events are exactly
  // the event class that moves escrow into a party's vault (design §4.1.2:
  // the one existing key that corresponds to a vault-balance change).
  // 'notifications' (#1213): repaid / defaulted / partial / swap-to-repay /
  // preclose / offset / refinance / internal-match all materialize inbox
  // rows and land as loan.updated — the bell must refetch or its badge lags.
  'loan.updated': [
    'myLoans',
    'loan',
    'claimables',
    'deskHistory',
    'vaultAssets',
    'notifications',
  ],
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
    // A secondary transfer also appends the recipient to
    // loan_participants, which useDeskHistory reads — and LiveChainSync
    // does not cover deskHistory, so without this a user acquiring a
    // position with the History tab open would see it stale until
    // focus/net (Codex #1227 r1).
    'deskHistory',
    // The same append feeds Activity's participation filter (#1023) —
    // a transferee whose Activity tab is open must learn the new loan
    // id or later actor-null events on it are filtered out
    // (Codex #1287 r1).
    'activityParticipantIds',
    // A one-sided claim (LenderFundsClaimed/BorrowerFundsClaimed) moves
    // funds into the claimant's vault and BURNS that side's position NFT
    // — the burn is what this key surfaces, while loan.updated only
    // follows when the claim also closes the loan (LoanSettled). Without
    // vaultAssets here, a second tab watching Vault keeps the pre-claim
    // balance after a one-sided claim once the block blanket is removed
    // (Codex #1227 r2).
    'vaultAssets',
  ],
  // #1213 PR 2 (Codex #1298 r3) — a calendar reminder row (maturity
  // T-7d / T-1d, grace entered) minted by the indexer's TIME-driven
  // sweep. It has no on-chain log, so NO other key fires on the tick
  // that mints it (especially the quiet caught-up path) — without this
  // mapping the bell waits out the 180 s poll. The reminded loan ids
  // ride the frame's hints, so own-scoped relevance dropping still
  // applies (notifications is in OWN_SCOPED_ROOTS).
  'notification.created': ['notifications'],
  'activity.appended': ['activity'],
  // NOT mapped on purpose: 'deskSymbols' (token metadata is immutable).
};

/** RPC read-diet PR A (design §4.1.1) — every root whose interval
 *  `signalAware()` stretches to the 180s net while the push rail is
 *  healthy. The explicit focus refetch below re-reads exactly this set
 *  when a hidden tab returns: `refetchOnWindowFocus` is globally off
 *  and `idleAware` alone never refetches on return, so without this a
 *  user coming back after a missed/lost frame would wait out the net.
 *  Exported for the unit test alongside KEY_MAP. */
export const STRETCHED_ROOTS: readonly string[] = [
  // signalAware roots (indexer-rail gated).
  'activeOffers',
  'myOffers',
  'myLoans',
  'claimables',
  'activity',
  // Activity's participation-id leg (#1023) — signalAware like the
  // feed itself; the focus refetch must re-read it with the feed or a
  // returning tab filters fresh events against a stale id set.
  'activityParticipantIds',
  'vaultAssets',
  // The in-app notification feed (#1213) — signalAware like the lists
  // above; a returning tab's focus refetch must re-read it or the unread
  // badge lags a frame missed while hidden.
  'notifications',
  'vpfi',
  'interactionRewards',
  'standingApprovals',
  'keeperConfig',
  'loanKeeperEnabled',
  // deskMarkets/deskBook/deskSignedBook stay on today's cadence
  // (time-based GTT expiry + gasless signed posts have no push
  // source; Codex #1228 r1) and so are NOT stretched or listed here.
  'deskTape',
  'deskCandles',
  'deskHistory',
  'deskAmendSource',
  // tipAware roots (indexer rail + chain WS gated) — refetched here on
  // focus too; they mount only on their detail/desk surfaces, so the
  // `refetchType: 'active'` predicate keeps the cost page-bounded.
  'offer',
  'loan',
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
  'offerLinkedLoan',
  'loanSalePending',
  'refinancePending',
  'deskPreviewMatch',
  'graceBannerTerms',
  // The strip query re-runs on invalidation even when its cursor-
  // snapshot key is unchanged — a hidden tab missed its block nudges,
  // so the return path must force one scan or a ghost row can outlive
  // the focus refetch of activeOffers (Codex #1228 r3).
  'bookGhostStrip',
];

const NUDGE_DEBOUNCE_MS = 300;
/** RPC read-diet PR A (design §4.1.6) — per-root minimum gap between
 *  push-driven refetches, leading AND trailing: the first frame in a
 *  burst fires immediately; frames landing inside the gap coalesce
 *  into ONE trailing refetch at the gap's end so the last event is
 *  always read (a leading-only gap would fetch the first frame's D1
 *  state and silently drop the rest of the burst). */
const ROOT_MIN_GAP_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** After this many connects that never went live, treat the channel
 *  as absent on this deployment and retry only occasionally. */
const GIVE_UP_AFTER = 6;
const DORMANT_RETRY_MS = 300_000; // 5 min


/** PR D — derive the wallet's own loan/offer id set from the react-query
 *  cache, DEFENSIVELY: any surprise (no cached entry, unavailable rows,
 *  non-array data, a non-numeric id) returns null, which the scoping
 *  rule treats as "unknown ⇒ never narrow". The cache is the right
 *  source: it is exactly what the user is currently shown, so a frame
 *  touching an id NOT in it cannot make the visible lists staler than
 *  they already are — and creations that ARE ours arrive with causative
 *  links (offerId/party) that the rule checks independently. */
function cachedIdSet(
  queryClient: QueryClient,
  root: 'myLoans' | 'myOffers',
  chainId: number,
  address: string | null | undefined,
  idField: 'loanId' | 'offerId',
): ReadonlySet<number> | null {
  if (!address) return null;
  const entries = queryClient.getQueriesData({
    queryKey: [root, chainId, address.toLowerCase()],
  });
  if (entries.length === 0) return null;
  const out = new Set<number>();
  for (const [, data] of entries) {
    // The full hooks cache a MyRows envelope ({ rows, ... }); accept a
    // bare array too so a cache-shape change degrades to coarse rather
    // than silently never narrowing (Codex #1244 r1).
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { rows?: unknown } | null)?.rows)
        ? (data as { rows: unknown[] }).rows
        : null;
    if (!rows) return null;
    for (const row of rows) {
      const id = (row as Record<string, unknown> | null)?.[idField];
      if (typeof id !== 'number') return null;
      out.add(id);
    }
  }
  return out;
}

export function IndexerPushSync() {
  const { readChain, address } = useActiveChain();
  // PR D: the socket effect deliberately does NOT depend on `address`
  // (an account switch must not tear the rail down), so the frame
  // handler reads the CURRENT address through a ref — a closure-captured
  // value would go stale after a switch and scope against the old
  // wallet's identity/cache, wrongly suppressing the new wallet's
  // refetches.
  const addressRef = useRef<string | null>(null);
  addressRef.current = address?.toLowerCase() ?? null;
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
    /** Per-root leading+trailing throttle state (§4.1.6): when the
     *  root last actually refetched, and whether frames landed inside
     *  the gap (→ one trailing refetch at the gap's end). */
    const rootLastAt = new Map<string, number>();
    const rootTrailing = new Map<string, ReturnType<typeof setTimeout>>();

    const flush = () => {
      nudgeTimer = null;
      const roots = [...pendingRoots];
      pendingRoots = new Set();
      const now = Date.now();
      for (const root of roots) {
        rootLastAt.set(root, now);
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === root,
          refetchType: 'active',
        });
      }
    };

    /** Queue a root for the debounced flush NOW (no per-root gap check
     *  — callers decide). */
    const queueNow = (roots: string[]) => {
      for (const r of roots) pendingRoots.add(r);
      if (nudgeTimer || pendingRoots.size === 0) return;
      nudgeTimer = setTimeout(() => {
        if (!cancelled) flush();
      }, NUDGE_DEBOUNCE_MS);
    };

    const scheduleNudge = (roots: string[]) => {
      if (typeof document !== 'undefined' && document.hidden) {
        for (const r of roots) hiddenDirty.add(r);
        return;
      }
      const now = Date.now();
      const ready: string[] = [];
      for (const r of roots) {
        const since = now - (rootLastAt.get(r) ?? 0);
        if (since >= ROOT_MIN_GAP_MS) {
          ready.push(r); // leading edge — fire on the debounce tick
        } else if (!rootTrailing.has(r)) {
          // Inside the gap: exactly one trailing refetch at gap end so
          // the burst's LAST event is always read (leading-only would
          // drop it until focus/net — Codex #1224).
          rootTrailing.set(
            r,
            setTimeout(() => {
              rootTrailing.delete(r);
              if (cancelled) return;
              // The tab may have gone hidden while the trailing timer
              // was armed — defer to the focus flush like any other
              // hidden-tab frame (Codex #1228 r2 P3).
              if (typeof document !== 'undefined' && document.hidden) {
                hiddenDirty.add(r);
                return;
              }
              queueNow([r]);
            }, ROOT_MIN_GAP_MS - since),
          );
        }
        // else: a trailing refetch is already queued — coalesce.
      }
      if (ready.length > 0) queueNow(ready);
    };

    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      // 1. Flush frames that arrived while hidden (through the
      //    throttle — a parked tab's backlog is not urgent).
      if (hiddenDirty.size > 0) {
        const roots = [...hiddenDirty];
        hiddenDirty = new Set();
        scheduleNudge(roots);
      }
      // 2. RPC read-diet PR A (§4.1.1) — the explicit focus refetch.
      //    While the rail is healthy the stretched roots poll at the
      //    180s net, refetchOnWindowFocus is globally off, and a frame
      //    lost while hidden left no hiddenDirty entry — so a
      //    returning tab re-reads the stretched set immediately,
      //    bypassing the per-root gap (tab returns are user-paced and
      //    rare; staleness here is what the user actually sees).
      if (isRailHealthy()) {
        // Patched roots stay out of the focus pass (Codex #1228 r5):
        // a wallet flow backgrounds the tab and returns right after
        // the receipt, and a lagging RPC refetch here would overwrite
        // the just-patched consent/keeper value. The idle-RESUME path
        // still reconciles them after >=2 min without interaction.
        queueNow(STRETCHED_ROOTS.filter((r) => !PATCHED_ROOTS.has(r)));
      }
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
            // RPC read-diet PR A — seed rail health from the hello's
            // cursor metadata (PR 0). Missing fields (older worker)
            // feed nulls, which the store treats as "unknown" → the
            // polling posture stands (fail-safe by design).
            railSocketLive(true);
            railCursorSignal(
              frame.cursor?.updatedAt ?? null,
              frame.scanCadenceSec ?? null,
            );
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
          // RPC read-diet PR C (§4.2.3): a position NFT changed hands
          // somewhere — any memoized claim verdict may now be wrong
          // even though its identity fields are unchanged (the
          // ownerOf probe is what this frame invalidates). Clear the
          // memo BEFORE the nudge so the resulting claimables refetch
          // re-probes instead of serving the stale verdicts back.
          if (frame.keys.includes('ownership.changed')) {
            bumpClaimVerdictEpoch();
          }
          // PR D (§4.2.2): drop the OWN-position roots when the frame
          // carries a COMPLETE hint that provably doesn't involve this
          // wallet. Own-id sets come from the react-query cache; any
          // doubt (no cache, malformed rows, truncated hint, older
          // worker) keeps the full coarse set — narrowing only ever
          // removes redundant work, never a needed refetch.
          const roots = scopeInvalidationRoots({
            roots: frame.keys.flatMap((k) => KEY_MAP[k] ?? []),
            hints: frame.hints,
            address: addressRef.current,
            myLoanIds: cachedIdSet(queryClient, 'myLoans', chainId, addressRef.current, 'loanId'),
            myOfferIds: cachedIdSet(queryClient, 'myOffers', chainId, addressRef.current, 'offerId'),
          });
          if (roots.length > 0) scheduleNudge(roots);
        } else if (frame.t === 'cursor') {
          // RPC read-diet PR A — the per-scan heartbeat (PR 0). The
          // store judges advancement by the PERSISTED updatedAt moving
          // across frames, so a wedged safe head (heartbeats flowing,
          // stamp frozen) demotes to polling on its own.
          railCursorSignal(frame.updatedAt, frame.scanCadenceSec);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        ws = null;
        railSocketLive(false); // stretched intervals fall back to 30s
        scheduleReconnect();
      };
      socket.onerror = () => {
        // `onclose` always follows `onerror` — let it drive the retry.
      };
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    // RPC read-diet PR A (Codex #1228 r1 P1) — a query that already
    // scheduled its 180s net keeps that timer until its NEXT fetch
    // (TanStack re-evaluates function intervals post-fetch), so a rail
    // drop alone would leave stretched roots stale for up to 3 min.
    // On the healthy-to-down transition, run one catch-up pass over
    // the stretched set: it refreshes the data AND reschedules every
    // interval at the restored 30s cadence. (Hidden tabs defer to the
    // focus flush - a parked tab needs no urgent catch-up.)
    const unsubRail = subscribeRailHealth(() => {
      if (cancelled || isRailHealthy()) return;
      // PR C (§4.2.3): a rail drop means ownership.changed frames may
      // have been missed — every memoized claim verdict recorded
      // before the drop is suspect, including for reuse AFTER a later
      // recovery (Codex #1232 r1). The claimables consumer also stops
      // READING the memo while the rail is down; this bump covers the
      // across-the-outage window.
      bumpClaimVerdictEpoch();
      const roots = STRETCHED_ROOTS.filter((r) => !PATCHED_ROOTS.has(r));
      if (typeof document !== 'undefined' && document.hidden) {
        for (const r of roots) hiddenDirty.add(r);
        return;
      }
      queueNow(roots);
    });

    return () => {
      cancelled = true;
      unsubRail();
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      for (const t of rootTrailing.values()) clearTimeout(t);
      rootTrailing.clear();
      // Deliberate teardown (chain switch / remount) drops the rail
      // AFTER unsubRail above, so the health subscriber's drop-bump
      // never sees this transition — bump explicitly, or verdicts
      // recorded before the switch stay readable when the user
      // returns within the TTL, missing every ownership.changed frame
      // from the away window (Codex #1232 r3).
      bumpClaimVerdictEpoch();
      railSocketLive(false); // chain switch / unmount — re-prove health
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
