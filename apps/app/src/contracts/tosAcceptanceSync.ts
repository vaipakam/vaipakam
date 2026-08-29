/**
 * Cross-tab Terms-acceptance sync (#2001).
 *
 * `LegalFacet.acceptTerms` allows re-acceptance — a second call is
 * valid, mines, and buys nothing but a newer timestamp. PR #1997
 * stopped the ACTING tab offering that second call: after the receipt
 * settles it writes the mined verdict into its query cache and pins
 * the wallet/chain/version so a lagging read cannot re-arm the prompt.
 * Both of those are per-tab — `acceptancePins` is module state and the
 * QueryClient is per-document — so a second tab holding the same
 * wallet kept its own stale `accepted: false`, a fresh-looking verdict
 * and an enabled Accept button, for up to its next refetch. That is
 * exactly the window in which somebody who just accepted in one tab is
 * most likely to click in the other, and the click costs gas.
 *
 * What crosses the tab boundary is the PIN — wallet, chain, version,
 * and the acting tab's timestamp — not an instruction to invalidate.
 * Adding the verdict's root to `RECEIPT_FLOOR_ROOTS` was considered in
 * the issue and rejected there: tab B would refetch against its own
 * possibly-lagging RPC, get `false` back, and have no pin of its own
 * to correct it — discarding a cached `true` in the process. With the
 * pin delivered first, tab B's next read corrects itself exactly the
 * way the acting tab's does, through the same `queryFn` path.
 *
 * The TTL is the acting tab's, deliberately: the frame carries the
 * `at` the pin was stamped with, and the receiver stores it verbatim,
 * so the 90-second bound (`ACCEPTANCE_PIN_TTL_MS`) expires at the same
 * moment in every tab. Re-stamping on delivery would extend the
 * override in whichever tab received it last — and the bound is the
 * reason the pin is safe at all: past it, a read that still says
 * `false` is a reorged acceptance, not a lagging node, and every tab
 * must return to believing the chain together.
 */
import type { QueryClient } from '@tanstack/react-query';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { isVerdictStale, tosQueryKey, type TosVerdictData } from './tosGate';
import {
  ACCEPTANCE_PIN_TTL_MS,
  acceptanceScope,
  adoptOrderedPin,
} from './tosAcceptancePin';

/**
 * How long after the invalidation below a receiving tab re-reads.
 * Mirrors the acting tab's own delayed second read (#2004 round 2 P2):
 * the invalidation's refetch can hit a lagging RPC and come back with
 * the PREVIOUS version still in force — which the newer pin cannot
 * correct, since pins apply only at the version the node reports — and
 * without a second read the stale prompt would sit enabled until the
 * 60-second poll, offering exactly the obsolete acceptance this
 * feature exists to prevent.
 */
const RECEIVER_SECOND_READ_MS = 4_000;

/** What the acting tab broadcasts after `acceptTerms` is mined and its
 *  receipt waited for. `kind` is the discriminator on the shared
 *  receipt-sync rail, whose other frame carries invalidation roots. */
export interface AcceptancePinFrame {
  kind: 'tos-acceptance-pin';
  chainId: number;
  /** The Diamond the acceptance was mined against (#2004 round 3 P1).
   *  A chain ID does not identify a deployment: during a rollout that
   *  points `deployments.json` at a fresh Diamond, an old tab and a
   *  new tab share this origin's channel while reading DIFFERENT
   *  contracts — and Terms state is per-Diamond, so an acceptance
   *  recorded on the retired one says nothing about the new one. The
   *  receiver drops any frame whose Diamond is not the one its own
   *  configuration reads. */
  diamond: string;
  address: string;
  version: number;
  hash: `0x${string}`;
  /** The acting tab's pin timestamp — carried so the TTL window is the
   *  same in every tab rather than restarting on delivery. */
  at: number;
}

export function buildAcceptancePinFrame(
  chainId: number,
  diamond: string,
  address: string,
  version: number,
  hash: `0x${string}`,
  at: number,
): AcceptancePinFrame {
  return { kind: 'tos-acceptance-pin', chainId, diamond, address, version, hash, at };
}

/**
 * Validate an incoming frame. Everything on the rail is external input
 * — another tab, or a `localStorage` ping any code on the origin could
 * have written — so nothing is trusted shapewise: a malformed frame is
 * dropped, never partially applied.
 */
export function parseAcceptancePinFrame(data: unknown): AcceptancePinFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const f = data as Record<string, unknown>;
  if (f.kind !== 'tos-acceptance-pin') return null;
  if (typeof f.chainId !== 'number' || !Number.isInteger(f.chainId) || f.chainId <= 0)
    return null;
  if (typeof f.diamond !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(f.diamond)) return null;
  if (typeof f.address !== 'string' || f.address.length === 0) return null;
  // Version 0 means "no ToS in force" — nothing to accept, so a frame
  // claiming an acceptance of it is malformed by construction.
  if (typeof f.version !== 'number' || !Number.isInteger(f.version) || f.version <= 0)
    return null;
  if (typeof f.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(f.hash)) return null;
  if (typeof f.at !== 'number' || !Number.isFinite(f.at) || f.at <= 0) return null;
  return {
    kind: 'tos-acceptance-pin',
    chainId: f.chainId,
    diamond: f.diamond,
    address: f.address,
    version: f.version,
    hash: f.hash as `0x${string}`,
    at: f.at,
  };
}

