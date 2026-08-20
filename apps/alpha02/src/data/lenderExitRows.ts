/**
 * Row decisions for the lender's Layer-1 exit chooser
 * (LenderEarlyWithdrawalUXDesign, Layer 1), extracted as a PURE
 * function so the branching is testable without a DOM.
 *
 * Same shape as `computeHoldGate` in `saleListingHold.ts` and for the
 * same reason: the interesting part of this card is not its markup, it
 * is which sentence a lender is shown and in what precedence. That
 * deserves a test matrix, and alpha02 has no component-render harness.
 *
 * Two invariants live here rather than in the component, because they
 * are the ones that would silently mislead if they regressed:
 *
 *   1. The wait row is CADENCE-AWARE and tri-state. On a loan with a
 *      periodic schedule the lender is paid DURING the term; a single
 *      end-of-term sentence misstates when they get paid, which is the
 *      exact fact the row exists to convey. Unknown renders a checking
 *      line rather than defaulting to either shape.
 *   2. Past maturity OUTRANKS every narrower reason on both sale rows.
 *      A fully-elapsed term is refused at creation, so "no matching
 *      offers right now" past due would send a lender hunting for a fix
 *      that cannot help.
 */
import { copy } from '../content/copy';

/** Whether a standing lending offer matches this position.
 *
 *  A union, not `boolean | undefined`: `'checking'` (a read is in
 *  flight) and `'unknown'` (we deliberately have not read) are
 *  different promises to the reader. Collapsing them would render
 *  "checking…" forever in the case where nothing is being checked. */
export type InstantSellCandidates = 'checking' | 'some' | 'none' | 'unknown';

/** Whether this position already carries a live sale listing.
 *
 *  A union for the same reason as `InstantSellCandidates`: the listing
 *  lock is authoritative for BOTH sale paths — `_createLoanSaleOfferImpl`
 *  refuses `SaleOfferAlreadyExists` and the direct sale is refused too —
 *  so an unanswered read must not collapse to "clear". A boolean did
 *  exactly that while the read was loading or had errored, showing both
 *  exits as available on a position whose lock had never been checked
 *  (Codex r1 P2).
 *
 *  `'unknown'` is the fourth state and exists because the fix for that
 *  finding nearly reintroduced it by the opposite door. The lock read
 *  is gated on a valid lender position token; with no such token the
 *  query NEVER runs, so its data stays undefined permanently. Mapping
 *  that to `'checking'` would have pinned both sale rows shut forever
 *  behind a spinner — a permanent dead end dressed as a transient one,
 *  which is the exact failure the card exists to prevent.
 *
 *  So: `'checking'` means a read that CAN answer has not answered yet;
 *  `'unknown'` means no read is possible at all. The latter makes no
 *  claim and leaves the rows to the tools, which is also harmless here
 *  — a position with no lender token cannot be listed or sold in the
 *  first place, so the tool refuses for its own, better-stated
 *  reason. */
export type SaleLockState = 'checking' | 'listed' | 'clear' | 'unknown';

export type LenderExitJumpTarget = 'early-exit-card' | 'loan-sale-card';

export interface LenderExitRow {
  key: 'wait' | 'sell-now' | 'list';
  title: string;
  desc: string;
  cost?: string;
  /** Structural facts true even when the row IS available. */
  note?: string;
  /** Keep `cost` visible even though `unavailable` is set.
   *
   *  The r2 rule — cost is noise on an option that cannot be taken —
   *  is right in general and WRONG for a live listing (Codex r5 P1). A
   *  listed position is not an option declined; it is a sale already in
   *  flight, which a buyer can complete at any moment. The held-balance
   *  transfer and the reward forfeiture are then PENDING CONSEQUENCES
   *  rather than hypothetical prices, and `LoanSalePendingCard` reports
   *  the settlement pull and funding status but neither loss — so
   *  hiding the line removes the only place they are stated. */
  costStillApplies?: boolean;
  /** Present ⇒ the row is not takeable and this says why. */
  unavailable?: string;
  /** Absent on the wait row — there is nothing to jump to. */
  target?: LenderExitJumpTarget;
}

