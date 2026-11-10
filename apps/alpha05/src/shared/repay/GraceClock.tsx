import { useCopy } from '../copy/useCopy';
import { formatSpan, formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { useNow } from '../ui/useNow';
import { graceClock, type GraceDates } from './graceClock';

/**
 * RB-GRACE-CLOCK: a repayment of a loan in grace counts down to the end of
 * grace by the chain's clock and says to send early, since a default filed
 * after grace ends and a repayment sent just before it race, and whichever
 * is mined first wins. It states; the re-read verdict refuses.
 */
export function GraceClock({ dates }: { dates: GraceDates }) {
  const { format } = useCopy();
  const clock = graceClock(dates, useNow(5_000));
  if (clock.kind === 'none') return null;
  const time = formatUtc(clock.endsAt);
  return (
    <div data-testid="grace-clock" data-kind={clock.kind}>
      {clock.kind === 'ended' ? (
        <Notice tone="danger" tier="A">
          {format('repay.graceClockEnded', { time })}
        </Notice>
      ) : (
        <Notice tone={clock.kind === 'urgent' ? 'danger' : 'warn'} tier="A">
          {format(clock.kind === 'urgent' ? 'repay.graceClockUrgent' : 'repay.graceClock', { time, left: formatSpan(clock.leftSeconds) })}
        </Notice>
      )}
    </div>
  );
}
