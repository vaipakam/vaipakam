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
/* `'unknown'` is what the page passes in BOTH modes today, and the
 * reason differs by mode — which matters, because only one of the two
 * is a deliberate trade.
 *
 * In Basic the candidate list is genuinely not fetched: it is a full
 * active-offers page walk, and running it for every lender who merely
 * opens a position is a poor trade for a row that has a tool behind it.
 *
 * In Advanced the list IS fetched — `EarlyExitFlow` mounts, walks the
 * offers and derives the compatible set — and the chooser still says
 * `'unknown'`, so with zero matches the row stays jumpable while the
 * tool below already knows it is empty (Codex r12 P2). That is
 * information discarded rather than not gathered. It costs a wasted
 * scroll to a surface that explains itself, not a dead end — the
 * anchor exists and says `earlyExit.none` — which is why it is tracked
 * rather than patched: the honest fix shares the tool's derivation
 * instead of copying it, and a second copy of the facet's admission
 * rules is the exact defect class this card was built to remove.
 * Tracked in #1849. */

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

/** Whether the sale TOOLS themselves can render.
 *
 *  Both sale surfaces are held behind the fee-entitlement read: a
 *  Full-stamped position carries its fee mode to the buyer, and that
 *  disclosure is part of the sale set, so until the read settles the
 *  page renders a stand-in card in place of BOTH tools and their jump
 *  anchors go with it. A row that stayed available then rendered a
 *  jump button whose target did not exist, and `jump()`
 *  optional-chains a missing element — so the click did nothing, with
 *  nothing said (Codex r3 P2).
 *
 *  Availability follows the tools rather than the anchors being
 *  patched onto the stand-in card, because the honest statement is
 *  about the OPTION, not the scroll: while the disclosure is unread
 *  the sale cannot be started, and a lender is better told that than
 *  scrolled to a card that says the same thing in smaller type. */
export type SaleToolsState =
  | 'ready'
  | 'checking'
  /** A prerequisite read FAILED — deliberately not saying which.
   *
   *  This was two states (`failed-terms` / `failed-meta`) and became
   *  one, which is the opposite direction to every other fix on this
   *  card and needs its reason recorded. Naming the failed read
   *  misfired TWICE: r8 routed a token-metadata failure into the fee
   *  sentence, r9 fixed that by splitting, and r10 found a third
   *  prerequisite (`loanLive`) landing in the fee sentence again. The
   *  bug was never which name — it was that a NAME EXISTS to get
   *  wrong, and each new prerequisite is another chance to get it
   *  wrong silently.
   *
   *  Nothing is lost by dropping it. All three failures are transient
   *  read failures with ONE remedy, and the lender cannot act
   *  differently on any of them; the specific read is a diagnostic
   *  fact, and this is an awareness card, not a diagnostic. Attributing
   *  a cause bought precision the reader could not use, at the price of
   *  a misstatement they could be misled by. */
  | 'failed';

/** Whether the loan has passed its due date.
 *
 *  A union rather than a boolean because there is a third answer, and
 *  it was previously spelled `false` (Codex r6 P2). The maturity check
 *  is chain-anchored from whichever live read has answered; in Basic
 *  mode the strategy read is disabled, so if the always-on terms read
 *  ERRORS there is no authoritative source left — and a boolean turned
 *  that into "not past due", presenting both sale rows as available on
 *  a position whose due date had never been established.
 *
 *  `'unknown'` fails CLOSED here, unlike `SaleLockState`'s `'unknown'`
 *  which leaves the rows alone. The difference is whether a read that
 *  COULD answer exists: the lock's unknown means no query can run at
 *  all and never will, so waiting on it would be a permanent dead end;
 *  maturity's unknown means a live query that is enabled for exactly
 *  this case has not answered yet, so it clears on the next refetch. */
export type MaturityState = 'past' | 'current' | 'unknown';

/** Whether the pending card below will offer a cancel, and if not, why.
 *
 *  Three-valued rather than a boolean (Codex r8 P2), because the two
 *  ways it can be absent want different sentences. A missing offer
 *  record means the listing was made elsewhere and this device cannot
 *  act on it — "cancel it where you listed it" is the right advice. An
 *  unverified holder means the card's isolated `ownerOf` read failed,
 *  which says nothing about where the listing was made and may resolve
 *  on the next attempt — telling that lender to go to another device
 *  would be a fabricated cause, and my own r7 fix introduced exactly
 *  that by folding the holder failure into the elsewhere wording. */