export interface LenderExitInput {
  /** 0 = no periodic schedule; `undefined` = live read in flight. */
  periodicInterestCadence: number | undefined;
  /** Whether the loan permits partial repayment. Affects the WAIT row's
   *  timing claim, not any sale row: `repayPartial` pays the lender
   *  that share of principal plus its accrued interest immediately,
   *  while the loan stays active — so "you claim at the end" is false
   *  for these loans even with no periodic schedule (Codex r4 P2). */
  allowsPartialRepay: boolean;
  /** A live listing whose offer record this device cannot recover: the
   *  pending card below then offers no cancel, so the row must not
   *  promise one (Codex r5 P2). */
  saleListingCancellable: boolean;
  /** Chain-anchored only — never a device clock. */
  pastDue: boolean;
  listingSupportedOnChain: boolean;
  collateralIsNft: boolean;
  saleLock: SaleLockState;
  heldVpfiUnresolved: boolean;
  borrowerOffsetPending: boolean;
  instantSellCandidates: InstantSellCandidates;
}

export function buildLenderExitRows(input: LenderExitInput): LenderExitRow[] {
  const o = copy.lenderExit.options;

  // Cadence first: a periodic schedule already says the lender is paid
  // during the term, which subsumes the partial-repay case. Only a
  // NO-cadence loan needs the partial variant to avoid claiming that
  // nothing reaches the lender before maturity.
  const waitDesc =
    input.periodicInterestCadence === undefined
      ? o.waitDescChecking
      : input.periodicInterestCadence !== 0
        ? o.waitDescPeriodic
        : input.allowsPartialRepay
          ? o.waitDescAtClosePartial
          : o.waitDescAtClose;

  // Invariant 2 — structural refusal first.
  const pastDueOr = (reason: string | undefined) =>
    input.pastDue ? copy.lenderExit.pastDue : reason;

  return [
    {
      key: 'wait',
      title: o.wait,
      desc: waitDesc,
      cost: o.waitCost,
    },
    {
      key: 'sell-now',
      title: o.sellNow,
      desc: o.sellNowDesc,
      cost: o.sellNowCost,
      // Same reasoning as the listing row: while a listing stands, the
      // buyer completing it incurs these same losses, and this row's
      // cost line carries the identical disclosure.
      costStillApplies: input.saleLock === 'listed',
      unavailable: pastDueOr(
        input.saleLock === 'checking'
          ? o.saleLockChecking
          : input.saleLock === 'listed'
            ? // The direct sale is refused while a listing stands, and
              // the page suppresses the instant-exit card entirely —
              // so without this the jump scrolled to no element. The
              // cancellable split is the same one the listing row
              // makes: this row NAMES the cancel as the fix, so it
              // must not name one this device cannot perform.
              input.saleListingCancellable
              ? o.sellNowAlreadyListed
              : o.sellNowAlreadyListedNoCancel
          : input.instantSellCandidates === 'checking'
          ? copy.lenderExit.checking
          : input.instantSellCandidates === 'none'
            ? o.sellNowNoOffers
            : // 'some' and 'unknown' both leave the row available: one
              // because we looked and found candidates, the other
              // because we have not looked and must not pretend to
              // have. The difference is visible in the tool, not here.
              undefined,
      ),
      target: 'early-exit-card',
    },
    {
      key: 'list',
      title: o.list,
      desc: o.listDesc,
      cost: o.listCost,
      note: o.listStructural,
      // A live listing is a sale in flight, not a declined option.
      costStillApplies: input.saleLock === 'listed',
      // Most structural reason wins, so a lender hears the thing they
      // cannot change before the thing they can. "Already listed" leads
      // because it is the one state with nothing to fix and something
      // to look at instead.
      unavailable: pastDueOr(
        input.saleLock === 'checking'
          ? o.saleLockChecking
          : input.saleLock === 'listed'
            ? input.saleListingCancellable
              ? o.listAlreadyListed
              : o.listAlreadyListedNoCancel
          : !input.listingSupportedOnChain
            ? o.listUnavailableNetwork
            : input.collateralIsNft
              ? o.listUnavailableNft
              : input.heldVpfiUnresolved
                ? o.listUnavailableHeldVpfi
                : input.borrowerOffsetPending
                  ? o.listUnavailableOffsetPending
                  : undefined,
      ),
      target: 'loan-sale-card',
    },
  ];
}

/** Whether the Basic-mode "switch to Advanced" action should render.
 *
 *  The wait row has no tool behind it, so a lender whose sale rows are
 *  all unavailable has nothing to switch TO — offering the switch would
 *  promise tools that would not appear. */
export function hasJumpableRow(rows: LenderExitRow[]): boolean {
  return rows.some((r) => r.target !== undefined && r.unavailable === undefined);
}
