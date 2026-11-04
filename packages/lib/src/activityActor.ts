/**
 * The wallet an activity row is filed under, per event (`activity_events.actor`).
 *
 * The loan and offer references come from the event's ABI by one rule
 * (`activityRefs.ts`, #1794), so an event needs an entry here only when it
 * has a meaningful actor. An event with no entry files with a NULL actor and
 * its references intact.
 *
 * Shared (#2658) because two layers read the same answer. The indexer files
 * each row by it; the app's Activity page receives a wallet's rows by it (the
 * `actor` match, beside the loan match), so the app's label catalog must name
 * every kind this table attributes. A kind added here without a label would
 * reach the page under a name generated from the contract's event, in English,
 * in every language. Keeping the table here, as data, lets the app's test read
 * the attributed kinds instead of keeping its own list of them.
 *
 * Keyed by a `Map`, not a plain object, so an event name that happens to be an
 * `Object.prototype` member never reads an inherited function as an entry.
 */

/** Reads the actor from a decoded event's args. */
type ActorRead = (args: Record<string, unknown>) => string | null;

/** The lower-cased string in `name`, or null when it holds anything else.
 *  Args reach this from a stored row as well as from a fresh decode, so a
 *  malformed field must read as no actor, never throw (#2708 r2). */
function str(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' ? v.toLowerCase() : null;
}

