import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDiamondRead } from '../../contracts/useDiamond';
import { TokenAmount } from '../app/TokenAmount';
import { CADENCE_I18N_KEY } from '../../lib/periodicInterestCadence';

interface Props {
  loanId: bigint;
  /** Loan's principal asset — used by the embedded `<TokenAmount>`
   *  formatters for the expected / paid / shortfall rows. */
  principalAsset: string;
  /** True when the wallet IS the borrower — controls the "Pay now"
   *  affordance. The actual payment goes through the existing
   *  `repayPartial` flow elsewhere on the page. */
  isBorrower: boolean;
  /** Callback that scrolls / opens the page's existing partial-repay
   *  surface. Wiring here is intentionally minimal — PR3 may build a
   *  dedicated "settle just this period's interest" flow. */
  onPayNowClick?: () => void;
}

interface PeriodicSettleView {
  cadence: number;
  periodEndAt: bigint;
  graceEndsAt: bigint;
  expected: bigint;
  paidByBorrower: bigint;
  shortfall: bigint;
  canSettleNow: boolean;
}

/**
 * T-034 PR2 — loan-detail "Next interest checkpoint" card.
 *
 * Reads `RepayFacet.previewPeriodicSettle(loanId)` and renders a
 * countdown + expected/paid/shortfall breakdown. Hidden entirely when
 * the loan's cadence is None (today's terminal-only behavior). When the
 * borrower is connected and a shortfall exists, a "Pay now" button
 * surfaces — clicking routes to the existing partial-repay flow which
 * automatically settles the accrued interest as part of any
 * principal-reduction call.
 */
export function PeriodicInterestCheckpointCard({
  loanId,
  principalAsset,
  isBorrower,
  onPayNowClick,
}: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondRead();
  const [view, setView] = useState<PeriodicSettleView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = diamond as unknown as {
          previewPeriodicSettle: (loanId: bigint) => Promise<
            [number, bigint, bigint, bigint, bigint, bigint, boolean]
          >;
        };
        const tup = await d.previewPeriodicSettle(loanId);
        if (cancelled) return;
        setView({
          cadence: Number(tup[0]),
          periodEndAt: BigInt(tup[1]),
          graceEndsAt: BigInt(tup[2]),
          expected: BigInt(tup[3]),
          paidByBorrower: BigInt(tup[4]),
          shortfall: BigInt(tup[5]),
          canSettleNow: Boolean(tup[6]),
        });
      } catch {
        // Older deploy without the view, or transient RPC blip — render
        // nothing rather than blocking the page.
        if (!cancelled) setView(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, loanId]);

  if (!view) return null;
  if (view.cadence === 0) return null; // None cadence — card hidden entirely

  const now = Math.floor(Date.now() / 1000);
  const periodEnd = Number(view.periodEndAt);
  const graceEnd = Number(view.graceEndsAt);
  const daysToBoundary = Math.max(0, Math.ceil((periodEnd - now) / 86400));
  const beyondGrace = now >= graceEnd;
  const cadenceLabel = t(
    CADENCE_I18N_KEY[view.cadence as keyof typeof CADENCE_I18N_KEY] ??
      'periodicInterest.cadence.none',
  );

  const stateColor = beyondGrace
    ? 'rgba(220,53,69,0.4)' // red — past grace, settler-callable
    : view.shortfall === 0n
      ? 'rgba(0,255,136,0.4)' // green — fully covered
      : 'rgba(245,158,11,0.45)'; // amber — pending

  const stateBg = beyondGrace
    ? 'rgba(220,53,69,0.08)'
    : view.shortfall === 0n
      ? 'rgba(0,255,136,0.08)'
      : 'rgba(245,158,11,0.08)';

  return (
    <div
      className="card"
      style={{
        border: `1px solid ${stateColor}`,
        background: stateBg,
        marginBottom: 16,
      }}
    >
      <div className="card-title">
        {t('loanDetails.periodicInterest.title', {
          cadence: cadenceLabel,
        })}
      </div>
      <div className="data-row">
        <span className="data-label">
          {t('loanDetails.periodicInterest.nextCheckpoint')}
        </span>
        <span className="data-value">
          {beyondGrace
            ? t('loanDetails.periodicInterest.pastGrace')
            : t('loanDetails.periodicInterest.inDays', { count: daysToBoundary })}
        </span>
      </div>
      <div className="data-row">
        <span className="data-label">
          {t('loanDetails.periodicInterest.expected')}
        </span>
        <span className="data-value mono">
          <TokenAmount amount={view.expected} address={principalAsset} />
        </span>
      </div>
      <div className="data-row">
        <span className="data-label">
          {t('loanDetails.periodicInterest.paid')}
        </span>
        <span className="data-value mono">
          <TokenAmount amount={view.paidByBorrower} address={principalAsset} />
        </span>
      </div>
      <div className="data-row">
        <span className="data-label">
          {t('loanDetails.periodicInterest.shortfall')}
        </span>
        <span className="data-value mono">
          <TokenAmount amount={view.shortfall} address={principalAsset} />
        </span>
      </div>
      {view.shortfall > 0n && isBorrower && (
        <button
          className="btn btn-primary btn-sm"
          style={{ marginTop: 12 }}
          onClick={onPayNowClick}
        >
          {t('loanDetails.periodicInterest.payNow')}
        </button>
      )}
      {beyondGrace && view.shortfall > 0n && (
        <small style={{ display: 'block', opacity: 0.85, marginTop: 8 }}>
          {t('loanDetails.periodicInterest.pastGraceHint')}
        </small>
      )}
    </div>
  );
}
