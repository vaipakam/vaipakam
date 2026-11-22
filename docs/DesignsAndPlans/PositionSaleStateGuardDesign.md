# Position sale state guard

Status: design, approved for build by the secured-vault thread. Card: #3710. Reviewed 2026-11-17: the builder's confirmations and route table are in sections 3.2, 3.5 and 7, and section 3.9 records the approval rule of #3721. Revised 2026-11-19: section 3.3 pays the holder's vault, not the holder's wallet (`PayoutDestinationRuleDesign.md`).

A position token can be sold on any marketplace. Its price depends on the
loan behind it: how much collateral backs a borrower position, how much is
still owed to a lender position. This design makes sure a buyer never pays
for a position whose value left it shortly before the sale, and says plainly
where that protection ends.

## 1. What the platform already does

These were checked in the code on 2026-11-17 and are not changed here.

- **A seller cannot remove collateral after selling.** A partial collateral
  withdrawal authorises whoever holds the borrower position token at the
  moment of the call. The original borrower has no standing once the token
  has moved. A holder who is not the original borrower is paid into their own
  vault.
- **A sale cannot fill in the same moment value leaves** (#3413). Every
  movement of value out of a loan's positions (a collateral withdrawal, a
  payout to a holder, a terms change) stamps the loan. Neither side's token
  can move in that block, or until a cooldown has passed. The cooldown is 5
  seconds by default, governed between 1 second and 10 minutes, and is one
  figure for every kind of value-out.
- **The token's metadata reports the live collateral amount.** It is computed
  on every read from the loan.
- **A protected vault's delay covers this payout.** Every payout to an owner's
  wallet goes through the one outflow policy, which queues it behind the
  delay. Every push from the Diamond to a protected wallet is credited to the
  vault instead.

## 2. What is still open

1. **A stale view.** Marketplaces cache metadata. Nothing tells them a
   position's figures changed, so a listing can show the collateral amount
   from before a withdrawal for a long time.
2. **A standing bid.** A buyer leaves a bid on a position. The holder removes
   collateral, waits out the cooldown, and accepts the bid. The bid was priced
   against the earlier position. No cooldown of any length fixes this, because
   a bid can stand for days.
3. **A listing filled late.** The same, the other way round: the holder lists
   at a fixed price, removes collateral, waits, and a buyer who looked earlier
   fills the listing.
4. **No proof the protected-payout rule holds for future routes.** It holds
   today by inspection only.

## 3. Decisions

### 3.1 A state number on every position

Each position token carries a **state number**, kept per token id and never
reset. It starts at 0 and goes up by one:

- for both tokens of a loan, at every stamp of section 1's value-out mark on
  that loan;
- for an offer's own token, at every change to the offer;
- for a token whose position changes kind, at that change. A direct accept
  turns an offer's token into a loan's token under the same id, so the number
  goes up there too.

Because the number belongs to the token and only rises, it cannot repeat
across that change of kind: a price agreed for an offer's token never matches
the loan position the same token later stands for. The time the token may next move is kept with it (section 3.5).

The number goes up only when value leaves. Collateral added or a debt reduced
by the borrower makes a position worth more to its buyer, so it does not
invalidate a price a buyer agreed to.

One view on the position token facet returns, for a token: the state number,
the block of the last value-out, and the time the token may next move. It
replaces the present cooldown view. One more entry, `requirePositionState`,
takes a token and an expected number and reverts
`PositionStateChanged(tokenId, expected, current)` when they differ. Anyone
may call either; neither changes state.

This is the root of the fix. A price is always a price for one state number.
Whoever commits to a price can commit to the number with it, and the fill can
be refused when the number has moved.

### 3.2 Marked at the seams, never path by path

Today the value-out mark is placed partly at a seam and partly by hand. The
outflow policy marks every payout to a position holder or a counterparty, and
retiring a token marks it. A collateral withdrawal, a partial swap-to-repay, a
terms change and the close-out freeze each place their own mark. A new route
that forgets the mark is a silent hole, and a read of the code on 2026-11-17
found candidates that reduce a loan's collateral with no mark of their own:
the partial liquidation, the matched liquidation legs, the fallback custody
split and the periodic forced sale. The builder confirmed all four: none was
marked, and each is now marked through the one collateral writer (section 7).

