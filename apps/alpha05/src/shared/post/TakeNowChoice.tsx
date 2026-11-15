import { useCopy } from '../copy/useCopy';
import { OfferRow } from '../offers/MatchingOffers';
import type { MatchRow } from '../offers/matches';
import type { TokenMetaMap } from '../reads/tokens';
import type { PostSide } from './postModel';

const KEYS = {
  borrower: { title: 'request.takeNowTitle', lead: 'request.takeNowLead', post: 'request.takeNowPost', back: 'request.takeNowBack' },
  lender: { title: 'lendOffer.takeNowTitle', lead: 'lendOffer.takeNowLead', post: 'lendOffer.takeNowPost', back: 'lendOffer.takeNowBack' },
} as const;

/**
 * #3622 B1 — shown between the form and the post review when an open offer
 * on the other side already fits the draft (`takeNowPicks`). Each fitting
 * offer is shown as the offer list shows it, with its own take button, which
 * opens the ordinary accept review on that offer's terms; "post anyway" opens
 * the post review the reader asked for. The choice is the reader's: nothing
 * is taken or posted from here without a press.
 */
export function TakeNowChoice({
  side,
  picks,
  matcherBps,
  meta,
  takeDisabled,
  onTake,
  onPost,
  onBack,
}: {
  side: PostSide;
  picks: MatchRow[];
  matcherBps: bigint | null;
  meta: TokenMetaMap | null;
  takeDisabled: boolean;
  onTake: (id: bigint) => void;
  onPost: () => void;
  onBack: () => void;
}) {
  const { text } = useCopy();
  const k = KEYS[side];
  return (
    <section className="take-now" aria-labelledby="take-now-title" data-testid="take-now">
      <h2 id="take-now-title">{text(k.title)}</h2>
      <p className="tier-a">{text(k.lead)}</p>
      {picks.length === 0 ? (
        // The page re-reads the book: an offer that fitted can be taken or
        // cancelled while the reader decides, and is then no longer shown.
        <p className="tier-a" data-testid="take-now-gone">
          {text('request.takeNowGone')}
        </p>
      ) : (
        <ul className="rows offer-rows">
          {picks.map((row) => (
            <OfferRow key={row.offer.id.toString()} role={side} row={row} matcherBps={matcherBps} meta={meta} onTake={onTake} takeDisabled={takeDisabled} />
          ))}
        </ul>
      )}
      <p className="actions">
        <button type="button" className="btn" onClick={onPost} data-testid="take-now-post">
          {text(k.post)}
        </button>
        <button type="button" className="btn-link" onClick={onBack} data-testid="take-now-back">
          {text(k.back)}
        </button>
      </p>
    </section>
  );
}
