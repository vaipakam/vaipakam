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
  /** A SECOND cost line, shown on the same terms as `cost`.
   *
   *  Separate from `cost` because it applies only to SOME positions
   *  (today: a Full-stamped fee entitlement) while the base cost
   *  sentence is identical for every one. Folding it in would mean two
   *  near-identical long strings per row in every locale, drifting
   *  apart on the next edit to either. */
  costExtra?: string;
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
  /** Whether the LENDER side of this loan's fee entitlement is stamped
   *  Full.
   *
   *  `FeeEntitlement` is keyed by loanId, NOT by holder, and no sale
   *  path clears it — `repriceFeeEntitlementOnExtension` is the only
   *  writer and it fires on extension, not sale. So the stamp travels
   *  with the position: the buyer inherits the yield-fee bump for the
   *  remaining term without paying any `C*`, and the seller, who paid
   *  it in VPFI at origination, keeps only the part already settled
   *  (Codex r12 P2).
   *
   *  Free to know: the sale rows already wait on the fee-entitlement
   *  read, so this adds no query. */
  lenderFeeModeFull: boolean;
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
  /** Less than `MIN_SALE_LISTING_SECONDS` remains before maturity.
   *
   *  LISTING-ONLY, and that asymmetry is the point: `_boundListingExpiry`
   *  clamps the window at maturity and then refuses anything shorter
   *  than the minimum, so in the final hour no listing can be created —
   *  while the instant sale has no window at all and stays available.
   *  `LoanSaleFlow` only reports this at submit time, after the lender
   *  has switched modes and filled the form (Codex r18 P2).
   *
   *  Costs no read: the app already exports the same
   *  `MIN_SALE_LISTING_SECONDS` the tool uses, so this SHARES the
   *  constant rather than copying it. */
  listingWindowTooShort: boolean;
  listingSupportedOnChain: boolean;
  /** Operator kill switch (`VITE_DISABLED_FLOWS`). Scoped to the
   *  LISTING row: `LoanSaleFlow` refuses and shows the incident
   *  banner, while the direct sale carries no kill switch at all — so
   *  gating both rows would invent a blocker on the instant exit
   *  (Codex r3 P2). */
  listingFlowDisabled: boolean;
  collateralIsNft: boolean;
  saleLock: SaleLockState;
  /** A listing may STILL BE STANDING, independently of whether the
   *  lock read is trustworthy enough to gate the rows on.
   *
   *  Two questions were riding on `saleLock` and they came apart in
   *  opposite directions (Codex r20 P2 ×2):
   *
   *   - "may I offer this row" — must fail CLOSED, so an initial read
   *     failure blocks rather than waving the rows through.
   *   - "might a buyer still complete a sale" — must fail OPEN for the
   *     COST lines, because a previously-confirmed listing does not
   *     stop being live just because the next poll errored, and the
   *     held-balance transfer and reward forfeiture stay pending.
   *
   *  Mapping an errored poll over a cached `listed` to `'checking'`
   *  satisfied the first and broke the second: the rows went
   *  unavailable AND both cost lines vanished, while
   *  `LoanSalePendingCard` stayed mounted and a buyer could still
   *  accept. One flag cannot answer both. */
  listingMayStand: boolean;
  /** See `SaleToolsState` — applies to BOTH sale rows. */
  saleTools: SaleToolsState;
  heldVpfiUnresolved: boolean;
  /** The borrower has a linked exit (preclose offset) pending.
   *
   *  Refuses BOTH sale routes, not just the listing (Codex r15 P2):
   *  `EarlyWithdrawalDirectFacet:253` rejects `OffsetActiveOnLoan` on
   *  the direct sale exactly as `EarlyWithdrawalFacet` does for a
   *  listing. Consulting it on one row only was a shadow copy that had
   *  missed one of the two entry points — and the row it left
   *  available is the one that jumps straight to a wallet prompt.
   *
   *  Still always `false` from the page (see the call site): the live
   *  link needs a chain read, tracked with #1841. Wiring it correctly
   *  now means the read lands as a one-line change on both rows rather
   *  than as a rediscovery of this asymmetry. */
  borrowerOffsetPending: boolean;
  instantSellCandidates: InstantSellCandidates;
  /** Has ANY live status read answered yet?
   *
   *  Only `chooserReadiness` consults this; no row's wording or
   *  availability depends on it, so the rendered card is unchanged.
   *  It exists because `fallbackPending` cannot carry its own third
   *  state: the page derives it with `.some(...)` over the live-status
   *  candidates, so `true` is self-evidencing while `false` is
   *  ambiguous between "not fallback" and "nothing has answered". */
  statusSettled: boolean;
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
  const pastDueOr = (reason: string | undefined) => {
    switch (conclusiveBlock(input)) {
      case 'past-due':
        return copy.lenderExit.pastDue;
      case 'maturity-unknown':
        return copy.lenderExit.options.maturityUnknown;
      case 'fallback':
        return o.saleFallbackPending;
      default:
        return reason;
    }
  };

  /** The sell-now row's verdict, hoisted so the LISTING row can read
   *  it (Codex r22 P2). The final-hour message reassures the lender
   *  that "selling into a standing offer still works" — true only when
   *  that row is in fact takeable, and the shared prerequisites can
   *  shut both at once. Two rows describing each other must read one
   *  value, not two copies of a guess. */
  const sellNowUnavailable = pastDueOr(
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
          : input.borrowerOffsetPending
            ? o.listUnavailableOffsetPending
          : input.instantSellCandidates === 'checking'
          ? copy.lenderExit.checking
          : input.instantSellCandidates === 'none'
            ? o.sellNowNoOffers
            : // 'some' and 'unknown' both leave the row available: one
              // because we looked and found candidates, the other
              // because we have not looked and must not pretend to
              // have. The difference is visible in the tool, not here.
              undefined,
      );

  return [
    {
      key: 'wait',
      title: o.wait,
      desc: waitDesc,
      // The SAME `listingMayStand` input the two sale rows use for
      // `costStillApplies` (Codex r24 P2). It was applied to the rows
      // that name the cost and not to the row that denies there is one,
      // so the card said "a buyer can still complete this and here is
      // what it takes from you" and "costs nothing — this is the
      // default" about one live listing, on the same screen.
      //
      // Not marked `unavailable`: waiting is not refused, it is simply
      // no longer what inaction selects. Saying so is the honest shape;
      // greying the row out would suggest the lender has no way back to
      // it when cancelling is exactly that way.
      cost: input.listingMayStand ? o.waitCostListed : o.waitCost,
    },
    {
      key: 'sell-now',
      title: o.sellNow,
      desc: o.sellNowDesc,
      cost: o.sellNowCost,
      costExtra: input.lenderFeeModeFull ? o.costFullTariff : undefined,
      // Same reasoning as the listing row: while a listing stands, the
      // buyer completing it incurs these same losses, and this row's
      // cost line carries the identical disclosure.
      costStillApplies: input.listingMayStand,
      unavailable: sellNowUnavailable,
      target: 'early-exit-card',
    },
    {
      key: 'list',
      title: o.list,
      desc: o.listDesc,
      cost: o.listCost,
      costExtra: input.lenderFeeModeFull ? o.costFullTariff : undefined,
      note: o.listStructural,
      // A live listing is a sale in flight, not a declined option.
      costStillApplies: input.listingMayStand,
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
          : // Ranked ABOVE the network and collateral reasons: this one
            // is about THIS loan right now, and a lender who is told
            // "not on this network" would go looking for another
            // network when the real answer is "not in the last hour".
            input.listingWindowTooShort
            ? // The variant WITHOUT the "selling still works" tail when
              // the instant sale is not in fact available (Codex r22
              // P2). Computed from the sell-now row's own verdict, so
              // the two rows cannot contradict each other.
              sellNowUnavailable === undefined
              ? o.listUnavailableTooClose
              : o.listUnavailableTooCloseOnly
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

/** Whether the chooser's answer about JUMPABILITY has settled yet.
 *
 *  Exposed for one reason: from outside the card, the absence of the
 *  "switch to Advanced" control is ambiguous. It is missing both while
 *  a prerequisite read is in flight AND when no row is genuinely
 *  jumpable, and those are the two cases a live review most needs to
 *  tell apart (#1855). Without a positive readiness signal a driver can
 *  only wait out a deadline and then guess — which is what
 *  `live-position-observe.mjs` does today, at 45 seconds per page, and
 *  it still cannot distinguish a stale render from a regression.
 *
 *  Deliberately scoped to the inputs that decide JUMPABILITY, not to
 *  everything the card reads:
 *
 *   - `periodicInterestCadence` is excluded. It changes the WAIT row's
 *     wording and nothing else, so waiting on it would block readiness
 *     on an answer that cannot move a jump — and on a loan whose
 *     cadence read never lands, readiness would never arrive.
 *   - `'unknown'` is NOT uniformly pending, and that asymmetry is the
 *     whole subtlety here. `maturity: 'unknown'` means a query enabled
 *     for exactly that case has not answered, so it clears — pending.
 *     `saleLock: 'unknown'` and `instantSellCandidates: 'unknown'` mean
 *     no query will EVER run, so they are settled answers; treating
 *     them as pending would hang forever on a Basic-mode page.
 *
 *  `'failed'` is reported distinctly rather than folded into `'ready'`.
 *  The rows have settled, so a reader is not left waiting — but a
 *  consumer asserting "the switch should be here" must not treat a
 *  failed prerequisite as a clean negative answer.
 */
export type ChooserReadiness = 'ready' | 'pending' | 'failed';


/** The HEAD of the sale rows' unavailability precedence — the blocks
 *  that decide both rows outright, before any narrower reason is read.
 *
 *  Extracted so `pastDueOr` and `chooserReadiness` cannot drift
 *  (Codex #1858 r1). They had the same precedence written twice, in
 *  different orders, and diverged immediately: the rows short-circuit
 *  on past maturity while readiness went on waiting for a sale-lock
 *  read whose answer could no longer matter. Two statements of one rule
 *  is the shadow-model defect this whole PR chain keeps finding, and it
 *  reappeared inside the fix for it. */
type ConclusiveBlock = 'past-due' | 'maturity-unknown' | 'fallback';

function conclusiveBlock(input: LenderExitInput): ConclusiveBlock | undefined {
  if (input.maturity === 'past') return 'past-due';
  if (input.maturity === 'unknown') return 'maturity-unknown';
  if (input.fallbackPending) return 'fallback';
  return undefined;
}

export function chooserReadiness(input: LenderExitInput): ChooserReadiness {
  const head = conclusiveBlock(input);
  // A CONCLUSIVE NEGATIVE IS AN ANSWER (Codex #1858 r1). Past maturity
  // and a fallback-settling loan shut BOTH sale rows outright, ahead of
  // every narrower reason — so the question is already decided and no
  // later read can change it. Reporting `pending` there kept a past-due
  // page undecided behind a slow or failing secondary read, preserving
  // the very timeout this predicate exists to remove.
  if (head === 'past-due' || head === 'fallback') return 'ready';
  if (head === 'maturity-unknown') return 'pending';
  // The status read must have SETTLED before a non-fallback answer can
  // be trusted (Codex #1858 r1). `fallbackPending` is derived by the
  // page from `liveStatusCandidates.some(...)`, so `false` means either
  // "not fallback" or "no status read has answered yet" — and if an
  // outstanding query then reports FallbackPending, the head above
  // turns both jumps off and a `ready` answer would have flipped from
  // yes to no after being published as settled. Only `true` is
  // self-evidencing; `false` needs this second fact to be meaningful.
  if (!input.statusSettled) return 'pending';
  if (input.saleTools === 'failed') return 'failed';
  if (input.saleTools === 'checking') return 'pending';
  if (input.saleLock === 'checking') return 'pending';
  if (input.instantSellCandidates === 'checking') return 'pending';
  return 'ready';
}
