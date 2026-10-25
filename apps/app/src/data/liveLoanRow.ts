/**
 * Live-chain fallback for a single loan row (#982 review): synthesize
 * an `IndexedLoan`-shaped row from the Diamond's `getLoanDetails` so a
 * loan the indexer hasn't caught up to (or missed) is still viewable —
 * the exact indexer-lag window the on-chain claimables discovery covers
 * must also be covered by the detail page those claims deep-link to.
 *
 * Shared by `useLoan` (detail-page fallback) and `useMyClaimables`
 * (chain-only candidate synthesis). Lives in its own module so both can
 * import it without a hooks ⇄ claimables cycle.
 */
import { type PublicClient } from "viem";
import { DIAMOND_ABI_VIEM } from "@vaipakam/contracts/abis";
import {
  graceSecondsFromBuckets,
  loanDeadlines,
  pauseInForceAt,
  readPauseLog,
  type GraceBucket,
} from "@vaipakam/lib/loanClock";
import { LIVE_STATUS_TO_INDEXED } from "../lib/types";
import type {
  IndexedLoan,
  IndexedLoanDeadlines,
  IndexedLoanStatus,
} from "./indexer";

/** True when a failed read is a contract REVERT / empty-data (an
 *  authoritative "no" — e.g. no such loan, a burned position NFT, or a
 *  not-claimable side) rather than a transport error.
 *
 *  Re-exported for this module's existing callers; the DEFINITION moved to
 *  `@vaipakam/lib` when the indexer's #2101 repair needed the same rule for
 *  the same decision, and two surfaces answering it differently would be
 *  worse than either answer (#2190 r6). */
export { isRevert } from "@vaipakam/lib/contractRevert";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Map a live loan struct (getLoanDetails' full struct, or the #1046
 *  batch view's `LoanSummary` — the field names are identical) plus
 *  its party addresses onto the indexer-row shape. Returns `null` for
 *  a zeroed struct (unknown id — the views return zero values instead
 *  of reverting, and status 0 would otherwise read as a fake "Active"
 *  loan with zero parties) or an unknown FUTURE status enum value. */
export function mapLoanStructToRow(
  d: Record<string, unknown>,
  lender: string,
  borrower: string,
  chainId: number,
  loanId: number,
): IndexedLoan | null {
  if (
    lender.toLowerCase() === ZERO_ADDR &&
    borrower.toLowerCase() === ZERO_ADDR
  ) {
    return null;
  }
  const status = (
    LIVE_STATUS_TO_INDEXED as Record<number, IndexedLoanStatus | undefined>
  )[Number(d.status)];
  if (!status) return null;
  return {
    chainId,
    loanId,
    offerId: Number(d.offerId ?? 0n),
    status,
    lender,
    borrower,
    principal: String(d.principal),
    // The live struct keeps only the outstanding principal; what the loan was
    // initiated with is not in it, so this row says it does not know (#2453).
    initPrincipal: null,
    // Likewise the executed terms: the struct holds only the live ones.
    initRateBps: null,
    initDurationDays: null,
    collateralAmount: String(d.collateralAmount),
    assetType: Number(d.assetType),
    collateralAssetType: Number(d.collateralAssetType),
    lendingAsset: String(d.principalAsset),
    collateralAsset: String(d.collateralAsset),
    durationDays: Number(d.durationDays),
    tokenId: String(d.tokenId),
    collateralTokenId: String(d.collateralTokenId),
    lenderTokenId: String(d.lenderTokenId),
    borrowerTokenId: String(d.borrowerTokenId),
    interestRateBps: Number(d.interestRateBps),
    startTime: Number(d.startTime),
    allowsPartialRepay: Boolean(d.allowsPartialRepay),
    startBlock: 0,
    startAt: Number(d.startTime),
    terminalBlock: null,
    terminalAt: null,
    updatedAt: 0,
  };
}

/** Read the live loan struct and map it onto the indexer-row shape.
 *  Returns `null` when the loan doesn't exist or carries an unknown
 *  FUTURE status enum value (an honest "not found / can't represent"
 *  instead of a lying row). THROWS on revert or transport failure —
 *  callers split those with `isRevert`. */
export async function readLoanRowLive(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  chainId: number,
  loanId: number,
): Promise<IndexedLoan | null> {
  const d = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: "getLoanDetails",
    args: [BigInt(loanId)],
  })) as Record<string, unknown>;
  return mapLoanStructToRow(
    d,
    String(d.lender),
    String(d.borrower),
    chainId,
    loanId,
  );
}

/** Why {@link withChainDeadlines} could not date the rows: the block, the
 *  pause log or the grace schedule did not read. */
export const CHAIN_CLOCK_UNREAD = "chain-clock-unread";

/**
 * Date each ACTIVE chain-read row on the D2 loan clock (#668 / #935, #2808),
 * the same figures the indexer serves as `IndexedLoan.deadlines`.
 *
 * A row built from the live struct carries no deadlines of its own, and a
 * list that reads its rows from the chain (`readOwnLoanRowsLive`) would
 * otherwise state every open loan's due date as unknown. One block, its
 * pause log and the grace schedule date them all, read at that one block so
 * the credit and the "paused now" flag describe the same moment. When any
 * of the three does not read, every active row says so
 * (`available: false`) rather than falling back to the original date, and
 * the rows themselves are still returned: the list's existence and status
 * answers do not depend on the clock. A Diamond that predates the pause log
 * reads as never paused, which is what its loans are held to.
 */
export async function withChainDeadlines<T extends IndexedLoan>(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  rows: readonly T[],
): Promise<T[]> {
  if (!rows.some((r) => r.status === "active")) return [...rows];
  let dateRow: (r: T) => IndexedLoanDeadlines;
  try {
    const block = await publicClient.getBlock();
    const [pauseLog, buckets] = await Promise.all([
      readPauseLog({
        client: publicClient,
        diamond,
        blockNumber: block.number,
      }),
      publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: "getGraceBuckets",
        blockNumber: block.number,
      }) as Promise<readonly GraceBucket[]>,
    ]);
    const at = block.timestamp;
    const pauseInForce = pauseInForceAt(pauseLog, at);
    dateRow = (r) => {
      const durationDays = BigInt(r.durationDays);
      const d = loanDeadlines(
        { startTime: BigInt(r.startTime), durationDays },
        graceSecondsFromBuckets(buckets, durationDays),
        pauseLog,
        at,
      );
      return {
        available: true,
        originalMaturity: Number(d.originalMaturity),
        pauseCredit: Number(d.pauseCredit),
        maturity: Number(d.maturity),
        graceEnd: Number(d.graceEnd),
        pauseInForce,
        asOf: Number(at),
      };
    };
  } catch {
    dateRow = () => ({ available: false, reason: CHAIN_CLOCK_UNREAD });
  }
  return rows.map((r) =>
    r.status === "active" ? { ...r, deadlines: dateRow(r) } : r,
  );
}
