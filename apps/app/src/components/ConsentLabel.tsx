/**
 * The mandatory risk-and-terms consent label with INLINE LINKS
 * (#1030): "Risk Disclosures" opens the Help page's risk section,
 * "Vaipakam Terms" opens the marketing site's Terms — both in a new
 * tab, because the label sits inside an in-flight write flow whose
 * form state a same-tab navigation would destroy.
 *
 * Anchors are interactive elements, so clicking them does NOT toggle
 * the wrapping label's checkbox (the HTML label activation rule);
 * stopPropagation is belt-and-braces for custom handlers up-tree.
 */
import { copy } from '../content/copy';

/** The marketing site's Terms of Service route (apps/www). */
const TERMS_URL = 'https://vaipakam.com/terms';

export function ConsentLabel() {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <span style={{ flex: 1 }}>
      {copy.consentParts.prefix}
      <a href="/help#risks" target="_blank" rel="noopener" onClick={stop}>
        {copy.consentParts.risk}
      </a>
      {copy.consentParts.mid}
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" onClick={stop}>
        {copy.consentParts.terms}
      </a>
      {copy.consentParts.suffix}
    </span>
  );
}