So the mark moves to the few places every such change must pass, and the hand
placed marks are deleted:

1. **The outflow policy.** Every outflow that names a loan marks it, except a
   consolidation, which keeps the value under the lien. This covers every
   payout, claim, fee and sale that takes assets out of a party's vault for a
   loan.
2. **One writer for a loan's collateral amount.** Every reduction goes through
   one library function that marks the loan. A build check, of the same kind
   as the one that already holds the loan-terms writer, refuses an assignment
   to the collateral amount anywhere else.
3. **The loan-terms writer.** It is already the only writer of a loan's
   principal and rate. It marks any change that raises what the borrower owes
   or lowers what the lender is owed.
4. **Retiring a token.** Unchanged.

Marking more often than strictly needed is safe: it costs a short wait and
moves the state number, and never lets a stale price through.

Two proofs ship with it:

- **A table of every route**, produced by the builder and kept in this
  document's build notes: each external entry that changes a loan, what it
  takes out of which position, and which seam marks it.
- **A property test** in the invariant suite: across any sequence of calls,
  if a figure the metadata reports got worse for a token's holder, that
  loan's state number went up in the same call. This is the check that does
  not depend on anyone listing the routes correctly.

### 3.3 The payee of a live-loan payout is read from the token

**Revised 2026-11-19** (owner decision, `PayoutDestinationRuleDesign.md`):
the holder is paid into their vault, not at their wallet. The earlier version
of this section added a payout "to the holder of a named position token, at
their wallet", with an isolated wallet step and a fallback into the holder's
vault when the wallet refused the token. That payout, its fallback and the
`HolderWalletPaymentToVault` event are removed before they merge.

A collateral withdrawal checks that the caller holds the borrower position
token, and then paid by one of three routes chosen in the withdrawal's own
code: the caller's wallet when the caller is also the original borrower, an
allowlisted address for a retired protected account, the holder's vault
otherwise. The check and the payment were two steps, and the first route
named the original borrower as payee.

The withdrawal now uses the outflow policy's existing position-holder payout
for every case, and its three-way choice is deleted. The policy reads the
holder from the token itself and releases the collateral into that holder's
vault as free balance. The calling route passes the loan and the token, never
a payee. A route can then no more pay the wrong party than it can skip the
mark.

When the holder owns the vault the collateral sits in, which is the normal
case because the withdrawal first consolidates a transferred borrower side
into the caller's vault, nothing moves: the lien drops and the holder's free
balance rises. The holder takes it to a wallet with an ordinary vault
withdrawal, in the same transaction if they choose the "and withdraw" option
of the payout design, and that withdrawal is where a protected account's
delay and lock apply.

No token is pushed at a wallet, so a token that calls a hook on the receiver
or blocks an address cannot stop a holder from taking surplus collateral out
of a loan, and no fallback is needed.

This gives what a claim step would give, that only the token's holder can
receive a loan's collateral, in one transaction and with nothing parked in
between. The marks are taken before the release, exactly as before.

### 3.4 A refresh signal for marketplaces

The position token contract (the standalone core, not the Diamond) emits the
standard metadata-update event, and reports the matching interface id. The
core gains one Diamond-only entry that emits the event for one or two token
ids, and does nothing else.

The Diamond calls it through one helper beside the value-out mark, for both
tokens of the loan, at:

- every value-out (the seams of section 3.2);
- every other change to a figure the metadata reports: collateral added, a
  repayment, a status change, a change of terms.

The builder lists these sites from the fields the metadata renderer reads, so
the list follows the renderer and is not kept by hand. A test asserts that
each renderer input has an emitting site.

### 3.5 Two waits: 15 minutes after the holder's own move, 60 seconds otherwise

