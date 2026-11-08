/**
 * LN-62 — a borrower's extension reserve (#2814). The holder of a loan's
 * borrower position can set aside the loan's principal token in their own
 * vault for its extensions: an extension, the keeper's or the borrower's own,
 * draws on that reserve first. The reserve stays the depositor's: it is not
 * free balance while reserved, it is never moved by anyone else, and the
 * depositor can take back what is unused whatever the loan's state and
 * whether or not they still hold the borrower position.
 *
 * Everything here is read from the chain. The index only names the loans a
 * wallet funded, was charged on, or withdrew a reserve from (candidates
 * widen, never decide); each loan is then read as `withdrawExtendReserve`
 * reads it, and the protocol's dry run is the last word on whether it pays
 * now (it also checks the account's manager and the sanctions screen).
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AutoLifecycleFacetABI, LoanFacetABI, VaipakamNFTFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { ASSET_ERC20, LOAN_STATUS_ACTIVE } from '../positions/model';
import { answerOrNull } from '../reads/answer';
import { discoverActorLoans } from '../reads/world/actorLoans';
import type { IndexerClient } from '../reads/world/indexerClient';
import { frozenRefusal, type FrozenState } from '../sanctions/posture';

type Hex = `0x${string}`;

export const AUTO = AutoLifecycleFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const NFT = VaipakamNFTFacetABI as Abi;

/** The three events the indexer files under the reserve's depositor. */
export const RESERVE_KINDS = ['ExtendReserveFunded', 'ExtendReserveWithdrawn', 'ExtendChargeDrawn'] as const;

/** The loans the index names under `wallet` for any step of a reserve. */
export function discoverReserveLoans(indexer: IndexerClient, chainId: number, wallet: Hex): Promise<{ loanIds: bigint[]; complete: boolean }> {
  return discoverActorLoans(indexer, chainId, wallet, RESERVE_KINDS);
}

/** `getExtendFunding(loanId, wallet)`: the reserve and what an extension
 *  would charge now and at the end of its window (both 0 for a loan that
 *  cannot be extended). */
export interface ReserveFunding {
  asset: Hex;
  reserved: bigint;
  otherFree: bigint;
  chargeNow: bigint;
  chargeAtGraceEnd: bigint;
}

/** One loan as the depositor's withdrawal reads it. */
export interface ReserveRow {
  loanId: bigint;
  /** Null when the loan could not be read. */
  loan: LoanDetails | null;
  /** Null when the funding view could not be read. */
  funding: ReserveFunding | null;
  /** The borrower position's holder now; null when unread (or the position
   *  token is gone, once the loan's borrower side has collected). */
  borrowerHolder: Hex | null;
}

type FundingTuple = readonly [Hex, bigint, bigint, bigint, bigint];

/** One loan, every read at one block (`blockNumber`, or the head). */
export async function readReserveRow(c: PublicClient, diamond: Hex, loanId: bigint, wallet: Hex, blockNumber?: bigint): Promise<ReserveRow> {
  const at = { blockNumber: blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 })) };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[]) => answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const [loan, funding] = await Promise.all([read<LoanDetails>(LOAN, 'getLoanDetails', [loanId]), read<FundingTuple>(AUTO, 'getExtendFunding', [loanId, wallet])]);
  const borrowerHolder = loan ? await read<Hex>(NFT, 'ownerOf', [loan.borrowerTokenId]) : null;
  return {
    loanId,
    loan,
    funding: funding ? { asset: funding[0], reserved: funding[1], otherFree: funding[2], chargeNow: funding[3], chargeAtGraceEnd: funding[4] } : null,
    borrowerHolder,
  };
}

/** Whether an extension of the loan can still draw on this wallet's reserve:
 *  the loan can be extended (running, an ERC-20 loan, no interest cadence),
 *  and the wallet holds the borrower position, since an extension charges
 *  only the current holder's vault. `null` when an input is unread. */
export function reserveDrawable(row: ReserveRow, wallet: Hex): boolean | null {
  if (row.loan === null) return null;
  const extendable = Number(row.loan.status) === LOAN_STATUS_ACTIVE && Number(row.loan.assetType) === ASSET_ERC20 && Number(row.loan.periodicInterestCadence) === 0;
  if (!extendable) return false;
  if (row.borrowerHolder === null) return null;
  return row.borrowerHolder.toLowerCase() === wallet.toLowerCase();
}

/** Whether the row belongs on the list: a reserve left, or a read that
 *  failed (said so, never dropped). */
export function reserveRowShown(row: ReserveRow): boolean {
  if (row.funding === null) return true;
  return row.funding.reserved > 0n;
}

/**
 * RB-ELIG for `withdrawExtendReserve`, in the order it checks: the protocol
 * pause (the withdrawal is one of the withdrawals a pause stops); the
 * sanctions screen on the caller, which here is fail-open in an outage, so
 * only a flagged wallet is refused (RB-FROZEN); then whether anything is
 * reserved. The account-manager check is the dry run's.
 */
export function reserveVerdict(row: ReserveRow, paused: boolean | null, copy: Pick<CopyAccess, 'text'>, readAt: number, frozen?: FrozenState): Verdict {
  const { text } = copy;
  const refuse = (code: string, reason: string, switchClass: '2' | null = null): Verdict =>
    closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], switchClass, readAt, 'own');
  if (paused === null) return unknownVerdict(text('reserve.unread'));
  if (paused) return refuse('EnforcedPause', text('reserve.paused'), '2');
  if (frozen === 'flagged') return closed([frozenRefusal('flagged', copy)], null, readAt, 'own');
  if (row.funding === null) return unknownVerdict(text('reserve.unread'));
  if (row.funding.reserved === 0n) return refuse('ExtendReserveZeroAmount', text('reserve.nothing'));
  return { ...OPEN, readAt, rail: 'own' };
}

/** The whole row as a key: any change to what the review states reopens it. */
export function reserveRowKey(row: ReserveRow): string {
  return [
    row.loan ? `${row.loan.status}:${row.loan.principalAsset}` : 'unread',
    row.funding ? `${row.funding.asset.toLowerCase()}=${row.funding.reserved}` : 'unread',
    row.borrowerHolder?.toLowerCase() ?? '-',
  ].join('|');
}

// ─── The transaction's own record ─────────────────────────────────────────

/** What the transaction recorded as withdrawn from `holder`'s reserve on
 *  `loanId`: the amount, and what stays reserved after it. */
export function reserveLogs(logs: readonly Log[], diamond: Hex, loanId: bigint, holder: Hex): { asset: Hex; amount: bigint; reserved: bigint }[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: AUTO, logs: [...own], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
  return events
    .filter((e) => e.eventName === 'ExtendReserveWithdrawn' && BigInt(String(e.args.loanId ?? -1)) === loanId && String(e.args.holder).toLowerCase() === holder.toLowerCase())
    .map((e) => ({ asset: e.args.asset as Hex, amount: BigInt(String(e.args.amount)), reserved: BigInt(String(e.args.reserved)) }));
}
