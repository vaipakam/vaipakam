/**
 * The ONE declaration of the query roots that ride the per-block tip rail
 * (RPC read-diet design §4.1.2).
 *
 * These are ACTION-GATING chain reads: roots that gate money-moving actions
 * or render action-decisive detail state, where a foreign block left
 * unread could mislead an imminent decision. `tipAware` stretches their
 * polling interval to the 180s net while the indexer push rail is healthy,
 * on the promise that something else refreshes them in between:
 *
 * - every delivered block (`LiveChainSync`'s `TIP_KEYS`, built from this list);
 * - a hidden tab coming back (`IndexerPushSync`'s `STRETCHED_ROOTS`);
 * - the first interaction after an idle stretch (`LiveChainSync`'s resume set).
 *
 * Those three are derived from this list, and `tipAware` accepts only a
 * root named here, so a stretched root cannot be left off a rail that its
 * stretch relies on. Before this list each rail was kept by hand, and the
 * same omission was found again with each new action gate (Codex #3024 r1,
 * #3030 r1; `offsetPending` and `maxWithdrawable` had each been missed).
 *
 * Whether a root ALSO rides the rail-down fallback blanket (`LIVE_KEYS`) or
 * the own-write receipt floor (`RECEIPT_FLOOR_ROOTS`) is a separate choice,
 * made in those lists: neither is what the stretch relies on.
 */
export const TIP_ROOTS = [
  // Detail-page cluster: owner, role and status gates on PositionDetails.
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
  'offer',
  'loan',
  'offerLinkedLoan',
  // Pending-card accept gates.
  'loanSalePending',
  'refinancePending',
  'offsetPending',
  // Borrower listing-hold card (#1511): its cleanup button appears on
  // expiry and disappears on a cleanup from another tab or actor, both
  // with no own-wallet action.
  'saleListingHold',
  // Take-back-collateral ceiling (UX3-009, #2389 r1): moves with prices,
  // debt and third-party actions on the loan.
  'maxWithdrawable',
  // A periodic-interest loan's current period (#2524): its phase, what is
  // owed and whether it can be recorded move with the chain clock, a
  // settlement by anyone, and the switch and the pause.
  'periodicInterest',
  // Past-due/grace banner terms (Codex #1228 r1 P3): a keeper extension
  // restamping the terms must reach the banner.
  'graceBannerTerms',
  // Desk crossable band: a stale band shows an executable match that
  // is not one (§4.1.2 / the r5 table split).
  'deskPreviewMatch',
  // Shared-book ghost-strip (§4.1.2a): block-driven so a just-ended offer
  // never outlives the throttle window on the book.
  'bookGhostStrip',
] as const;

export type TipRoot = (typeof TIP_ROOTS)[number];
