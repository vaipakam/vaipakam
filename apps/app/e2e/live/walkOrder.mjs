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

/**
 * #2094 r2 — SHOULD THIS VISIT WAIT, SO THE LAST SEAT GOES TO A FULL ONE?
 *
 * A lender run asserts two things: the exit chooser, which only a FULL
 * visit can check, and the forced-close card, which every visit checks. The
 * order above ranks for the forced-close card's confirmation coverage, so
 * a wallet with more close-out-ready rentals than the cap would spend every
 * seat on forced-close-only visits and leave the chooser unasserted — a
 * BLOCKED run over a healthy deployment, with the candidate that could have
 * cleared it discovered and left unvisited.
 *
 * So the LAST seat is held for a full visit while the run has none and one
 * is still ahead in the walk. Every earlier seat keeps the order above, and
 * a held visit is not dropped: the drive offers it again once the walk has
 * passed every full candidate, if seats remain.
 *
 * @param {object} args
 * @param {number} args.seatsLeft visits the cap still allows
 * @param {boolean} args.observedFull whether a full visit has been made
 * @param {string|null|undefined} args.mode this candidate's visit mode
 * @param {boolean} args.fullAhead whether a full candidate is still ahead
 */
export function holdsLastSeatForFull({ seatsLeft, observedFull, mode, fullAhead }) {
  return seatsLeft === 1 && !observedFull && mode !== 'full' && fullAhead;
}
