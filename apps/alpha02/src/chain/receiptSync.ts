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
  'loan',
  'offer',
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
];

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
  invalidateRoots(queryClient, roots);
  setTimeout(() => invalidateRoots(queryClient, roots), SECOND_READ_DELAY_MS);

  const frame: ReceiptFrame = { roots };
  const ch = getChannel();
  if (ch) {
    try {
      ch.postMessage(frame);
    } catch {
      /* channel closed — the storage ping below still lands */
    }
  }
  try {
    // Storage events fire only in OTHER tabs; the value must change
    // each time or repeat writes are swallowed.
    localStorage.setItem(
      STORAGE_PING_KEY,
      JSON.stringify({ ...frame, at: Date.now() }),
    );
  } catch {
    /* storage unavailable (private mode) — broadcast channel covered it */
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
