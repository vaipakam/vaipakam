/**
 * Centralized own-receipt invalidation — the rail that carries the
 * "your own transaction reflects within a block" contract once the
 * per-block blanket stands down (RPC read-diet PR A, design §4.1.4).
 *
 * Three jobs, all ADDITIVE to the flows' existing surface-specific
 * invalidations (never a replacement):
 *
 *  1. FLOOR — after any confirmed write, invalidate the standard
 *     post-receipt set (own positions, claimables, vault, rewards/
 *     VPFI, approvals, activity, book) so no future flow can forget
 *     the roots every money movement touches. `claimInteractionRewards`
 *     and the VPFI vault actions are Diamond writes whose roots §4.1.2
 *     moves off the block-driven set, and ERC-20 approve/revoke goes
 *     through the token helpers — all of them land here.
 *
 *  2. CROSS-TAB BROADCAST — publish the invalidated roots on a
 *     BroadcastChannel (localStorage ping fallback) so every open tab
 *     of this origin applies the same invalidation the acting tab
 *     does. A submit from a second tab then still lands "within a
 *     block" in this one, with zero extra RPC (§4.1.4 rule 2).
 *
 *  3. SECOND RE-READ — a single invalidation right after
 *     `waitForTransactionReceipt` can refetch PRE-tx state from a
 *     public RPC that still serves the parent block. Schedule one
 *     delayed re-invalidation ~2× block time after the receipt so a
 *     lagging read reconciles without waiting out the 180s net. One
 *     shot, never a poll.
 */
import type { QueryClient } from '@tanstack/react-query';
import { bumpClaimVerdictEpoch } from '../data/claimVerdictCache';

/** Every root a confirmed own-write may have moved. Kept coarse on
 *  purpose: these refetch `refetchType: 'active'` only, so the cost is
 *  bounded to the queries actually mounted on the current page. */
export const RECEIPT_FLOOR_ROOTS: readonly string[] = [
  'myLoans',
  'myOffers',
  'activeOffers',
  'claimables',
  'vaultAssets',
  'tokenBalance',
  'standingApprovals',
  'vpfi',
  'interactionRewards',
  'activity',
  // Activity's participation-id leg (#1023): an own accept/initiate
  // seeds loan_participants, and the feed the receipt refreshes
  // filters against this set — refreshing one without the other lets
  // the new loan's actor-null companions slip the filter.
  'activityParticipantIds',
  'loan',
  'offer',
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
  // Codex #1228 r1 — desk views: the flows' surface-specific desk
  // invalidations are LOCAL to the acting tab, so the cross-tab floor
  // must carry them or a second tab on Rate Desk misses an own fill
  // when the push rail is down. Cheap: indexer HTTP, active-only.
  'deskBook',
  'deskMarkets',
  'deskTape',
  'deskCandles',
  'deskHistory',
  'deskSignedBook',
  'deskAmendSource',
  // Codex #1228 r1 — the split ghost-strip no longer re-runs with each
  // activeOffers refetch (it keys on the cursor snapshot), so an
  // offer-ending own receipt must force the scan explicitly or the
  // just-ended row outlives the receipt refresh on the book.
  'bookGhostStrip',
  // Codex #1228 r2 — keeper permissions moved to signalAware, and the
  // settings/loan cards only invalidate the acting tab; the floor
  // carries them so a second Settings tab sees a confirmed toggle.
  'keeperConfig',
  'loanKeeperEnabled',
  // Codex #1228 r3 — the crossable band's post-write invalidation in
  // MatchBand is local to the acting tab; an own fill must refresh the
  // action gate in a second tab together with the book.
  'deskPreviewMatch',
  // Codex #1228 r3 — the pending-card funding watches read the live
  // allowance/balance; a re-approve/revoke in one tab must refresh the
  // green/red funding verdict a second tab is showing.
  'loanSalePending',
  'refinancePending',
];

/** Roots whose writes PATCH the cache with the mined value instead of
 *  refetching (public RPCs serve pre-tx state for seconds — the
 *  LiveChainSync exclusion doctrine). The ACTING tab must not
 *  invalidate these right after its own receipt or the refetch races
 *  the patch and bounces the checkbox (Codex #1228 r2). Other tabs
 *  hold no patch, so the broadcast still carries them — a receiving
 *  tab's 5s second re-read reconciles any RPC lag. */
export const PATCHED_ROOTS: ReadonlySet<string> = new Set([
  'vpfi',
  'loanKeeperEnabled',
]);

/** ~2× Base/OP block time. The second re-read exists for public RPCs
 *  that serve the parent block for a few seconds after the receipt —
 *  by two block times the read layer has caught up everywhere we've
 *  measured (#RPC-diet live notes). */
const SECOND_READ_DELAY_MS = 5_000;

const CHANNEL_NAME = 'vaipakam-receipt-sync-v1';
const STORAGE_PING_KEY = 'vaipakam-receipt-sync-ping-v1';

