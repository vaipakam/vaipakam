import { Link } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import type { FinishCard as FinishCardModel } from '../receipt/types';
import { Receipt, type ReceiptProps } from './Receipt';
import { Notice } from './Notice';

/**
 * RB-CONFIDENCE — the finish card shown after every action: the MEASURED
 * outcome (done, partial, not done, unknown; never a receipt presented as
 * success), one line per leg with its reason, the next action the
 * position now has, and the receipt it was signed against.
 */
export function FinishCard({ card, describeAsset, nowMs }: { card: FinishCardModel } & Omit<ReceiptProps, 'receipt'>) {
  const { text } = useCopy();
  const { outcome } = card;
  const tone = outcome.verdict === 'done' ? 'ok' : outcome.verdict === 'not-done' ? 'danger' : 'warn';
  const verdictKey = `finish.${outcome.verdict === 'not-done' ? 'notDone' : outcome.verdict}` as const;
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
