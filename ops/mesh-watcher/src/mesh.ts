/**
 * One tick's reads: Base's per-chain books, plus every reachable chain's
 * own ledger.
 *
 * The chain set comes from the canonical Diamond, not from config — see
 * `chains.ts`. Chains that cannot be reached become coverage gaps rather
 * than being dropped: a watcher that silently narrows its scope reports
 * "all clear" for chains it never looked at.
 */

import { pickChain, rotationOrder, type TickScope } from './rotation';
import type { Abi, Address, PublicClient } from 'viem';
import {
  REPATRIATION_ABI,
  REWARD_RECONCILIATION_ABI,
  REWARD_AGGREGATOR_ABI,
  REWARD_CUSTODY_ABI,
  REWARD_REMITTANCE_LENS_ABI,
} from './abi';
import {
  isCoverageGap,
  resolveChain,
  verifyChainIdentity,
  type ChainTarget,
  type CoverageGap,
} from './chains';
import type { Config, Env } from './env';
import { classify, describeFailure, PreclassifiedFailure } from './errors';
import { makeBaseRedactor } from './redact';
import {
  asFreshSnapshot,
  type BaseChainBooks,
  type FRESH,
  type LocalLedger,
  type MeshObservation,
} from './invariants';

/** A local read before the freshness check has vouched for it. */
type RawLocalLedger = Omit<LocalLedger, FRESH>;

/**
 * Read a view whose decode shape `assertAbiShape` has already verified.
 *
 * The cast is what that assertion buys: the compiled ABI drives the
 * decode (so field ORDER is authoritative), and the startup check has
 * confirmed the arity and types this call site assumes.
 */
async function readView<T>(
  client: PublicClient,
  address: Address,
  functionName: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
  abi: Abi = REWARD_AGGREGATOR_ABI,
): Promise<T> {
  const result = await client.readContract({
    address,
    abi,
    functionName,
    args: args as never,
    // Pin to ONE block when the caller supplies it. Related ledger fields
    // are written atomically on-chain but read over several RPC calls, so
    // an unpinned read can straddle a funding or retirement transaction
    // and observe, say, an old `consumed` beside a newly-incremented
    // `outstanding` — paging a `commit-identity` violation that never
    // existed (Codex #1443 r1). A false CRITICAL is the worst outcome
    // this Worker can produce, so every related read shares a block.
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return result as T;
}

/**
 * Multicall3 at its canonical address, deployed on every chain the mesh runs
 * on (checked on Base Sepolia, Arbitrum Sepolia and BNB testnet). A chain
 * wired into the mesh without it makes that chain's view reads fail as one
 * coverage gap, the same as an unreachable endpoint.
 */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** One view in a {@link readViews} batch. */
interface ViewCall {
  functionName: string;
  args?: readonly unknown[];
  abi?: Abi;
}

/** A batched view's outcome: its decoded value, or why it failed. */
type ViewOutcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Read every view of one Diamond in ONE `eth_call`, through Multicall3, at
 * one pinned block.
 *
 * Why batched: Workers Free allows 50 subrequests per invocation, and a tick
 * that read each view as its own request spent most of that on view reads
 * alone. One batch per Diamond keeps a tick to a handful of requests however
 * many views the checks need.
 *
 * `allowFailure` keeps each view's failure its own: a view that reverts (a
 * selector missing from the current cut) or does not decode comes back as a
 * failed outcome carrying viem's error, which `classify` reads exactly as it
 * read the error of a lone `readContract`. Only a failure of the whole call —
 * transport, or Multicall3 absent — throws, and the caller treats that as the
 * chain being unreadable.
 *
 * `batchSize: 0` stops viem from splitting the batch into several calls by
 * calldata size, so the request count stays one. Every call is still pinned,
 * so the snapshot is one block either way.
 */
async function readViews(
  client: PublicClient,
  address: Address,
  calls: readonly ViewCall[],
  blockNumber: bigint,
): Promise<ViewOutcome[]> {
  const results = await client.multicall({
    contracts: calls.map((c) => ({
      address,
      abi: c.abi ?? REWARD_AGGREGATOR_ABI,
      functionName: c.functionName,
      args: (c.args ?? []) as never,
    })),
    allowFailure: true,
    blockNumber,
    multicallAddress: MULTICALL3,
    batchSize: 0,
  });
  return results.map((r) =>
    r.status === 'success' ? { ok: true, value: r.result } : { ok: false, error: r.error },
  );
}

/**
 * The value of a view the caller cannot do without: its failure is the
 * failure of the whole read, as it was when these views were awaited together.
 */
function required<T>(outcome: ViewOutcome): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value as T;
}

