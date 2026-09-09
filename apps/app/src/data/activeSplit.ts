/**
 * How the active-loan total relates to its typed subtotals.
 *
 * The public Analytics page shows three counters together: active loans,
 * of which ERC-20, and of which NFT rentals. Subtracting gives a fourth
 * — the active loans the indexer counted but could not type, because the
 * row still carries the `'0x'` lending-asset placeholder.
 *
 * ## Why this is a three-way answer and not a number
 *
 * The subtraction has an outcome the page must not present as a count:
 * the subtotals can exceed the total, which means the endpoint
 * contradicted itself. Clamping that to zero — the previous behaviour —
 * is right about not rendering a negative count and wrong about what to
 * do instead. It leaves three mutually inconsistent figures side by
 * side, sums that a reader can add up for themselves, and no
 * acknowledgement anywhere on the page that they disagree.
 *
 * That is the failure the standing principle in `CLAUDE.md` names: a
 * surface must "say what it knows, say what it does not know, and never
 * render a figure or an outcome it cannot substantiate. An unstated
 * unknown is a defect." A silent clamp states, by omission, that the
 * numbers reconcile. When they do not, that is false.
 *
 * The contradiction is not hypothetical, either. `apps/indexer` carries
 * a comment about this exact shape: a sale vehicle counted into the
 * typed subtotals but excluded from the total made "the ERC-20 / NFT
 * active subtotals EXCEED the `active` count beside them" — "two figures
 * on one card disagreeing, which is worse than either being wrong
 * alone". That was fixed indexer-side. This page should not assume the
 * fix holds forever, on the one surface whose whole purpose is being
 * trustworthy about numbers.
 */

export type ActiveSplit =
  /** At least one counter was absent. A residual computed against a
   *  missing input would be a figure this page invented. */
  | { kind: 'unknown' }
  /** The subtotals fit inside the total. `unclassified` may be zero,
   *  which is the ordinary case once every active loan is typed. */
  | { kind: 'reconciled'; unclassified: number }
  /** The subtotals EXCEED the total. `excess` is by how much — reported
   *  so the page can say what it saw rather than merely that something
   *  is wrong. */
  | { kind: 'contradiction'; excess: number };

export function resolveActiveSplit(input: {
  active: number | undefined;
  erc20ActiveLoans: number | undefined;
  nftRentalsActive: number | undefined;
}): ActiveSplit {
  const { active, erc20ActiveLoans, nftRentalsActive } = input;
  if (
    typeof active !== 'number' ||
    typeof erc20ActiveLoans !== 'number' ||
    typeof nftRentalsActive !== 'number'
  ) {
    return { kind: 'unknown' };
  }
  // A non-finite or negative counter is itself a contradiction rather
  // than a number to do arithmetic with — NaN would propagate silently
  // through the subtraction and compare false against every bound,
  // landing in `reconciled` with a NaN residual.
  if (
    !Number.isFinite(active) ||
    !Number.isFinite(erc20ActiveLoans) ||
    !Number.isFinite(nftRentalsActive) ||
    active < 0 ||
    erc20ActiveLoans < 0 ||
    nftRentalsActive < 0
  ) {
    return { kind: 'unknown' };
  }
  const residual = active - erc20ActiveLoans - nftRentalsActive;
  if (residual < 0) return { kind: 'contradiction', excess: -residual };
  return { kind: 'reconciled', unclassified: residual };
}
