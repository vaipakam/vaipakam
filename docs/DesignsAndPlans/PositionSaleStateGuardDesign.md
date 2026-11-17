# Position sale state guard

Status: design, approved for build by the secured-vault thread. Card: #3710.

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
split and the periodic forced sale. Each needs confirming, since some may be
covered by the payout they end in.

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

A collateral withdrawal checks that the caller holds the borrower position
token, and then pays by one of three routes chosen in the withdrawal's own
code: the caller's wallet when the caller is also the original borrower, an
allowlisted address for a retired protected account, the holder's vault
otherwise. The check and the payment are two steps, and the first route names
the original borrower as payee.

The outflow policy gains one payout for this: **to the holder of a named
position token, at their wallet**. The policy reads the holder from the token
itself and pays that holder under the same rules as any owner payout (the
protected-mode delay, the lock, the allowlisted address of a retired
protected account). The calling route passes the loan and the token, never a
payee. The withdrawal uses it for every case, and its three-way choice is
deleted. A route can then no more pay the wrong party than it can skip the
mark.

This gives what a claim step would give, that only the token's holder can
receive a loan's collateral, in one transaction and with nothing parked in
between.

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

Builder to confirm: the in-platform sale and handover routes replace a
position's token and do not transfer it, so they do not wait. If any protocol
route does transfer a token, it is listed in the build notes with the effect
of the wait.

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
  token. A claim would add a transaction, and a seller could collect it just
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
  once the cooldown has passed. The app says so wherever it links out to a
  marketplace listing. Orders made through the app, once section 3.6 exists,
  carry the guard and are refused if the position changed.
- After removing collateral or receiving a payout, a holder is told their
  token cannot be transferred for the cooldown, with the time it frees.

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
- The route table of section 3.2 is added here by the builder.
- New selectors need the usual registrations, the ABI exports and a row in the
  permissionless-steps ledger for nothing here (both new Diamond entries are
  views; the core entry is Diamond-only).
- The indexer needs no change. The app change is section 4.
