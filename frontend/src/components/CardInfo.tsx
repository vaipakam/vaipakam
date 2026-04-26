import { ExternalLink } from 'lucide-react';
import { InfoTip } from './InfoTip';
import { getCardHelp } from '../lib/cardHelp';

/**
 * `<CardInfo id="…">` — drop-in (i) icon next to a card title that
 * opens an InfoTip with a brief blurb and an optional "Learn more →"
 * link out to the canonical documentation.
 *
 * Looks the entry up in `lib/cardHelp.ts` by id. Returns `null` when
 * the id has no registered entry, so adding `<CardInfo />` to a card
 * before its copy has been drafted is safe — no broken render, just
 * a missing icon you can fill in later.
 *
 * Usage:
 *   <div className="card-title">
 *     Your Loans
 *     <CardInfo id="dashboard.your-loans" />
 *   </div>
 *
 * Pairs with the existing `.card-title` styles — `<InfoTip>`'s
 * trigger is `inline-flex` with `vertical-align: middle`, so it
 * sits cleanly on the title's baseline without further CSS.
 */
export interface CardInfoProps {
  /** Registry key — `<page>.<card-slug>`. See lib/cardHelp.ts. */
  id: string;
}

export function CardInfo({ id }: CardInfoProps) {
  const entry = getCardHelp(id);
  if (!entry) return null;

  return (
    <InfoTip ariaLabel="About this card">
      <span>{entry.summary}</span>
      {entry.learnMoreHref && (
        <>
          {' '}
          <a
            href={entry.learnMoreHref}
            target="_blank"
            rel="noreferrer noopener"
            className="card-info-learn-more"
          >
            Learn more
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        </>
      )}
    </InfoTip>
  );
}

export default CardInfo;
