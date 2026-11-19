/**
 * #3755 / #3768 — the interest a loan has paid, from the statements the
 * indexer keeps in `loan_interest_events` (migration 0103).
 *
 * The contracts state every interest payment on a loan once
 * (`LoanInterestPaid`, the one step every payment passes through: a
 * repayment, a partial repayment, a preclose, a refinance payoff, a
 * swap-to-repay, a prepay-listing sale, a forced sale, a discounted
 * liquidation, the payment reserve and the periodic sale), and state a
 * take-back when a payment parked for the lender side arrived short
 * (`LoanInterestUndelivered`). A loan's interest paid up to a moment is the
 * sum of its 'paid' rows less the sum of its 'undelivered' rows up to then.
 *
 * What the figure is: the interest the loan's settlements CHARGED, late fee
 * included where the route charges one, before the treasury's yield fee, in
 * the loan's principal asset. A forced sale counts what it recovered, not
 * what was owed. It says what the loan paid, not who received it. What it
 * leaves out: a fallback recovery (settled as one amount with the principal
 * and the bonus, so no interest figure exists) and NFT rentals, for which the
 * contracts state nothing.
 *
 * Side-effect-free, so it is unit-tested on its own; the amounts are summed
 * as bigint here because they can exceed SQLite's 64-bit integers.
 */

/** One statement row of `loan_interest_events`. */
export interface LoanInterestRow {
  loan_id: number;
  kind: 'paid' | 'undelivered' | string;
  gross: string;
  block_at: number;
}

/**
 * Interest paid per loan up to and including `asOf` (unix seconds). A loan
 * whose take-backs exceed its payments in the rows given (only possible when
 * the caller passed a partial history) reads as zero, never as negative,
 * which is how the contracts' own counter behaves.
 */
export function interestPaidByLoan(rows: readonly LoanInterestRow[], asOf: number): Map<number, bigint> {
  const net = new Map<number, bigint>();
  for (const r of rows) {
    if (r.block_at > asOf) continue;
    let v: bigint;
    try {
      v = BigInt(r.gross);
    } catch {
      continue;
    }
    if (v <= 0n) continue;
    if (r.kind === 'paid') net.set(r.loan_id, (net.get(r.loan_id) ?? 0n) + v);
    else if (r.kind === 'undelivered') net.set(r.loan_id, (net.get(r.loan_id) ?? 0n) - v);
  }
  for (const [id, v] of net) if (v < 0n) net.set(id, 0n);
  return net;
}
