/**
 * "Your options as the lender" — the lender's early-withdrawal
 * CHOOSER (LenderEarlyWithdrawalUXDesign, Layer 1).
 *
 * The INVERSION from the borrower's chooser is the whole point of this
 * card, not a styling difference. The borrower's card promotes ways to
 * act, because a borrower carrying a debt usually benefits from knowing
 * their exits. A lender's position is already the thing that pays: the
 * default — doing nothing — is the option that costs no sale
 * forfeiture, so the wait row renders FIRST and the sale rows follow
 * with their cost stated up front.
 *
 * Two rules this card must not break:
 *
 *  - The wait row is CONDITIONAL, never a promise. "If the borrower
 *    repays…" — a lender told they will be paid at maturity has been
 *    told something the protocol cannot guarantee.
 *  - The wait row is CADENCE-AWARE. On a loan with a periodic interest
 *    schedule the lender is paid DURING the term, so a single
 *    end-of-term sentence misstates when they get paid — which is
 *    precisely the fact the row exists to convey. The shape is chosen
 *    from the loan's own schedule, never assumed, and while the
 *    schedule is unknown the row says so rather than guessing.
 *
 * Availability is honest and explanatory: a row that cannot be taken
 * says WHY and names what remains, instead of vanishing (which reads as
 * "no such option") or jumping to a card that would refuse.
 *
 * Deliberately dumb, exactly like the borrower's chooser: it never
 * submits anything. Rows jump to the flow's own card, which owns its
 * gates, quotes and confirm receipt.
 */
import { ListChecks } from 'lucide-react';
import { copy } from '../content/copy';
import {
  buildLenderExitRows,
  chooserReadiness,
  hasJumpableRow,
  type InstantSellCandidates,
  type LenderExitJumpTarget,
  type MaturityState,
  type SaleCancelState,
  type SaleLockState,
  type SaleToolsState,
} from '../data/lenderExitRows';

export type { LenderExitJumpTarget };

