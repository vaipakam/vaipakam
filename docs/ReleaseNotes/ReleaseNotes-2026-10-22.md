# Release Notes — 2026-10-22

Today the protocol began to book only what arrived. Every token move it records is now measured where the tokens land:

- a flow a user chose refuses a short arrival;
- a forced close-out (a liquidation, a default or the in-kind fallback) acts on what arrived, puts any shortfall on that loan's own figures and pays the lender first;
- every fee or share sent to the treasury goes through one host, which records what reached the treasury.

For an ordinary token, which delivers exactly what it sends, nothing changes. The change has not reached the testnets yet: testnet refreshes wait until the current waves of work are done.

## Thread — The protocol books only what arrived (PR #2622)

Every token move the protocol records is now measured where the tokens land,
so no ledger can name tokens that are not there. Before this change the
protocol recorded the amount it asked a token to move. For an ordinary token
that is the same thing, but a token that delivers less than it sends (a fee on
transfer, share rounding, an upgradeable token that switches a fee on after a
loan opens) left the books ahead of the balances. A forced close-out then sold
or forwarded the full recorded collateral, and the difference came out of
tokens the protocol holds for other users. A deposit or repayment recorded the
full amount against a vault that received less, so the lender's claim could
not be paid in full.

The rule has three outcomes, and the FLOW a move belongs to decides which
one applies, never the move alone. A payment from a user's wallet (offer
funding, collateral, a rental prepayment, repayment, preclose, refinance, a
liquidator's payment, a fee, and Permit2 pulls) is refused by name unless all
of it arrived, in every flow. A flow someone chose to start now (accepting an
offer, repaying, preclosing, refinancing, swap-to-repay, selling a lender
position on either route, a rental day, an in-place extension, a marketplace
sale of the collateral) records the party it pays as paid in full, so every
hop inside it is refused when it lands short: out of a vault, onward from the
protocol, and into the receiving vault. A token can charge one hop and not
another, which is why the first review round's fixes, which measured only some
hops, were not enough. A move the protocol must complete (liquidation in all
its routes, time-based default including the in-kind and rental cases,
periodic-interest auto-liquidation, the fallback entry and the fallback retry)
never stalls: it acts on what arrived, the claim, lien or custody row beside a
credit names that same figure, and the shortfall reduces only that loan's own
figures. In an internal match, a leg that delivers less clears only what it
delivered of the receiving loan's debt, and the rest stays owed on that loan.
This keeps the lender-first principle (owner decision 2026-10-20): issue #2440
suggested refusing a short delivery on liquidation, which was deliberately not
taken because it would trap the lender once a token switched a fee on.

Three kinds of move pay no counterparty, so they act on what arrived in every
flow. A fee drawn from a vault for the treasury or for the party who matched
two offers is recorded as it arrived, and its recipient bears the charge. A
payout of a user's own balance, or of a recorded claim, pays what the token
delivers. And a transferred position's backing following it to the new
holder's vault (the borrower's collateral, or the lender's parked proceeds)
carries one side's own backing between that side's vaults: that side bears its
token's charge, its records fall to what arrived, and the checks of the flow
that triggered the move then run on those true figures. A move whose source is
also its destination (one user on both sides of a match or a default, or a
payer who is also the payee) counts as delivered in full for an ordinary
token, because the tokens stay where they were sent.

The review rounds brought every move recorded as a payment in full under the
rule. Accepting an offer refuses a lending asset whose net principal reaches
the borrower short, as it already refused short collateral. A rental
repayment's share reaching the lender's vault, a rental day's fee, a partial
or full swap-to-repay (the lender's proceeds and the borrower's surplus), an
in-place extension, and a seller's net from either sale route are refused the
same way, so a seller always receives at least the floor they set. A rental
whose prepay token starts charging is no longer serviced day by day and
settles through the time-based default at the end of its term (the renter's
buffer then goes to the treasury, as on any rental default). A partial
liquidation leaves the loan open and records its payment to the lender as
received in full, so it is now refused when that payment lands short; the full
liquidation stays open and acts on what arrived. The periodic
auto-liquidation's payout to the lender-position holder's wallet must arrive
in full (see below); when that holder's share is frozen into the stored
lender's vault instead, the loan books what the vault received, and a short
payout leaves the period it settles open. A
failed fallback retry that restores less than it pulled lowers the loan's
recorded collateral along with the custody. The optional backstop purchase of
fallback collateral is priced on what actually reached the backstop, and its
cash to the lender must arrive in full. Every return from the backstop to the
treasury (unused capital, unused purchase cash, a resolved loan's proceeds and
a swept residue) credits the treasury with what reached it. Three of those are
forwarded by the backstop vault, which is its own upgradeable contract: until
governance upgrades it, those three still report what the vault sent.

A marketplace sale of collateral is paid by the buyer straight to each
recipient, so the protocol could not measure it from its own side. The listing
contract now does: it reads the recipient's balance before the marketplace
moves any token and again after, and refuses the whole sale unless the share
the platform records as paid arrived in full (the lender's share of a sale of
a loan's collateral, on which the loan closes as repaid, and the platform's
proceeds of a sale of an offer's collateral). The buyer's payment then never
leaves the buyer. The treasury's share, the seller's own remainder and the
seller-agreed marketplace and royalty fees record nobody as paid, so they are
not measured, and a lender buying the collateral of their own loan by filling
that listing on its own pays their own share to themselves. In a marketplace
call that combines orders (a listing matched against a bid, or a batch) the
account submitting it need not be the one paying, so there the share is
measured whoever submitted it, and a lender paying their own listing inside
such a call is refused. When one purchase covers several listings, each is
measured against its own share of the arrivals, and what one listing's
settlement pays onward is never counted as another's arrival. The record lives
only for the transaction. A fill whose first check did not run in the same
transaction is refused rather than accepted unmeasured.

Every fee into the treasury drawn from a wallet or a vault, and every
treasury share the protocol already holds from a settlement, now runs through
one small new facet, TreasuryFeeFacet, which measures what the treasury
received and records the accrual once. A wallet fee is refused unless it all
arrived; a vault fee or a held share is recorded as it arrived and never stops
a close-out. Before, twelve settlement sites (liquidation, default, claim,
swap-to-repay, the marketplace sale of an offer's collateral, the in-place
extension) pushed the treasury's share by hand and recorded the requested
figure. Where the protocol is its own treasury, a share it already holds is no
longer moved at all: the tokens are already where the treasury keeps them, so
the whole share is recorded, and a token that charges on transfer can no longer
take its fee out of the balances held for other users by a transfer from the
protocol to itself.
Moving the fee legs there is also what keeps PrecloseFacet under the contract
size limit. Two related defects were fixed on the way: a rental preclose
moved the lender's rental share into the lender's vault without recording it,
so the lender's claim could not be paid; and a rental default sent the
forfeited buffer to the treasury without recording the accrual. Deployments
must refresh TreasuryFeeFacet together with its callers; the complete refresh
and both curated refresh scripts carry it. The listing contract is upgraded
separately (it is its own upgradeable contract, not a facet), and until it is,
a marketplace sale of collateral is still settled on the amounts the order
names.

The third review round settled where a measurement can be trusted at all. A
balance is a sound measure only inside the protocol's own custody (its
contract, a user's vault, the treasury). A user's wallet can lower its own
reading while a transfer runs (a receiving hook can pass the tokens straight
on), and if the protocol booked that lower figure and left the rest owed, the
same owner could be paid again. So a reading at a wallet is now used only to
refuse: every payment to a wallet whose arrival decides what is still owed is
refused unless all of it arrived, in every flow, a forced one included. That
covers the periodic auto-liquidation's payment to the lender-position holder
and the partial swap-to-repay's surplus to the borrower. A payout that closes
an entitlement whatever arrives (a recorded claim, a user's own balance, a
liquidator's or keeper's bonus, a treasury claim, a payroll withdrawal) takes
no reading at the wallet. The round also added the sender's side: a move out
of custody that costs the sender more than it sends (a token that charges its
sender on top of the amount) is refused in every flow, because the excess
would come out of tokens held for someone else. And a lender's claim that a
close-out recorded at zero (a token that delivered nothing) now completes and
closes the position, where before it was stuck behind "nothing to claim"; a
borrower claiming first no longer settles the loan over it. The app offers
that claim too.

A new pre-deploy check reads the compiled contracts and fails on any ERC-20
move written outside the delivery library that is not listed, with the reason
it may skip the library, in an allowlist. The list is exact: a new raw move,
a second one in a listed function, or a listed one that has gone all fail.
Writing it is what found the backstop returns above. The thirty-two moves it
lists are the VPFI reward, recycling and fee paths, the cross-chain receivers,
the keeper's own contracts, the swap adapters (each attempt is measured as a
whole), the vault's two primitives behind measured callers, and owner sweeps
that record nothing.

