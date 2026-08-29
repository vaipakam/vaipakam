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
import { tosQueryKey, type TosVerdictData } from './tosGate';
import { acceptanceScope, pinAcceptance } from './tosAcceptancePin';

/** What the acting tab broadcasts after `acceptTerms` is mined and its
 *  receipt waited for. `kind` is the discriminator on the shared
 *  receipt-sync rail, whose other frame carries invalidation roots. */
export interface AcceptancePinFrame {
  kind: 'tos-acceptance-pin';
  chainId: number;
  address: string;
  version: number;
  hash: `0x${string}`;
  /** The acting tab's pin timestamp — carried so the TTL window is the
   *  same in every tab rather than restarting on delivery. */
  at: number;
}

export function buildAcceptancePinFrame(
  chainId: number,
  address: string,
  version: number,
  hash: `0x${string}`,
  at: number,
): AcceptancePinFrame {
  return { kind: 'tos-acceptance-pin', chainId, address, version, hash, at };
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
 * Yes when it holds nothing, or holds a verdict at the SAME version —
 * acceptance is write-only on-chain, so at a matching version the
 * mined `true` can only be ahead of a cached `false`, never wrong.
 * No when the cached version DIFFERS: this tab has seen a version the
 * acting tab had not when it accepted (governance installed a new one
 * in between), and overwriting would open the gate on terms the wallet
 * never accepted. The pin is still stored — it simply never matches
 * the newer version — and the invalidation that follows re-reads the
 * truth.
 */
export function shouldAdoptPinnedVerdict(
  cached: TosVerdictData | undefined,
  version: number,
): boolean {
  return cached === undefined || cached.version === version;
}

/**
 * Receiver side: apply an acceptance mined in another tab, in the same
 * order the acting tab applied it — verdict into the cache (guarded),
 * pin, then a re-read.
 *
 * No delayed second re-read here, unlike the receipt floor: the pin
 * outlives any RPC lag by construction (90s against seconds), and the
 * `queryFn` consults it on every read, so a lagging refetch corrects
 * itself without a second scheduled pass.
 */
export function applyAcceptancePinFrame(
  queryClient: QueryClient,
  frame: AcceptancePinFrame,
): void {
  const scope = acceptanceScope(frame.chainId, frame.address);
  pinAcceptance(scope, frame.version, frame.at);
  const queryKey = tosQueryKey(frame.chainId, frame.address);
  const cached = queryClient.getQueryData<TosVerdictData>(queryKey);
  if (shouldAdoptPinnedVerdict(cached, frame.version)) {
    queryClient.setQueryData<TosVerdictData>(queryKey, {
      accepted: true,
      version: frame.version,
      hash: frame.hash,
    });
  }
  void queryClient.invalidateQueries({ queryKey });
}