export type SaleCancelState = 'yes' | 'no-elsewhere' | 'no-unverified';

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
  /** 0 = no periodic schedule; `undefined` = the read has not answered.
   *  Pair with `cadenceReadFailed` to tell a failure from a wait. */
  periodicInterestCadence: number | undefined;
  /** Whether the cadence read FAILED, as opposed to being in flight
   *  (Codex r7 P2). Both arrive as `undefined` cadence, and rendering
   *  the checking line for a persistent failure promises an answer
   *  that is not coming — the same transient-dressing-a-dead-end shape
   *  as the sale lock's fourth state, on the wait row instead. */
  cadenceReadFailed: boolean;
  /** Whether the loan permits partial repayment. Affects the WAIT row's
   *  timing claim, not any sale row: `repayPartial` pays the lender
   *  that share of principal plus its accrued interest immediately,
   *  while the loan stays active — so "you claim at the end" is false
   *  for these loans even with no periodic schedule (Codex r4 P2). */
  allowsPartialRepay: boolean;
  /** Whether the pending card below will actually render a cancel.
   *
   *  It gates on `state.offerId && state.isHolder` — TWO conditions,
   *  and the holder half fails independently: the pending hook's
   *  isolated `ownerOf` call returns `isHolder: false` on a read
   *  failure by design, while a locally remembered offer id stays
   *  verified and non-null. Keying the row on the offer id alone
   *  therefore promised a cancel that a partial read failure had
   *  already removed (Codex r5 P2 for the id, r7 P2 for the holder).
   *  Mirror BOTH, or this drifts from the card again. */
  saleCancel: SaleCancelState;
  /** The live read says the loan is FallbackPending (Codex r8 P2).
   *
   *  The card stays mounted for this status — it is not terminal, and a
   *  lender still has options worth reading — but both sale entry
   *  points require exactly `Active`
   *  (`EarlyWithdrawalDirectFacet:167`, `EarlyWithdrawalFacet:270`), so
   *  the rows must not be offered. Affirmative only: an unread status
   *  is not a fallback-pending one. */
  fallbackPending: boolean;
  /** Chain-anchored only — never a device clock. See `MaturityState`
   *  for why this is not a boolean. */
  maturity: MaturityState;
  listingSupportedOnChain: boolean;
  /** Operator kill switch (`VITE_DISABLED_FLOWS`). Scoped to the
   *  LISTING row: `LoanSaleFlow` refuses and shows the incident
   *  banner, while the direct sale carries no kill switch at all — so
   *  gating both rows would invent a blocker on the instant exit
   *  (Codex r3 P2). */
  listingFlowDisabled: boolean;
  collateralIsNft: boolean;
  saleLock: SaleLockState;
  /** See `SaleToolsState` — applies to BOTH sale rows. */
  saleTools: SaleToolsState;
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
      ? input.cadenceReadFailed
        ? o.waitDescUnknown
        : o.waitDescChecking
      : input.periodicInterestCadence !== 0
        ? o.waitDescPeriodic
        : input.allowsPartialRepay
          ? o.waitDescAtClosePartial
          : o.waitDescAtClose;

  // Invariant 2 — structural refusal first. The unknown arm fails
  // CLOSED (Codex r6 P2): an unestablished due date is not evidence of
  // a live one, and both contracts refuse an exit past maturity, so
  // presenting the rows as takeable would be a claim made from a read
  // that did not answer.
  // Ranked above the listing lock: a fallback-pending loan refuses both
  // sales outright, so "cancel the listing first" would be advice that
  // does not lead anywhere (Codex r8 P2).
  const pastDueOr = (reason: string | undefined) =>
    input.maturity === 'past'
      ? copy.lenderExit.pastDue
      : input.maturity === 'unknown'
        ? copy.lenderExit.options.maturityUnknown
        : input.fallbackPending
          ? o.saleFallbackPending
          : reason;

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
              input.saleCancel === 'yes'
              ? o.sellNowAlreadyListed
              : input.saleCancel === 'no-elsewhere'
                ? o.sellNowAlreadyListedNoCancel
                : o.sellNowAlreadyListedCancelUnverified
          : // Ranked BELOW the listing lock to match the page's own
            // order: the stand-in card replaces the tools only on the
            // branch a live listing has already taken over.
            input.saleTools !== 'ready'
            ? input.saleTools === 'failed'
                ? o.saleToolsFailed
                : o.saleToolsChecking
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
            ? input.saleCancel === 'yes'
              ? o.listAlreadyListed
              : input.saleCancel === 'no-elsewhere'
                ? o.listAlreadyListedNoCancel
                : o.listAlreadyListedCancelUnverified
          : !input.listingSupportedOnChain
            ? o.listUnavailableNetwork
            : input.collateralIsNft
              ? o.listUnavailableNft
              : // Operator/protocol-level facts about whether the
                // surface exists at all rank ABOVE position-specific
                // refusals: "the tool is switched off" before "your
                // position carries a balance to clear".
                input.listingFlowDisabled
              ? o.listUnavailableFlowDisabled
              : input.saleTools !== 'ready'
                ? input.saleTools === 'failed'
                    ? o.saleToolsFailed
                    : o.saleToolsChecking
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