Closes #2440. Closes #667. Closes #2623. Addresses #1281 item 011. Out of scope and
unchanged: the VPFI recycling and reward custody paths, which already measure
their own deliveries.
<!-- assembled-fragment: 2440-measured-delivery.md sha256=092d6ad86dc15ba0888bb57c4694af2febf7b554140682974b562d6b13521df1 -->

## Thread — Sanctions screen on the buyer of listed collateral (PR #2646)

A collateral sale through the marketplace now screens the buyer, not only
the sale's recipients. Before, the fill re-checked the borrower, the live
position holders and the fee recipients, but never the account buying the
collateral, so a flagged wallet could buy a borrower's listed NFT. Now the
fill is refused when the account filling the listing is flagged and, for
ERC-721 collateral, when the account holding the NFT after the fill is
flagged (which covers a buyer who sends the NFT to another wallet, and a
marketplace match someone else assembles). The platform's own offer-match
path screens the bidder before it calls the marketplace. Each screen uses
the same outage-aware sanctions read as the existing recipient screens.

What stays outside is stated in the code and the functional spec rather
than implied: the marketplace does not tell the platform where ERC-1155
collateral goes or who paid in a match someone else assembled, so a
flagged recipient of ERC-1155 collateral that is not the account filling
the listing, and a flagged paying bidder of such a match whose NFT goes to
an unflagged account, are not seen.

Closes #1279.

_Committed 2026-10-22 08:30 UTC (dbb70ec5a)._
<!-- assembled-fragment: 1279-listing-buyer-sanctions-screen.md sha256=07ee6deed7c7294c98212e49d470e650a484bbc6d2469a9fba8c9c96eb4c4183 -->

## Thread — Fallback split priced honestly; rental offers single-value (PR #2637)

**The fallback split now decides "the oracle is unavailable" from the price
reads, never from how small a converted figure is.** When every swap route
fails, the protocol splits the collateral: the lender takes the collateral
needed to cover their fallback entitlement, the treasury its handling share,
and the borrower the rest. If a price cannot be read, the lender takes
everything instead. Before this change the code treated a lender share that
converted to zero units as "unavailable". So on a fully priced loan whose
entitlement was worth less than one unit of collateral, the lender received
the whole collateral and the oracle-unavailable event was emitted. Now one
pair of price reads decides availability for the whole split, and a priced
split stays a split however small its shares.

**The lender's share rounds up, lender first.** "The collateral needed to
cover the entitlement" now means the smallest whole amount worth at least
the entitlement at that price. The old floor could leave the lender up to
one collateral unit short. The treasury's share still rounds down, and the
borrower keeps the remainder. Two places keep the same rule:

- When an internal match consumes part of a waiting fallback, the remaining
  lender share is rescaled rounding up.
- The keeper backstop's purchase check no longer allows a one-wei shortfall.
  At an unchanged price the slice it buys is now always worth the full due.
  And when a rescale leaves a collateral share beside a due rounded down to
  zero, the backstop no longer buys that share for nothing: it spends
  nothing and the lender keeps the share in kind.

The same conversion change reaches two other paths:

- **Periodic-interest auto-liquidation.** The sale is sized to the
  collateral needed for the shortfall, rounded up, so a small shortfall is no
  longer sized to a sale of nothing. The sale also reads one price for both
  sizing and quoting, and refuses before anything moves when a price is
  missing.
- **Discounted liquidation.** It refuses on an unpriced pair, as it always
  meant to, and no longer on a figure that merely rounds to zero.

**NFT-rental offers are single-value on their daily fee.** Creating a
rental offer with a fee range is now refused, and so is editing one into a
range (`RentalAmountRangeNotAllowed`). Every rental path prices the
prepayment from the offer's single fee. With a range, the fee the loan ran
on could differ from the fee that was prepaid. The clearest case was a
replacement borrower taking over a rental whose fee sat inside that
borrower's range: the incoming prepayment came out short of the fee the
rental kept charging. The app already sent rental offers at one fee, so
nothing changes for an ordinary user.

