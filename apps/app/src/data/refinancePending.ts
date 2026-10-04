/**
 * Page-owned pending-refinance state — deliberately OUTSIDE the
 * RefinanceFlow component. The marker and its live verification must
 * not depend on the strategy card's mount gates (loanLive readiness,
 * sanctions resolution, advanced mode, loan still active): a live
 * request keeps its banner, its cancel affordance, and the
 * partial-repay interlock through ALL of those windows, or a lender
 * can accept a request the page no longer admits exists.
 *
 * #2391 — the request is DISCOVERED ON CHAIN from the current
 * borrower-position holder's own offers (`refinanceDiscovery.ts`), so one
 * made on another device or through another tool is found too. The
 * device-local marker stays as a fast-path hint (it names this device's
 * request before the next discovery poll). Whichever names the request,
 * every render of the pending surface verifies it against the chain in
 * one batch: the offer
 * record (cancel DELETES it → zeroed creator self-heals the marker),
 * the LIVE loan (payoff recomputed from chain, never a cached prop),
 * LIVE fees (the top-up figure must track a governance retune), the
 * standing allowance + wallet balance (a sibling repay flow's
 * zero-first approve can strand the request silently), and chain
 * time (the cancel cooldown gate must not trust the device clock).
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  CANCEL_COOLDOWN_SECONDS,
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  readLoanLive,
  refinanceApprovalOf,
  refinancePayoffOf,
} from '../contracts/loanLive';
import { readGraceSecondsLive } from '../contracts/preflights';
import { discoverRefinanceRequest, type RefinanceDiscovery } from './refinanceDiscovery';
import { ownScanUnresolved, resolveNamedRequest } from './refinanceInterlock';
import { readLiveProtocolFees } from './fees';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { makePendingMarkerStore } from '../lib/pendingMarker';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { idleAware } from '../lib/idle';

/** #2391 — the discovery query's key (a prefix without the holder, for
 *  invalidation). Deliberately outside the 'refinancePending' root. */
export function refinanceDiscoveryKey(
  chainId: number,
  loanId: number,
  holder?: string,
): unknown[] {
  return holder === undefined
    ? ['refinanceDiscovery', chainId, loanId]
    : ['refinanceDiscovery', chainId, loanId, holder];
}

const marker = makePendingMarkerStore('app.refinanceOffer');

/** Live read of this device's refinance-request marker for a loan
 *  (#2389 r6). `useRefinancePending` seeds from the marker once, on
 *  mount, so a request posted from ANOTHER TAB afterwards is invisible
 *  to its state; a write that changes the loan's collateral re-reads
 *  the store itself just before the wallet opens. localStorage is shared
 *  across tabs, so this sees them. A request made on another device or
 *  through another tool is found by on-chain discovery instead (#2391). */
export function readRefinanceMarker(chainId: number, loanId: number): string | null {
  return marker.read(chainId, loanId);
}

export interface RefinancePendingState {
  /** #2406 r1 — who posted the request: the only wallet that can cancel
   *  it, so the pending card (and its funding actions) key to it, not to
   *  the loan's original borrower. */
  creator: string;
  /** Loan still Active on-chain (a request on a settled loan is dead
   *  weight — cancel + revoke is the only remaining action). */
  loanActive: boolean;
  accepted: boolean;
  /** Unix-seconds the request expires (its on-chain Good-Til-Time). */
  expiresAt: bigint;
  /** Chain time is at/past expiresAt — acceptOffer rejects the
   *  request, so it no longer blocks partial/preclose and the only
   *  remaining action is cancel (which also unwinds the approval). */
  expired: boolean;
  /** Chain time is strictly past the loan's grace window — the
   *  contract's admission gate rejects the accept (#1189), so like
   *  `expired` the request can never complete and only
   *  cancel-to-unwind remains. */
  pastGrace: boolean;
  /** Chain time says the cancel cooldown has elapsed. */
  cancelUnlocked: boolean;
  /** Standing approval no longer covers the request's approval
   *  target (the pull at its LAST fillable moment — an allowance
   *  covering only today's payoff still strands an in-grace accept). */
  allowanceShort: boolean;
  /** Wallet balance no longer covers the live top-up figure. */
  balanceShort: boolean;
  /** Live payoff (what an accept RIGHT NOW pulls — includes any
   *  accrued grace-window late fee) and spare-balance figure. */
  payoff: bigint;
  topUp: bigint;
  /** The restore action's approval target: the payoff at the
   *  request's last fillable moment (covers the late fee any later
   *  accept could add, #1236). */
  approvalTarget: bigint;
}