/** The actor is the lower-cased address in `name`. */
const arg =
  (name: string): ActorRead =>
  (args) =>
    str(args, name);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ACTIVITY_ACTOR: ReadonlyMap<string, ActorRead> = new Map<string, ActorRead>([
  ['OfferCreated', arg('creator')],
  ['OfferAccepted', arg('acceptor')],
  // The row's offer is the LENDER offer (#600) — see `intendedAlias` in
  // activityRefsPolicy.json. The actor is the matcher.
  ['OfferMatched', arg('matcher')],
  ['OfferCanceled', arg('creator')],
  // T-086 Round-8 (#358) §19.7 + Codex round-19 P2 #3 — Scenario A
  // terminal. The event carries (offerId, executor); `executor` is
  // the protocol's Seaport-conformant executor singleton (never a
  // real user), so it is never the actor. The BORROWER (= offer
  // creator) is who needs to see this row. We rely on the
  // `recordActivityEvents` enrichment pass having put the `creator`
  // field into `args` (looked up from the `offers` table) before this
  // mapper runs. When that lookup found nothing (an offer created in
  // the same batch), the row is filed with no actor rather than under
  // the executor contract (#2708 r1): its offer reference still files
  // it on the offer's timeline.
  ['OfferConsumedBySale', arg('creator')],
  // #193 / Codex round-2 P2 — denormalize the actor (= creator;
  // OfferMutateFacet's access gate guarantees msg.sender ==
  // offer.creator) + offerId so per-offer and per-wallet
  // activity filters surface modify events alongside the other
  // offer-mutation rows. Without this mapping the event lands
  // in activity_events with NULL refs and falls out of the
  // dashboard's offer-timeline + wallet-history queries.
  ['OfferModified', arg('creator')],
  ['LoanInitiated', arg('borrower')],
  ['LoanRepaid', arg('repayer')],
  // T-092 Phase 3 (#503) Codex round-4 P2 — `caller` is the
  // address that initiated the extension (the keeper, or the
  // borrower-NFT owner extending directly). Indexed on-chain so
  // `pluckActivityRefs` can return it as the activity actor.
  // Without this, `?actor=...` filters would miss direct
  // borrower self-extensions because `DecodedLog` doesn't store
  // `msg.sender`.
  ['LoanExtended', arg('caller')],
  // T-090 Sub 2 — `borrower` is `msg.sender` (current borrower-NFT
  // owner), the load-bearing authority root for the swap-to-repay
  // surface (see SwapToRepayFacet round-3 P2 #1).
  ['SwapToRepayExecuted', arg('borrower')],
  ['SwapToRepayPartialExecuted', arg('borrower')],
  // T-090 v1.1 (#389) Sub 2 (#417) — borrower-attributed events.
  ['SwapToRepayIntentCommitted', arg('committedBy')],
  ['SwapToRepayIntentCancelled', arg('cancelledBy')],
  // `Filled` attributed to the borrower who originated the
  // commit, NOT the Fusion solver who actually submitted the
  // fill tx (Codex round-1 PR #421 P2 — the Activity feed's
  // close-out row must reach the connected borrower, otherwise
  // they lose visibility of their own successful repay). The
  // `committedBy` field on `args` is stashed by the indexer
  // dispatcher BEFORE the row delete that releases it — see the
  // `SwapToRepayIntentFilled` branch in `processLoanLogs`.
  ['SwapToRepayIntentFilled', arg('committedBy')],
  // #1566 slice 3 — the fill's pre-hook took the committed lot out of the
  // borrower's vault, inside the fill. Actor = the borrower whose vault it
  // left; the fill's own `SwapToRepayIntentFilled` represents the transaction.
  ['SwapToRepayIntentLotPulled', arg('borrower')],
  // #1566 slice 2 — one row per move of a loan's vault-held fallback
  // custody (entry, each settlement slice, a retry's pull and restore, a
  // match leg, the return to the pledge). Actor = the counterparty the move
  // names; the action that moved it (liquidation, claim, cure, match)
  // represents the transaction.
  ['FallbackCustodyMoved', arg('counterparty')],
  // #630 backstop Role B — surface the cash buyout on the loan timeline and
  // the lender's activity feed. Actor = the paid lender-NFT owner.
  ['BackstopAbsorbedLoan', arg('lenderNftOwner')],
  // #393 v1-d.2 auto-roll. When the borrower hasn't claimed yet the loan
  // stays Repaid, so this is the only signal the lender side closed (the
  // proceeds were re-liened into the owner's intent capital and the lender
  // NFT burned). Actor = the intent owner whose loan rolled, so it surfaces
  // on `/activity?actor=<wallet>`.
  ['IntentLoanRolled', arg('owner')],
  // Leg A is the row's loan (see `intendedAlias` in
  // activityRefsPolicy.json). Actor is the matcher (msg.sender of the
  // entry-point call).
  ['InternalMatchExecuted', arg('matcher')],
  ['LenderFundsClaimed', arg('claimant')],
  ['BorrowerFundsClaimed', arg('claimant')],
  // T-034 PR2 — settler / advancer is the meaningful actor.
  ['PeriodicInterestSettled', arg('settler')],
  ['PeriodicInterestAutoLiquidated', arg('settler')],
  // #2795 — the forced-sale breakdown is filed under whoever submitted the
  // sale (and received the bonus); a held extra paid on a handover under
  // the exiting holder it was paid to.
  ['ForcedSaleSettled', arg('keeper')],
  ['BorrowerHeldExtraPaid', arg('to')],
  // #1209 — the seller of a lender position keeps a claim on the interest
  // they earned. Every step of that claim is filed under the seller, who is
  // no longer a party to the loan, so the Claims page can find the loans
  // they hold a claim on (`/activity?actor=<seller>&kind=…`) and their feed
  // shows each payment.
  ['SellerInterestClaimRecorded', arg('seller')],
  ['SellerInterestPaid', arg('seller')],
  ['SellerInterestWithdrawn', arg('seller')],
  ['SellerInterestClaimClosed', arg('seller')],
  ['RepayPartialPeriodAdvanced', arg('advancedBy')],
  ['VPFIDepositedToVault', arg('user')],
  ['VPFIWithdrawnFromVault', arg('user')],
  // RL-2 (#1303) — reward loop-closure events: actor = the wallet whose
  // claim / vault the VPFI moved through, so the Activity feed's
  // per-wallet filter surfaces them (the ledger itself lives in the
  // dedicated reward_* tables, not args_json).
  ['InteractionRewardsClaimed', arg('user')],
  ['RewardDeliveredToVault', arg('user')],
  ['VaultVpfiDebited', arg('user')],
  // #1566 — one settled chunk of a forfeited reward entry (the loan sweep or
  // the flagged-owner sweep). Actor = the entry's owner; loan = the loan it
  // accrued on, so the forfeit shows on that loan's timeline.
  ['RewardEntryForfeitSettled', arg('user')],
  // Position-NFT lifecycle. The "actor" for activity-feed filter
  // purposes is the recipient (`to`) — that's the wallet that
  // gained ownership and most likely cares to see the event in
  // their feed. The sender (`from`) appears in args_json; a
  // future enhancement could surface a second row per Transfer
  // keyed on `from` if the per-wallet feed needs to show
  // "outgoing" transfers explicitly.
  ['Transfer', arg('to')],
  // T-086 step 12 — prepay-listing events. The on-chain payloads
  // use slightly different field names: Posted carries `lister`,
  // Updated carries `lister`, Canceled carries `caller`. The loan_id is
  // present on all of them. Codex P2 round-2 on PR #304.
  // `PrepayCollateralSaleSettled` carries only `executor`, the protocol's
  // sale executor contract (its `msg.sender`), so it has no actor (#2708
  // r1); the loan reference files it on the loan's timeline.
  ['PrepayListingPosted', arg('lister')],
  ['PrepayListingUpdated', arg('lister')],
  ['PrepayListingCanceled', arg('caller')],
  // T-086 Round-6 / Block D (#345) — atomic match-rotation event.
  // The borrower (msg.sender) clicked Match; `matcher` is the
  // canonical actor for activity-feed purposes.
  ['PrepayListingMatched', arg('matcher')],
  // #2550 / #2559 — a fill the solver's capacity would have refused went
  // through on the intent owner's priority-routing credit. The row belongs on
  // the loan the fill opened and on the owner's feed, whose credit it spent.
  ['IntentPriorityFill', arg('owner')],
  // #2342 — a closed loan's owed VPFI entering or leaving a vault owner's
  // fee-tier exclusion. The row belongs on the loan's timeline, and on
  // the vault owner's feed while it charges them. `vaultOwner` is the zero
  // address when the side stops excluding anything, which names no wallet,
  // so the actor is left NULL rather than filed under 0x0.
  [
    'TierExclusionUpdated',
    (args) => {
      const owner = str(args, 'vaultOwner');
      return owner && owner !== ZERO_ADDRESS ? owner : null;
    },
  ],
  // No entry, so no actor, by design for: a status edge (`LoanStatusChanged`),
  // a settlement or default record (`LoanSettled`, `LoanDefaulted`,
  // `LoanLiquidated`, `OwedAt*Recorded`, …) and a system-triggered cancel
  // (`SwapToRepayIntentForceCancelled`, whose `source` is the Diamond). Each
  // is a consequence of the call that produced it, whose own row carries
  // the actor. Their loan references are still filed (`activityRefs.ts`).
  // An actor is always a participant (`activityParticipants.ts`), so no
  // entry here may read an address that rule classes as never a party (a
  // protocol contract, an asset, the treasury); its test enforces that.
]);

/** The wallet one decoded event is filed under, or null for none. */
export function activityActor(eventName: string, args: Record<string, unknown>): string | null {
  const read = ACTIVITY_ACTOR.get(eventName);
  return read ? read(args) : null;
}

/** Every event kind filed under a wallet as its actor. */
export function actorAttributedKinds(): ReadonlySet<string> {
  return new Set(ACTIVITY_ACTOR.keys());
}
