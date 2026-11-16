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
 * "no such option") or jumping to a card that would refuse. The WHY is
 * the contract's own verdict on each sale route for this wallet
 * (`saleExitVerdict`, #1841), never a rule restated here.
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
  type LenderExitInput,
  type LenderExitJumpTarget,
} from '../data/lenderExitRows';

export type { LenderExitJumpTarget };

/** The card's props are the rows' input plus the mode switch. Each field
 *  is documented once, on `LenderExitInput`, so the card cannot carry a
 *  second description of a rule that has since moved (#1841 replaced
 *  most of them with the contract's verdict). */
export function LenderExitOptionsCard({
  isAdvanced,
  onSwitchToAdvanced,
  ...rowInput
}: LenderExitInput & {
  isAdvanced: boolean;
  onSwitchToAdvanced: () => void;
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
      // The retired app's `/loans/:id/early-withdrawal` lands here (#2076).
      id="lender-exit-options"
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
