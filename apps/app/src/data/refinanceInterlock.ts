/**
 * #2391 / #2406 r3 — ONE derivation of what a loan's refinance request
 * means for the page, read by every surface it touches.
 *
 * Rounds 1–3 of #2406's review kept finding the same seam: each surface
 * (take back collateral, partial repayment, close early, handover, offset,
 * the options chooser, the refinance form, the full-repayment review)
 * worked out "is a request live?" and "has the chain answered?" for
 * itself, so a fix to one left the next one wrong — an expired request
 * still hid the form, the chooser offered jumps to cards the page had
 * held back, the repayment review ignored an unanswered check. This module
 * is the single answer; the page renders from it and decides nothing.
 *
 * Three concepts, kept apart because they answer different questions:
 *
 *  - WHICH request the page names (`resolveNamedRequest`) — the one its
 *    pending card verifies and offers to cancel. Only a request's creator
 *    can cancel it, so a viewer who is not the current holder is shown the
 *    request THEY made (a position transferred after posting leaves the
 *    request and its payoff approval with the old holder), never the
 *    holder's.
 *  - Whether a request BLOCKS (`blocking`) — an acceptable request exists,
 *    which settling or changing the loan would strand. Only the current
 *    holder's request can be filled (the contract checks the creator is the
 *    holder), an expired one cannot, nor one whose loan is past grace.
 *  - Whether the page KNOWS (`check`) — the holder's scan answered, or a
 *    blocking request already has its own interlock. Anything else holds
 *    the surfaces a request would strand, and says why.
 */
import type { RefinanceDiscovery } from './refinanceDiscovery';

/** 'settled': the page knows. 'checking': the scan has not answered yet.
 *  'unchecked': it failed (may answer on retry). 'capped': the holder has
 *  posted more offers since the boundary than a scan reads (a retry will
 *  not help, so the page must not say "try again"). */
export type RefinanceCheck = 'settled' | 'checking' | 'unchecked' | 'capped';

/** The verified facts of the named request the interlock needs. */
export interface NamedRequestFacts {
  creator: string;
  expired: boolean;
  pastGrace: boolean;
}

/** The request the page names. `ownScan` is the connected viewer's own
 *  scan, run only when the viewer is NOT the current holder (or the
 *  position is burned): a request found there is the only one this viewer
 *  can act on, so it wins. Otherwise an OPEN request the holder's scan
 *  found beats this device's marker (which may name an expired or
 *  cancelled one), and the marker beats an expired request the scan found
 *  (the marker names a request just posted, before the next scan). */
export function resolveNamedRequest(a: {
  holderScan: RefinanceDiscovery | undefined;
  ownScan: RefinanceDiscovery | undefined;
  markerId: string | null;
}): { offerId: string | null; fromOwnScan: boolean } {
  if (a.ownScan?.kind === 'found') {
    return { offerId: a.ownScan.offerId, fromOwnScan: true };
  }
  const h = a.holderScan;
  const holderOpen = h?.kind === 'found' && h.open ? h.offerId : null;
  const holderAny = h?.kind === 'found' ? h.offerId : null;
  return { offerId: holderOpen ?? a.markerId ?? holderAny, fromOwnScan: false };
}

export function refinanceInterlock(a: {
  offerId: string | null;
  /** The named request came from the viewer's own scan — the viewer is not
   *  the holder, so it cannot be filled and never blocks. */
  fromOwnScan: boolean;
  /** Live-verified facts of the named request; undefined while loading. */
  state: NamedRequestFacts | undefined;
  /** The current borrower-position holder; undefined while unknown,
   *  'burned' once the position is gone. */
  holder: string | 'burned' | undefined;
  holderScan: RefinanceDiscovery | undefined;
  holderReadFailed: boolean;
}): { blocking: boolean; check: RefinanceCheck } {
  // Unknown holder = cannot rule the creator out: block (conservative).
  const creatorIsHolder = (creator: string) =>
    a.holder === undefined
      ? true
      : a.holder !== 'burned' && creator.toLowerCase() === a.holder.toLowerCase();
  const namedBlocking =
    a.offerId !== null &&
    (a.state === undefined
      ? // Still verifying: block, unless it is known to be the viewer's
        // own request on a position they no longer hold.
        !a.fromOwnScan
      : creatorIsHolder(a.state.creator) && !a.state.expired && !a.state.pastGrace);
  // An open request the holder's scan found that the page is NOT naming
  // (the viewer's own request is named instead) still blocks.
  const h = a.holderScan;
  const holderOpen = h?.kind === 'found' && h.open ? h.offerId : null;
  const blocking = namedBlocking || (holderOpen !== null && holderOpen !== a.offerId);

  // A device marker naming an EXPIRED request does not settle the check:
  // a failed scan could be hiding a different, open one (#2406 r2).
  let check: RefinanceCheck;
  if (h?.kind === 'none' || h?.kind === 'found' || blocking) check = 'settled';
  else if (h?.kind === 'unknown') check = h.reason === 'capped' ? 'capped' : 'unchecked';
  else if (a.holderReadFailed) check = 'unchecked';
  else check = 'checking';
  return { blocking, check };
}

/** The verdict a live pre-send check takes from one fresh scan. */
export function liveRefinanceVerdict(
  d: RefinanceDiscovery,
): 'clear' | 'open' | 'unchecked' | 'capped' {
  if (d.kind === 'found') return d.open ? 'open' : 'clear';
  if (d.kind === 'unknown') return d.reason === 'capped' ? 'capped' : 'unchecked';
  return 'clear';
}
