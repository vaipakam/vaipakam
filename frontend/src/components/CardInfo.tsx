import { ExternalLink } from 'lucide-react';
import { InfoTip } from './InfoTip';
import { getCardHelp } from '../lib/cardHelp';
import { useMode } from '../context/ModeContext';

/**
 * `<CardInfo id="…">` — drop-in (i) icon next to a card title that
 * opens an InfoTip with a brief blurb and a "Learn more →" link out
 * to the canonical user guide.
 *
 * Looks the entry up in `lib/cardHelp.ts` by id. Returns `null` when
 * the id has no registered entry, so adding `<CardInfo />` to a card
 * before its copy has been drafted is safe — no broken render, just
 * a missing icon you can fill in later.
 *
 * The "Learn more →" link is computed from the active UI mode:
 * basic → `docs/UserGuide-Basic.md#<id>`, advanced →
 * `docs/UserGuide-Advanced.md#<id>`. Each id is registered as an HTML
 * anchor (`<a id="…"></a>`) in both guides so the fragment resolves
 * deterministically on GitHub's renderer. When the in-app `/help/<id>`
 * route lands (Phase 3), only this component changes — the per-card
 * registry stays untouched.
 *
 * Pairs with the existing `.card-title` styles — `<InfoTip>`'s
 * trigger is `inline-flex` with `vertical-align: middle`, so it
 * sits cleanly on the title's baseline without further CSS.
 */
export interface CardInfoProps {
  /** Registry key — `<page>.<card-slug>`. See lib/cardHelp.ts. */
  id: string;
}

const DOCS_BASE =
  'https://github.com/vaipakam/vaipakam/blob/main/docs';

function buildLearnMoreHref(mode: 'basic' | 'advanced', id: string): string {
  const file = mode === 'advanced' ? 'UserGuide-Advanced.md' : 'UserGuide-Basic.md';
  return `${DOCS_BASE}/${file}#${id}`;
}

export function CardInfo({ id }: CardInfoProps) {
  const entry = getCardHelp(id);
  const { mode } = useMode();
  if (!entry) return null;

  const learnMoreHref = buildLearnMoreHref(mode, id);

  return (
    <InfoTip ariaLabel="About this card">
      <span>{entry.summary}</span>
      {' '}
      <a
        href={learnMoreHref}
        target="_blank"
        rel="noreferrer noopener"
        className="card-info-learn-more"
      >
        Learn more
        <ExternalLink size={11} aria-hidden="true" />
      </a>
    </InfoTip>
  );
}

export default CardInfo;