export function useRefinancePending(
  loanId: number,
  principalAsset: `0x${string}` | undefined,
  /** #2391 — the CURRENT borrower-position holder (a fresh read; the
   *  page's `freshData(nftOwners)`), whose open offers are searched for a
   *  request. `undefined` while unknown; `'burned'` when the position is
   *  gone (no request can be settled then). */
  holder: string | 'burned' | undefined,
  /** #2391 — the loan's own offer id: every request for the loan is
   *  newer, which bounds the on-chain search. */
  loanOfferId: number | undefined,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const queryClient = useQueryClient();
  const [markerId, setMarkerId] = useState<string | null>(() =>
    marker.read(readChain.chainId, loanId),
  );

  // #2391 — on-chain discovery: the holder's offers posted since the loan
  // began, tagged for this loan. Its own query root, NOT under
  // 'refinancePending' (#2406 r1): that root is re-fetched on every block,
  // and discovery is a multi-read scan that only needs a minute's cadence
  // (a borrower action re-runs it live before sending anyway).
  // Keyed by the SCANNED wallet ('burned' = nothing to scan), so the
  // holder's scan and a viewer's own scan of the same wallet share a cache.
  const scan = (target: string | undefined, enabled: boolean) => ({
    queryKey: refinanceDiscoveryKey(
      readChain.chainId,
      loanId,
      target?.toLowerCase() ?? 'burned',
    ),
    enabled: enabled && Boolean(readClient) && loanOfferId !== undefined,
    refetchInterval: idleAware(60_000),
    queryFn: async (): Promise<RefinanceDiscovery> => {
      if (target === undefined || loanOfferId === undefined) return { kind: 'none' };
      const result = await discoverRefinanceRequest({
        client: readClient!,
        diamond: readChain.diamondAddress,
        loanId: BigInt(loanId),
        sinceOfferId: BigInt(loanOfferId),
        holder: target as `0x${string}`,
      });
      // #2406 r7 — a FAILED scan rejects, so the query keeps its last
      // answer as `data` (naming a request already found keeps its card)
      // and reports `isError` (the check reads it as unknown). Returned as
      // data it would have overwritten that answer. A capped scan is a real
      // answer and resolves.
      if (result.kind === 'unknown' && result.reason === 'failed') {
        throw new Error('refinance discovery failed');
      }
      return result;
    },
  });
  const holderAddr = holder === undefined || holder === 'burned' ? undefined : holder;
  // A burned position has no holder whose request could be filled: nothing
  // to search (the viewer's own scan below still finds their leftovers).
  const holderQuery = useQuery(scan(holderAddr, holder !== undefined));
  // #2406 r3 — the connected viewer's OWN offers, when they are not the
  // holder: only a request's creator can cancel it, so a wallet that
  // posted a request and then transferred the position (or whose loan
  // settled) must still find it, with its payoff approval, from any device.
  const ownTarget =
    address &&
    (holder === 'burned' ||
      (holderAddr !== undefined && holderAddr.toLowerCase() !== address.toLowerCase()))
      ? address
      : undefined;
  const ownQuery = useQuery(scan(ownTarget, ownTarget !== undefined));
  // A failed refetch is an unknown, not the last answer heard.
  const holderScan: RefinanceDiscovery | undefined = holderQuery.isError
    ? { kind: 'unknown', reason: 'failed' }
    : holderQuery.data;
  // #2406 r6 — NAMING reads the last scan that ANSWERED (a failed refetch
  // keeps the previous data): a request already found keeps its card and
  // its cancel-and-revoke action through a data-source error, as the spec
  // requires of the pending view. The CHECK still reads that failure as
  // unknown (`holderScan` above), so the surfaces a request would strand
  // hold back meanwhile. The own scan only ever names a request for
  // cleanup; its failure blocks nothing.
  const { offerId: candidateId, fromOwnScan } = resolveNamedRequest({
    holderScan: holderQuery.data,
    ownScan: ownTarget === undefined ? undefined : ownQuery.data,
    markerId,
  });

  const seedKey = `${readChain.chainId}:${loanId}`;
  const [seededFor, setSeededFor] = useState(seedKey);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    setMarkerId(marker.read(readChain.chainId, loanId));
  }

  const remember = useCallback(
    (id: string) => {
      marker.write(readChain.chainId, loanId, id);
      setMarkerId(id);
    },
    [readChain.chainId, loanId],
  );
  const clear = useCallback(() => {
    marker.write(readChain.chainId, loanId, null);
    setMarkerId(null);
    // A request found by discovery is cleared by the chain, not the marker:
    // re-scan so a cancelled one stops being named.
    void queryClient.invalidateQueries({
      queryKey: refinanceDiscoveryKey(readChain.chainId, loanId),
    });
  }, [readChain.chainId, loanId, queryClient]);

  const query = useQuery({
    queryKey: [
      'refinancePending',
      readChain.chainId,
      loanId,
      candidateId,
      address?.toLowerCase(),
    ],
    enabled: Boolean(readClient) && candidateId !== null && Boolean(principalAsset),
    // RPC read-diet PR A — pending-card accept gate: tip-nudged per
    // block on WS deploys (§4.1.2), so the interval is only the net.
    refetchInterval: tipAware(30_000, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<RefinancePendingState | 'gone'> => {
      const diamond = readChain.diamondAddress;
      const [offer, live, fees, latestBlock, allowance, balance] =
        await Promise.all([
          readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOfferDetails',
            args: [BigInt(candidateId!)],
          }) as Promise<{
            creator: string;
            accepted: boolean;
            refinanceTargetLoanId: bigint;
            createdAt: bigint;
            expiresAt: bigint;
          }>,
          readLoanLive(readClient!, diamond, loanId),
          readLiveProtocolFees(readClient!, diamond),
          readClient!.getBlock({ blockTag: 'latest' }),
          address
            ? (readClient!.readContract({
                address: principalAsset!,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address, diamond],
              }) as Promise<bigint>)
            : Promise.resolve(0n),
          address
            ? (readClient!.readContract({
                address: principalAsset!,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address],
              }) as Promise<bigint>)
            : Promise.resolve(0n),
        ]);
      // cancelOffer DELETES the record — zeroed creator = gone. Also
      // treat a marker pointing at some other loan's offer as gone.
      if (
        offer.creator === ZERO_ADDRESS ||
        offer.refinanceTargetLoanId !== BigInt(loanId)
      ) {
        return 'gone';
      }
      // The grace bucket — via the app-shared query cache (same key
      // as useGraceSeconds), so the 30s poll doesn't re-read what a
      // 5-minute-fresh config read already answered. fetchQuery, NOT
      // ensureQueryData: ensure returns a cached entry regardless of
      // age, which would freeze a governance grace change out of the
      // pastGrace/approvalTarget math indefinitely (Codex #1256 r1);
      // fetchQuery enforces the staleTime bound. Bucketed on the
      // LIVE duration (a keeper extend can move the bucket).
      const graceSec = await queryClient.fetchQuery({
        queryKey: ['graceSeconds', readChain.chainId, Number(live.durationDays)],
        queryFn: () =>
          readGraceSecondsLive({
            publicClient: readClient!,
            diamondAddress: diamond,
            durationDays: Number(live.durationDays),
          }),
        staleTime: 5 * 60 * 1000,
      });
      // Payoff AS OF NOW (what an accept in this block pulls —
      // includes any accrued grace-window late fee, #1189/#1236).
      const payoff = refinancePayoffOf(live, latestBlock.timestamp);
      const topUp =
        payoff -
        live.principal +
        (live.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n;
      // Strictly past grace the contract's admission gate rejects any
      // accept — the request behaves like an expired one from here.
      const pastGrace = latestBlock.timestamp > loanEndTimeOf(live) + graceSec;
      // What the contract could pull at the request's LAST fillable
      // moment — the allowance threshold (Codex #1256 r1): an
      // allowance covering only today's payoff still strands a
      // later in-grace accept, so warn (and restore) against this.
      const approvalTarget = refinanceApprovalOf(live, {
        expiresAt: offer.expiresAt,
        graceSeconds: graceSec,
      });
      // Disconnected wallet (address undefined) must not paint the
      // funding warnings red off zero placeholders.
      const fundingKnown = Boolean(address);
      // Judged by CHAIN time — an expired request is unacceptable
      // on-chain, so the funding warnings stop (there is nothing left
      // to fund) and only cancel-to-unwind remains.
      const expired =
        offer.expiresAt !== 0n && latestBlock.timestamp >= offer.expiresAt;
      return {
        creator: offer.creator,
        loanActive: live.status === LOAN_STATUS_ACTIVE,
        accepted: offer.accepted,
        expiresAt: offer.expiresAt,
        expired,
        pastGrace,
        cancelUnlocked:
          latestBlock.timestamp >= offer.createdAt + CANCEL_COOLDOWN_SECONDS,
        // Funding warnings stop past grace too — like expiry, there
        // is nothing left to fund (accepts are rejected on-chain).
        allowanceShort:
          fundingKnown &&
          !offer.accepted &&
          !expired &&
          !pastGrace &&
          allowance < approvalTarget,
        balanceShort:
          fundingKnown &&
          !offer.accepted &&
          !expired &&
          !pastGrace &&
          balance < topUp,
        payoff,
        topUp,
        approvalTarget,
      };
    },
  });

  // Self-heal: a deleted/foreign record clears the marker.
  //
  // Deliberately an effect (#1520), same reasoning as offsetPending: this
  // invalidates persisted device state on verified chain evidence, and the
  // marker feeds this hook's query key, so a render-derived value would keep
  // the key naming a record already known to be gone.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (query.data === 'gone') clear();
  }, [query.data, clear]);

  return {
    /** Non-null while a request is known — from this device's marker or
     *  from on-chain discovery (state may still be loading). See
     *  `resolveNamedRequest` for which one is named. Null once the chain
     *  has VERIFIED the named record gone (cancelled, or another loan's):
     *  a last-known scan kept through a failed refetch must not keep
     *  naming a request the chain says no longer exists (#2406 r6). */
    offerId: query.data === 'gone' ? null : candidateId,
    /** The named request came from the viewer's own scan (they are not the
     *  holder): shown for cleanup, never blocking. */
    fromOwnScan,
    /** #2406 r4/r5 — the viewer's OWN scan (run when they are not the
     *  holder) failed or hit its page cap: a request they posted could
     *  exist unseen, so the page says so and names the manual cleanup
     *  rather than staying silent. Never blocks — the contract will not
     *  settle such a request. */
    ownScanUnresolved: ownScanUnresolved(
      ownTarget === undefined ? undefined : ownQuery.isError ? 'error' : ownQuery.data,
    ),
    /** #2391 — the holder's on-chain discovery verdict, which decides
     *  whether the page KNOWS (`refinanceInterlock`). `undefined` while
     *  loading. */
    holderScan,
    /** Live-verified state; undefined while loading or errored. */
    state: query.data === 'gone' ? undefined : query.data,
    remember,
    clear,
  };
}