export function LenderExitOptionsCard({
  isAdvanced,
  onSwitchToAdvanced,
  ...rowInput
}: {
  isAdvanced: boolean;
  onSwitchToAdvanced: () => void;
  /** Loan's periodic-interest cadence (0 = none). `undefined` while the
   *  live read is in flight — renders the neutral checking wording
   *  rather than asserting the at-close shape, which would misstate
   *  when a periodically-settling lender is paid. */
  periodicInterestCadence: number | undefined;
  /** Whether that read FAILED rather than being in flight — see
   *  `LenderExitInput.cadenceReadFailed`. */
  cadenceReadFailed: boolean;
  /** Chain-anchored. Past maturity BOTH sale rows flip to the past-due
   *  line: a fully-elapsed term is refused at CREATION. Three-valued,
   *  not a boolean — see `MaturityState`. */
  maturity: MaturityState;
  /** See `LenderExitInput.listingWindowTooShort`. */
  listingWindowTooShort: boolean;
  /** The listing surface is not published to every deployment. */
  listingSupportedOnChain: boolean;
  /** Operator kill switch — LISTING row only. See the input's note. */
  listingFlowDisabled: boolean;
  /** Whether the sale tools (and their jump anchors) can render at
   *  all — see `SaleToolsState`. */
  saleTools: SaleToolsState;
  /** Phase 1 listing is ERC-20-collateral only. */
  collateralIsNft: boolean;
  /** Wait-row timing only — see `LenderExitInput.allowsPartialRepay`. */
  allowsPartialRepay: boolean;
  /** See `LenderExitInput.lenderFeeModeFull`. */
  lenderFeeModeFull: boolean;
  /** Whether the pending card below will offer a cancel, and if not,
   *  why — see `SaleCancelState`. */
  saleCancel: SaleCancelState;
  /** Live status says FallbackPending: the card stays, both sales go.
   *  See `LenderExitInput.fallbackPending`. */
  fallbackPending: boolean;
  /** Has every enabled live status read answered? Only the readiness
   *  attribute reads it — see `LenderExitInput.statusSettled`. */
  statusSettled: boolean;
  /** Has every enabled MATURITY read answered? A different query set
   *  from `statusSettled`'s, and only the readiness attribute reads it
   *  — see `LenderExitInput.maturitySettled`. */
  maturitySettled: boolean;
  /** Did an enabled maturity read stop WITHOUT answering? Settled and
   *  answered are different — see `LenderExitInput.maturityReadFailed`. */
  maturityReadFailed: boolean;
  /** The same for the status reads — see
   *  `LenderExitInput.statusReadFailed`. */
  statusReadFailed: boolean;
  /** Did the sale-lock read fail rather than being in flight? See
   *  `LenderExitInput.saleLockReadFailed`. */
  saleLockReadFailed: boolean;
  /** Has the sale-lock read stopped? See
   *  `LenderExitInput.saleLockSettled`. */
  saleLockSettled: boolean;
  /** Has the source that reported FallbackPending stopped? See
   *  `LenderExitInput.fallbackSourceSettled`. */
  fallbackSourceSettled: boolean;
  /** Whether this position already carries a live listing. A TRI-STATE
   *  (`SaleLockState`), not a boolean: the lock refuses BOTH sale paths
   *  (`SaleOfferAlreadyExists`, and the page unmounts the instant-exit
   *  card entirely), so an unanswered read must not collapse to
   *  "clear" — that showed both exits as available on a position whose
   *  lock had never been checked (Codex r1 P2). */
  saleLock: SaleLockState;
  /** See `LenderExitInput.listingMayStand`. */
  listingMayStand: boolean;
  /** A position with unresolved held VPFI cannot be unified to one
   *  settlement identity, so listing refuses it
   *  (`SalePositionNotConsolidatable`).
   *
   *  KNOWN GAP: no caller can currently compute this — there is no
   *  cheap client read for the held-for-lender balance, so every caller
   *  passes `false` today and the refusal still surfaces as a revert in
   *  the listing tool rather than as this row's explanation. The prop
   *  exists so wiring it later is a one-line change at the call site
   *  rather than a re-plumb, and so the omission is visible here
   *  instead of silently absent. */
  heldVpfiUnresolved: boolean;
  /** The borrower has a linked exit (preclose offset) pending — the
   *  protocol refuses a listing until it clears (`OffsetActiveOnLoan`).
   *
   *  KNOWN GAP, same shape as `heldVpfiUnresolved`: every caller passes
   *  `false` today. `useOffsetPending` seeds from a browser-LOCAL
   *  marker written by the borrower's own session, so a lender's
   *  browser has nothing to read; surfacing it needs a chain read of
   *  the loan→offset-offer link, tracked with the other deferred
   *  pre-checks. Until then the listing tool still refuses correctly —
   *  the cost is a wasted click, not a wrong action. */
  borrowerOffsetPending: boolean;
  /** See `InstantSellCandidates`. `'unknown'` is today's Basic-mode
   *  answer and is deliberate: the candidate list comes from
   *  `useActiveOffers`, a full active-offers page walk this page does
   *  not otherwise make, and hoisting it would put that walk on every
   *  lender who merely opens a position. */
  instantSellCandidates: InstantSellCandidates;
}) {
  const rows = buildLenderExitRows(rowInput);

  const jump = (target: LenderExitJumpTarget) => {
    document
      .getElementById(target)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // See `hasJumpableRow`: the wait row has no tool behind it, so a
  // lender whose sale rows are all unavailable has nothing to switch TO.
  const anyJumpableRow = hasJumpableRow(rows);

  return (
    <section
      className="card"
      data-testid="lender-exit-card"
      // A READINESS SIGNAL, not decoration (#1855). From outside this
      // card the absence of the switch below is ambiguous — it is
      // missing both while a prerequisite read is in flight and when no
      // row is genuinely jumpable. A live review cannot tell those apart
      // from the DOM, so it waits out a 45-second deadline per page and
      // then still cannot distinguish a stale render from a regression.
      //
      // These two attributes make the card state its own answer:
      // `ready` says the jumpability question has settled, and
      // `jumpable` says what it settled to. With both, "the switch
      // should be here" becomes a fact a driver can read rather than
      // one it has to infer from an absence.
      //
      // Presentational-null: nothing styles or branches on these, and
      // removing them changes no rendered pixel. They are the smallest
      // thing that makes the invariant observable.
      data-chooser-ready={chooserReadiness(rowInput)}
      data-chooser-jumpable={anyJumpableRow ? 'yes' : 'no'}
    >
      <div className="card-title">
        <ListChecks aria-hidden />
        <h3 style={{ margin: 0 }}>{copy.lenderExit.title}</h3>
      </div>
      <p className="muted">{copy.lenderExit.blurb}</p>
      <div className="stack" style={{ gap: 12 }}>
        {rows.map((row) => (
          <div className="item-row" key={row.key}>
            <div className="row-main">
              <div className="row-title">{row.title}</div>
              <div className="row-sub">{row.desc}</div>
              {row.cost && (!row.unavailable || row.costStillApplies) ? (
                <div className="row-sub muted">{row.cost}</div>
              ) : null}
              {/* Same gate as `cost` — it IS a cost line, just one that
                  applies to a subset of positions. */}
              {row.costExtra &&
              (!row.unavailable || row.costStillApplies) ? (
                <div className="row-sub muted">{row.costExtra}</div>
              ) : null}
              {/* Codex r2 P2 — the structural note renders INDEPENDENTLY
                  of availability, unlike `cost`. Gating it the same way
                  suppressed the cross-party disclosure precisely while
                  a listing was actively holding the borrower's offset
                  and collateral-withdrawal options — the moment it is
                  most true and most worth saying. It matters for
                  listings a lender did not make in this session: by a
                  keeper, on another device, or before this card
                  shipped. `LoanSalePendingCard` covers the seller's own
                  lock and cancellation but never the borrower impact,
                  so nothing else on the page says it.

                  `cost` is availability-gated, but NOT unconditionally
                  — see `costStillApplies` (Codex r5 P1). The r2 rule
                  said cost is noise on an option that cannot be taken,
                  which is right in general and wrong for a live
                  listing: that is a sale in FLIGHT, not an option
                  declined, so its losses are pending consequences
                  rather than hypothetical prices. Three tiers, then:
                  `desc` and `note` always; `cost` when the option is
                  takeable OR already committed; the `unavailable`
                  reason only when it is neither. */}
              {row.note ? (
                <div className="row-sub muted">{row.note}</div>
              ) : null}
              {row.unavailable ? (
                <div className="row-sub muted">{row.unavailable}</div>
              ) : null}
            </div>
            {row.target && !row.unavailable && isAdvanced ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => jump(row.target as LenderExitJumpTarget)}
              >
                {copy.lenderExit.jump}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {!isAdvanced && anyJumpableRow ? (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onSwitchToAdvanced}
          >
            {copy.lenderExit.switchToAdvanced}
          </button>
          <p className="field-hint" style={{ marginTop: 8 }}>
            {copy.lenderExit.switchNote}
          </p>
        </div>
      ) : null}
    </section>
  );
}
