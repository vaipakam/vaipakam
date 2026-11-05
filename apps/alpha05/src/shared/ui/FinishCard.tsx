import { Link } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import type { FinishCard as FinishCardModel } from '../receipt/types';
import { partialMix } from '../tx/outcome';
import { Receipt, type ReceiptProps } from './Receipt';
import { Notice } from './Notice';

/**
 * RB-CONFIDENCE — the finish card shown after every action: the MEASURED
 * outcome (done, partial, not done, unknown; never a receipt presented as
 * success), one line per leg with its reason, the next action the
 * position now has, and the receipt it was signed against.
 */
const PARTIAL_KEY = { failed: 'finish.partialFailed', unknown: 'finish.partialUnknown', mixed: 'finish.partialMixed' } as const;

/** The verdict sentence is chosen from the legs' statuses, so "did not land"
 *  is said only of a leg whose failure was read, never of one whose effect
 *  could not be read back. */
export function verdictCopyKey(outcome: FinishCardModel['outcome']) {
  switch (outcome.verdict) {
    case 'done':
      return 'finish.done' as const;
    case 'not-done':
      return 'finish.notDone' as const;
    case 'unknown':
      return 'finish.unknown' as const;
    case 'partial':
      return PARTIAL_KEY[partialMix(outcome.legs)];
  }
}

export function FinishCard({ card, describeAsset, nowMs }: { card: FinishCardModel } & Omit<ReceiptProps, 'receipt'>) {
  const { text } = useCopy();
  const { outcome } = card;
  const tone = outcome.verdict === 'done' ? 'ok' : outcome.verdict === 'not-done' ? 'danger' : 'warn';
  const verdictKey = verdictCopyKey(outcome);
  return (
    <section className="finish" aria-label={text('finish.title')}>
      <Notice tone={tone} tier="A">
        {text(verdictKey)}
      </Notice>
      <ul className="legs">
        {outcome.legs.map((leg) => (
          <li key={leg.label} data-status={leg.status}>
            <span className="leg-label">{leg.label}</span>
            {': '}
            {leg.status === 'done' ? text('finish.legDone') : leg.reason}
          </li>
        ))}
      </ul>
      {card.next && (
        <p className="tier-b">
          <Link className="btn btn-primary" to={card.next.to}>
            {card.next.label}
          </Link>
        </p>
      )}
      <Receipt receipt={card.receipt} describeAsset={describeAsset} nowMs={nowMs} />
    </section>
  );
}