/**
 * Whether a failed repatriation-view read reverted at the CONTRACT (the
 * selector does not exist in the current cut) as opposed to failing in
 * transport.
 *
 * Used for GAP WORDING ONLY — never to substitute a value. An earlier
 * revision inferred "missing selector ⇒ pre-C2 deployment ⇒ the value is
 * known-zero", which is wrong under a PARTIAL FACET REFRESH (Codex #1618
 * r5): Diamond storage persists across cuts, so a post-C2 Diamond whose
 * refresh dropped the repatriation facet has a nonzero draw/outflow in
 * storage behind a reverting view. Selector absence identifies the
 * current CUT, not the deployment's history — the value is UNKNOWN
 * either way, and every dependent check skips. Exported for direct
 * testing — the catch branches that use it do I/O.
 */
export function isMissingSelector(err: unknown): boolean {
  return classify(err).kind === 'contract-revert';
}

/**
 * Build the gap for an unreadable Base-side repatriation-draw view.
 *
 * Exported for the same reason as {@link compositionUnavailableGap}: the
 * catch branch does I/O-adjacent work a unit test must reach directly.
 */
export function repatDrawUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getChainRepatriationDraw');
  const preC2 = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'base-books-repat',
    detail:
      `getChainRepatriationDraw() could not be read for chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The draw is UNKNOWN this tick, so the availability-formula, repat-cap AND keeper-cap checks for this chain did NOT run (substituting zero would page a false CRITICAL on any chain with a live repatriation). keeper-cap is included because its remaining-capacity figure is measured AFTER the repatriation draw, so an unreadable repat draw disables it too — the keeper draw's own capacity bound is NOT monitored in this window either.\n\n` +
      (preC2
        ? `The selector does not exist in this Diamond's CURRENT CUT — either a pre-C2 deployment, or a partial facet refresh that dropped the RepatriationFacet while its storage (possibly nonzero) persists; selector absence cannot distinguish the two. Cut the facet (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

/**
 * #1569 M4 C3 — the gap for an unreadable keeper-earmark draw.
 *
 * Same discipline as the repatriation draw above, and for the same reason
 * (Codex #2031 r3): the keeper draw is a THIRD subtrahend of the
 * availability formula, so a tick that cannot read it cannot re-derive
 * availability either. Substituting zero would page a false CRITICAL on
 * every armed chain, which is precisely the failure this watcher exists to
 * distinguish from a real one.
 */
export function keeperDrawUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getChainKeeperDraw');
  const pre1569 = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'base-books-keeper',
    detail:
      `getChainKeeperDraw() could not be read for chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The draw is UNKNOWN this tick, so the availability-formula, keeper-cap AND (on the canonical chain) the base-self-inert keeper leg did NOT run (substituting zero would page a false CRITICAL on any chain with an armed keeper allocation, and the cap check has nothing to compare). Naming all three matters during an incident: the draw's capacity bound is NOT monitored in this window, and on Base the self-inertness leg is the ONLY check that would catch a keeper draw booked against the canonical id.\n\n` +
      (pre1569
        ? `The selector does not exist in this Diamond's CURRENT CUT — either a pre-#1569 deployment, or a partial facet refresh that dropped the RewardAggregatorFacet while its storage (possibly nonzero) persists; selector absence cannot distinguish the two. Cut the facet (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

/**
 * #1452 — the gap for an unreadable acknowledged recycled share. The
 * `base-ahead-of-chain` relocated leg did NOT run for the chain this tick; a
 * zero substitute would hide exactly the misrouted arrival the leg exists for.
 */
export function remittedRecycledUnavailableGap(chainId: number, err: unknown): CoverageGap {
  const view = 'getChainRemittedRecycled';
  const failure = classify(err, view);
  const missing = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'base-books-relocation',
    detail:
      `${view}() could not be read for chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The acknowledged recycled share is UNKNOWN this tick, so the relocated-custody leg of base-ahead-of-chain did NOT run for this chain: an arrival credited as absorption instead of relocated custody is NOT being watched in this window.\n\n` +
      (missing
        ? `The selector does not exist in this Diamond's CURRENT CUT — a pre-#1452 deployment, or a refresh that dropped the remittance lens. Cut it (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

/**
 * Base's books for one chain: six views in one batch at the pinned Base block
 * ({@link readViews}).
 *
 * The first three are required: without any of them the chain's books are
 * unreadable this tick. The last three are a NEWER facet's selectors each, so
 * a canonical Diamond missed during a refresh must cost only the checks that
 * need them, not the whole chain's books. Each is UNKNOWN on any failure,
 * missing selector included (Codex #1618 r5): storage persists across facet
 * cuts, so a partial refresh that dropped a facet leaves a nonzero value
 * behind a reverting view, and a zero substitute would page a false CRITICAL.
 * The dependent checks skip, and the gap names which.
 *
 * Exported for direct testing with a fake client: it does I/O.
 */
export async function readBaseBooks(
  canonical: ChainTarget,
  chainId: number,
  blockNumber: bigint,
  gaps: CoverageGap[],
): Promise<BaseChainBooks> {
  const args = [chainId];
  const [ledgerR, retirementR, outstandingR, repatR, keeperR, recycledR] = await readViews(
    canonical.client,
    canonical.diamond,
    [
      { functionName: 'getChainRecycledLedger', args },
      { functionName: 'getChainRecycledCommitRetirement', args },
      { functionName: 'getChainOutstandingRecycledCommit', args },
      // #1568 C2 — the repatriation draw pair. The draw slot and the
      // availability view move in one transaction, so it shares the block.
      { functionName: 'getChainRepatriationDraw', args, abi: REPATRIATION_ABI },
      // #1569 M4 C3 — the keeper-earmark draw.
      { functionName: 'getChainKeeperDraw', args },
      // #1452 — Base's acknowledged recycled share for this chain.
      { functionName: 'getChainRemittedRecycled', args, abi: REWARD_REMITTANCE_LENS_ABI },
    ],
    blockNumber,
  );
  const ledger = required<readonly [bigint, bigint, bigint, bigint]>(ledgerR!);
  const retirement = required<readonly [bigint, bigint]>(retirementR!);
  const outstanding = required<bigint>(outstandingR!);

  let repat: BaseChainBooks['repat'];
  if (repatR!.ok) {
    const draw = repatR!.value as readonly [bigint, bigint];
    repat = { netDraw: draw[0], lifetimeReleased: draw[1] };
  } else {
    gaps.push(repatDrawUnavailableGap(chainId, repatR!.error));
  }

  let keeperDraw: bigint | undefined;
  if (keeperR!.ok) keeperDraw = keeperR!.value as bigint;
  else gaps.push(keeperDrawUnavailableGap(chainId, keeperR!.error));

  let recycledAcked: bigint | undefined;
  if (recycledR!.ok) recycledAcked = (recycledR!.value as readonly [bigint, bigint])[0];
  else gaps.push(remittedRecycledUnavailableGap(chainId, recycledR!.error));
  return {
    chainId,
    keeperDraw,
    recycledAcked,
    reported: ledger[0],
    consumed: ledger[1],
    avail: ledger[2],
    attributed: ledger[3],
    retired: retirement[0],
    released: retirement[1],
    outstanding,
    repat,
  };
}

/** A chain's own ledger — read against that chain's own Diamond. */
interface LocalRead {
  ledger: RawLocalLedger;
  /**
   * Gaps produced by the OPTIONAL views — empty when everything read.
   *
   * Returned rather than swallowed (#1448 r3): an optional read that fails
   * silently lets the tick certify the mesh healthy while several CRITICAL
   * checks did not run at all, which is the one outcome a watcher must never
   * produce. Making it part of the return type means a future optional read
   * cannot be added without deciding what its absence costs.
   */
  gaps: CoverageGap[];
}

/**
 * Build the gap for an unreadable composition view.
 *
 * Exported so it can be tested directly: `readLocalLedger` does I/O, so the
 * catch branch is otherwise unreachable from a unit test — which is exactly
 * how the missing gap survived review (#1448 r3).
 */
/**
 * Build the gap for an unreadable chain-local repatriation position.
 *
 * Exported for direct testing, like {@link compositionUnavailableGap}.
 */
export function repatPositionUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getRepatriationPosition');
  const preC2 = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'own-ledger-repat',
    detail:
      `getRepatriationPosition() could not be read on chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The repatriated-out cumulative is UNKNOWN this tick, so bucket composition for this chain did NOT run (substituting zero would page a false CRITICAL after any real repatriation).\n\n` +
      (preC2
        ? `The selector does not exist in this Diamond's CURRENT CUT — either a pre-C2 deployment, or a partial facet refresh that dropped the RepatriationFacet while its storage (possibly nonzero) persists; selector absence cannot distinguish the two. Cut the facet (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

/**
 * Build the gap for an unreadable reconciliation-totals view (#1566 closure
 * 2 cutover PR 2, Codex #2206 r9) — the two reattribution cumulatives.
 *
 * Exported for direct testing, like {@link compositionUnavailableGap}.
 */
export function reattributionUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getReconciliationTotals');
  const missing = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'own-ledger-reattribution',
    detail:
      `getReconciliationTotals() could not be read on chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The two reattribution cumulatives are UNKNOWN this tick, so bucket composition for this chain did NOT run (substituting zero would page a false CRITICAL after any real correction of a classification).\n\n` +
      (missing
        ? `The selector does not exist in this Diamond's CURRENT CUT — either a deployment predating the reconciliation epoch, or a partial facet refresh that dropped the RewardReconciliationFacet while its storage (possibly nonzero) persists; selector absence cannot distinguish the two. Cut the facet (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

/**
 * Build the gap for an unreadable backing snapshot (#1434 P2-w2; since
 * #1566 slice 4 PR B the VERSIONED snapshot is the only one read).
 *
 * Exported for direct testing, like {@link compositionUnavailableGap}.
 */
export function backingSnapshotUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getRecycleBackingSnapshotV2');
  const missing = isMissingSelector(err);
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'own-ledger-backing',
    detail:
      `getRecycleBackingSnapshotV2() could not be read on chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `The balance / arrival-reservation tuple AND the custody activation state are UNKNOWN this tick, so the recovery-reservation backing check did NOT run for this chain (substituting zero would page a false CRITICAL after any real quarantine, substituting the reservation as zero would silently stop alarming on spent recovery backing, and assuming non-activation would apply the Diamond-only relation to custody that may be on the holder).\n\n` +
      (missing
        ? `The versioned snapshot does not exist in this Diamond's CURRENT CUT — either a pre-slice-4 deployment, or a partial refresh that dropped the RewardCustodyFacet while its storage (possibly an ACTIVATED custody) persists; selector absence cannot distinguish the two. The legacy lens tuple cannot stand in: it carries no activation state, and the flag that does lives on the same facet as the versioned snapshot, so an activated chain that has lost the facet is indistinguishable from one that never had it. Cut the RewardCustodyFacet (back) in to close this gap.`
        : `The view did not revert, so the cause is not the cut; the classification above names what failed. Inside a batched read that is usually an answer that does not decode against the compiled ABI, so re-export the facet ABIs if the Diamond changed. (A transport failure fails the whole batch and is reported as the chain being unreadable instead.)`),
  };
}

