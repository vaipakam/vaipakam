/**
 * The summary over a wallet's live loans (#3320), one per side: what is still
 * lent out or owed in principal, per token; the next date a payment falls
 * due; and the loans that need the reader now. It adds the loans up and
 * manages none of them: every loan stays its own position and its own row.
 *
 * It reads only what the list reads (the held loans and their deadlines), and
 * so states what it cannot know rather than guessing (RB-FUNDS):
 *  - amounts in different tokens are never added together; the value
 *    comparison at today's prices is the exposure line's, which counts what
 *    it cannot price;
 *  - an NFT rental has no token amount, so it is counted, not totalled;
 *  - a loan whose dates could not be read is counted, because the next date
 *    may be its own;
 *  - interest is not in the principal totals; each loan's page reads what
 *    repaying it costs now.
 */
import { ASSET_ERC20, loanObligations, type Deadlines, type LiveLoanRow } from './model';

type Hex = `0x${string}`;

export interface TokenTotal {
  asset: Hex;
  amount: bigint;
}

export interface NextDate {
  loanId: bigint;
  at: number;
  /** The loan's final repayment, or an owed periodic-interest checkpoint. */
  kind: 'repayment' | 'interest';
}

export interface SideSummary {
  loans: number;
  /** Principal per ERC-20 token, in the order the tokens first appear. */
  principal: TokenTotal[];
  /** Loans whose principal is an NFT (rentals): counted, never totalled. */
  rentals: number;
  /** The earliest date still ahead, across the side's loans; null when none. */
  next: NextDate | null;
  /** Loans whose dates could not be read: the next date may be one of them. */
  undated: bigint[];
  /** Loans with a payment past its date and its grace period still running. */
  inGrace: bigint[];
  /** Loans with a grace period that has ended. */
  pastGrace: bigint[];
  /** Loans whose collateral sale did not complete. */
  fallback: bigint[];
}

export interface BookSummary {
  borrowed: SideSummary | null;
  lent: SideSummary | null;
}

function emptySide(): SideSummary {
  return { loans: 0, principal: [], rentals: 0, next: null, undated: [], inGrace: [], pastGrace: [], fallback: [] };
}

function addPrincipal(totals: TokenTotal[], asset: Hex, amount: bigint): void {
  const key = asset.toLowerCase();
  const hit = totals.find((t) => t.asset.toLowerCase() === key);
  if (hit) hit.amount += amount;
  else totals.push({ asset, amount });
}

function earlier(a: NextDate | null, b: NextDate): NextDate {
  return a === null || b.at < a.at || (b.at === a.at && b.loanId < a.loanId) ? b : a;
}

/**
 * Sums the live loans per side. A loan that is past its grace period on one
 * obligation and in grace on the other is listed once, under the more severe
 * one. A wallet holding both sides of one loan counts it on each side.
 */
export function bookSummary(rows: readonly LiveLoanRow[], deadlinesOf: (row: LiveLoanRow) => Deadlines | null, nowSec: number): BookSummary {
  let borrowed: SideSummary | null = null;
  let lent: SideSummary | null = null;
  for (const row of rows) {
    const side = row.borrowerSide ? (borrowed ??= emptySide()) : (lent ??= emptySide());
    const l = row.loan;
    side.loans++;
    if (l.assetType === ASSET_ERC20) addPrincipal(side.principal, l.principalAsset, l.principal);
    else side.rentals++;

    const { stage, interest } = loanObligations(row, deadlinesOf(row), nowSec);
    if (stage.kind === 'fallback') {
      side.fallback.push(l.id);
      continue;
    }
    if (stage.kind === 'deadline-unknown') side.undated.push(l.id);
    if (stage.kind === 'grace-over' || interest?.kind === 'interest-overdue') side.pastGrace.push(l.id);
    else if (stage.kind === 'in-grace' || interest?.kind === 'interest-in-grace') side.inGrace.push(l.id);

    if (stage.kind === 'running' || stage.kind === 'due-soon') side.next = earlier(side.next, { loanId: l.id, at: stage.dueAt, kind: 'repayment' });
    if (interest && (interest.kind === 'interest-later' || interest.kind === 'interest-soon'))
      side.next = earlier(side.next, { loanId: l.id, at: interest.dueAt, kind: 'interest' });
  }
  return { borrowed, lent };
}
