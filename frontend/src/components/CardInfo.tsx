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
  /** Optional viewer role. When set AND the registry entry carries a
   *  role-keyed summary, the tooltip shows the role-specific copy and
   *  the "Learn more →" anchor gets a `:lender` / `:borrower` suffix
   *  so the user lands on the matching subsection of the user guide.
   *  Pass `form.offerType` from the Create Offer flow; omit elsewhere. */
  role?: 'lender' | 'borrower';
}

/**
 * Build the in-app help URL for a given (mode, card id, role suffix)
 * triple. The /help routes (`/help/basic`, `/help/advanced`) are
 * publicly accessible — no wallet required, same chrome as the
 * landing / analytics pages — so the link works from any context
 * including the Public Dashboard.
 *
 * The fragment carries the registry id and (for role-keyed cards)
 * a `:lender` / `:borrower` suffix. The UserGuide page reads the
 * suffix on first load to set the page-wide tab and reads the
 * base id to scroll to the right section.
 */
function buildLearnMoreHref(
  mode: 'basic' | 'advanced',
  id: string,
  roleSuffix: string,
): string {
  return `/help/${mode}#${id}${roleSuffix}`;
}

export function CardInfo({ id, role }: CardInfoProps) {
  const entry = getCardHelp(id);
  const { mode } = useMode();
  if (!entry) return null;

  const isRoleKeyed = typeof entry.summary !== 'string';
  // Role-keyed entry: pick the variant matching the viewer's role and
  // suffix the docs anchor so the link lands on the right subsection.
  // Fallback to the lender variant when role wasn't supplied — keeps
  // the tooltip readable even if the call site forgot the prop.
  const summary = isRoleKeyed
    ? entry.summary[role ?? 'lender']
    : (entry.summary as string);
  const roleSuffix = isRoleKeyed && role ? `:${role}` : '';
  const learnMoreHref = buildLearnMoreHref(mode, id, roleSuffix);

  return (
    <InfoTip ariaLabel="About this card">
      <span>{summary}</span>
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
