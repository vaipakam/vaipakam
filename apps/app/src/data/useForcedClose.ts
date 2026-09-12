/**
 * Live reads behind the lender's forced close-out card.
 *
 * Everything here exists to feed `decideForcedClose` FACTS. The
 * decision itself is pure and lives in `forcedClose.ts` so it can be
 * tested without a chain; this module's only job is answering its
 * questions honestly, including answering "I don't know" when a read
 * fails.
 *
 * ## One aggregate, with per-fact failure kept independent
 *
 * The polled facts are read in a single Multicall3 `aggregate3` with
 * `allowFailure`, built and read back by `forcedCloseReads.ts`. That
 * module's header carries the argument; the short form is that the old
 * one-query-per-fact design existed so a failed LTV read — which happens
 * NORMALLY on illiquid collateral — could not take defaultability down
 * with it, and a per-call status preserves exactly that while making one
 * request instead of seven.
 *
 * What the aggregate adds is provenance. `Multicall3.getBlockNumber()`
 * rides inside it, so every fact and the block it was evaluated at come
 * from the same execution. The card publishes that block (#2098, #2131):
 * a surface touching funds states what it knows, and "as of which block"
 * is part of what it knows.
 *
 * EVERY decision input is in the aggregate, including the loan's own
 * status, consent flag and shape (#2148 round 1 P1). The first version
 * left consent as a separate long-staleTime query — set at init, never
 * changes, any block is a valid answer — and took status and shape from
 * the page's own reads. The immutability argument was sound and still
 * beside the point: the block is published as the height the DECISION was
 * made at, and a decision assembled from inputs evaluated at different
 * times has no single height. Reading the loan struct as one more call in
 * the same execution makes the claim true without exceptions, at the cost
 * of one call in an `eth_call` that was already being made.
 *
 * ## The read that is allowed to fail
 *
 * `calculateLTV` is expected to revert for illiquid collateral, so its
 * failure is reported as `undefined` rather than surfaced. That is safe
 * only because `decideForcedClose` reaches the LTV question ONLY after
 * establishing the collateral is liquid — where a revert is genuinely
 * abnormal and `undefined` correctly becomes `unknown`. If that
 * ordering ever changes, this leniency has to be revisited with it.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { forcedCloseFacts, forcedCloseReadPlan } from './forcedCloseReads';

/** Poll cadence. The interesting transitions here are slow — a grace
 *  period expiring, a sequencer recovering — but a lender sitting on
 *  the page as grace lapses should see the card turn actionable
 *  without a manual reload. */
const REFETCH_MS = 30_000;

export interface ForcedCloseReads {
  /** `loan.status === Active`, from the aggregate. */
  active: boolean | undefined;
  /** The principal leg's kind, from the aggregate. */
  assetType: 'erc20' | 'rental' | undefined;
  /** The collateral leg is an NFT, from the aggregate. */
  collateralIsNft: boolean | undefined;
  defaultable: boolean | undefined;
  sequencerHealthy: boolean | undefined;
  paused: boolean | undefined;
  consentFromBoth: boolean | undefined;
  internalMatchCandidate: boolean | undefined;
  collateralIlliquid: boolean | undefined;
  ltvCollapsed: boolean | undefined;
  /** The block every fact above was evaluated at — `block.number` of
   *  the aggregate's own execution, not a sighting taken beside it.
   *  `undefined` while unread, when the aggregate failed, or in the one
   *  case where only the block call inside it failed. */
  block: bigint | undefined;
  /** When the decision inputs last settled.
   *
   *  The card releases its post-submit hold once this passes the submit
   *  stamp, so the question it must answer is "has every fact behind
   *  the verdict been rechecked since I submitted?" — not "has any of
   *  them".
   *
   *  It was `defaultable` alone, on the reasoning that a composite
   *  would answer the weaker question. Round 34 P2 showed the argument
   *  had expired: round 31 made the independently-polled match
   *  candidate part of actionability, so after a PARTIAL match — which
   *  leaves the loan Active and consumes the opposing candidate — the
   *  `defaultable` refetch could land first and release the hold while
   *  `internalMatch` still served its stale `true`, re-offering an
   *  empty-route close-out that the live simulation would then refuse.
   *  It then became the OLDEST settle time across several queries.
   *
   *  With every fact in one aggregate there is one query and one settle
   *  time, which is the strong form of that requirement by construction.
   *
   *  Settled means data OR error: a query that fails after the submit
   *  has genuinely been rechecked, and its `undefined` feeds the
   *  decision honestly. */
  updatedAt: number;
}

export function useForcedCloseReads(opts: {
  loanId: string | number | undefined;
  /** The loan's collateral asset. `undefined` while the loan read is
   *  in flight — the liquidity read is left out of the aggregate rather
   *  than asked of a zero address, which `checkLiquidity` rejects
   *  outright with `InvalidAsset`. */
  collateralAsset: `0x${string}` | undefined;
  /** Only mount these reads for a lender looking at an Active loan.
   *  Everything else pays RPC for an answer nothing renders. */
  enabled: boolean;
}): ForcedCloseReads {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const diamond = readChain.diamondAddress as `0x${string}`;
  const loanId = opts.loanId;
  const on = opts.enabled && loanId !== undefined && Boolean(publicClient);

  const reads = useQuery({
    // The asset is part of the key because it changes the plan's shape.
    queryKey: [
      'forcedClose',
      'reads',
      readChain.chainId,
      String(loanId),
      opts.collateralAsset ?? '',
    ],
    enabled: on,
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      // Every chain this app supports carries the canonical Multicall3 in
      // its viem definition. A chain without one is a configuration
      // error, thrown rather than worked around: a second code path that
      // silently reads seven times without a block is exactly the kind of
      // divergence this aggregate was built to remove.
      const multicall3 = publicClient!.chain?.contracts?.multicall3?.address;
      if (!multicall3) {
        throw new Error(`no Multicall3 configured for chain ${readChain.chainId}`);
      }
      const plan = forcedCloseReadPlan({
        diamond,
        multicall3,
        loanId: BigInt(loanId!),
        collateralAsset: opts.collateralAsset,
      });
      const slots = await publicClient!.multicall({
        allowFailure: true,
        // The plan's entries are built against the diamond's ABI and the
        // one Multicall3 fragment above; the loose `contract` type on the
        // plan is what lets the mapper be tested without viem's generics.
        contracts: plan.map((e) => e.contract) as never,
      });
      return forcedCloseFacts(plan, slots as never);
    },
  });

  // `isError` disqualifies a cached value rather than ranking below it —
  // the house rule from `loanLive` and the sale lock. A stale
  // "defaultable" retained through a failed refetch would keep a submit
  // button live against a loan whose status may have moved. The whole
  // aggregate failing is a provider failure, and every fact reads unknown.
  const facts = reads.isError ? undefined : reads.data;

  return {
    active: facts?.active,
    assetType: facts?.assetType,
    collateralIsNft: facts?.collateralIsNft,
    defaultable: facts?.defaultable,
    sequencerHealthy: facts?.sequencerHealthy,
    paused: facts?.paused,
    consentFromBoth: facts?.consentFromBoth,
    internalMatchCandidate: facts?.internalMatchCandidate,
    collateralIlliquid: facts?.collateralIlliquid,
    ltvCollapsed: facts?.ltvCollapsed,
    block: facts?.block,
    updatedAt: Math.max(reads.dataUpdatedAt, reads.errorUpdatedAt),
  };
}
