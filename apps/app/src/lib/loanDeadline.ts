/**
 * An indexed loan's due date, on the D2 loan clock (#668 / #935, #2808).
 *
 * A pause moves every open loan's due date and grace end later by the time
 * the protocol spent paused since the loan started. The indexer computes the
 * moved dates (`IndexedLoan.deadlines`); this is the one place a list or
 * badge reads them, so no surface goes back to `startTime + durationDays`
 * for a deadline. What the row does not establish is said: a pause still in
 * force (`paused`, the dates are still moving) and dates the indexer could
 * not compute or did not send (`unknown`) are their own answers, never the
 * original date standing in.
 */
import type { IndexedLoan } from "../data/indexer";

export type RowDeadline =
  | {
      kind: "known";
      /** The effective due date the chain enforces. */
      maturity: number;
      /** The due date the loan was opened with. */
      originalMaturity: number;
      /** How far pauses moved it, in seconds (0 when never paused). */
      pauseCredit: number;
    }
  /** A pause is in force: the deadlines move later for as long as it lasts. */
  | { kind: "paused"; originalMaturity: number; pauseCredit: number }
  | { kind: "unknown" };

export function rowDeadline(loan: Pick<IndexedLoan, "deadlines">): RowDeadline {
  const d = loan.deadlines;
  if (!d || !d.available) return { kind: "unknown" };
  if (d.pauseInForce) {
    return {
      kind: "paused",
      originalMaturity: d.originalMaturity,
      pauseCredit: d.pauseCredit,
    };
  }
  return {
    kind: "known",
    maturity: d.maturity,
    originalMaturity: d.originalMaturity,
    pauseCredit: d.pauseCredit,
  };
}
