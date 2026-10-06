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
 *    holder), an expired one cannot, nor one whose loan is past grace, nor
 *    (#2425) one that is not the loan's recorded request.
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
  /** #2425 — not the loan's recorded request (the protocol reports another,
   *  or none): it can never be taken and holds nothing back. */
  untakeable: boolean;
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
  const h = a.holderScan;
  // #2406 r5 — the holder's scan has already judged THIS request expired.
  // That verdict stands while the richer verification loads or fails (its
  // batch also reads fees, balances and allowances, any of which can fail
  // for reasons unrelated to the request): a failed side-read must not turn
  // a request the chain says has expired back into a live one.
  // #2425 — likewise once the scan has found it is not the loan's recorded
  // request: the protocol will never take it, so it blocks nothing.
  const scanSaysDead =
    h?.kind === 'found' && (!h.open || h.untakeable === true) && h.offerId === a.offerId;
  const namedBlocking =
    a.offerId !== null &&
    (a.state === undefined
      ? // Still verifying: block, unless it is known to be the viewer's
        // own request on a position they no longer hold, or the holder's
        // scan already found it expired or untakeable.
        !a.fromOwnScan && !scanSaysDead
      : creatorIsHolder(a.state.creator) &&
        !a.state.expired &&
        !a.state.pastGrace &&
        !a.state.untakeable);
  // An open request the holder's scan found that the page is NOT naming
  // (the viewer's own request is named instead) still blocks.
  const holderOpen = h?.kind === 'found' && h.open && h.untakeable !== true ? h.offerId : null;
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
  // #2425 — a request the protocol will never take holds nothing back.
  if (d.kind === 'found') return d.open && d.untakeable !== true ? 'open' : 'clear';
  if (d.kind === 'unknown') return d.reason === 'capped' ? 'capped' : 'unchecked';
  return 'clear';
}

/** #2424 r7 — the verdict before POSTING a new request. Unlike the
 *  settlement checks, an expired request the holder never cancelled blocks
 *  too: the protocol refuses a new request until it is cancelled (it may
 *  still hold a fresh pledge, and the loan's record is how it is found), so
 *  the form stops and offers the cancel instead of writing caps and an
 *  approval for a post that would fail. */
export function postRefinanceVerdict(
  d: RefinanceDiscovery,
): 'clear' | 'open' | 'expired' | 'unchecked' | 'capped' {
  // #2425 — the protocol refuses a new request only for the loan's RECORDED
  // one (open, or expired and uncancelled); a leftover never blocks a post.
  if (d.kind === 'found' && d.untakeable !== true) return d.open ? 'open' : 'expired';
  return liveRefinanceVerdict(d);
}

/** #2406 r4/r5 — the viewer's OWN scan (run only when they are not the
 *  holder) did not answer: it failed, or hit its page cap. Either way a
 *  request this wallet posted could survive unseen with its payoff
 *  approval, so the page says so and names the manual cleanup. Keyed on
 *  the scan alone — not on the viewer's other roles, which say nothing
 *  about whether they once held the borrower position (r5). */
export function ownScanUnresolved(
  scan: RefinanceDiscovery | 'error' | undefined,
): 'failed' | 'capped' | null {
  if (scan === 'error') return 'failed';
  if (scan?.kind === 'unknown') return scan.reason;
  return null;
}

/** What a full-repayment review showed about a refinance request. */
export type RepayNotice = 'pending' | 'unchecked' | null;

/** #2406 r4/r5 — the confirm-time decision for a full repayment. Every
 *  confirm re-checks live (a latch that skipped the check went stale once a
 *  request was cancelled or a failed read recovered, r5). The repayment
 *  proceeds when what the review SHOWED covers what the live check found —
 *  a found open request is covered only by the "request is live" warning,
 *  an unanswered check by either warning, a clear check by anything (a
 *  warning shown is then merely conservative). Otherwise it stops once and
 *  the review shows `notice`; repayment is never refused outright. */
export function repayRefinanceDecision(
  shown: RepayNotice,
  live: 'clear' | 'open' | 'unchecked' | 'capped',
): { proceed: boolean; notice: RepayNotice } {
  const needed: RepayNotice = live === 'clear' ? null : live === 'open' ? 'pending' : 'unchecked';
  const covered =
    needed === null || shown === 'pending' || (shown === 'unchecked' && needed === 'unchecked');
  return { proceed: covered, notice: needed };
}

