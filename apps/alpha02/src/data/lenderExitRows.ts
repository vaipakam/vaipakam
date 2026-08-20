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
 *  (Codex r1 P2). */
export type SaleLockState = 'checking' | 'listed' | 'clear';

export type LenderExitJumpTarget = 'early-exit-card' | 'loan-sale-card';

export interface LenderExitRow {
  key: 'wait' | 'sell-now' | 'list';
  title: string;
  desc: string;
  cost?: string;
  /** Structural facts true even when the row IS available. */
  note?: string;
  /** Present ⇒ the row is not takeable and this says why. */
  unavailable?: string;
  /** Absent on the wait row — there is nothing to jump to. */
  target?: LenderExitJumpTarget;
}

export interface LenderExitInput {
  /** 0 = no periodic schedule; `undefined` = live read in flight. */
  periodicInterestCadence: number | undefined;
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

  const waitDesc =
    input.periodicInterestCadence === undefined
      ? o.waitDescChecking
      : input.periodicInterestCadence !== 0
        ? o.waitDescPeriodic
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
      unavailable: pastDueOr(
        input.saleLock === 'checking'
          ? o.saleLockChecking
          : input.saleLock === 'listed'
            ? // The direct sale is refused while a listing stands, and
              // the page suppresses the instant-exit card entirely —
              // so without this the jump scrolled to no element.
              o.sellNowAlreadyListed
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
      // Most structural reason wins, so a lender hears the thing they
      // cannot change before the thing they can. "Already listed" leads
      // because it is the one state with nothing to fix and something
      // to look at instead.
      unavailable: pastDueOr(
        input.saleLock === 'checking'
          ? o.saleLockChecking
          : input.saleLock === 'listed'
            ? o.listAlreadyListed
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
