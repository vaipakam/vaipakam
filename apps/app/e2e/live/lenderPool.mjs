/**
 * Which lender positions the live position drive visits, and for which
 * card (#2094).
 *
 * A lender detail page carries two cards with different audiences, and the
 * drive's pool used to be the exit chooser's alone. That dropped two
 * supported forced-close states: an overdue NFT RENTAL (the chooser never
 * renders on one; the forced-close card has its own `ready-rental` route)
 * and a SANCTIONS-FLAGGED holder (the chooser is correctly suppressed; the
 * forced-close card deliberately stays, because closing out a defaulted
 * loan is a wind-down the protocol keeps open to every caller).
 *
 * Loosening the chooser's filter would run the chooser's assertions on
 * positions it was written to exclude. So the pool is the union of two
 * rules, and each position carries the mode it is visited in:
 *
 *   |                  | exit chooser (`full`)      | forced close only            |
 *   |------------------|----------------------------|------------------------------|
 *   | asset type       | ERC-20 only                | a rental, or a flagged       |
 *   | status           | Active or FallbackPending  | holder's position, Active    |
 *   | flagged holder   | correctly suppressed       | correctly available          |
 *
 * A `full` visit judges both cards; a `forced-close` visit judges only the
 * forced-close card. The accepted-sale lock that unmounts that card is a
 * per-visit read (`stillEligible`), the same for both modes.
 *
 * Imports nothing.
 */

/**
 * @param {{ held: boolean, active: boolean, fallbackPending: boolean,
 *   rental: boolean, holderFlagged: boolean | undefined }} f
 *   `held` — the lender token resolves to a holder. `holderFlagged` is
 *   read only for an ERC-20 position, where it decides the mode; on a
 *   rental it is `undefined` and changes nothing.
 * @returns {'full' | 'forced-close' | null}
 */
export function lenderVisitMode(f) {
  if (!f.held) return null;
  if ((f.active || f.fallbackPending) && !f.rental && f.holderFlagged === false) return 'full';
  if (f.active && (f.rental || f.holderFlagged === true)) return 'forced-close';
  return null;
}

/** Why a position is visited for the forced-close card only. */
export function forcedCloseOnlyWhy(f) {
  return f.rental ? 'NFT rental' : 'holder sanctions-flagged';
}
