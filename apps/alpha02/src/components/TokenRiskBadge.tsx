/**
 * Browsing-surface token-risk badge (#1036 badges slice).
 *
 * The accept-review gate is the ENFORCEMENT point (fail-closed); this
 * badge is the EARLY WARNING on the surfaces where the user is still
 * choosing — the Offer Book rows and the guided-match cards — so a
 * booby-trapped offer is visibly marked before anyone clicks into it.
 * Browse-tier semantics are deliberately fail-open: a pending screen
 * shows nothing (no crying wolf while loading), 'unsupported' chains
 * show nothing (testnets would badge every faucet mock), and only a
 * concrete signal — flagged, cautioned, or positively-unscreenable —
 * renders. Absence of a badge is the default state everywhere, so it
 * never reads as a cleanliness claim.
 */
import { copy } from '../content/copy';
import { AssetType } from '../lib/types';
import {
  legVerdictKey,
  needsSecurityCheck,
  type ScreenableLeg,
  type TokenSecurityVerdict,
} from '../data/tokenSecurity';
import type { IndexedOffer } from '../data/indexer';

export type OfferRiskLevel = 'block' | 'warn' | 'unchecked';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The ERC-20 legs of an offer the screen applies to: the lending
 *  asset (or the rental's prepay asset — an NFT contract is not a
 *  token) plus the ERC-20 collateral. Curated legs drop out via
 *  needsSecurityCheck. */
export function offerScreenableLegs(offer: IndexedOffer): ScreenableLeg[] {
  const candidates: string[] = [];
  if (offer.assetType === AssetType.ERC20) {
    candidates.push(offer.lendingAsset);
  } else if (
    offer.prepayAsset &&
    offer.prepayAsset.toLowerCase() !== ZERO_ADDRESS
  ) {
    candidates.push(offer.prepayAsset);
  }
  if (
    offer.collateralAssetType === AssetType.ERC20 &&
    offer.collateralAsset.toLowerCase() !== ZERO_ADDRESS
  ) {
    candidates.push(offer.collateralAsset);
  }
  return candidates
    .filter((address) => needsSecurityCheck(offer.chainId, address))
    .map((address) => ({ chainId: offer.chainId, address }));
}

/** Worst concrete signal across the offer's screenable legs, or null
 *  when there is nothing to show (curated/clean legs, unscreened
 *  chain, or the screen is still loading). */
export function offerRiskLevel(
  offer: IndexedOffer,
  verdicts: Record<string, TokenSecurityVerdict | undefined>,
): OfferRiskLevel | null {
  const rank: Record<OfferRiskLevel, number> = {
    block: 3,
    warn: 2,
    unchecked: 1,
  };
  let worst: OfferRiskLevel | null = null;
  for (const leg of offerScreenableLegs(offer)) {
    const v = verdicts[legVerdictKey(leg.chainId, leg.address)];
    const level: OfferRiskLevel | null =
      v === undefined
        ? null // still loading — no badge, not "unchecked"
        : v.kind === 'block'
          ? 'block'
          : v.kind === 'warn'
            ? 'warn'
            : v.kind === 'unknown'
              ? 'unchecked'
              : null; // clean | unsupported
    if (level !== null && (worst === null || rank[level] > rank[worst])) {
      worst = level;
    }
  }
  return worst;
}

export function OfferRiskBadge({ level }: { level: OfferRiskLevel | null }) {
  if (level === null) return null;
  const text = copy.tokenSecurity.badge[level];
  const cls =
    level === 'block'
      ? 'badge-danger'
      : level === 'warn'
        ? 'badge-warn'
        : 'badge-neutral';
  return (
    <span className={`badge ${cls}`} title={text.title}>
      {text.label}
    </span>
  );
}