Closes #1281: this change fixes items 021 and 027. Item 011 was fixed by
the measured-delivery change (#2622), and item 041 by the earlier
par-guard rework, whose last one-wei allowance this change removes.

Nothing here has reached the testnets yet: per the owner's 2026-10-21
decision, every testnet refresh waits until all the waves of work are done.
This changes no storage. Both rules assume records written under them. A
rental offer created earlier with a fee range would not be refused when it
is used, and a fallback split sized by the old rounding could fall one unit
short of the exact purchase check, so the backstop would refuse it and the
lender would keep the ordinary claim. Neither kind of record can exist
where this code runs: every chain that runs the current fallback custody
code is deployed fresh (owner decision of 2026-10-07), so it starts with no
earlier records.

_Committed 2026-10-22 07:29 UTC (00ce84c54)._
<!-- assembled-fragment: 1281-fallback-priced-split-and-rental-single-value.md sha256=09dee3314d56b129d9f641eafbff70e412cfba7f9b9122209d4fc2b5ccae6fe7 -->

## Indexer — every activity row is filed under the loan or offer it names (PR #2659)

**Loan and offer references now come from each event's own definition, by one rule (#1794).** The activity ledger can be filtered by loan and by offer, but those references used to be written out by hand, one event at a time. An event nobody had written out was stored with no loan and no offer. The row existed, but nobody looking at a loan could find it. Sixty event fields were in that state, among them a lender selling a loan, a borrower's early close-out, collateral being added or withdrawn, health-factor liquidations and fallback episodes. Now the indexer reads the reference straight from the event's definition, using the same rule the coverage check uses to decide that an event carries one. All of those events are filed under their loan or offer, and a new event that names a loan is filed correctly without anyone remembering to add it. Only the "who did it" field is still decided per event.

**What is deliberately not filed, and why, is written down in one policy file.** Each exception is stated with its reason, and the indexer and the coverage check read the same file.
- Companion records whose main event in the same transaction is already filed are not filed again, so one action is not listed twice.
- `SanctionedProceedsLocked` is not filed under a loan, because its loan field carries an offer number when the refund comes from a cancelled offer.
- The value zero, which events use to mean "no loan" (a treasury conversion's swap attempts carry it), is never filed as a loan.

Where an event names two candidates, the choice is recorded with its reason:
- A refinance is filed under the old loan it closes.
- A standing-intent or signed-order match is filed under the counterparty's standing offer, not the slice offer the protocol creates inside the same transaction.

Each exception also records which event fields it was granted for, and the coverage check flags the exception if those fields change (#1807). The check now states what it guards: accidental drift, not deliberately constructed workarounds (#1811).

**What this means for existing data.** Rows already in the ledger keep their earlier filing. Every testnet is indexed again from scratch at its next fresh deployment, so no rewrite of existing rows was added. In the app, a wallet's Activity page now also lists these events for the loans it holds. Some of them have no translated label yet and show an English name generated from the event, which the app's label work will cover.

Closes #1794, #1807, #1811.

_Committed 2026-10-22 17:02 UTC (54dc9727f)._
<!-- assembled-fragment: 1794-activity-refs-from-abi.md sha256=ff28826083cc8047e6388aba949aa99b803fe1c97855abf8bed6547ac8830046 -->

## Thread — a lost internal match on the close-out card now ends in a sale (PR #2671)

When an overdue loan can be settled against an opposing position, the
lender's close-out card sends that settlement. The opposing position is
another loan anyone can act on, so it can be taken between the card's read
and the transaction running. For a loan whose collateral would otherwise be
sold, the protocol then moves on to the sale, and the card used to send no
sale route, so losing that race refused the close-out and cost the lender the
network fee. The card now asks the exchanges for a price on confirm, exactly
as it does for a sale, and sends those routes with the settlement. A lost
match therefore ends in a sale, or in the protocol's fallback if every route
fails at that moment. Where no price can be found, the settlement is still
sent without a route, and the card says beforehand that a lost match would
then fail for the fee alone. The card's race paragraph now names those
endings and the incentive a sale may pay its submitter instead of the matcher
one. The keeper's default pass already sent a quoted route on this route.

The issue also described a second hazard: a close-out ending a loan whose
lender position had just been sold, stranding the buyer's payment. The
current contracts already rule this out. A sale's acceptance completes it in
the same transaction, and a sale cannot be accepted from the loan's maturity
on, while a close-out is possible only after the grace period, so the two
cannot meet. Existing contract tests pin both halves. The card's own sale
check stays, as the rule it shares with the keeper, and the comments and
functional spec that said the protocol does not keep the two apart are
corrected.

Closes #2078.

_Committed 2026-10-22 23:46 UTC (b581c47e4)._
<!-- assembled-fragment: 2078-match-close-out-carries-sale-route.md sha256=7bf3631d485c02d0fe81ce01284411dbeddaf3a32def7c2ea58cb85982a423bd -->

## Indexer — reads say when a chain is not served, stats are one consistent view, config labels match their capture, and the ingest probe watches what is configured (PR #2653)

**A chain that is not being served answers "unavailable" everywhere (#1140).** Most indexer reads that name a chain already refused a chain the indexer is not indexing, but eight did not: the recent-loans tape, market discovery, the active offer book, active loans, both stats endpoints, the loan time series and recent offers. They answered such a chain with an empty list or zero counts, which the app shows as "no fills yet" or "no live markets" when the truth is that the chain is not being served. They now give the same "chain not configured" answer as the rest. The single-loan, single-offer, activity, offers-by-creator and protocol-config routes follow the same rule, so the whole surface behaves the same way. The check now lives in one place, and a test fails if a new route reads a chain without asking it. The app already treats this answer as unavailable, so nothing changes there. The one write that names a chain, the record of how a prepay match was found, is now refused only for a chain the protocol is not deployed on. A passing RPC outage therefore cannot make it lose that one-time record. The reward-metric reads are outside this change (#2654).

**Stats counts and the block they cite come from one read (#2080).** The loan and offer stats each read their counts and then, separately, the block the indexer had reached, which they report as "current through block N". If ingest landed between those two reads, the counts were older than the block quoted beside them. All of these figures now come from one database transaction, so the counts and the block always describe the same moment. The counts also agree with each other: the ERC-20 and NFT subtotals can no longer exceed the active total.

**Config labels are the ones the values were read with (#2073).** The public protocol-config answer adds field names (such as the treasury fee) to the raw on-chain settings. Those names used to come from whichever version of the indexer served the request. If a contract upgrade had reordered the fields without changing their number, a stored snapshot could be served with real values under the wrong names, and nothing would show it. The snapshot now stores the names it was read with, and the answer uses only those. It stores them only when the chain shows that the contract code answering at that block is the code the indexer's definition was built from. During an in-place upgrade that the running indexer predates, that check fails, and the snapshot keeps the raw values with no names. A snapshot taken before this change shows only the raw values until the next refresh adds its names (normally within six hours, sooner after any governance change). This needs an additive database migration (0067).

**The ingest health probe watches what the indexer is configured to scan (#2498).** The probe kept its own list of chains, so a chain that was switched on or restored in the indexer would be ingested but never checked. The indexer's health answer now lists the chains it is configured to scan: those with a deployment and an RPC binding present. It reads this list without looking up any secret, and says so. The probe watches exactly that list, apart from chains named in an explicit "intentionally idle" setting, which is empty today. If the list is missing, or nothing is left to watch, the probe reports a problem instead of passing.

**Also fixed:** after #2647 moved the agent to a five-minute cadence, three agent tests from #2635 ran on a minute the agent now skips and failed on main. They now run on a minute the agent acts on.

_Committed 2026-10-22 16:29 UTC (ee82efb1b)._
<!-- assembled-fragment: 2080-indexer-read-path-honesty.md sha256=e28cd7743a68e777668ab08a82d3a10c302c49c80e816e66a5d032042a4b63d0 -->

## Indexer — a repaired loan's ending on the Activity feed, and live updates that survive a restart (#2195, #2196)

A loan the reconciliation pass closes because its ending event was missed for good now shows that ending in its activity history. The activity ledger is a record of the chain's events, and a repaired ending has no event, so none is invented. Instead the repair now records what it observed on the loan itself: the ended status the chain showed and the settled block it read it at, plus that block's time. The Activity feed serves this as its own kind of entry, marked as found by reconciliation, placed in the feed at the block where it was observed. It does not claim when the loan ended, which event ended it, who acted, or in which transaction. Loans repaired before this change get no entry, because the block their repair read was not kept. If the feed cannot read these entries (for example in the moment between a deploy and its database migration), it says the list is unknown rather than empty. A reader asks for these entries explicitly; one that does not ask gets exactly the events-only pages it always got, so an entry it would not show never takes the place of an event. A repair now also signals connected apps that the Activity feed changed. The app does not show these entries yet; that is #2643. Closes #2195.

A live-update push can no longer be lost when the indexer stops between saving a change and announcing it. Some changes cannot be found again once saved: a reconciliation repair, a settlement correction, a withdrawn record, a reminder, and every event already scanned past. Before, a crash in that gap meant connected apps kept showing old data until their next poll. Now a marker is saved before each scan and cleared only after its announcement goes out. A scan that finds the marker still set tells every connected app that everything may have changed, without naming specific loans, since it cannot know what the lost scan changed. The same recovery now sends every update type, not a subset, and is sent even when the new scan has updates of its own. The cost is two small storage writes per scan, about 1,700 a day across three chains, well inside the free plan's daily allowance. Closes #2196.

_Committed 2026-10-22 07:40 UTC (2dd9575e7)._
<!-- assembled-fragment: 2195-repaired-loan-ending-and-push-recovery.md sha256=01d61dbab9d5158833be5b324a15453e2b3333b674f86c4959b1d3b009394102 -->

## Indexer — reconciliation repairs: settled-head hold, orphan withdrawal, missed settlements, holder history (PR #2636)

The indexer no longer reads the chain up to a guessed point. Each turn it asks the RPC for the chain's settled ("safe") block; when that read fails for any reason, it used to step back 32 blocks from the newest and scan up to there, and because the scan never revisits a block, a reorganisation deeper than that margin would have left wrong rows in the database for good. A turn without a settled block now holds: it scans nothing, keeps its place, keeps serving what it has, and logs which chain is held and the reason the RPC gave. The cursor's age on the ingest health page grows while it lasts. The repair lanes that fill in or correct records from chain reads hold on the same turn, and the one that read the newest block instead of a settled one now reads at the settled block. Every chain the platform indexes today answers the settled-block question, so in practice this is a one-turn pause on a timeout. Closes #2201.

A loan record the chain has no loan for is now withdrawn from publication rather than only reported. When the reconciliation pass proves, at the settled block, that a loan id does not exist on chain, it moves the record out of the loans table, together with the loan's activity entries, participation history and notifications (so it also leaves wallets' history, the Activity page and the bell) and any listing or swap commitment attached to it, into a separate holding table that keeps the whole record and the block the proof was read at, so an operator can restore it if the check was wrong. The same applies to an ended record: the settlement heal, which reads every ended-but-unsettled record anyway, withdraws one the chain has no loan for by the same move. Settled records get a slow existence-only rotation, run on whatever the turn has left, which withdraws a settled record the chain has no loan for and never rewrites a real settlement. Each move is started only when the turn can still afford all of it and the work after it. The loan's alert memory (which warning each wallet last received) is cleared with it, so if the id is later issued to a real loan that loan's first warning is not suppressed. The move is one transaction conditional on the whole record, and the set of activity, history and notification rows about it, being unchanged since it was read, so a concurrent update or a newly arrived row, even within the same second, leaves everything in place and the next pass tries again. The holding table is backed up nightly and restored from the backup, because rebuilding the index from the chain cannot recreate a record the chain never had, and it survives a redeployment of the contracts, each entry naming the deployment it is about. The kept record is the operator's finding: the stale-quarantine report names every withdrawal on each pass until a person marks it reviewed, and because the record is backed up, a restored database keeps naming it. The id's reminder hold is released after the move, so a real loan later issued the same id is reminded normally. Every surface that lists or counts loans stops showing it with no per-surface change. Closes #2197.

An ended loan whose settlement announcement the indexer missed entirely is now brought up to settled from the chain's own status. The settlement heal used to consider only records whose settlement event was in the activity ledger; it now checks every ended-but-unsettled record against the chain on its rotation and promotes it to settled only when the chain says Settled, with the settlement's block and time left unknown unless a confirmed event supplies them. Each turn reads one bounded page per ended status, so the cost stays a page however many ended loans are waiting; each lap runs to the highest id it started with, so loans that end during a lap wait for the next one instead of keeping the walk from ever returning to the start, and the log says how many settlements were dated by a confirmed event and how many were not. Closes #2192.

A corrected loan's chain-verified holders are now recorded in its participation history, in the same transaction as the correction, so a holder whose transfer fell in the missed stretch appears in the wallet's loan history and Activity filter. A holder who already has an entry is left as recorded, and a side the chain did not name records nothing. The other half of #2195 (a reconciliation-marked ending in the Activity ledger) and #2196 (a durable broadcast for repairs) are in a follow-up change.

_Committed 2026-10-22 07:06 UTC (e69b26c3f)._
<!-- assembled-fragment: 2201-indexer-reconciliation-repairs.md sha256=1837151d5f5b6c11a3ce2cc719ba0e6b2ebe1c810947e3734f0f3c4ffc33d1c3 -->

## Thread — the indexer counts its requests against the right limits, and the agent ticks every five minutes (PR #2647)

The indexer has counted every request its scheduled work makes since #2227, so that a pass stops before the hosting plan stops it. It counted against one limit of 50, and that was the wrong model: the plan has a limit of 50 for requests that leave Cloudflare (the chain reads and the OpenSea post), a separate limit of 1,000 for requests to Cloudflare's own services (the database, the secrets store, the ingest objects), and a limit of 50 database statements. A week of production logs agreed with that reading. Nearly every ingest run ended with the single counter exactly full, about a hundred went over it, one by more than double, and none of them was stopped. Because every repair lane stopped at that counter, database calls were using up room meant for chain reads. The counter now keeps three meters, one per limit. Each repair lane states its cost as the chain reads and database statements it actually makes. Every run logs all three figures. The database-statement limit stays at the documented 50, the conservative reading, even though one run went past it without being stopped. The next adjustment is made from those logs (#2221).

The scheduled tick on the fallback ingest path used to start the chain scan, the reserve snapshot and the OpenSea retry sweep together, all drawing on one allowance. The scan could lose that race, which is the condition that drops events (#2194). Now the scan runs first. The snapshot and then the sweep run one after the other, and each checks what is left before it starts, so neither can count on room the other is about to use. The sweep checks before every listing, and its reads no longer retry, so its cost per listing is a fixed seven. The write side and the reminder sweep also share one check for whether the quarantine table exists, so a cold pass makes that check once instead of twice.

The agent's scheduled tick now does its work every five minutes instead of every minute (#2236). It runs on the plan's 10 ms processing allowance and was stopped for it in two episodes, most recently on 15–16 October. Its work is a payment reminder sweep whose window is days wide, plus two clean-ups, so the extra four runs an hour bought nothing. The trade-offs are that a full reminder pass over the loans now takes five times as many minutes, and that an expired Telegram link code can stay in the database up to five minutes longer. Such a code was already refused at use. #2230 records when a slower pass would start to matter: when one pass takes longer than the reminder window. Nothing is near that today.

_Committed 2026-10-22 13:04 UTC (0cf8faeeb)._
<!-- assembled-fragment: 2221-workers-free-request-ceilings.md sha256=246c8b677129fafb8b745cc7095d5d1e2d6987ca1420e51f8336bdc31f5e980e -->

## App and agent — Push alerts are offered only when they can be sent (PR #2665)

**The app no longer offers Push alerts a deployment cannot deliver (#2251).** Until now the Alerts card offered the Push opt-in whenever the app was built with a channel address, whatever the agent could actually do. A deployment with no Push signing key, or with a malformed one, still showed the opt-in, accepted it and saved it, and no alert ever arrived. The agent now answers one question for the app: can Push alerts be sent from here, and through which channel. The card offers the opt-in and the subscribe link only when the answer is yes, and the link opens the channel the agent names, so a build-time address can no longer point at the wrong channel. When the answer is no, or the agent cannot be reached, the card says so and offers nothing. The agent also refuses a new Push opt-in when it cannot send. It refuses that save as a whole and stores nothing, so even an app tab opened before this release reads it as a failure rather than showing Push as on. The current app then saves the rest again without the opt-in, states that Push was not switched on, and re-reads the status. A wallet that already opted in keeps its choice, and delivery resumes once the rail is working again.

**The signing key may now post as a delegate of the channel (#1456).** The Push sender lives in one shared module that both Workers can use, rather than a copy inside the agent. An operator may set the channel's address beside its key; the key then signs as a delegate of that channel, so the channel owner's key need not sit on the Worker and a compromised signer can be removed by the owner without moving the channel. With no channel address set, the key signs as the channel itself, as before.

What the status covers is stated in the answer itself and on the card: it is the agent's rail, which sends payment reminders. The warnings when a loan gets risky come from the keeper, which still uses its own copy of the sender until it moves onto the shared module (that move belongs to the keeper work), so the card says this check does not cover them and suggests keeping another alert channel on for them.

Closes #2251. Closes #1456. Part of #2248.

_Committed 2026-10-22 21:03 UTC (3ef16b57d)._
<!-- assembled-fragment: 2251-1456-push-rail.md sha256=364271421597ccecf2924d24e024074b77311fbd5eb7bf4ab510e428e382bd86 -->

## Thread — one schema gate for every scheduled user of the shared database (PR #2635)

The indexer has held its scheduled work while the shared database was missing
a migration its build carries, so new code never met an older schema. The
agent had no such check, and the keeper machine borrowed the indexer's by
reaching into the indexer's source. The agent and the indexer both
auto-deploy on merge, through a dashboard deploy command the repository cannot
pin, so an agent build could go live before the indexer's deploy had applied
its migrations.

The gate and the list of shared migrations now live in the shared package. The
indexer, the agent's cron tick and the keeper machine's tick all use them. Each
declines by name while a migration is missing and resumes by itself once it
lands. The agent's HTTP routes are still not gated and must tolerate the
previous schema. The migrations directory stays the indexer's, and the
indexer's typecheck still fails if the list and the directory differ. The
recommended Workers Builds setting (deploy command `pnpm run deploy` for all
three) is unchanged; the gates are the backstop for a route that skips it.

Closes #2410.

_Committed 2026-10-22 09:42 UTC (9f54c89ea)._
<!-- assembled-fragment: 2410-shared-d1-schema-gate.md sha256=b69c5c71d4e97b851e3c0e04d019e21c1700c6f1d388f09b8f474eaca16b9e3a -->

## App — a refinance request says what it is, to the lender and to the borrower (PR #2668)

**A lender funding a refinance request is now told it is one (#2421).** A borrow request can be tagged with a running loan it asks to refinance. Accepting such a request does more than open a loan: in the same transaction it pays off and closes the borrower's running loan, with that loan's lender paid from the borrower's wallet. The new lender's loan, less the borrower's loan-initiation fee, is delivered to that same wallet first, so it can fund part or all of the payoff, with the borrower covering any difference. The guided review did not say so. It described the collateral as "They lock 100 tCOL" even when that collateral was already locked under the running loan and simply carried over. The review now names the loan being refinanced, says that accepting pays off and closes it, and says how that payoff is funded. It also describes the collateral from the request's own recorded decision: either the stake already locked under that loan carries over and is not a new pledge, or the borrower pledged a new batch and gets the old loan's collateral back when it closes. The app reads this from the chain. Until it knows, the review says it is checking, or that the check failed with a retry, and it cannot be signed. The running loan can change after a request is posted: it can be repaid or closed, or have collateral added, which breaks a carry-over request. So the review also runs the protocol's own acceptance check for the request, confirms it is the loan's currently recorded request (the only one that can be taken), repeats it while the review stays open, and runs it once more just before signing. If a repeat fails, the review goes back to "check failed" with a retry instead of showing the last answer as current. An offer that has been cancelled (which deletes it) is shown as no longer open, with nothing to sign, not as an ordinary borrow request. Each check reads everything it combines from the same block. When that check refuses, the review says the request cannot be taken right now, gives the reason, shows no receipt and offers nothing to sign. On a deployment without that check, the review says it cannot confirm the request is still takeable, and that a stale request fails on-chain with only the network fee spent. The offer list inside the guided flow now tags a refinance request the same way the Offer Book does.

**A borrower posting a refinance request is told it is not a guarantee (#544).** Posting a request changes nothing about the loan until a lender accepts it. The refinance form, its review and the standing request card (including while it is still checking the request's state) now say so: the loan keeps its due date and grace window, it can still default if no lender accepts in time, and the borrower should be ready to repay it themselves.

Closes #2421. Closes #544.

_Committed 2026-10-22 23:12 UTC (ff5ef728c)._
<!-- assembled-fragment: 2421-544-refinance-request-honesty.md sha256=7f390dd0794a7b7ee0f6b37e13c7b4f95050be12a328cf67fb940ea4f7638765 -->

## Thread — A buy offer used by a direct sale leaves the offer book (PR #2648)

When a lender sold their position straight into a standing buy offer, the
contract marked that offer accepted and retired its position record, but the
only event it published was the loan-sale event, which names no offer. The
indexer and the app's offer-book catch-up therefore kept showing the consumed
offer as fillable, and anyone who tried to take it got a revert.

The direct sale now also publishes the same offer-accepted event the ordinary
accept path publishes, naming the consumed offer, the selling lender, the
loan and the principal the buyer took over. Every consumer that already
retires an accepted offer (the indexer's offer status and the app's book
catch-up) handles a direct sale the same way, with no change on their side,
and the activity feed shows the offer as taken. The loan-sale event is
unchanged. (No inbox notification is sent for an accepted offer yet, by
either route; that is queued separately in the indexer's notification
list.)

Closes #2527.

_Committed 2026-10-22 12:40 UTC (6bc7dba8c)._
<!-- assembled-fragment: 2527-direct-sale-retires-buy-offer.md sha256=7c00557a028aa1ca3cb72099e006e0ec291b53d4093227747d863011cebd7605 -->

## Indexer and app — the Offer Book names refinance requests (PR #2661)

**A refinance request now says what it is on the Offer Book (#2528).** A borrower asks to refinance a running loan by posting a borrow request tagged with that loan. A lender who accepts it funds a new loan that replaces the old one. Until now the indexer kept no record of the tag, so on the Offer Book a refinance request looked exactly like an ordinary borrow request. The indexer now records which loan each request is for, and the Offer Book row says "refinance request: the borrower wants to move loan #N to a new lender". The label is translated in the nine translated languages.

**Unknown is kept separate from "not a refinance".** The market data now carries three states: the loan the request refinances, a recorded "not a refinance request", or not read yet. The last covers a row whose details the indexer could not read when it first saw the offer, until its repair pass reads them. The row shows the tag only when the request is known to be a refinance. An unread request is never presented as an ordinary one by a "not a refinance" claim. A schema change adds the column, and offers indexed before it are filled from each offer's own creation record in the activity ledger. Any offer without such a record stays "not read yet". The app's direct chain reads carry the tag as well.

Closes #2528.

_Committed 2026-10-22 17:45 UTC (2d56c9b0b)._
<!-- assembled-fragment: 2528-offer-book-refinance-requests.md sha256=d86807a7262a16851a3a18f16fc6857b82cd1124cb426cdd5fb046fcd78b414e -->

## App — guided matching, Approvals, Vault and review receipts state what they know (PR #2663)

**Guided matching recommends only offers the security check has answered for (#2535).** When a borrower or lender asks for matching offers, the app recommends up to five. Before this change, an offer whose token security check was still running showed with no badge at all, so an offer that would turn out to be flagged could sit in the list until the check finished. Offers past the first fifteen candidates were never checked and could be recommended unchecked. Now an offer whose check has not answered is shown in its place and marked "Checking", and it cannot be chosen until the answer arrives. If the check flags it, it drops out and the next offer moves up. Nothing beyond the checked part of the list is recommended. When flagged offers leave the list short, more of the list is checked, up to sixty offers. Past that, the list says more matching offers exist and links to the Offer Book, which lists every offer and marks those the security check warns about. Accepting an offer was already blocked until its check passed; this change makes the recommendation itself honest.

**Approvals and the Vault say when a position list came from the backup source (#2536).** The standing approvals card in Settings and the Vault page build their token lists from the wallet's own loans and offers. Those lists are read from the chain, with the indexer as a backup. When only the backup answered, the lists could lag by a few minutes, and both surfaces still presented their results as complete. They now keep showing what they found and add a note that a token or asset from a very recent position may be missing until the backup source catches up. On an older deployment where held offers can only be read from the backup source, and that source is also down, the note says instead that tokens from held offers of any age may be missing and to try again.

**Review receipts show exact amounts (#2537).** The review receipt for accepting or posting an offer is what the user consents to. Its amounts were rounded for display to a few decimal places, sometimes upward, and very long figures lost digits, so the reviewed figure could differ from the one signed. The receipt now shows every amount (principal, interest and collateral) exactly as the transaction carries it. Long exact figures wrap inside the receipt rather than being cut off. Lists and cards elsewhere keep the shorter rounded form, since nothing is being agreed to there. The other review surfaces (refinance, loan sale, offset, obligation transfer, early exit, the trading desk, rentals and VPFI) still round and are tracked in #2662.

The new copy is translated in the nine translated languages.

Closes #2535. Closes #2536. Closes #2537.

_Committed 2026-10-22 19:31 UTC (3850518a0)._
<!-- assembled-fragment: 2535-2536-2537-app-data-honesty.md sha256=70cb72f7db54458fad2d55e97b2d618a761ed5f7c1873e1fc072a5316c522630 -->

## Thread — Sanctions-hold alerts arrive as one digest per chain (PR #2632)

The keeper's sanctions-hold pass used to send each wallet's alert as a post of its own: one per wallet per condition (observation deadline at risk, held overdue, held with no observation chain, a reverted settlement, stuck staging), plus the chain-wide capacity and backlog alerts. A chain with hundreds of held wallets could fill the operators' chat with hundreds of messages a run. Each post could take up to ten seconds, so the pass had to reserve ten minutes at the end of every run for its alerts.

Each run now sends one message per chain. The chain-wide conditions come first, then the wallets grouped by condition. What one Telegram message cannot hold is counted per condition, and every line is written to the keeper's journal. Each condition still repeats every six hours while it holds, and stops once a fresh read shows it gone. A message that fails to deliver records nothing, so the next run sends it again. The digest's bookkeeping (which conditions are open, which were already sent, what this message delivered, what cleared) is one database statement each, however many wallets it covers, and the journal is written in parts small enough that no log platform cuts them. The same shared digest helper now writes every due line to the journal for every pass that uses it, so "each named in the keeper journal" is always true.

The ten-minute reserve is replaced by a tail sized from what actually follows the sends: re-checking unconfirmed transactions, re-reading the wallets the run touched, and one alert message and one notice message per chain. The re-read and the digest's database work now give up on a request still in flight when the run's time runs out, and a message that could only start after that waits for the next run, so the tail cannot overrun. No funds move; this only changes what reaches the ops chat and when. The pass is already armed on the testnets and its wording changes with this release.

Closes #2565.

_Committed 2026-10-22 04:14 UTC (afcb38880)._
<!-- assembled-fragment: 2565-sanctions-alert-digest.md sha256=051e517ed56827fa3567c5149eb1cb332cc38e5b8a38b82d8db2ad2e9253264c -->

## Thread — Retire the keeper "unscheduled" hold banners from the runbooks (PR #2634)

Several operator runbooks still carried the old warning that the keeper was
unscheduled, that "there is no next tick", and that it could be re-enabled only
through the Worker re-enable sequence. None of that has been true since the
keeper moved to its always-on machine and its Worker stopped running passes.
The banners are removed from the flash-loan liquidator rollout, the incident,
governance and deployment runbooks, the cron-slot inventory and the staging
plans. The checks they carried are kept and restated for the machine: the
five-point liquidation stand-down in the incident runbook's discount-path
section, the reward remittance coverage rule (all destinations covered at the
source, which still does not prove the mirrors were funded) together with its
reconcile-every-day rule, and the governance ceremony's handling of the master
and reward flags. Evidence now comes from the machine's journal instead of the
Worker log, a setting change is an edit to the machine's env file applied by one
procedure in the keeper machine runbook, and that runbook is the one place
that says how to start, stop and arm the keeper. That procedure restarts the
keeper only if it is already running, so a keeper someone stopped during an
incident stays stopped. It confirms the change from a tick that began after
the restart, because the lease line the runbooks used to cite is printed only
when the lease changes hands.

The flash-loan rollout no longer tells operators to set the keeper's
discount-path flag while the keeper ignores it. A line set early would switch
the branch on by itself at the restart after the fix lands, with nobody
watching. The staging plan's smoke-test and arming steps no longer stop or
restart the one keeper machine, which also serves the live testnets. The
watcher smoke test now raises a threshold above a loan's health factor, the
direction that sends an alert.

The staging plan and the staging-state checklist no longer tell operators to
arm the keeper, or give it its signing key and RPCs, on the keeper Worker.
Those settings are lines in the keeper machine's env file, and a Worker secret
arms nothing. The staging plan's key inventory now lists both places that hold
the keeper's signing key: the machine's env file, which the passes sign with,
and the Worker's unused binding. The watcher smoke test now applies the alert
credentials to a running keeper before it tests them. The flash-loan rollout now checks the contract owner against the
key the machine actually signs with, confirms the keeper restarted onto the
release that carries the new address, and checks that the discount flag is
literally `true`. The alert-key incident section now searches the keeper
machine's journal as well as the agent's logs.

The cron-slot inventory no longer holds a trigger in reserve for the keeper
Worker, because that Worker will not be scheduled again. The inventory itself
(docs/ops/CloudflareCronSlots.md) is the one place that states the account's
occupancy, and its account stamp is unchanged because no live read was taken. The Telegram and Push key rotations now also update the
keeper's machine, which never read those credentials from the shared store.

One gap in the code is now stated in the runbooks rather than hidden: the
keeper's per-chain flag that turns on the flash-loan liquidation branch is not
passed through to the pass that reads it, so that branch cannot fire on either
host whatever the flag says. This fails safe, but it means the flag-based
snap-off is currently a no-op. The fix belongs in the keeper code and is
tracked in #2633. Closes #2570.

_Committed 2026-10-22 04:59 UTC (16e6a4124)._
<!-- assembled-fragment: 2570-retire-keeper-hold-banners.md sha256=b7494eff4ff47bcf173d459f76cff9686e3959236616bf6440e258b2a17320eb -->

## Thread — EIP-7702 wallets get the vault reward default (PR #2639)

A reward claim from a person's own wallet lands in their vault by default, where it counts toward their fee-discount tier straight away; a claim from a contract gets a plain wallet transfer instead, as integrations expect. The test for "a person's own wallet" was "the address has no code". A wallet that has upgraded to a smart account under EIP-7702 carries a 23-byte delegation marker as its code, so it was treated as a contract and its rewards skipped the vault. The 2026-10-21 reward rehearsal found this on Base Sepolia, where the dev wallets are delegated; the same wallets on Arbitrum Sepolia are not, so the same person got a different venue on each chain.

An address whose only code is that delegation marker now counts as a person's own wallet, both for a direct claim and for a staged claim day that settles later. One shared rule decides it, so the two paths cannot drift. A real contract, including code that merely resembles the marker, keeps the wallet transfer, and the explicit vault or wallet choice works as before for everyone. Checks elsewhere that an admin-set address is a contract are deliberately unchanged, since a delegated wallet does run code.

The owner chose this on 2026-10-22. It reaches each chain with its next contract refresh.

Closes #2617.

_Committed 2026-10-22 07:37 UTC (e40abeebf)._
<!-- assembled-fragment: 2617-7702-wallets-vault-default.md sha256=5baf616555034c5d43bc1031b0516ffd2ea8a76ed252529b1f9c08a44244f556 -->

## Thread — Base keeps every chain's report; the list only decides what counts (PR #2645)

Base's reward aggregator used to refuse a day report from any chain not on its expected-source list. That one check was answering two questions. Who may report is already settled by the messenger, which authenticates every report. Whose figures count toward a day's total was settled anyway at finalization, which adds up only the chains listed at that moment. So the refusal protected nothing and lost real data. A report also carries what a chain says about itself (its custody era, its recycled availability, and the commitments it has retired or released), and a chain taken off the list before its last report landed had all of that thrown away. Base then kept showing those retired commitments as outstanding, and capped the repatriation that winds the chain down below what it actually holds (#2618).

Now every authenticated report applies what it says about its chain, on time or late. Its day figures are stored and count only if the chain is on the list when the day finalizes. That includes the recycled credit a report claims for the day: it used to be credited to the day's absorption the moment the report landed, so a report the day never counted could still help size the day's recycled reward budget. It is now credited when the day finalizes, and only for the chains that finalization counts. A report from an off-list chain is announced as stored and not counted, and if the chain is put back on the list before the day finalizes, its figures simply count, with no CCIP message to re-execute by hand.

The same change fixes how Base decides a day is complete (#2613). It used to compare a count of reports with the length of the list, so a report from an off-list chain could stand in for a listed chain that had not reported yet, and anyone could then finalize the day early. Completeness is now judged chain by chain over the list, and only a listed chain's report starts the four-hour grace window. Base also refuses an ordinary finalization while the list is empty or leaves Base out, since either would zero real interest for good. The admin force-finalize override is unchanged. The judgement lives in one shared library used by both the finalization call and the readiness view, and by Base's own report as well as the mirrors'.

Three related rules land with it. The admin setter for the list now refuses an empty list or one that leaves Base out, so the bad list the finalization guards against can no longer be stored at all (#2621). And a finalized day now keeps its own record of what it counted: the listed chains it zeroed, readable as a list, and whether any given chain's report was included in the total. Both are written once at finalization, so a later edit of the list no longer changes what readers are told about a past day (#2619), and a mirror whose report landed but did not count can now be told so (#2626).

The keeper reads both records. Its notice of a finalized day's zeroed chains now comes from Base's own record where Base keeps one, so a list edited after the finalization can no longer make it name the wrong chains. A mirror whose report landed but was left out is now told so. On a Base deployed before these records, or for a day finalized before them, the keeper falls back to what it did before, and says so as it did. The zeroed-chain record says whether the finalization wrote it, so such a day is never read as one that zeroed no chain. It takes a Base for an older one only when Base answers that it has no such record; a read that simply failed leaves the day for the next run, rather than settling it or recording a list-based answer for good.

This reaches chains with the next fresh deploy. The spec gained the rule "who may report is not the same question as whose figures count", and the code-vs-docs audit entries for both issues are marked resolved toward the spec.

Closes #2618. Closes #2613. Closes #2619. Closes #2626. Part of #2621 (the expected-list rule; the clock, route and report-shape rules stay open there).

_Committed 2026-10-22 10:54 UTC (e9d54573d)._
<!-- assembled-fragment: 2618-day-report-intake-and-record.md sha256=e4e6a73395afeb8c808ddc992aec4f57b0c223f943cb79ade3a4f31c7e00ca49 -->

## Thread — Day-close CCIP fee ceiling (PR #2631)

The keeper's reward day-close pass pays a CCIP fee on three kinds of send: a mirror's daily report to Base, and Base's broadcast of each finalized day, to every mirror or to one. Until now it paid whatever the reward messenger quoted, and the messenger's fee settings are governance-controlled. A fee set wrong, or by a compromised owner, would have been paid from the keeper's unattended key up to eight times per chain per run. No protocol funds were at risk, only the keeper's gas wallet, but the spend had no bound.

The pass now has a per-chain ceiling on what one send may pay, the plain setting `REWARD_DAY_CLOSE_MAX_FEE_WEI`. It takes comma-separated `chainId=wei` entries, plus an optional `*=wei` for every chain not named. Unset, it is 0.002 of the chain's native token everywhere, about 12 to 40 times the report fees read when the pass was armed. A quote above the ceiling is not paid: nothing is sent, the standing refusal alert names the call, the quote and the ceiling, and the day stays owed until the quote falls or the ceiling is raised. A setting that cannot be parsed pays nothing on any chain and is said by the held-steps alert, never replaced by the default. Calls that pay no fee, such as finalizing a day, are not affected, so Base still finalizes a day whose broadcast is held.

The check sits in the one place every send goes through, so no step of the pass can pay past it. It bounds only the keeper's own spending; anyone may still make these permissionless calls.

Closes #2627.

_Committed 2026-10-22 06:31 UTC (84e4faca7)._
<!-- assembled-fragment: 2627-day-close-fee-ceiling.md sha256=befa0da87eeffe87a1ba94e0bf404d0cc78c0f54edfcc648e53d5ca53e69b078 -->

## Thread — BNB Testnet gets faucet mocks and priced test assets (PR #2640)

BNB Testnet now carries the same faucet and oracle mock setup as Base Sepolia and Arbitrum Sepolia. Until now it had only one priced asset, so no priced loan could open there and nothing could test how BNB reports reward interest to Base. On 2026-10-22 the mocks were deployed and wired into the BNB Diamond: faucet tokens, mock price feeds and pools, rental NFTs and a mock swap adapter. Two test loans opened there the same day to exercise reward reporting.

Users will notice a change. Once the deployments bundle this records reaches the app, BNB Testnet's faucet stops showing "no test assets here" and offers minting, and the mock assets appear in the lending and borrowing pickers on BNB, as they already do on the other two testnets. The workers (indexer, agent, keeper) pick up the new addresses when this merges, and from then the keeper's close-out routing on BNB recognises the mock swap adapter, as it does on the other testnets. The app picks them up at its next deploy.

The Diamond's own configuration changed too, and the record says so rather than leaving it implied. The PancakeSwap v3 factory used for liquidity checks and the real ETH/USD feed were replaced by mocks, and a mock price registry was set where none had been. The PancakeSwap swap adapter stays registered, with the mock adapter added after it. The whole run, with its configuration transactions, is recorded in BNB's deployment ledger. The priority-routing perk was in fact already priced on BNB when this was written, which the next note corrects (#2641).

_Committed 2026-10-22 11:05 UTC (6b6522e19)._
<!-- assembled-fragment: 2640-bnb-testnet-mocks.md sha256=1ee8902b7bd2d1331198ba94bc5e99deee9430261f11535028454a849fde6e7c -->

## App — every review receipt and consent line shows the exact amount (PR #2664)

**The exact-amount rule now holds on every surface where the user agrees to a figure (#2662).** #2537 made the accept and post review receipt show amounts exactly as the transaction carries them. The other consent surfaces still rounded to a few decimal places, sometimes upward, so a reviewed figure could differ from the one signed. They now show the exact figure too: the refinance payoff, wallet top-up and payoff headroom; the loan sale's principal, approval bound and current cost; the offset's principal and completion bound; the obligation transfer receipt's cost lines and the replacement collateral; the early exit's proceeds to the seller; the trading desk's escrow, collateral lock, initiation fee, gasless-funds warning, signed-fill amounts and amend top-up; the rental receipts; the VPFI deposit and withdrawal receipt; the Full tariff quote and balance shortfall; the position page's figures and its receipts, including what a lender or borrower claim pays and the recorded-debt figures beside it; the Claim-everything checklist; and the pending-step cards for refinance, offset and loan sale.

A shortfall or minimum shown beside an input ("you need X more", "collateral must be at least X") is exact for the same reason: a rounded figure could be just below the real one, and a user who typed it would be refused. Browsing surfaces (offer lists, candidate rows, balances, the vault list, and the Claims and Positions rows that link to a loan's page) keep the shorter rounded form, since nothing is being agreed to there. The rewards claim card is unchanged in this release; it belongs to the rewards work.

Closes #2662.

_Committed 2026-10-22 20:19 UTC (44c630f34)._
<!-- assembled-fragment: 2662-exact-amounts-every-consent.md sha256=345dd21a25b482487e641b18f86d74d43aa9b7c18117c60b99dabd210a69c361 -->

## Thread — a distrusted oracle price refuses the close-out; Tellor dispute buffer (PR #2652)

A failed liquidation or a time-based default could treat a price the oracle sources disagreed about exactly like a price that did not exist. A missing price sends all of the collateral to the lender, so a brief disagreement at settlement could take a borrower's whole surplus — and give anyone able to provoke one a reason to. The oracle now reports three outcomes instead of two: priced, unavailable (no feed, or a stale or non-positive answer) and distrusted (Chainlink answered, but every secondary source that answered disagreed, or the Pyth cross-check of the ETH reference price diverged beyond its bound). A new read-only view, `getAssetPriceStatus`, returns which of the three a read is, and the existing no-revert price read is unchanged for everything that already uses it. Where a forced close-out would act on a distrusted price, it now refuses with the error that read raised and moves nothing, and it can be tried again once the sources agree. That covers the failed-swap fallback (either leg distrusted), the time-based default (when its choice between selling and handing over in kind rests on a distrusted price: the collateral's own, wrapped ether's included, or a quote asset's when only a route over that quote has the depth to take the floor; an empty or too-shallow pool does not count), the discounted liquidation and the keeper backstop's par check. A missing price keeps its rule: the lender takes all the collateral, and that rule wins when one leg is missing and the other is distrusted. Wrapped ether as collateral now passes the same own-price check as every other asset; before, the default classified it on the ETH/USD feed's freshness alone, so where its price read failed while that feed was still fresh, a distrusted price escaped the refusal and a missing one sent the default into price reads that revert, instead of the missing-price rule. This is the owner's decision of 2026-10-22, which puts the lender first and lets nothing settle on a price the protocol cannot trust. The cost is stated in the spec: while the sources keep disagreeing, the loan stays open until they agree again or governance removes a faulty secondary source. The keeper's default pass previews every default before sending it, so while the refusal holds it sends nothing and the loan is tried again on a later run; no keeper change is needed. The lender's close-out card in the app now asks the same settlement-time liquidity question the default uses, so while a price is distrusted it says it cannot tell yet instead of predicting an in-kind close.

The Tellor read now uses only a report made at least twenty minutes earlier, so a report made moments before, which nobody has yet had time to dispute, can no longer be the one secondary that agrees with Chainlink. Freshness is still measured from the moment of the read, so with the default one-hour bound a Tellor report counts while it is twenty to sixty minutes old. On a chain younger than twenty minutes, Tellor reads as unavailable. The buffer is a fixed value, not a governance setting. The soft quorum itself is unchanged (owner decision D14, 2026-10-16).

The new selector belongs to `OracleFacet`. Because the fallback, liquidation and claim paths now call it, OracleFacet must be refreshed together with FallbackCustodyFacet, RiskFacet and ClaimFacet, or those paths revert `FunctionDoesNotExist`. The curated `RedeployFacets` refresh carries the three consumers but not the oracle, so it now refuses a Diamond whose oracle is older, and the oracle is refreshed first with `UpgradeOracleFacet`. No testnet is refreshed now; every chain gets a fresh deploy once all waves are done. Closes #666 and #665.

_Committed 2026-10-22 14:47 UTC (f898dfb3c)._
<!-- assembled-fragment: 666-665-oracle-divergence-refuses.md sha256=da3368a0560c8c86a7ccc95538e0f4816df0622ea9ef4eceb57de1f61b94b77b -->

## Thread — an NFT rental repaid in grace no longer reverts (PR #2656)

An NFT rental repaid after its maturity but inside the grace period could
revert with an insufficient-prepayment error, leaving default as the only way
out. The repayment billed every day elapsed since the rental started that the
daily deduction had not yet collected, including the days past maturity, so a
rental whose daily deductions had not run kept accruing rent beyond the term
its prepayment funds. Once that rent plus the late fee passed the prepayment
and buffer, the close-out failed and the borrower lost the buffer to the
default path.

Rent is now never billed past the agreed term. A rental closed after maturity
owes at most its remaining prepaid days, which is its whole remaining
prepayment, and the time past maturity is charged only as the late fee, drawn
from the buffer as before. The owed days are counted by one shared rule, which
both the repayment and the handover of a rental to a replacement borrower now
use; the handover already capped at the term, so its figures do not change. In
term, nothing changes: a rental closed before maturity owes the days elapsed
since the last deduction. The lender receives the full remaining rent plus the
late fee, less the treasury share, where the reverted repayment used to push
the loan into default.

The repayment quote view no longer carries an unused copy of the rent
calculation; for a rental it still returns the late fee alone, since the rent
is drawn from the borrower's vaulted prepayment and not from the wallet.

Closes #901.

_Committed 2026-10-22 16:03 UTC (d0478addc)._
<!-- assembled-fragment: 901-rental-rent-capped-at-term.md sha256=00dd0a8628fe8fdf535e92d89343138b51ea629d25b73779aac2270ee62ecb46 -->

## Thread — concurrent ERC-1155 rentals no longer overwrite each other (PR #2657)

A lender's vault can hold several units of one ERC-1155 token and rent parts
of it to different borrowers at the same time. The vault recorded each
renter in a single slot per token, so a second rental of the same token
replaced the first renter's record, and repaying or defaulting either rental
cleared the record for every renter of that token. It also recorded every
ERC-1155 renter as holding one unit, whatever quantity was rented. No funds
moved wrongly, but the user rights the vault reports to integrations were
wrong for every concurrent rental.

Each ERC-1155 rental now has its own record in the vault, keyed by its loan,
carrying the loan's rented quantity. Starting, extending, handing over,
repaying or defaulting one rental changes only that rental's record; the
other rentals of the same token keep their renter, quantity and expiry, and
the vault's aggregate quantity and earliest expiry are computed across them.
This holds even when the same borrower rents the same token twice. ERC-721
rentals are unchanged: a token can be rented once at a time and keeps its
single record.

The rental update the platform publishes for integrators now names the
rental it changed, so a subscriber can tell concurrent rentals of one token
apart, including when one of them is revoked. One lender's vault now carries
at most 64 active rentals of one ERC-1155 token at once. Every change to a
token's rentals reads all of that token's records, so without a limit enough
concurrent rentals could make repaying or defaulting one of them cost more
than a transaction allows, leaving it unable to close. A new rental beyond
the limit is refused when it is accepted; rentals whose rights have expired
do not count, and closing or extending an existing rental is never refused.
An ERC-1155 rental offer whose quantity is larger than one rental record can
hold is now refused when it is created, before any units move, rather than
standing open with units no accept could ever record.

Every step of a rental now sets the renter through one Diamond route that
reads the loan for the vault, the token, the asset type and the quantity, so
no caller can pass figures that disagree with the loan. The two earlier
routes are retired. The accept now records the renter just after the loan
is created rather than before, since the loan is what the record is keyed
by.

Rollout: the change spans the vault implementation and every facet that
touches a rental, so it reaches a chain by a fresh deploy, or by the
all-facets refresh together with the vault-implementation upgrade, in one
paused window. Lenders do not have to upgrade their own vaults: the first
rental step that reaches a vault on an older version upgrades it to the
current implementation, so an accept, a repayment, a default or a handover
is never blocked on that. An older vault keeps an ERC-1155 rental's record
under its renter rather than its loan, and the new writes would never find
it, so the in-place refreshes refuse to cross this change while any ERC-1155
rental is open: such rentals are closed first, or the chain gets a fresh
deploy. Because a new rental could otherwise open between that check and
the refresh, the crossing runs only while the operator has already paused
the platform. The curated partial refresh refuses a Diamond
from before this change rather than leave a rental half on the old routes.

Closes #902.

_Committed 2026-10-22 23:12 UTC (a24081d12)._
<!-- assembled-fragment: 902-erc1155-rentals-per-rental-rows.md sha256=ec5d1396d0a9cc47fba3eec8759da0c9b24aa03ada6b7da4410b67b23a98dc81 -->

## Thread — the Timelock is now the only way to change who controls the protocol (PR #2642)

Owner decision D1 (2026-10-16) is now built. After handover the role root
(`DEFAULT_ADMIN_ROLE`) sits on the Timelock alongside Diamond ownership and the
delayed admin roles. Before this change the governance Safe held the role root
directly, which meant it could re-grant any Timelock-held role to a hot key, or
hand the whole Diamond to a new admin, in one transaction with no delay. The
48-hour review window was therefore advisory. Now every grant, every rotation
of the role root, every full admin handover and every facet or vault upgrade
waits out the Timelock delay in public (#934, #897, #909).

The governance Safe keeps one direct power, through a new emergency revoker
role: it can remove a role from a compromised hot key (a keeper, watcher or
pauser key) immediately, logging a reason. It cannot grant anything, cannot
remove the role root, and cannot remove any role from the Diamond owner, so a
compromised Safe can neither take governance nor disarm it. The Diamond owner
and the role root are also kept together: ownership can only move to a
non-zero address that already holds the role root, and the current owner can
never lose the role root (#906). That closes the old footgun where a
`transferOwnership` to the zero address bricked upgrades for good, or moved
ownership while leaving the role root behind.

The Timelock itself is hardened (#938). Its delay can never be lowered below
the value it was deployed with, so one queued operation can no longer turn it
into a pass-through. An independent canceller (the Pauser Safe) can veto a
queued operation, and is mandatory on mainnet. It cannot, however, cancel an
operation that removes itself as canceller: a proposer or another canceller
can. The handover also refuses a Timelock whose delay or permanent floor is
below 48 hours on a mainnet. Without that rule a
captured canceller could cancel everything, including its own removal, and
freeze governance for good. The price is that a captured proposer can remove
the canceller, though only after one public delay. Whatever it queues before
that removal runs can still be vetoed, so getting an operation past the veto
takes a second delay. The handover also now refuses a Timelock whose proposer
is not the same Governance Safe that receives the emergency revoker. The Timelock always administers
itself. The vault-implementation upgrade event now carries the new code's hash
as the record of what ran. It is emitted when the upgrade executes, so the
check during the delay is made on the queued operation itself: reviewers read
the code hash of the implementation address in its calldata. The audit
intake and the governance docs now say plainly that governance can move vault
funds through an upgrade, and that the protection is that such a change is
public and delayed, not that it is impossible.

Two operational consequences follow from putting the root on the Timelock.
Giving a role to a new key after handover, for example a replacement keeper or
watcher key, is now a Timelock operation and waits out the delay; taking a role
away from a compromised key stays immediate through the emergency revoker. And
on a Diamond refreshed in place rather than freshly deployed, nobody holds the
emergency revoker role until the root admin grants it, because only the
handover hands the role out, and a refresh does not re-run the handover. The
in-place refresh migrates no role state, so it now refuses, before deploying
anything, a Diamond whose owner does not hold the root role or where a
governance Safe named in the deploy settings holds the root directly. That is
the shape the retired pre-D1 handover left behind, and such a chain reaches
the new topology only through a fresh deploy.

The emergency revoker role is never granted at initialisation. Only the
handover gives it out, straight to the governance Safe, so no handover path can
leave it behind on the deployer's hot key. The Timelock's canceller is taken
from the same `PAUSER_ADDRESS` setting the handover uses for the Pauser Safe,
there is no separate setting to mistype, and the handover refuses a Timelock
whose canceller is not that Safe. The Timelock deploy requires that canceller
on every chain, testnets included, because the handover requires it everywhere;
a Timelock deployed without one could never be handed the Diamond. On any chain
that is not a known testnet both Safes must also be deployed contracts.

There is now one handover procedure. The two older scripts (a separate
"grant ops roles" step and "transfer admin to timelock") are retired: they split
the roles differently from the canonical handover, left the deployer holding the
unpause role, and did not know the new topology. The governance runbook, the
mainnet multisig setup guide and the Base Sepolia deploy guide now walk the one
procedure, and the Tenderly ABI files carry the new upgrade event and Timelock
constructor (#936, #650).

Operators: rename `DEFAULT_ADMIN_ADDRESS` to `EMERGENCY_REVOKER_ADDRESS` in the
deploy `.env` (the handover refuses the old name). Make sure `PAUSER_ADDRESS` is
the Pauser Safe before deploying a Timelock, and do not set
`TIMELOCK_CANCELLER` (the Timelock deploy refuses it). Nothing changes on the
live testnets until their next fresh deploy.

Closes #934, #897, #909, #938, #906, #936.

_Committed 2026-10-22 16:48 UTC (f6e799f93)._
<!-- assembled-fragment: 934-timelock-root-admin.md sha256=c691a1538f22a72a4035920667fbc658a55c8ce9fa7dcee55648d436996510f0 -->
