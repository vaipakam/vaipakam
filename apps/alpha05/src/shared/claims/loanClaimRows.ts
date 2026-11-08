/**
 * LN-50 — the loan payouts the Claims page lists, found by the position the
 * wallet holds: the protocol's pending rule lists the claims of the party
 * recorded at origination, so each listed row is kept only while the wallet
 * still holds that side's position, and a held position on an ended loan the
 * wallet received from someone else (which that rule does not cover) is read
 * on its own, its claim asked of the protocol directly.
 *
 * Every row is then read from the chain as the claim reads it: the loan's
 * state, that side's holder now, and the side's claim with its payouts. A
 * row whose claim could not be read is kept and said to be unread, never
 * dropped; a received position whose claim is confirmed empty is left out.
 */
import { readPositionOwnerFor } from '../positions/positionNft';
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, LoanFacetABI } from '@vaipakam/contracts/abis';
import type { LoanDetails } from '../positions/loanView';
import type { PayoutRow, Payouts } from '../positions/reads';
import { claimLanes, sideOpen, type ClaimLane, type ClaimSide, type SideClaim } from './loanClaim';
import { readSideClaim } from './loanClaimReview';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;

export interface LoanClaimRow {
  loanId: bigint;
  side: ClaimSide;
  /** Listed by the protocol's pending rule (false: a received position). */
  listed: boolean;
  /** Null when the loan could not be read. */
  loan: LoanDetails | null;
  holder: Hex | null;
  /** Null when unread. */
  claim: SideClaim | null;
  lanes: ClaimLane[];
}

export interface LoanClaimRows {
  /** The protocol pause, which stops every claim; null when unread. */
  paused: boolean | null;
  rows: LoanClaimRow[];
  /** The walks behind the list reached their end (not cut by a cap). */
  complete: boolean;
}

async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function readRow(c: PublicClient, diamond: Hex, p: PayoutRow, listed: boolean): Promise<LoanClaimRow> {
  const loan = await maybe(c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [p.loanId] }) as Promise<LoanDetails>);
  if (!loan) return { loanId: p.loanId, side: p.side, listed, loan: null, holder: null, claim: null, lanes: [] };
  const [holder, claim] = await Promise.all([
    // #3205: the side's LIVE holder through the position-NFT door; a retired
    // (or burned) token has none.
    maybe(readPositionOwnerFor(c, diamond, p.side === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId)),
    readSideClaim(c, diamond, p.loanId, p.side),
  ]);
  const lanes = claim
    ? claimLanes(p.side, claim, {
        assetType: Number(loan.assetType),
        principalAsset: loan.principalAsset,
        prepayAsset: loan.prepayAsset,
        tokenId: loan.tokenId,
        quantity: loan.quantity,
      })
    : [];
  return { loanId: p.loanId, side: p.side, listed, loan, holder, claim, lanes };
}

export async function readLoanClaimRows(c: PublicClient, diamond: Hex, payouts: Payouts): Promise<LoanClaimRows> {
  const [paused, listed, received] = await Promise.all([
    maybe(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused' }) as Promise<boolean>),
    Promise.all(payouts.rows.map((p) => readRow(c, diamond, p, true))),
    Promise.all(payouts.unlisted.map((p) => readRow(c, diamond, p, false))),
  ]);
  // A received position is listed once its claim is confirmed open; one
  // that could not be read stays, said to be unread.
  const kept = received.filter((r) => r.claim === null || r.loan === null || sideOpen(r.side, r.claim, Number(r.loan.assetType)));
  return {
    paused,
    rows: [...listed, ...kept].sort((a, b) => (a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : a.side === b.side ? 0 : a.side === 'lender' ? -1 : 1)),
    complete: payouts.complete,
  };
}