export function compositionUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getRecycleCompositionPosition');
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'own-ledger-composition',
    detail:
      `getRecycleCompositionPosition() could not be read on chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `Most likely a chain missed during a facet refresh. For this chain THIS TICK: bucket composition and the canonical-role cross-check did NOT run, and bucket coverage fell back to the pre-#1444 rule (strict on a mirror; not evaluated on the canonical chain, where a released remittance legitimately produces a shortfall and the figure that would explain it is the one missing).`,
  };
}

/** Exported for direct testing with a fake client: it does I/O, like {@link readBaseBooks}. */
export async function readLocalLedger(target: ChainTarget): Promise<LocalRead> {
  const viewGaps: CoverageGap[] = [];
  // One block for this chain's whole tuple, for the same reason as the
  // Base-side reads: bucket coverage compares a balance against a
  // reservation that a single claim moves together.
  const block = await target.client.getBlock();
  const blockNumber = block.number;
  // Seven views in ONE batch at that block ({@link readViews}). The first
  // three are required; each of the other four is a NEWER facet's selector,
  // so its own failure costs only the checks that need it (below).
  const [custodyR, retirementR, governorR, compositionR, repatR, reconciliationR, backingR] =
    await readViews(
      target.client,
      target.diamond,
      [
        { functionName: 'getRecycleCustodyPosition' },
        { functionName: 'getLocalRecycledCommitRetirement' },
        { functionName: 'getGovernorCommitState' },
        { functionName: 'getRecycleCompositionPosition' },
        { functionName: 'getRepatriationPosition', abi: REPATRIATION_ABI },
        { functionName: 'getReconciliationTotals', abi: REWARD_RECONCILIATION_ABI },
        { functionName: 'getRecycleBackingSnapshotV2', abi: REWARD_CUSTODY_ABI },
      ],
      blockNumber,
    );
  const custody = required<readonly [bigint, bigint, bigint]>(custodyR!);
  const retirement = required<readonly [bigint, bigint]>(retirementR!);
  const governor = required<readonly [bigint, bigint, bigint, bigint]>(governorR!);

  // #1444 / #1446 — the raw slots.
  //
  // Optional because this is a NEWER facet selector (#1448 r2): a chain
  // missed during a facet refresh answers the three views above and reverts
  // this one. When that single revert rejected the whole local read,
  // `observeMesh` discarded the custody, retirement and governor evidence it
  // had successfully fetched — turning several working CRITICAL checks into
  // one non-paging coverage gap. Its absence must cost only the checks that
  // need it.
  //
  // The shared pinned block is load-bearing: the composition and coverage
  // checks compare these counters against the bucket and payout figures, so
  // a mixed-block tuple would show a mid-transaction state as a violation.
  let composition:
    | {
        credited: bigint;
        releasedRemitStranded: bigint;
        isCanonicalRewardChain: boolean;
        releasedRemitResolved: bigint;
      }
    | undefined;
  if (compositionR!.ok) {
    const c = compositionR!.value as readonly [bigint, bigint, boolean, bigint];
    composition = {
      credited: c[0],
      releasedRemitStranded: c[1],
      isCanonicalRewardChain: c[2],
      releasedRemitResolved: c[3],
    };
  } else {
    viewGaps.push(compositionUnavailableGap(target.chainId, compositionR!.error));
  }

  // #1568 C2 — the repatriated-outflow cumulative, optional for the same
  // newer-facet reason as the composition view. `undefined` (view
  // unavailable) and `0n` (facet present, nothing repatriated) are
  // deliberately distinct: the first reports a coverage gap, the second is
  // just a healthy figure. UNKNOWN on ANY failure, missing selector included
  // — same partial-refresh reasoning as the Base-side draw (Codex #1618 r5).
  // The composition check skips for this chain.
  let repatriatedOut: bigint | undefined;
  if (repatR!.ok) {
    repatriatedOut = (repatR!.value as readonly [bigint, Address, Address, bigint])[0];
  } else {
    viewGaps.push(repatPositionUnavailableGap(target.chainId, repatR!.error));
  }

  // #1566 closure 2 cutover PR 2 (Codex #2206 r9) — the two reattribution
  // cumulatives, optional for the same newer-facet reason, with the same
  // UNKNOWN-vs-zero rule as the repatriated-out term: a chain refreshed
  // without the reconciliation facet fails this view alone, and the checks
  // that consume the pair skip rather than substitute a zero that would page
  // after any real correction.
  let reattribution:
    | { reattributedIn: bigint; reattributedOut: bigint }
    | undefined;
  if (reconciliationR!.ok) {
    const totals = reconciliationR!.value as readonly [bigint, bigint, bigint];
    reattribution = { reattributedIn: totals[1], reattributedOut: totals[2] };
  } else {
    viewGaps.push(reattributionUnavailableGap(target.chainId, reconciliationR!.error));
  }

  // #1434 P2-w2 — the backing snapshot (balance + arrival reservation),
  // optional for the same newer-facet reason.
  //
  // #1566 slice 4 PR B — the VERSIONED snapshot, and ONLY it (Codex #2186
  // r3 P1): on a chain whose reward custody moved onto the holder, the
  // bucket and the recovery position are the holder's and the relation to
  // alarm on changes (`checkHardInvariants` branches on `custodyActivated`).
  // The legacy lens tuple carries no activation state, and the flag that
  // does lives on the SAME facet as V2 — so a Diamond that cannot answer V2
  // cannot establish non-activation either, and "the custody facet was
  // never installed" is indistinguishable from "it was removed after
  // activation" (a partial refresh; the storage flag persists). The backing
  // stays UNKNOWN there, reported as a coverage gap that names the cut to
  // fix — the same rule the repatriation and composition views follow. An
  // earlier revision read the legacy tuple when the activation probe was
  // itself missing, which is exactly the conflation.
  let backing:
    | {
        vpfiBalance: bigint;
        strandedRecoveryReserved: bigint;
        recoveryPositionReserved: bigint;
        custodyActivated: boolean;
        holderBalanceKnown: boolean;
        holderBalance: bigint;
        holderAttributed: bigint;
      }
    | undefined;
  if (backingR!.ok) {
    const snap = backingR!.value as readonly [
      bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
      boolean, boolean, bigint, bigint,
    ];
    backing = {
      vpfiBalance: snap[0],
      strandedRecoveryReserved: snap[6],
      recoveryPositionReserved: snap[7],
      custodyActivated: snap[8],
      holderBalanceKnown: snap[9],
      holderBalance: snap[10],
      holderAttributed: snap[11],
    };
  } else {
    viewGaps.push(backingSnapshotUnavailableGap(target.chainId, backingR!.error));
  }

  return {
    ledger: {
    // The freshness brand is applied by `observeMesh` after validation —
    // this raw read is not yet known to be comparable against Base.
    chainId: target.chainId,
    custodyRelocated: custody[0],
    bucket: custody[1],
    reportedCumulative: custody[2],
    localRetired: retirement[0],
    localReleased: retirement[1],
    armedFromDay: governor[0],
    outstandingFresh: governor[1],
    outstandingRecycled: governor[2],
    paidOutRecycled: governor[3],
    composition,
    repatriatedOut,
    reattribution,
    backing,
    observedAt: block.timestamp,
    },
    gaps: viewGaps,
  };
}

