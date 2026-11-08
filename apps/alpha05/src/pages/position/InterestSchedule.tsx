import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { CADENCE_NAME, isCadence } from '../../shared/offers/cadence';
import type { LoanView } from '../../shared/positions/loanView';
import { settlementState, type SettlementState } from '../../shared/positions/schedule';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { Fact, Facts } from './Facts';

/**
 * LN-24 — a running loan's interest schedule: the current period's end and
 * grace end, the interest it owes, what has been paid toward it and what is
 * still owed, all from the protocol's own preview (`previewPeriodicSettle`),
 * and whether the period can be settled now. The deployment's periodic-
 * settlement switch and the protocol pause are stated in every phase, by
 * name, because either stops settlement: switched off, the switch's
 * sentence replaces any warning of a sale; paused, the pause is named and
 * no sale is announced. An unread switch, pause or period is stated as
 * unknown. The block time the period is placed against is stated.
 *
 * Read-only: paying a period by partial repayment and settling a due period
 * come with their own actions.
 */
export function InterestSchedule({ view: v, meta }: { view: LoanView; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const l = v.loan;
  const s = v.schedule;
  const unknown = text('receipt.unknown');
  const amount = (x: bigint) => tokenAmount(x, l.principalAsset, meta, format);
  const cadence = l.periodicInterestCadence;
  const state: SettlementState | null = s ? settlementState(s, v.periodicOn, v.paused, v.chainNow) : null;
  const pauseCredit = v.deadlines?.pauseCredit ?? 0n;

  const settleValue = (): string | null => {
    if (!state) return null;
    switch (state.kind) {
      case 'off':
        return text('schedule.settleOff');
      case 'paused':
        return text('schedule.settlePaused');
      case 'due':
        return text('schedule.settleOpen');
      case 'held':
        return text('schedule.settleHeld');
      case 'running':
        return format('schedule.settleOpens', { time: formatUtc(Number(state.graceEndsAt)) });
      default:
        return null;
    }
  };

  const notes = (
    <div className="schedule-notes" data-testid="schedule-notes" data-state={state?.kind ?? 'unread'}>
      {state === null ? (
        <Notice tone="warn" tier="A">
          {text('schedule.unread')}
        </Notice>
      ) : (
        <StateNote state={state} amount={amount} />
      )}
      {state?.kind !== 'off' && <p className="tier-b">{text(l.allowsPartialRepay ? 'schedule.payByPartial' : 'schedule.noPartial')}</p>}
      {pauseCredit > 0n && <p className="tier-a">{text('schedule.pausedStretch')}</p>}
      {state && state.kind !== 'off' && state.kind !== 'paused' && <p className="tier-b">{text('schedule.keeper')}</p>}
      {v.chainNow !== null && <p className="tier-b">{format('schedule.chainTime', { time: formatUtc(Number(v.chainNow)) })}</p>}
    </div>
  );

  return (
    <Facts
      title={text('schedule.title')}
      id="position-schedule"
      testId="position-schedule"
      foot={notes}
      lead={<WhyLink summaryKey="schedule.expectedSummary" detailKey="schedule.expectedWhy" />}
    >
      <Fact
        label={text('schedule.rowCadence')}
        value={isCadence(cadence) && cadence !== 0 ? format('accept.scheduleEvery', { cadence: text(CADENCE_NAME[cadence]) }) : null}
        unknown={unknown}
      />
      <Fact label={text('schedule.rowPeriodEnd')} value={s ? formatUtc(Number(s.periodEndAt)) : null} unknown={unknown} binding />
      <Fact label={text('schedule.rowGraceEnd')} value={s ? formatUtc(Number(s.graceEndsAt)) : null} unknown={unknown} binding />
      <Fact label={text('schedule.rowExpected')} value={s ? amount(s.expected) : null} unknown={unknown} />
      <Fact label={text('schedule.rowPaid')} value={s ? amount(s.paid) : null} unknown={unknown} />
      <Fact label={text('schedule.rowShortfall')} value={s ? amount(s.shortfall) : null} unknown={unknown} binding />
      <Fact label={text('schedule.rowSettle')} value={settleValue()} unknown={unknown} binding />
    </Facts>
  );
}

/** The sentence for where the period stands; a sale is announced only when
 *  settlement is on and the protocol is not paused. */
function StateNote({ state, amount }: { state: SettlementState; amount: (x: bigint) => string }) {
  const { text, format } = useCopy();
  switch (state.kind) {
    case 'off':
      return <p className="tier-a">{text('schedule.off')}</p>;
    case 'switch-unread':
      return <p className="tier-a">{text('schedule.switchUnread')}</p>;
    case 'paused':
      return <p className="tier-a">{text('schedule.paused')}</p>;
    case 'pause-unread':
      return <p className="tier-a">{text('schedule.pauseUnread')}</p>;
    case 'time-unread':
      return <p className="tier-b">{text('schedule.timeUnread')}</p>;
    case 'held':
      return <p className="tier-a">{text('schedule.held')}</p>;
    case 'running':
      return state.shortfall === 0n ? (
        <p className="tier-b">{text('schedule.covered')}</p>
      ) : (
        <p className="tier-a">{format('schedule.owedLater', { amount: amount(state.shortfall), time: formatUtc(Number(state.graceEndsAt)) })}</p>
      );
    case 'due':
      return state.shortfall === 0n ? (
        <p className="tier-b">{text('schedule.covered')}</p>
      ) : (
        <p className="tier-a">{format('schedule.dueShort', { amount: amount(state.shortfall) })}</p>
      );
  }
}
