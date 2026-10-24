/**
 * When the borrower's "Ways to repay or exit early" chooser
 * (`EarlyRepayOptionsCard`) renders on a position page, as ONE rule
 * (#1557).
 *
 * `PositionDetails` used to write this condition inline, and the live
 * review drive (`e2e/live/live-position-observe.mjs`) copied its clauses
 * to decide which loans to visit. The copy drifted twice inside one
 * review, and the failure was silent: a predicate grown too narrow does
 * not report a problem, it visits fewer loans, or reports "nothing to
 * look at". The page now renders from this function, and the drive's
 * mirror (`e2e/live/chooserEligibility.mjs`) is checked against it over
 * every combination of facts by `chooserEligibility.test.mjs`, so a
 * clause added here and not there fails CI.
 *
 * The facts are already-resolved booleans. How each is READ (the live
 * status precedence, the offset-pending query, the grace deadline) stays
 * with its caller. The grace window's bucket walk is shared the same way,
 * in `lib/grace.ts`.
 *
 * No imports, and only erasable TypeScript, so the drive's parity test
 * can load it directly.
 */

export interface EarlyRepayChooserFacts {
  /** The connected wallet holds the borrower side of the loan. */
  viewerIsBorrower: boolean;
  /** The loan's status is Active. */
  active: boolean;
  /** The loan lends an NFT (a rental) rather than an ERC-20. */
  rental: boolean;
  /** A preclose-offset is in progress on the borrower position. */
  offsetPending: boolean;
  /** The grace deadline has VERIFIABLY passed (live terms + grace read). */
  graceVerifiablyOver: boolean;
  /** The borrower closed the loan in this page session. */
  closedThisSession: boolean;
}

/** Why the chooser is not shown, in clause order. */
export type EarlyRepayChooserExclusion =
  | 'not-borrower'
  | 'not-active'
  | 'closed-this-session'
  | 'rental'
  | 'offset-pending'
  | 'grace-over';

/**
 * The first clause that hides the chooser, or `null` when it renders.
 * The order decides only which reason is named when several hold.
 */
export function earlyRepayChooserExclusion(
  f: EarlyRepayChooserFacts,
): EarlyRepayChooserExclusion | null {
  if (!f.viewerIsBorrower) return 'not-borrower';
  if (!f.active) return 'not-active';
  if (f.closedThisSession) return 'closed-this-session';
  if (f.rental) return 'rental';
  if (f.offsetPending) return 'offset-pending';
  if (f.graceVerifiablyOver) return 'grace-over';
  return null;
}

/** Whether the chooser renders. */
export function earlyRepayChooserRenders(f: EarlyRepayChooserFacts): boolean {
  return earlyRepayChooserExclusion(f) === null;
}
