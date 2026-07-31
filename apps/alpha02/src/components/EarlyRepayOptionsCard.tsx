/**
 * "Ways to repay or exit early" — the borrower's early-repayment
 * CHOOSER (FunctionalSpecs §8). The contracts offer six ways out of
 * an active ERC-20 loan before its due date; historically the page
 * exposed only "Repay this loan" in Basic mode and hid the rest in
 * unadvertised Advanced cards. This card names every path with its
 * cost implication up front (the §8 "path-specific interest
 * implication warning"), so the choice is discoverable BEFORE any
 * flow opens.
 *
 * Deliberately dumb: it never submits anything. Each row jumps to the
 * flow's own card (which owns its gates, quotes, and confirm
 * receipt); in Basic mode the advanced rows share one explicit
 * "switch to Advanced" action instead — mode is a user choice, never
 * a side effect of browsing options.
 */
import { ListChecks } from 'lucide-react';
import { copy } from '../content/copy';

export type EarlyRepayJumpTarget =
  | 'repay-action'
  | 'partial-repay-card'
  | 'preclose-card'
  | 'transfer-card'
  | 'offset-card'
  | 'refinance-card';

interface OptionRow {
  key: string;
  title: string;
  desc: string;
  cost?: string;
  unavailable?: string;
  target: EarlyRepayJumpTarget;
  /** Rendered in Basic mode too (the full-repay path lives there). */
  basic?: boolean;
}

export function EarlyRepayOptionsCard({
  isAdvanced,
  onSwitchToAdvanced,
  partialAllowed,
  /** Loan interest mode when known (live read); undefined shows the
   *  conservative full-term wording (the protocol default). */
  useFullTermInterest,
  /** Local-clock hint only — annotates the transfer/offset rows once
   *  the due date passed (their cards gate on chain time). */
  pastDueHint,
  refinancePending,
  refinanceEligible,
}: {
  isAdvanced: boolean;
  onSwitchToAdvanced: () => void;
  partialAllowed: boolean;
  useFullTermInterest: boolean | undefined;
  pastDueHint: boolean;
  refinancePending: boolean;
  /** Carry-over refinance binds to the ORIGINAL borrower — a wallet
   *  that acquired the position on the secondary market never gets
   *  the refinance card, so the chooser must say why instead of
   *  offering a jump to nothing (Codex #1500 r1). */
  refinanceEligible: boolean;
}) {
  const o = copy.earlyRepay.options;
  const rows: OptionRow[] = [
    {
      key: 'full',
      title: o.repayFull,
      desc: o.repayFullDesc,
      cost:
        useFullTermInterest === false
          ? o.closeEarlyCostProRata
          : o.closeEarlyCostFullTerm,
      target: 'repay-action',
      basic: true,
    },
    {
      key: 'partial',
      title: o.repayPartial,
      desc: o.repayPartialDesc,
      unavailable: partialAllowed ? undefined : o.repayPartialUnavailable,
      target: 'partial-repay-card',
    },
    {
      key: 'close-early',
      title: o.closeEarly,
      desc: o.closeEarlyDesc,
      cost:
        useFullTermInterest === false
          ? o.closeEarlyCostProRata
          : o.closeEarlyCostFullTerm,
      target: 'preclose-card',
    },
    {
      key: 'transfer',
      title: o.transfer,
      desc: o.transferDesc,
      cost: o.transferCost,
      unavailable: pastDueHint ? copy.offset.onlyBeforeDue : undefined,
      target: 'transfer-card',
    },
    {
      key: 'offset',
      title: o.offset,
      desc: o.offsetDesc,
      cost: o.offsetCost,
      unavailable: pastDueHint ? copy.offset.onlyBeforeDue : undefined,
      target: 'offset-card',
    },
    {
      key: 'refinance',
      title: o.refinance,
      desc: o.refinanceDesc,
      cost: o.refinanceCost,
      unavailable: !refinanceEligible
        ? o.refinanceTransferredUnavailable
        : refinancePending
          ? copy.refinance.partialBlockedByPending
          : undefined,
      target: 'refinance-card',
    },
  ];

  const jump = (target: EarlyRepayJumpTarget) => {
    document
      .getElementById(target)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const anyAdvancedRow = rows.some((r) => !r.basic);

  return (
    <section className="card">
      <div className="card-title">
        <ListChecks aria-hidden />
        <h3 style={{ margin: 0 }}>{copy.earlyRepay.title}</h3>
      </div>
      <p className="muted">{copy.earlyRepay.blurb}</p>
      <div className="stack" style={{ gap: 12 }}>
        {rows.map((row) => (
          <div className="item-row" key={row.key}>
            <div className="row-main">
              <div className="row-title">{row.title}</div>
              <div className="row-sub">{row.desc}</div>
              {row.cost && !row.unavailable ? (
                <div className="row-sub muted">{row.cost}</div>
              ) : null}
              {row.unavailable ? (
                <div className="row-sub muted">{row.unavailable}</div>
              ) : null}
            </div>
            {!row.unavailable && (isAdvanced || row.basic) ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => jump(row.target)}
              >
                {copy.earlyRepay.jump}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {!isAdvanced && anyAdvancedRow ? (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onSwitchToAdvanced}
          >
            {copy.earlyRepay.switchToAdvanced}
          </button>
          <p className="field-hint" style={{ marginTop: 8 }}>
            {copy.earlyRepay.switchNote}
          </p>
        </div>
      ) : null}
    </section>
  );
}