interface ReceiptFrame {
  roots: string[];
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function invalidateRoots(queryClient: QueryClient, roots: readonly string[]) {
  const set = new Set(roots);
  void queryClient.invalidateQueries({
    refetchType: 'active',
    predicate: (q) => typeof q.queryKey[0] === 'string' && set.has(q.queryKey[0]),
  });
}

/**
 * Invalidate `roots` here AND in every other tab of this origin, then
 * schedule the one-shot second re-read locally. Call AFTER the receipt
 * confirms success. Flows keep their own surface-specific
 * invalidations on top — the union is what the acting tab sees, and
 * the broadcast carries the same union when the caller routes its
 * extra roots through `extraRoots`.
 */
export function publishReceiptInvalidation(
  queryClient: QueryClient,
  extraRoots: readonly string[] = [],
): void {
  const roots = [...new Set([...RECEIPT_FLOOR_ROOTS, ...extraRoots])];
  // RPC read-diet PR C (§4.2.3): an own write may have claimed/burned/
  // moved a position NFT — every memoized claim verdict is suspect, so
  // clear the memo before the claimables refetch this floor triggers.
  bumpClaimVerdictEpoch();
  // Acting tab, IMMEDIATE pass: skip the patched roots — their flows
  // may have just written the mined value into the cache, and an
  // immediate refetch from a lagging RPC would overwrite it (Codex
  // #1228 r2). The DELAYED pass includes them (Codex #1228 r3): not
  // every write to these roots patches (VPFI vault deposit/withdraw
  // only invalidates), and by ~2 block times the read layer serves
  // post-tx state — so the re-read reconciles the unpatched flows
  // without racing a fresh patch.
  const immediateRoots = roots.filter((r) => !PATCHED_ROOTS.has(r));
  invalidateRoots(queryClient, immediateRoots);
  setTimeout(() => invalidateRoots(queryClient, roots), SECOND_READ_DELAY_MS);

  const frame: ReceiptFrame = { roots };
  const ch = getChannel();
  if (ch) {
    try {
      ch.postMessage(frame);
      return; // delivered — the storage ping would double-deliver
    } catch {
      /* channel closed — fall through to the storage ping */
    }
  }
  // Fallback ONLY when BroadcastChannel is unavailable/failed: tabs of
  // the same browser share BC support, so writing both would hand
  // every receiver two immediate invalidations + two delayed re-reads
  // per receipt (Codex #1228 r2).
  try {
    // Storage events fire only in OTHER tabs; the value must change
    // each time or repeat writes are swallowed.
    localStorage.setItem(
      STORAGE_PING_KEY,
      JSON.stringify({ ...frame, at: Date.now() }),
    );
  } catch {
    /* storage unavailable (private mode) — nothing else to try */
  }
}

/** The shared QueryClient, registered by the app-shell listener so
 *  plain async helpers with no hook context (the ERC-20 approval
 *  helpers) can publish through the same rail. */
let sharedClient: QueryClient | null = null;

/**
 * For non-hook write helpers (ERC-20 approve/revoke, Permit2 setup):
 * publish through the registered shared QueryClient. No-op before the
 * shell mounts — every real approval happens long after.
 */
export function publishReceiptInvalidationGlobal(
  extraRoots: readonly string[] = [],
): void {
  if (sharedClient) publishReceiptInvalidation(sharedClient, extraRoots);
}

/**
 * Receiver side — call once from the app shell with the shared
 * QueryClient. Applies invalidations published by OTHER tabs
 * (BroadcastChannel messages self-exclude the sender; storage events
 * only ever fire cross-tab). The second re-read runs here too: this
 * tab's RPC lag is independent of the acting tab's.
 */
export function listenForReceiptInvalidations(
  queryClient: QueryClient,
): () => void {
  sharedClient = queryClient;
  const apply = (frame: ReceiptFrame | null) => {
    if (!frame || !Array.isArray(frame.roots)) return;
    const roots = frame.roots.filter((r): r is string => typeof r === 'string');
    if (roots.length === 0) return;
    // Same PR C memo clear as the acting tab: the broadcast means an
    // own write confirmed somewhere on this origin.
    bumpClaimVerdictEpoch();
    invalidateRoots(queryClient, roots);
    setTimeout(() => invalidateRoots(queryClient, roots), SECOND_READ_DELAY_MS);
  };

  const ch = getChannel();
  const onMessage = (ev: MessageEvent) => apply(ev.data as ReceiptFrame | null);
  ch?.addEventListener('message', onMessage);

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== STORAGE_PING_KEY || !ev.newValue) return;
    try {
      apply(JSON.parse(ev.newValue) as ReceiptFrame);
    } catch {
      /* malformed ping — ignore */
    }
  };
  window.addEventListener('storage', onStorage);

  return () => {
    ch?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
  };
}