/**
 * Whether the receiving tab may write the mined verdict straight into
 * its cache, ahead of the refetch.
 *
 * ONLY when it already holds a verdict at the SAME version. Acceptance
 * is write-only on-chain, so at a matching version the mined `true`
 * can only be ahead of a cached `false`, never wrong — and rewriting
 * `accepted` within a version leaves the entry's implicit claim about
 * WHICH version is in force exactly as the tab's own read left it.
 *
 * A DIFFERENT cached version refuses for the obvious reason: this tab
 * has seen a version the acting tab had not when it accepted, and
 * overwriting would open the gate on terms the wallet never accepted.
 *
 * An ABSENT entry refuses too (review round 1 P1), and the asymmetry
 * with the acting tab is the point. The acting tab may seed an empty
 * cache because its receipt anchors the version: `acceptTerms` reverts
 * on a stale version, so a mined acceptance proves the version was in
 * force when it mined. A frame proves only that the wallet accepted
 * that version AT SOME POINT — governance may have installed a newer
 * one since — and a seeded `accepted: true` is a fresh successful
 * entry TanStack would serve while its first real read is still in
 * flight, opening both gates under the newer version. So an empty
 * cache takes only the pin; the first real read adopts it exactly when
 * the chain still reports that version, through the same `queryFn`
 * correction every other read uses.
 */
export function shouldAdoptPinnedVerdict(
  cached: TosVerdictData | undefined,
  version: number,
): boolean {
  return cached !== undefined && cached.version === version;
}

/**
 * Receiver side: apply an acceptance mined in another tab — verdict
 * into the cache (doubly guarded: version match AND a fresh successful
 * entry), pin through ordered adoption, then a re-read now and once
 * more after `RECEIVER_SECOND_READ_MS` (the immediate refetch can hit
 * a lagging node still reporting the previous version, which a newer
 * pin cannot correct — round 2 P2; an earlier version of this comment
 * claimed no second read was needed, which round 3's P3 rightly called
 * the opposite of the code below it).
 */
export function applyAcceptancePinFrame(
  queryClient: QueryClient,
  frame: AcceptancePinFrame,
  now: number = Date.now(),
): void {
  // Round 3 P1: the frame must have been mined against the SAME
  // Diamond this tab reads. Chain ID and wallet do not identify a
  // deployment — during a rollout an old tab and a new tab share this
  // channel while configured for different Diamonds, and Terms state
  // is per-Diamond. An unknown chain refuses too: a frame this tab
  // cannot even resolve a deployment for proves nothing about any
  // contract it reads.
  const deployment = getDeployment(frame.chainId);
  if (!deployment || deployment.diamond.toLowerCase() !== frame.diamond.toLowerCase())
    return;
  // Round 2 P1: a frame can arrive AFTER its own safety window — a
  // suspended tab resuming is enough — and past the bound the chain's
  // answer must win in every tab at once. Applied to the whole frame,
  // not just the pin: `acceptanceIsPinned` would already reject an
  // expired pin, but the cache write would still have manufactured a
  // fresh `accepted: true` the gates serve while the refetch runs.
  if (now - frame.at > ACCEPTANCE_PIN_TTL_MS) return;
  const scope = acceptanceScope(frame.chainId, frame.address);
  // Ordered adoption, not a plain overwrite: a delayed older frame
  // must not evict a newer pin. And when ordering REFUSES the frame,
  // nothing else of it may apply either (round 2 P1): with `false`
  // cached at v3, a v4 frame adopted, and a straggling v3 frame, the
  // version guard below would happily match the v3 cache and rewrite
  // it to `accepted: true` — opening the gates under terms this tab's
  // own pin already knows are obsolete. A refused frame is history;
  // the pin that beat it already ran this function's tail.
  if (!adoptOrderedPin(scope, frame.version, frame.at, now)) return;
  const queryKey = tosQueryKey(frame.chainId, frame.address);
  // Round 3 P1: the verdict is written only over a FRESH, SUCCESSFUL
  // entry at the matching version. `setQueryData` stamps a new
  // `dataUpdatedAt` and turns an error state back into success — it
  // manufactures freshness — so matching against a stale or
  // error-retained verdict would let a delayed frame reopen the gates
  // under terms that have since been superseded, with no refetch to
  // correct an INACTIVE query at all. A cache that fails the
  // freshness bar keeps only the pin; the next real read adopts it
  // exactly when the chain agrees.
  const state = queryClient.getQueryState<TosVerdictData>(queryKey);
  const freshCached =
    state?.status === 'success' && !isVerdictStale(state.dataUpdatedAt, now)
      ? state.data
      : undefined;
  if (shouldAdoptPinnedVerdict(freshCached, frame.version)) {
    queryClient.setQueryData<TosVerdictData>(queryKey, {
      accepted: true,
      version: frame.version,
      hash: frame.hash,
    });
  }
  void queryClient.invalidateQueries({ queryKey });
  // See `RECEIVER_SECOND_READ_MS` — one delayed re-read, never a poll.
  setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, RECEIVER_SECOND_READ_MS);
}
