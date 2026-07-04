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
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { LIVE_STATUS_TO_INDEXED } from '../lib/types';
import type { IndexedLoan, IndexedLoanStatus } from './indexer';

/** True when a failed read is a contract REVERT / empty-data (an
 *  authoritative "no" — e.g. no such loan, a burned position NFT, or a
 *  not-claimable side) rather than a transport error. */
export function isRevert(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    (e.walk((x) => x instanceof ContractFunctionRevertedError) !== null ||
      e.walk((x) => x instanceof ContractFunctionZeroDataError) !== null)
  );
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

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
    functionName: 'getLoanDetails',
    args: [BigInt(loanId)],
  })) as Record<string, unknown>;
  // getLoanDetails does NOT revert for an unknown id — it returns the
  // ZEROED struct, whose status 0 reads as "Active". Without this
  // guard a bogus/future id would render as a fake active loan with
  // zero parties instead of the not-found state.
  if (
    String(d.lender).toLowerCase() === ZERO_ADDR &&
    String(d.borrower).toLowerCase() === ZERO_ADDR
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
    lender: String(d.lender),
    borrower: String(d.borrower),
    principal: String(d.principal),
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
