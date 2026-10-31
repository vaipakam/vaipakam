# Refinance: net the payoff inside the Diamond, every refinance atomic (#3042)

**Status:** design, approved direction (owner decision 2026-10-28 11:19 UTC on #3042).
**Deploy:** fresh deploy only, like the rest of the prelive work.

## 1. What changes for a reader

**Before.** A refinance moves money in a round trip through the borrower's
wallet. At accept, the new lender's net principal (principal minus the
borrower's Loan Initiation Fee) goes from the new lender's vault to the
borrower's wallet. The refinance then pulls the whole payoff back out of that
wallet: the treasury fee on the old loan's interest to the treasury, and the
old lender's due (old principal plus interest, plus any grace late fee) to the
old lender's vault. A refinance can also be completed after the fact, in a
second transaction (`refinanceLoan`), by the holder or a delegated keeper.

**After.** Every refinance completes in the transaction that accepts the
refinance-tagged offer, and the new lender's net principal pays the payoff
directly, inside the Diamond:

1. The new lender's whole net principal goes from the new lender's vault to
   the old lender's vault.
2. The borrower's wallet pays the rest of the old lender's due.
3. The borrower's wallet pays the treasury fee.

The net principal can never exceed the old lender's due (§3.3), so there is no
surplus to route anywhere. One event states every leg. The after-the-fact completion is removed, so there
is one fund path.

## 2. Why

- **The recorded flow is the real one.** Today the transfers show principal
  going to the borrower and coming back. After, they show what actually
  happens: new lender to old lender, and the borrower paying only the
  difference.
- **The borrower's standing approval shrinks to the difference.** Today the
  borrower must have approved the Diamond for roughly the whole payoff before
  anyone accepts their offer. After, the approval only needs to cover the
  difference: the old loan's interest (and any late fee) plus the new loan's
  initiation fee, plus any principal difference.
- **The borrower's wallet stops being a waypoint.** A wallet the asset's
  issuer has blocked, or an approval lowered after the offer was posted, no
  longer fails a refinance whose payoff the new principal covers.

## 3. Design

### 3.1 One predicate decides "this accept is a refinance"

`LibRefinanceNetting.isRefinanceAccept(offer)` is true exactly when the
accepted offer is a Borrower offer carrying a `refinanceTargetLoanId`. Both
sites read it:

- the net-principal delivery in `OfferAcceptFeeFacet.chargeBorrowerLifAndDeliver`,
  which parks the net principal instead of delivering it;
- the chain into `RefinanceFacet` in `OfferAcceptFacet._acceptOffer` (direct
  accept, and a matched fill with partial-fill off), and the dust-close chain in
  `LibOfferMatchExecute` (matched fill with partial-fill on).

A tagged Borrower offer is matchable only as an all-or-nothing fill
(`LibAutoRefinanceCheck.matchAdmissible`), so the dust-close chain fires in
the same transaction. So the parked amount is always consumed in the
transaction that parked it, or the transaction reverts.

### 3.2 The hand-off is transient and exact

The delivery leg does not re-derive anything later. It records what it did not
deliver: `LibRefinanceNetting.park(offerId, newLender, asset, netPrincipal)`,
in EIP-1153 transient storage keyed by the offer id. `RefinanceFacet` calls
`take(borrowerOfferId)`, which returns the record and clears it, and refuses
(`RefinanceNetPrincipalMissing`) when nothing is parked or the parked lender or
asset is not the new loan's. Transient storage is the right scope: the record
means "undelivered in this transaction" and must not outlive it.

The net principal stays in the new lender's vault between the two steps. It is
never withdrawn to the Diamond, so no Diamond-held balance is created and the
#538 concern (spending offer-locked vault funds) does not apply: the amount
moved is the slice the accept already released for this loan.

While it waits there it is committed, not free. The accept still runs code
between the park and the take that reads the new lender's free balance: the
per-party Full VPFI tariff, when VPFI is the lending asset, gates and pulls
`C*` from it. A read that counted the parked amount would let the tariff spend
money already promised to the old lender, and the payoff would then come up
short. So the park also keeps a per-(owner, asset) transient total
(`parkedOf`), and the one free-balance rule, `LibEncumbrance.freeBalance`,
subtracts it alongside the owner's liens. Every free-balance reader and the
vault withdraw guard therefore see the parked amount as held. The take clears
the total before it moves the funds, so the payoff's own withdrawal passes the
guard. Outside a refinance accept the total is zero and nothing changes.

### 3.3 The settlement legs

With `net` parked, `due` the old lender's due and `fee` the treasury fee on the
old loan's interest (both computed exactly as before):

| Leg | Amount | From | To |
| --- | --- | --- | --- |
| A | `net` | new lender's vault | old lender's vault |
| B | `due − net` | borrower's wallet | old lender's vault |
| C | `fee` | borrower's wallet | treasury |

The borrower's total spend is therefore `due + fee − net`: for a request asking
for the old principal, the old loan's interest (and any late fee) plus the new
loan's initiation fee.

**Why there is no surplus leg.** An earlier draft of this section had five
legs, routing any net principal beyond the due to the treasury fee and then to
the borrower. Those two legs can only ever be zero. The replacement principal
is the tagged offer's amount, which `LibAutoRefinanceCheck.validate` and the
refinance range check both require to be at most the old loan's outstanding
principal; a matched fill of an all-or-nothing tagged offer fills exactly that
amount. The due is that principal plus interest, so `net = amount − LIF` is
always below it. Carrying code paths that cannot run is the opposite of
stating the flow, so they were dropped. `_settlePayoff` refuses the case
outright (`RefinanceNetPrincipalExceedsPayoff`) instead of leaving any excess
in the new lender's vault on a loan that records it as delivered.

The old lender is paid first, matching the standing rule that the exiting
lender is made whole before anyone else. Legs A and B land behind the same
`LibSanctionedLock` pin on `oldLoan.lender` that the deposit carried before, so
a sanctions-flagged old lender's proceeds are parked, never brick the
refinance. The old lender's claim (`lenderClaims[oldLoanId]`) is still `due`,
and every voluntary leg is refused unless it delivered in full.

### 3.4 One event per refinance, stating each leg

`RefinancePayoffSettled(oldLoanId, newLoanId, asset, newLenderToOldLender,
borrowerToOldLender, borrowerToTreasury)`, emitted beside `LoanRefinanced`.
It is a settlement breakdown (`informational/settlement`, like `RepayFacet`'s);
the state change itself is `LoanRefinanced`. `LoanRefinanced` drops
its `shortfallPaid` field, which has been a constant zero since #411 and was
kept only for indexer compatibility; prelive there is nothing to stay
compatible with.

### 3.5 The after-the-fact completion is retired

- `RefinanceFacet.refinanceLoan` and the `Direct` route are removed. The two
  atomic entries remain.
- The auto-refinance kill switch keeps governing the matcher route only, as
  today. A lender's direct accept is never gated by it.
- The keeper `Refinance` action bit has no remaining reader (on the atomic
  routes the caller is the Diamond), so it is retired: dropped from the valid
  action mask, the keeper settings card and its copy.
- An untagged Borrower offer is an ordinary new loan. It no longer doubles as a
  refinance that someone completes later, so the "legacy untagged" branches
  and their comments go.
- The accept and the payoff are one behaviour across a self-call
  (`OfferAcceptFeeFacet` parks, `RefinanceFacet` takes), so a Diamond carrying
  one side new and the other old would either deliver the principal AND pull
  the full payoff, or take a record nothing parked. The curated refresh
  scripts therefore refuse a pre-#3042 Diamond: `RefinanceRecordRollout`
  treats a still-routed `refinanceLoan(uint256,uint256)` as the marker, and
  only a fresh deploy or `RefreshAllFacetsInPlace` (whose stale-route sweep
  removes the retired selector) crosses the boundary.

### 3.6 Placement and size

The netting lives in `RefinanceFacet` (a private settlement function in its
own stack frame, as `_exitingLenderDue` is) and the park in
`OfferAcceptFeeFacet`, which is already the accept's money-moving seam and has
headroom. `OfferAcceptFacet` changes only by reading the shared predicate.
Removing `refinanceLoan` frees bytes in `RefinanceFacet`. Sizes are checked
against EIP-170 with the deploy-sanity suite.

## 4. What does not change

- The initiation fee and its treasury/matcher split, charged from the new
  lender's funded principal at accept.
- The old lender's due and the treasury fee, and how each is computed
  (mode-aware interest, grace late fee, yield-fee discount).
- Collateral handling (carry-over retag, or return of the old collateral), the
  post-refinance risk gates, the old loan's NFTs and its terminal transition.

## 5. Off-chain and docs

- App: keeper settings drop the Refinance action. The refinance flow sizes the
  standing approval to the wallet's share (the payoff at the last fillable
  moment minus the net principal at the live initiation-fee rate, an upper
  bound since a fee discount only lowers it), and the copy says the new
  loan's money pays the old lender directly.
- Indexer: decodes `LoanRefinanced` from the regenerated ABI, so the dropped
  `shortfallPaid` needs no handler change; the settlement event is
  informational and needs no projection.
- Keeper: comments only (it never called `refinanceLoan`).
- Functional spec, admin knobs doc, whitepaper and the T-092-H design doc stop
  describing a standalone completion.