The wait is kept per token, in the same word as its state number, as the time
the token may next move. Two lengths apply:

- **The holder's own move: 15 minutes** (governed, 1 minute to 1 hour). When
  the holder of a token makes a call that takes value out of that position
  for themselves (a collateral withdrawal, a claim, a change to their own
  offer), that token cannot move for 15 minutes. This is the case with a
  motive to sell at a stale price, and 15 minutes gives marketplaces, wallets
  and explorers time to act on the refresh signal before anyone can buy.
- **Any other value-out: 60 seconds** (governed, 1 second to 10 minutes). A
  repayment, a liquidation or a keeper step also changes the position, but
  the holder did not choose its timing. The short wait covers the race around
  the transaction. It is kept short so that the other side of a loan cannot
  hold a token unsellable by making small payments.

A new wait never shortens one already running. The same-block rule stays.

The owner asked (2026-11-17) whether the money should wait 15 minutes instead,
collected by a claim. The window is the right one; it is applied to the token
because that gives a buyer the same protection (nobody can buy during the 15
minutes in which a stale figure may still be shown) while an honest borrower
receives surplus collateral at once and in one transaction. Section 5 records
the comparison.

Confirmed by the builder: no protocol route transfers a position token. The
in-platform sale and handover routes retire a position's token and mint a new
one, so they do not wait. The only transfer calls in contracts that can hold
position tokens (the backstop vault and the aggregator adapter sweeps) refuse
position tokens.

### 3.6 A sale guard for orders, built when the app offers position sales

A small standalone contract with no owner, no settings and no storage acts as
the order restriction for the order protocol the collateral listings already
use (`contracts/src/seaport/`). An order that names it carries the expected
state number of each position token in the order: from the order's maker in
the order itself, or from the taker in the fill's extra data. At fill the
guard reads section 3.1's view and refuses a fill whose number has moved.

That covers both a standing bid (the bidder commits the number) and a late
fill of a listing (the taker commits the number).

It is the second step of this card. It needs no further contract change after
step one, since it only reads the view, and it is worth building only when
the app creates position orders. Until then, sections 3.1 to 3.5 ship and the
app shows the state number.

### 3.7 What is deliberately not done

- **No delay on the withdrawal itself.** It would make every honest borrower
  wait for their own surplus collateral, and it would not help a standing bid,
  which outlasts any delay. Holding the token, not the money, puts the wait on
  the sale.
- **No claim step for a live loan.** Claims exist for amounts created when a
  loan ends, collected later by whoever then holds the position. A live
  holder is checked at the call, and section 3.3 makes the payee follow the
  token, into that holder's vault. A claim would add a transaction, and a seller could collect it just
  before selling, so it would need the same wait and state number anyway.
- **No delay on moves from a protected vault into protocol positions.** That
  is the Ready-balance decision of 2026-11-08 and is unchanged.

### 3.8 The protected-payout rule gets a guard

The rule: no route pays the owner wallet of a protected vault except through
the outflow policy or the credit-if-protected helper. Under #3568 the builder
adds a test that drives every payout route against a protected vault and
asserts nothing reaches the wallet before the delay, and a static check that
fails the build when a new raw transfer to a user address appears outside
those two helpers. The four transfers that skip the check today (to protocol
contracts and the keeper) are listed in the check with their reasons.

### 3.9 Approval is per token (#3721)

A position token may be approved for transfer one token at a time. An approval
over all of a holder's tokens is refused: nothing in the platform relies on
one, marketplaces list a position with a per-token approval, and a single
prompt from a dishonest website should not be able to hand over every
position a holder has. A token's approval is cleared when the token moves. An
approval is refused while the holder is locked and is retired by a later
lock, as before. The platform's own alert (#3719) tells the holder when an
approval is given.

As built: granting an approval over all tokens is refused by name, and the
token always answers that no such approval exists, so a marketplace or a
wallet that asks sees none. Taking one away still succeeds and changes
nothing, so a wallet's "revoke all approvals" tool keeps working against the
token. A per-token approval emits the standard approval event (owner,
approved address, token), and that event is what the alert reads; no
separate event was added for it.

