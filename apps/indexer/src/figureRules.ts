/**
 * #3879 — the counting rule for public figures (ProjectKitDesign.md §8,
 * guard 1). One module so every figure the indexer publishes (the loan
 * totals, the agreed-rate candles, and later the rental figures of #3882)
 * applies the same rule and states it in the same words.
 *
 * THE RULE.
 *
 *  1. No value total. The index reads no price, so it never adds amounts of
 *     different assets together. Every amount is stated in its own asset's
 *     smallest units, on its own line. A figure that would need a price is
 *     not formed here.
 *
 *  2. One address on both sides. A loan whose lender and borrower were the
 *     same address when it opened is left out of rate figures and counted
 *     on its own line. "When it opened" means the two parties the opening
 *     event names, kept on the loan row as `init_lender` / `init_borrower`
 *     (migration 0118): a later sale or handover moves a loan neither in
 *     nor out. `loans.lender` / `loans.borrower` are rewritten by a sale or
 *     a handover, and `loan_participants` records the position holders at
 *     opening rather than the event's parties, so neither can answer this.
 *     A figure taken from a sale or a takeover applies the same test to
 *     that event's own parties. The rule sees one address on both sides
 *     only. It cannot see two addresses that belong to one person, and
 *     every figure that applies it says so. A loan whose opening parties
 *     cannot be established is left out of rate figures too, and counted
 *     on its own line as "opening parties unknown": it is never assumed to
 *     have two parties.
 *
 *  3. No mean across assets or terms. Every rate figure is per lending
 *     asset and term range; no figure averages rates of different assets
 *     or different terms together.
 *
 *  4. Each figure states its block and what it leaves out. The feed's
 *     envelope carries the block; each route's `about.excludes` and the
 *     `counting` object below carry the rest.
 */

/** What every figure says about amounts (rule 1). */
export const NO_VALUE_TOTAL =
  "Each amount is in its own asset's smallest units. No value total is formed: the index reads no price, so amounts of different assets are never added together.";

/** What every figure that applies rule 2 says about it. */
export const ONE_ADDRESS_RULE =
  'A loan whose opening event names the same address as lender and borrower is left out of rate figures and counted on its own line; a later sale or handover moves a loan neither in nor out. The rule sees one address on both sides only; it cannot see two addresses that belong to one person. A loan whose opening parties cannot be established is left out too, counted as `openingPartiesUnknown`, and never assumed to have two parties.';

/** What every figure says about rates (rule 3). */
export const NO_CROSS_MEAN =
  'No figure is a mean across assets or terms: every rate figure is per lending asset and term range.';

/** The short phrases for a route's `about.excludes`. */
export const ONE_ADDRESS_EXCLUDES =
  'loans whose lender and borrower were the same address when they opened (counted as `oneAddress`; two addresses of one person cannot be seen)';
export const PARTIES_UNKNOWN_EXCLUDES =
  'loans whose opening parties cannot be established (counted as `openingPartiesUnknown`; never assumed to be two parties)';

const ALIAS = /^[a-z_][a-z0-9_]*$/i;

/**
 * A SQL boolean, true when loan row `alias` had one address on both sides
 * when it opened (rule 2). Static text: `alias` is a fixed identifier
 * chosen by the caller, never request input.
 */
export function oneAddressLoanSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error('bad alias');
  return `(${alias}.init_lender IS NOT NULL AND ${alias}.init_lender = ${alias}.init_borrower)`;
}

/** A SQL boolean, true when loan row `alias`'s opening parties are not known. */
export function partiesUnknownLoanSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error('bad alias');
  return `(${alias}.init_lender IS NULL OR ${alias}.init_borrower IS NULL)`;
}

/**
 * A SQL boolean, true when rule 2 leaves loan row `alias` out of rate
 * figures: one address on both sides, or opening parties unknown. The text
 * is exactly the WHERE of the partial index
 * `idx_loans_rates_left_out_tenor_start_at` (migration 0118), which is what
 * lets SQLite count these rows through it; keep the two identical.
 */
export function leftOutOfRatesSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error('bad alias');
  return `(${alias}.init_lender IS NULL OR ${alias}.init_borrower IS NULL OR ${alias}.init_lender = ${alias}.init_borrower)`;
}

/**
 * The complement of {@link leftOutOfRatesSql}, written as plain AND terms:
 * true when loan row `alias` is two known, different opening parties. The
 * rate candles select with it rather than `NOT leftOut`, because SQLite
 * uses a partial index only when each term of the index's WHERE appears in
 * the query's; `idx_loans_rates_eligible_tenor_start_at` (migration 0118)
 * carries these same terms, so a market full of left-out loans cannot
 * turn the capped candle read into a scan of its whole history.
 */
export function ratesEligibleSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error('bad alias');
  return `${alias}.init_lender IS NOT NULL AND ${alias}.init_borrower IS NOT NULL AND ${alias}.init_lender <> ${alias}.init_borrower`;
}

/**
 * How many left-out loans a bounded figure counts before it says "at
 * least" instead (the rate candles; the unplaced count does the same).
 */
export const LEFT_OUT_COUNT_CAP = 1_000;

/** The statement a figure carries about how it counted (rules 1 and 2). */
export interface CountingStatement {
  /** Always null: no value total is formed (rule 1). */
  valueTotal: null;
  amounts: string;
  /** Loans in scope left out of the rate figures: one address on both sides. */
  oneAddress: number;
  /** Loans in scope left out of the rate figures: opening parties unknown. */
  openingPartiesUnknown: number;
  oneAddressRule: string;
  rates: string;
}

export function countingStatement(oneAddress: number, openingPartiesUnknown: number): CountingStatement {
  return {
    valueTotal: null,
    amounts: NO_VALUE_TOTAL,
    oneAddress,
    openingPartiesUnknown,
    oneAddressRule: ONE_ADDRESS_RULE,
    rates: NO_CROSS_MEAN,
  };
}