/**
 * Collect one tick's observation.
 *
 * @throws When the canonical chain itself cannot be resolved or read —
 *         there is no partial answer worth reporting in that case, and
 *         the caller turns it into an infrastructure alert.
 */
export async function observeMesh(
  env: Env,
  config: Config,
  scope: TickScope,
): Promise<MeshObservation> {
  const canonical = resolveChain(env, config.canonicalChainId);
  if (isCoverageGap(canonical)) {
    throw new Error(
      makeBaseRedactor(env)(
        `canonical chain ${config.canonicalChainId} unreadable: ${canonical.detail}`,
      ),
    );
  }

  // Every Base-side read this tick shares one block, so the per-chain
  // books cannot straddle a transaction that updates them together.
  //
  // And that block must be RECENT. A canonical RPC stuck on an old head
  // answers every call happily, so the watcher would read stale Base
  // books — and a Base that merely trails the mirrors is not a hard
  // violation, so nothing else would notice. It could then report
  // `ok: true` while blind to a new accounting violation or a
  // newly-wired chain (#1443 r9).
  // #1445 — and it must be the chain we think it is. Issued CONCURRENTLY
  // with the head read: verification costs one request but no extra round
  // trip, which is what makes it affordable on every tick.
  //
  // A canonical mismatch is FATAL, not a coverage gap. Every Base-side
  // figure in this tick — the expected chain set, each chain's books, the
  // whole composition position — is read from this client, so a wrong
  // canonical does not degrade the tick, it invalidates it. Treating it
  // as a gap would let the mirror-side checks run and report against
  // books from an unrelated network.
  // `allSettled`, not `all` (#1464 r2). With `all`, a wrong-network
  // canonical endpoint that answers `eth_chainId` but whose concurrent
  // `getBlock` rejects loses the FULFILLED mismatch verdict entirely, and
  // the operator gets only the generic head-read failure — both chain ids
  // and the `RPC_<id>` instruction gone. That is the same loss the mirror
  // path was just fixed for, surviving on the canonical path: the fix has
  // to be applied to both or the distinction only half exists.
  //
  // A partial failure like that is the LIKELY shape, not an exotic one: an
  // endpoint pointed at the wrong network is often also a different
  // provider, tier or auth setup, so one call succeeding while another
  // fails is unremarkable.
  const [headResult, identityResult] = await Promise.allSettled([
    canonical.client.getBlock(),
    verifyChainIdentity(canonical, 'base-books'),
  ]);

  // A real MISMATCH is preferred over the head failure: a wrong-network
  // canonical explains any read anomaly, so it is the actionable
  // diagnosis, and reporting the head error first sends the operator to a
  // provider for a fault that is not there.
  //
  // Gated on `chain-mismatch` specifically (#1464 r4).
  // `verifyChainIdentity` also returns a truthy gap when `eth_chainId`
  // itself fails — a `no-rpc`, carrying no diagnosis at all. Preferring
  // THAT would discard a genuinely more actionable head failure: an HTTP
  // 401 on `getBlock` says "the credential is wrong", and the operator
  // would instead be told `eth_chainId` was unreachable, re-labelled
  // `config`. Two unreachability reports, and we would keep the emptier
  // one.
  const canonicalIdentity =
    identityResult.status === 'fulfilled' ? identityResult.value : null;
  if (canonicalIdentity?.reason === 'chain-mismatch') {
    // PRE-CLASSIFIED, not a bare Error (#1464 r1). `runTick` passes what
    // it catches through `classify`, which substring-matches the message —
    // and this detail contains "WRONG NETWORK", so the `network` marker
    // matched and the operator was told "the endpoint could not be
    // reached", losing both chain ids and the name of the secret to fix.
    // The whole configuration-fault-vs-reachability distinction this
    // change introduces was being erased on exactly the path where it
    // matters most.
    throw new PreclassifiedFailure({
      kind: 'config',
      summary: makeBaseRedactor(env)(canonicalIdentity.detail),
    });
  }
  if (headResult.status === 'rejected') {
    // No mismatch, and the head read failed: the ordinary
    // unreachable-canonical case, and the report we PREFER over an
    // `eth_chainId` reachability gap because it can carry a status code.
    // Classified rather than forwarded, since viem puts the provider URL —
    // and its API key — in the message.
    throw new PreclassifiedFailure(
      classify(
        headResult.reason,
        `canonical head read on chain ${config.canonicalChainId}`,
      ),
    );
  }
  if (canonicalIdentity) {
    // Head read fine, but `eth_chainId` failed — so identity is UNKNOWN
    // rather than wrong. Still fatal: every Base-side figure below would
    // be read from an endpoint we cannot vouch for, and the canonical path
    // has no coverage-gap channel. Reported last, since it is the least
    // informative of the three outcomes.
    throw new PreclassifiedFailure({
      kind: 'config',
      summary: makeBaseRedactor(env)(canonicalIdentity.detail),
    });
  }
  const canonicalHead = headResult.value;
  const canonicalBlock = canonicalHead.number;
  const wallClockSeconds = Math.floor(Date.now() / 1000);
  const canonicalAge = wallClockSeconds - Number(canonicalHead.timestamp);

  const expected = await readView<readonly number[]>(
    canonical.client,
    canonical.diamond,
    'getExpectedSourceChainIds',
    [],
    canonicalBlock,
  );

  const gaps: CoverageGap[] = [];
  if (canonicalAge > config.staleLocalSeconds) {
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'stale-head',
      source: 'base-books',
      detail: `the CANONICAL chain is serving a stale head — its latest block is ${canonicalAge}s old (limit ${config.staleLocalSeconds}s). Every Base-side figure below was read from that block, so newly-introduced violations and newly-wired chains may not be visible yet.`,
    });
  }
  if (expected.length === 0) {
    // Either this is not the canonical reward chain, or the mesh source
    // set was never configured. Both make every per-chain check below
    // vacuous, so say so rather than reporting a clean tick.
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'no-deployment',
      source: 'config',
      detail: `getExpectedSourceChainIds() is empty on the configured canonical Diamond (${canonical.diamond} on chain ${config.canonicalChainId}) — the mesh source set is unconfigured, or CANONICAL_CHAIN_ID points at a mirror`,
    });
  }

  // The canonical chain must itself be IN the expected set — `finalizeDay`
  // sums the global denominators over exactly that list, so a canonical id
  // missing from it silently drops Base's own activity out of every day's
  // totals. Injecting it unconditionally for the reads below would make
  // the watcher look like it covers Base while masking precisely that
  // misconfiguration (Codex #1443 r3), so say so first, then inject.
  if (expected.length > 0 && !expected.map(Number).includes(config.canonicalChainId)) {
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'no-deployment',
      source: 'config',
      detail: `the canonical chain ${config.canonicalChainId} is NOT in getExpectedSourceChainIds() — finalizeDay sums the global denominators over that list, so Base's own activity is being dropped from every day's totals. Its books are still read below, but the on-chain source set needs fixing.`,
    });
  }

  // Base's own chain id is included on purpose: its per-chain books must
  // be inert, and `base-self-inert` is the check that proves it.
  const rotation = rotationOrder(config.canonicalChainId, expected.map(Number));
  // ONE chain per tick — see `rotation.ts`. Base is still read every tick
  // (head, identity, expected set), and Base's row for the observed chain
  // is read at the same pinned block as above.
  const observedChainId = pickChain(rotation, scope);
  if (observedChainId === null) {
    gaps.push({
      chainId: scope.kind === 'chain' ? scope.chainId : config.canonicalChainId,
      reason: 'no-deployment',
      source: 'config',
      detail:
        scope.kind === 'chain'
          ? `chain ${scope.chainId} is not in the mesh (canonical ${config.canonicalChainId} plus getExpectedSourceChainIds() = [${rotation.slice(1).join(', ')}]), so there is nothing to observe for it`
          : 'the rotation is empty, so this tick observed no chain',
    });
  }
  const chainIds = observedChainId === null ? [] : [observedChainId];

  // allSettled, not all: one chain's transient RPC error or revert would
  // otherwise discard every SUCCESSFUL chain's books and abort the whole
  // observation, so hard violations already readable elsewhere went
  // unevaluated and undelivered (Codex #1443 r6). A rejected chain
  // becomes a coverage gap; the rest are still checked.
  const bookResults = await Promise.allSettled(
    chainIds.map((id) => readBaseBooks(canonical, id, canonicalBlock, gaps)),
  );
  const books: BaseChainBooks[] = [];
  bookResults.forEach((result, i) => {
    const id = chainIds[i]!;
    if (result.status === 'fulfilled') {
      books.push(result.value);
      return;
    }
    gaps.push({
      chainId: id,
      reason: 'no-rpc',
      source: 'base-books',
      // CLASSIFIED, never forwarded — the classification boundary has to
      // hold here too, or a credential in an encoding the redactor does
      // not know still reaches the alert (#1443 r9).
      detail: describeFailure(classify(result.reason, `Base-side books for chain ${id}`)),
    });
  });

  const freshLocals = new Map<number, LocalLedger>();
  const allLocals = new Map<number, Omit<LocalLedger, FRESH>>();
  await Promise.all(
    chainIds.map(async (id) => {
      const target = id === canonical.chainId ? canonical : resolveChain(env, id);
      if (isCoverageGap(target)) {
        gaps.push(target);
        return;
      }
      // #1445 — identity is verified CONCURRENTLY with the ledger read,
      // not before it (#1464 r2). Awaiting it first added a serialized
      // round trip to every mirror on every tick and lengthened the
      // critical path by the slowest mirror's latency — while the comment
      // and README claimed no extra round trip, which made the claim
      // false for the path it was written about.
      //
      // Skipped for the canonical chain, already verified fatally above;
      // re-checking would spend a request to re-learn the same answer.
      const identityPromise =
        id === canonical.chainId
          ? Promise.resolve(null)
          : verifyChainIdentity(target, 'own-ledger');

      // `allSettled`, so a ledger read that throws cannot discard the
      // identity verdict. Order matters below: a wrong-network endpoint
      // EXPLAINS a failed or nonsense read, so the mismatch is the more
      // useful diagnosis and is reported in preference to `no-rpc`.
      const [identityResult, localResult] = await Promise.allSettled([
        identityPromise,
        readLocalLedger(target),
      ]);

      const identity =
        identityResult.status === 'fulfilled' ? identityResult.value : null;
      // Same `chain-mismatch` gating as the canonical path (#1464 r4): an
      // `eth_chainId` reachability gap must not pre-empt the ledger read's
      // own failure, which can carry a status code and is the better
      // diagnosis. The mirror had this bug too — the fix belongs on both
      // paths or the preference is inconsistent between them.
      if (identity?.reason === 'chain-mismatch') {
        // Treated exactly like the freshness gate below: gap, and excluded
        // from `allLocals` as well as `freshLocals`. A wrong-network ledger
        // is not merely unusable for cross-chain comparison — it would be
        // compared against Base as if it were this chain and produce a
        // false CRITICAL, the worst output this Worker has.
        gaps.push(identity);
        return;
      }
      if (localResult.status === 'rejected') {
        // REDACT: viem puts the request URL in its error messages, and
        // provider URLs carry the API key in the path or query. This
        // string ends up in a Telegram alert (Codex #1443 r4).
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          source: 'own-ledger',
          detail: describeFailure(
            classify(localResult.reason, `own-ledger read on chain ${id}`),
          ),
        });
        return;
      }
      if (identity) {
        // Ledger read fine, `eth_chainId` failed: identity UNKNOWN, not
        // wrong. Recorded as a gap and the chain excluded, because a
        // snapshot from an endpoint whose identity we cannot vouch for must
        // not be compared against Base — that is the same reasoning as the
        // mismatch case, and the weaker evidence does not weaken it.
        gaps.push(identity);
        return;
      }
      try {
        const { ledger, gaps: viewGaps } = localResult.value;
        // BEFORE the stale-head early return below, or a chain that is BOTH
        // stale and missing the composition view would lose this gap
        // entirely (#1448 r3).
        gaps.push(...viewGaps);
        // FRESHNESS GATE. A mirror RPC serving a stale head makes Base
        // legitimately ahead of what we just read, and
        // `base-ahead-of-chain` would report that as ledger corruption —
        // a false CRITICAL, the worst thing this Worker can emit (Codex
        // #1443 r6). Too-stale snapshots are treated exactly like an
        // unreadable chain: surfaced as a coverage gap, and excluded from
        // every cross-chain comparison. Base-side checks still run.
        // Retained regardless of age: same-chain checks (bucket
        // coverage) compare figures from ONE pinned block and stay valid
        // however old it is.
        allLocals.set(id, ledger);
        const verdict = asFreshSnapshot(
          ledger,
          wallClockSeconds,
          config.staleLocalSeconds,
        );
        if ('stale' in verdict) {
          gaps.push({
            chainId: id,
            reason: 'stale-head',
            source: 'own-ledger',
            detail: `chain ${id} is serving a stale head — its latest block is ${verdict.ageSeconds}s old (limit ${config.staleLocalSeconds}s), so Base can legitimately hold newer figures than this snapshot. CROSS-CHAIN comparisons for this chain are skipped this tick; same-chain checks still run.`,
          });
          return;
        }
        freshLocals.set(id, verdict.fresh);
      } catch (err) {
        // The READ's own rejection is handled above, by the `allSettled`
        // branch. What can still reach here is the post-read processing:
        // the freshness validation and the map writes. Kept as a net
        // rather than deleted — a throw from here would otherwise abort
        // this chain's closure silently and leave it out of the tick with
        // no gap at all, which is the one outcome this Worker must never
        // produce — but the CONTEXT no longer says "read", because a
        // mislabelled gap sends an operator to the RPC provider for a
        // fault that is not there (#1464 r2).
        //
        // REDACT regardless: viem's messages carry the request URL and
        // provider URLs carry the API key, and this string reaches a
        // Telegram alert (Codex #1443 r4).
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          source: 'own-ledger',
          detail: describeFailure(
            classify(err, `own-ledger snapshot processing on chain ${id}`),
          ),
        });
      }
    }),
  );

  return {
    canonicalChainId: config.canonicalChainId,
    expectedChainIds: rotation,
    observedChainId,
    rotation,
    books,
    freshLocals,
    allLocals,
    gaps,
  };
}