**No delay on an approval (owner decision 2026-11-19).** The card first asked
for a per-token approval above the protection threshold to wait protected
mode's delay. That is not built, for three reasons. There is no on-chain
threshold to read, so the token would have to price a position inside the
approval, and a price outage would then either block every approval or let
it through. A plain transfer by the holder is not delayed, so a slower
approval protects little. And the strict form already exists: under the
holder lock an approval is refused, earlier approvals read as none, a
transfer is refused and unlocking waits the account's delay. So the choice
offered to a holder is the lock: when protected mode is switched on, the app
pre-selects "Lock my position tokens", with a clear way to switch it off for
a holder who wants to list a position. The contracts do not change.
Switching protected mode on does not by itself lock the tokens; a vault lock,
a handover and the manager's own lock do.

What the app and the alert are to show (none of it is built yet): every
approval of a position token alerts its holder (#3719); each position shows
"Approved for transfer to" with the address and a one-tap removal; and the
token's details carry an "Approved for transfer" trait, refreshed when an
approval is given or cleared, if the metadata facet has room for it in the
refactor.

### 3.10 An open offer's escrow follows its token (#3744)

An open offer has its own position token, and a fill already gives the
creator's side of the new loan to whoever holds that token. The offer's
escrow (a lender offer's principal, a borrower offer's collateral or rental
prepayment) sits in the creator's vault until then. Owner decision
2026-11-19: the rights over that escrow follow the token too, the same way
3.3 reads a live loan's payee from its token.

- **Who acts.** Whoever holds the offer's token cancels the offer, changes
  its terms, lowers its size, stages it (the price-move guard, the treasury
  backstop, a parallel collateral sale) and chooses its keepers. The rule
  has one runtime copy on `OfferBookFacet` (`requireOfferHolder`), reached by
  a self-call, so a facet near EIP-170 carries a call rather than the rule.
  A cancel is also open to the holder's controller (a replaced account) and,
  once the offer has expired or its route is dead, to anyone.
- **Who is paid.** Every refund of the escrow (a cancel, an expired or
  dead-route clean-up, a size cut, a collection offer's reduction) leaves the
  creator's vault through one outflow class, `OfferHolder`. The route names
  no payee: the policy reads the holder from the offer's token. Under the
  payout rule (owner decision 2026-11-19) the refund lands in that holder's
  VAULT as its free balance, never at a wallet; only the owner's own
  withdrawal reaches a wallet. A creator still holding its own offer moves
  nothing: the released escrow becomes its free balance where it already
  sits. The vault checks the destination against the token's holder itself,
  as it does for a live loan's holder payout.
- **Marks.** A refund takes value out of the offer's token, so the policy
  raises its state number and starts its wait (3.2), before a cancel
  retires it.
- **Growing an offer.** A raise pulls more from the creator's wallet into
  the creator's vault, so only the creator, still holding the token, may
  raise it; another holder may lower, re-price or cancel.

Alternatives considered: (B) refusing any move of an offer's token until it
becomes a loan's, which drops the open-offer sale the fill rule already
supports; (C) parking each refund in a claim the holder takes later, which
adds a step where 3.3 chose "hold the token, not the assets". Recommendation
and decision: as above (A).

At the fill (design rulings of 2026-11-19), the holder of a borrower offer's
token is the borrower: the net principal goes into its vault as free balance,
the initiation fee's hold discount is its own, and a holder that is
sanctions-flagged or has not accepted the Terms in force makes the offer
unfillable, with a named refusal the previews report. The creator, whose vault
holds the collateral, is screened as before, and its risk consents stay with
the offer. An offer's Full-tariff consent is given by the token's holder,
recorded with that wallet, and counts only while that wallet holds the token;
a transfer lapses it and the fill runs on the standard tariff. The same rule
covers the lender side of a match and a collection offer's slices: the loan
side an offer creates belongs to whoever holds the offer's token when the loan
opens, while the creator's vault funds it and stays recorded as the funding
vault. Every ownership check reads the holder and refuses by name; nothing
falls back to the creator. An offer with no token of its own keeps its
creator.

A refinance request is the one exception (design ruling 2026-11-19). It stands
only while its creator holds both the loan's borrower token and the request's
own token, each unmoved since the request was posted: the payoff permit is the
creator's signature and any carried collateral sits in the creator's vault, so
neither half can belong to anyone else. The test lives in the one standing rule
(`LibRefinanceRequest`), so accept, match, both previews, the loan-holding guard
and the views all follow it; a moved request token is refused by name
(`RefinanceRequestTokenMoved`). The request's rights and escrow stay with the
creator, so its token's holder gains nothing: the creator cancels it (anyone
may clear it), a fresh pledge stays in the creator's vault, the cancel drops
its payoff permit, and the loan's holder may post a new request in its place.

## 4. What a user is told

- **On any marketplace, in the token's own details.** Most marketplaces do
  not show a contract's refusal reason, so a buyer would see only that a
  purchase fails. The metadata therefore carries two traits: "Transfer hold
  until", a date and time, present only while a wait of section 3.5 is
  running, and "State number". The refresh signal of section 3.4 is sent when
  either changes. The hold's end is a fixed time, so no second signal is
  needed when it passes. The collection description says in one sentence that
  a position cannot be sold for a short time after value leaves it.
- A refused transfer keeps its named reason with the token and the time the
  hold ends, which the app and block explorers show.

- The position page shows the state number and the time of the last value-out,
  and says that a buyer should check both before paying.
- On an outside marketplace, the platform cannot stop a sale at a stale price
  once the wait has passed. The app says so wherever it links out to a
  marketplace listing. Orders made through the app, once section 3.6 exists,
  carry the guard and are refused if the position changed.
- After removing collateral or receiving a payout, a holder is told their
  token cannot be transferred for the wait of section 3.5, with the time it
  frees.

## 5. Alternatives considered

1. **Hold the money for 15 minutes and pay it by a claim that follows the
   token.** It has one real merit: the token stays sellable throughout and a
   buyer in the window receives the parked amount. Against it: every payout
   on every route becomes two steps, or needs a keeper pass to deliver it;
   amounts sit parked for each loan; and a protected vault's own delay stacks
   on top. Holding the token for the same 15 minutes protects the same buyer
   and costs only a holder who wants to sell within 15 minutes of taking
   value out.
2. **Lengthen the cooldown only.** Simple, but a standing bid outlasts it, and
   a long wait holds honest holders' tokens after every payout.
3. **Delay the withdrawal.** Section 3.7.
4. **Route withdrawals through claims.** Sections 3.3 and 3.7.
5. **A holder-set "for sale" lock that blocks value-out while set.** A buyer
   would still have to check the lock at the fill, which needs the same order
   guard as section 3.6, and an honest seller gains a step. The state number
   gives the buyer the same assurance with nothing for the seller to do.
6. **Block withdrawals while a listing exists.** The platform cannot see
   orders signed on other marketplaces.

## 6. Recommendation

Build sections 3.1 to 3.5 and 3.8 now as step one. Build 3.6 when the app
offers position sales. Keep withdrawals immediate and claims for loan-end
amounts.

## 7. Build notes

- The position token core changes (the event, the interface id, the
  Diamond-only entry), so this reaches a chain by fresh deploy.
- The value-out mark, the count and the refresh call sit behind one helper in
  the position token library, called only from the seams of section 3.2, so
  nothing can stamp without counting or refreshing.
- The one view of section 3.1 is `positionState(tokenId)`, returning the state
  number, the block of the last value-out and the time the token may next
  move.
- New selectors need the usual registrations, the ABI exports and a row in the
  permissionless-steps ledger for nothing here (both new Diamond entries are
  views; the core entry is Diamond-only).
- The indexer needs no change. The app change is section 4.

### 7.1 Route table (from the builder, 2026-11-17)

**The seams, which are the only places that mark:**

- **A. The outflow policy.** Every outflow whose class names a loan marks both
  of its tokens and raises their state numbers: a payout to a position holder,
  to a counterparty, to a matched counterparty, to claim custody, to a prior
  seller, and to a liquidation buyer. A consolidation is excluded. For the
  first two, the payee's token also takes the long wait
  when the caller of the guarded action holds it. The caller is recorded by
  the reentrancy guard for the length of the call.
- **B. The one writer of a loan's collateral amount.** A reduction marks. A
  set marks when the amount falls and refreshes otherwise. An addition
  refreshes. The build check refuses any other writer; origination is the one
  listed exception.
- **C. The loan-terms writer.** A rate change always marks (an extension, a
  handover). A principal write-off marks. A principal reduction marks when
  less was delivered than was cleared, and refreshes otherwise.
- **D. The one function that takes a held amount out of a lender position**
  marks. The claim and both intent re-commits use it.
- **E. Retiring a token** marks the loan, or the offer's token, and gives the
  long wait when the caller holds the token.
- **F. An offer's token.** A change to the offer, a match drawing on it and
  its end each mark, with the long wait when the caller holds the token. An
  offer's token becoming a loan's token marks the loan. The marking for a
  match runs in one place: a self-call host on the position token facet marks
  both offers' tokens in one call with one refresh. The match core is compiled
  into four facets, and writing the two calls into each put two of them over
  the size limit.
- **Refresh only:** a status change, an increase in collateral, a principal
  reduction delivered in full.

| Route | What leaves which position | Seam |
| --- | --- | --- |
| Partial collateral withdrawal | Collateral leaves the borrower side | A (to the holder's vault as free balance: long wait on the borrower token when the holder calls), B |
| Add collateral, the standing top-up | Nothing; collateral rises | B, refresh only |
| Repayment, partial or full | The lender is paid; principal falls | A, C. A full repayment changes status, which refreshes |
| Standing interest payment and due-date repayment | The reserve pays the lender | A, C |
| Partial swap-to-repay | Collateral is sold; a surplus goes to the holder | B, C, A. The hand mark was removed |
| Full swap-to-repay | The loan ends | Status refresh; then claims and retire: A, D, E |
| Partial health-factor liquidation | Collateral is sold | B (newly marked), C, A |
| Matched liquidation legs | Collateral moves between loans | B on each leg (newly marked), A, C |
| Discounted and split liquidation | The buyer takes collateral | A, and B where collateral is written |
| Fallback entry and shortfall split | The custody figure falls | B (newly marked) |
| Time-based default | Collateral goes to claim custody | B, A |
| Periodic forced sale | Collateral is sold for interest | B (newly marked), A |
| Terminal forced sale | The loan ends | B; claims later: A, D, E |
| Obligation handover | The borrower and the terms change | B, C, E, then a new token |
| Offset, listed sale, direct sale | The side moves to a new holder | E, then a new token. No transfer, so no wait |
| Automatic extension | Terms change; interest is paid out | C, A. The hand mark was removed |
| Claims | A side is paid out | A (long wait for the caller's own token), D, E |
| Intent re-commit, both entries | Held funds leave the lender side | D. The hand mark was removed |
| Consolidation | Custody moves under the lien | Not marked, except when less is credited than was sent: B |
| Offer change, match, cancel, direct accept | The offer's token changes | F, E |
| Payout to a prior seller | Paid to that seller | A |

**The holder's-wallet payout is removed** (2026-11-19, section 3.3). The
partial collateral withdrawal uses the position-holder payout, which pays a
vault and needs no wallet step, no fallback and no ERC-20-only restriction.

**Raw transfers outside the policy.** The static check of section 3.8 lists
each with its reason (29 sites as built): cross-chain messenger fees, which
pay a protocol contract and never a user, refunds of a caller's own unspent fee,
the broadcast-budget withdrawal, vault deposits and credits, consolidation
legs into a vault, reward custody, the keeper reward, the repatriation return
and the recycle release.
