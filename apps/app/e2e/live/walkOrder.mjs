/**
 * WHICH DISCOVERED POSITIONS THIS DRIVE VISITS FIRST.
 *
 * The walk is capped (`OBSERVE_MAX_POSITIONS`), so on a lender with more
 * eligible loans than the cap the ORDER decides which assertions can run
 * at all. Three review rounds have now found the same failure in it — a
 * usable target discovered and left unvisited behind candidates that
 * could not exercise the assertion, with the run exiting 2 to report the
 * assertion unrun. Each fix was one class narrower than the last:
 *
 *   - round 9   Active before everything else, because the forced-close
 *               card applies only to an Active position while the pool
 *               this walk inherits admits FallbackPending too.
 *   - round 28  and an Active position whose sale has been ACCEPTED
 *               correctly unmounts the card, so it is Active and
 *               inapplicable — demoted behind the rest of the Active set.
 *   - round 72  and a card that mounts need not OFFER anything. The
 *               confirmation coverage this drive requires can only come
 *               from one that does, so positions the protocol would
 *               accept a close-out on go first of all.
 *
 * Extracted here so the ordering is a pure function with tests rather
 * than three interleaved comment blocks around a top-level expression.
 * The I/O stays in the drive: this takes the ANSWERS as sets and never
 * asks anything itself.
 *
 * STABLE PARTITIONS, NEVER A SORT. Within each band the discovery order
 * is preserved, so reordering changes which loans are sampled and never
 * whether a sampled one is judged — the chooser assertions apply to every
 * band alike.
 *
 * EVERY BAND PROMOTES OR DEMOTES ON A POSITIVELY ESTABLISHED FACT. Both
 * `acceptedSale` and `acceptsCloseOut` are sets of ids the drive
 * ANSWERED for; a probe that could not be run contributes no id, and the
 * loan keeps its place rather than being ranked on a failed read. Letting
 * one bad RPC response reorder a good candidate would cost the run the
 * coverage this function exists to secure.
 *
 * `acceptsCloseOut` is an ORDERING HEURISTIC AND NOTHING ELSE: the
 * protocol accepting a close-out does not mean the card offers one, and
 * the probe behind it is unpinned. No verdict reads it.
 *
 * @param {object} args
 * @param {Array<{id: bigint|string|number, status: unknown}>} args.loans
 *   candidates in discovery order
 * @param {string} args.role the observed role; only 'lender' reorders
 * @param {unknown} args.activeStatus the status value meaning Active
 * @param {Set<unknown>} [args.acceptedSale] ids with an accepted sale
 * @param {Set<unknown>} [args.acceptsCloseOut] ids the protocol would
 *   accept a close-out on
 * @returns {Array<object>} the same loans, reordered
 */
export function walkOrderFor({
  loans,
  role,
  activeStatus,
  acceptedSale = new Set(),
  acceptsCloseOut = new Set(),
}) {
  const all = Array.isArray(loans) ? loans : [];
  if (role !== 'lender') return [...all];

  const sold = (l) => acceptedSale.has(l?.id);
  const active = (l) => l?.status === activeStatus;
  // The applicability bands, worst last.
  const banded = [
    ...all.filter((l) => active(l) && !sold(l)),
    ...all.filter((l) => active(l) && sold(l)),
    ...all.filter((l) => !active(l)),
  ];

  // Then the round-72 band, applied ACROSS the result rather than within
  // it: a loan the protocol would accept a close-out on is Active and
  // unlocked by construction, so it can only come from the first band —
  // and taking it from anywhere keeps this composable if that ever stops
  // being true.
  const accepts = (l) => acceptsCloseOut.has(l?.id);
  if (!banded.some(accepts)) return banded;
  return [...banded.filter(accepts), ...banded.filter((l) => !accepts(l))];
}
