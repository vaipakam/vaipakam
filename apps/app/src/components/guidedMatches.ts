/**
 * Guided matching's pick (#1036 badges slice, #2535).
 *
 * Guided matching is a RECOMMENDATION surface for a naive user, so it
 * holds itself to a stricter rule than the Offer Book, which never hides
 * anything (browse must not lie about the market):
 *
 * - An offer the security screen flags as dangerous is left out, and the
 *   count of what was left out is stated.
 * - An offer is recommended only from the SCREENED head of the candidate
 *   list. Nothing past the screened depth is shown unscreened; when the
 *   head runs out of acceptable offers the depth grows (bounded), and
 *   when the bound is reached the surface says more offers exist.
 * - An offer whose screen has not answered yet is shown as "checking"
 *   and cannot be chosen until it has. It keeps its place in the list:
 *   if it turns out flagged it drops out and the next candidate moves up.
 *
 * The accept review stays the enforcement point (fail-closed); this module
 * only decides what is offered as a pick.
 */
import type { TokenSecurityVerdict } from '../data/tokenSecurity';
import type { IndexedOffer } from '../data/indexer';
import {
  offerRiskLevel,
  offerScreenPending,
  type OfferRiskLevel,
} from './TokenRiskBadge';

/** How many offers guided matching recommends. */
export const GUIDED_MATCH_LIMIT = 5;
/** How far the screened head grows per step (three times the limit, so a
 *  few flagged offers still leave a full list in one batch). */
export const MATCH_SCREEN_STEP = 15;
/** The most candidates ever screened for one pick, bounding the batch a
 *  book full of flagged offers could otherwise force. */
export const MATCH_SCREEN_MAX = 60;

export interface GuidedMatch {
  offer: IndexedOffer;
  risk: OfferRiskLevel | null;
  /** The screen has not answered for every leg yet: shown, not choosable. */
  checking: boolean;
}

export interface GuidedMatchPick {
  matches: GuidedMatch[];
  /** Offers left out because the screen flagged them. */
  hiddenFlagged: number;
  /** The pick is not final: a listed offer is still being checked, or the
   *  screened head ran short and a deeper screen is due. */
  screening: boolean;
  /** Screen MATCH_SCREEN_STEP more candidates: the head is fully answered,
   *  came up short, and more candidates exist within the bound. */
  deepen: boolean;
  /** The bound was reached with candidates left unscreened and the list
   *  short: say that more offers exist rather than imply there are none. */
  unscreenedTail: boolean;
}

/** `candidates` in recommendation order; `depth` = how many of them the
 *  screen has been asked about (the caller passes the same depth to the
 *  screen). */
export function pickGuidedMatches(
  candidates: IndexedOffer[],
  verdicts: Record<string, TokenSecurityVerdict | undefined>,
  depth: number,
): GuidedMatchPick {
  const scanned = Math.min(depth, candidates.length);
  const matches: GuidedMatch[] = [];
  let hiddenFlagged = 0;
  for (let i = 0; i < scanned && matches.length < GUIDED_MATCH_LIMIT; i += 1) {
    const offer = candidates[i]!;
    const risk = offerRiskLevel(offer, verdicts);
    if (risk === 'block') {
      hiddenFlagged += 1;
      continue;
    }
    matches.push({ offer, risk, checking: offerScreenPending(offer, verdicts) });
  }
  const pending = matches.some((m) => m.checking);
  const short = matches.length < GUIDED_MATCH_LIMIT && scanned < candidates.length;
  const deepen = short && !pending && depth < MATCH_SCREEN_MAX;
  return {
    matches,
    hiddenFlagged,
    screening: pending || deepen,
    deepen,
    unscreenedTail: short && depth >= MATCH_SCREEN_MAX,
  };
}
