# Winding down a network (#3858, part 1)

Status: design. Nothing here is built. Part 2 of #3858 is the runbook section
and the launch check's rule, written by the governance thread from this
document.

## 1. Why this exists

`contracts/deployments/.active-chains` is the list of networks the platform's
off-chain parts know. The export script builds the consolidated deployment
bundle from it, so the app, the indexer, the keeper and the agent see exactly
those networks, and the daily launch check (#3824) is ruled to read the same
list. Removing a line makes a network disappear from all of them in one
commit. For a testnet that is a reviewed commit and nothing more. For a main
network it would take the app away from every owner who still has a balance
there, and the platform has no design for a wind-down: no state in which a
network stops growing while every open position runs to its end, no rule for
what must keep running until then, and no rule for what the list says once it
is over.

This document settles those rules. It covers one case: a network other than
the canonical one is retired on purpose, or has to stop opening positions
because of an incident. Retiring the canonical network would first need the
canonical role moved, which is its own design and is out of scope here.

## 2. What exists today

Read on `main` on 2026-11-20.

**The global pause** (`AdminFacet.pause`, the Pauser's call; `unpause` is the
Unpauser's). Under owner decision D2 (`GlobalPauseD2Design.md`) repay and
add-collateral stay open, and new positions, claims, withdrawals, liquidations
and defaults stop. The paused time is added to every loan's due date and grace
end. It is the right tool while an incident is being understood. It cannot be
a wind-down state: lenders cannot claim, nothing can default, and every
deadline moves out for as long as it lasts.

**The per-asset pause** (`AdminFacet.pauseAsset`, admin or Pauser to switch
on, admin or Unpauser to switch off). One seam,
`LibFacet.requireAssetNotPaused`, refuses the steps that create exposure to
one asset, and exits stay open. It is close to what a wind-down needs, with
three gaps. It is per asset and the asset set is open-ended, so it cannot
close a network. It refuses adding collateral and funding a loan's reserve,
which a borrower on a closing network must be able to do. And the in-place
extension of a loan does not ask it.

**Feature switches** (Auto-lend, the instant market, the internal match, the
backstop, auto-refinance, auto-extension and others). There is no switch for
the base offer book, and closing a network through a dozen switches would
leave the set to drift as features are added.

**The Terms rule** (`LibTerms`, #3734). Every step in which a wallet takes on
a new position asks one host, `LegalFacet.requireCurrentTerms`: loan creation
for both parties, posting an offer, setting an Auto-lend slot, a position
moving to a new holder through a platform route (a sale or a takeover), the
in-place extension, and an aggregator adapter's own check. A wallet that only
reduces or leaves a position is never asked. Receiving a position token by a
plain transfer is not asked either (`TermsAcceptanceEnforcementDesign.md`
section 3): that holder can claim and close, and cannot sell through the
platform into a wallet that is not current. The previews ask the same host
for a reason they can show.

So the platform already keeps, in one place, the exact list of steps a
closing network must refuse.

## 3. Three states

| State | What is true |
|---|---|
| **Open** | The network as it runs today. |
| **Closing** | No new position can be taken. Every position that exists runs to its own end on its own terms, and everything a close-out reads keeps running. |
| **Closed** | No loan is open. What remains is each owner's own: a vault balance, a claim not yet collected, an offer or Auto-lend capital the owner has not taken back. None of it needs a price, a swap or a keeper. Withdrawing, claiming, cancelling an offer and taking capital out of a slot stay available with no end date. |

A network moves from Open to Closing by one on-chain switch. It moves from
Closing to Closed by fact, not by a switch: the last loan ends. Closed is read
from the chain, and nothing is turned off on-chain to reach it.

## 4. The closing rule

**Rule.** While a network is Closing, no step may commit a wallet's money or
its standing consent to a new position there, whatever the wallet's Terms
standing.

**Where it is asked.** At the sites that ask the Terms rule today, through the
same host, as one question with two parts: the network is open, and the
wallet's Terms are current. The host keeps the Terms answer as it is and gains
the first part. No opening step gains a second call, and a facet near its size
limit carries the same call it carries now. One site is the exception: setting
standing instructions on a loan asks the Terms rule today, and in Closing it
must stay open, because a collateral top-up, an interest payment and a
repayment at the due date all help a loan end. That site keeps asking the
Terms part alone.

**What Closing refuses.** Posting an offer of any kind. Accepting or matching
one. Setting or funding an Auto-lend slot. An instant borrow. A step that
brings a new party into a loan, which covers a lender's sale and a takeover.
An extension of a loan in place, a refinance, and a continuation with another
lender. A flash loan, and a rate auction's opening and its bids, when those
are built. The backstop vault's lending is refused
like any wallet's: the Terms rule exempts that vault, and the closing rule
does not.

**What Closing leaves open.** Repaying, in full or in part. Adding collateral.
Funding or withdrawing a loan's reserves. Setting or clearing standing
instructions, and their runs. Withdrawing collateral that is surplus.
Cancelling an offer. Withdrawing from a slot and from the vault. Depositing
into the vault, which a repayment or a top-up may need. Claiming. Liquidation,
the time-based default, the periodic interest settlement and every fallback
step. The backstop's absorb of a loan in the fallback state, which is how the
lender on that loan is paid. The builder confirms that the absorb passes no
site that asks the closing rule, or allows it there by name. Reward claims.

**A lender's sale through the platform is refused, and that is a choice.** A
sale does not lengthen a loan, but the direct sale and the takeover spend what
another wallet set before the network began closing (a standing buy offer, an
Auto-lend slot's capital and consent), and a listing needs a buyer to accept
an offer, which is an opening step like any other. On a network closed for an
incident, a sale into standing capital would make that capital the way out
for whoever acts first. Keeping one predicate (a step that commits money or
standing consent to a new position is refused) is worth more than the
exception. The cost is stated to lenders: on a closing network the platform's
sale routes are closed. The sale-exit verdict reports the closing state for
both routes, so a listing is refused with its reason up front instead of
being posted where it can never fill (posting a sale listing is exempt from
the Terms rule today).

**A position token can still be transferred.** A plain transfer of a position
token passes no Terms site and is not refused in Closing or in Closed. The
token is its holder's property. The transfer hook's own checks still apply
(the wait after a payout, sanctions, the protected-account rules). Recovery
transfers and the tokens of finished loans, which carry claims not yet
collected, have to keep moving. A plain transfer commits nobody's standing
consent and moves no money on the platform: the receiver chose it outside the
platform, and as under the Terms rule can only claim and close. So the closing
rule stops the platform arranging a new party for a loan. It does not freeze
who holds a token.

**Who switches it.** On: the Pauser, at once, or governance through its delay.
Off: governance only. The shape is the per-asset pause's: quick hands may
switch it on and only slower ones may switch it off. It gives the platform a
second incident tool beside the global pause: stop growth without stopping
repayments, claims or liquidations, and without moving any deadline.

**What the chain says.** One view answers whether the network is closing and
since when, and the switch emits an event both ways. The previews report the
closing state as the reason an opening step would be refused, so the app shows
it before a wallet is asked to sign.

### Alternatives considered

- **Pause every asset.** The set is open-ended, and it refuses the two things
  a borrower must still be able to do.
- **The global pause.** It stops claims and defaults and moves every deadline.
- **Switch features off one by one.** No switch covers the base offer book,
  and the list changes with every feature.
- **A new check at every opening step.** It would duplicate the Terms rule's
  list of sites, and the two lists would drift.
- **Allow a sale during Closing.** It needs a second predicate for one case,
  and it would spend standing offers and slot capital on a closing network.
- **Refuse a plain transfer of a live position token too.** It would freeze a
  holder's own property during an incident, recovery transfers and the tokens
  of finished loans would each need an exception, and the receiver takes on
  nothing the platform arranged.

### Recommendation

One switch, asked at the Terms rule's sites through the Terms rule's host.

## 5. What happens to what is already open

- **Offers on the book** stay cancellable and can no longer fill. A lender's
  money in a slot is withdrawable as it is today. The app asks owners to
  withdraw, and nothing is moved for them. An offer or slot capital left
  behind does not hold the network in Closing (section 7).
- **Loans** run to their due date and grace on their own terms. Nothing is
  called in early.
- **Due-date plans** (auto-extension, auto-refinance, continuing with another
  lender) do not run, because each would open or lengthen a position. A
  borrower with a plan is told at the switch, on every channel they have, that
  the plan will not run and the loan is due on its date. Repaying at the due
  date from the reserve keeps working.
- **A rate auction in progress** is unwound and every bid is released, when
  that feature is built.
- **A loan in the fallback state** follows its own steps to the end. It has
  no date by which it must end (section 7).

The earliest day a network can be Closed is read from the chain: the latest
grace end among the loans then open, each read through the loan clock
(`LoanClockFacet.getLoanDeadlines`), which already adds paused time and the
window of a sequencer outage. It is published with the switch as the earliest
day, never as a promise, and the launch check reads it again every day. It
moves earlier as loans are repaid. It moves later if the network is paused, if
its sequencer has an outage that reaches a deadline, or if a loan enters the
fallback state.

## 6. What must keep running until Closed

Nothing a close-out reads is retired while a loan is open. That means the
price feeds and the price guard's settings, the swap adapters and their
liquidity, the sanctions list, the keeper passes that back a permissionless
close-out step (liquidation, the time-based default, the periodic settlement,
the standing-instruction runs, the hourly price checkpoints, position upkeep),
the indexer, the alerts and the app.

Two facts make this strict. When a price is missing, a fallback gives the
lender all of the collateral, so a feed removed early changes who gets what.
And a forced sale whose routes all fail ends in the in-kind fallback, while
one with no route enabled is refused outright. If a
feed or a route is going to disappear for reasons outside the platform, its
date is announced as soon as it is known, with what changes for a loan still
open on that day.

Keeper passes that open positions (the matcher, the backstop fill, renewals)
are disarmed for the network at the switch. They would be refused anyway.

## 7. The Closed state

A network is Closed when all of these hold, read from the chain:

1. The closing switch is on.
2. No loan is Active or in the fallback state.
3. No close-out step is waiting on a price or a swap. The builder confirms,
   per claim path, that a claim on a finished loan reads neither.

**An offer or slot capital left behind does not block Closed.** Only its
owner can cancel an offer that has no expiry or take capital out of a slot,
and nothing is moved for an owner (section 12), so a test that waited for them
could wait for ever. It does not need to wait. On a closing network an offer
can never fill and a slot can never lend, so each is only the owner's own
balance under the owner's own hold. Cancelling and taking capital back stay
available with no end date, the closed view lists them from chain reads, and
the builder confirms that neither path reads a price, a swap or the indexer.

**A loan in the fallback state does block Closed, and it has no dated end.**
It ends when its lender claims, when its borrower cures it, or when the
backstop takes it at the lender's request, and a cure returns it to an open
loan, so everything in section 6 keeps running for it. No step on `main`
ends an unclaimed fallback by a date. One lender who never claims can
therefore hold a network in Closing. This document does not settle that: it
is a question for the fallback's own design, carded from section 13.

After that:

- **Withdrawing, claiming, cancelling an offer and taking capital out of a
  slot stay available with no end date.** The contracts are not removed,
  governance keeps ownership so a problem found later can still be handled,
  and no upgrade may take those paths away.
- **The app keeps a closed-network view**: connect, see the vault balance,
  uncollected claims and any offer or slot capital still held, from chain
  reads alone, and withdraw. It does not depend on the indexer. The network
  stays in the deployment bundle for this (section 9).
- **The indexer's rows for the network are kept**, not purged, so statements
  for past years can still be produced. The indexer stops reading the chain.
- **What the platform itself holds there** (treasury balance, the reserve,
  the backstop vault, the keeper wallet) is returned to the treasury wallet.
  The reserve is returned only after the last loan it could have paid toward
  has ended and its claim has been paid or has lapsed under the reserve's own
  rules.

## 8. Other networks

- **The platform token.** The app stops offering a transfer of the platform
  token into the closing network at the switch. The lane itself stays open in
  both directions, because the platform's own reward budget travels on it
  from the canonical network for every day the closing network still earns
  (`RewardRemittanceFacet.remitRewardBudget`, credited there by
  `RewardRemittanceReceiver`). The lane closes inbound only after the last
  reward budget has been delivered. A holder who sends tokens in by another
  route during Closing can send them out again while the lane exists.
  Transfers out stay open for as long as the lane exists. If the lane's
  operator retires it, tokens left on the network cannot move, and that date
  is announced as soon as it is known.
- **Rewards.** Fees keep arriving during Closing, so the network stays a
  reward source until Closed, and its reward budget keeps being sent to it.
  It is then removed from the expected sources at a day boundary, after the
  budget for the last day with activity has been delivered and could be
  claimed. The removal already has its own release steps (#2963).
  The reward builder confirms the order.
- **Messages in flight** in either direction are delivered or re-executed
  before the lanes' own contracts are paused.

## 9. Off-chain record

`.active-chains` decides which networks the app, the indexer, the keeper and
the agent know at all. That makes it the wrong place to record a wind-down: a
network that left the list would vanish from the app while owners still hold
balances there.

- **A main network that has opened to users stays on the list for good.**
  Winding it down changes its state, never its presence. A testnet may still
  be removed in a reviewed commit, as today.
- **The state has two sources, one for each fact.** Closing is the chain's
  fact: every consumer reads the closing view, and nothing off-chain records
  it. Closed is recorded in the network's deployment record, in a reviewed
  commit made after the test of section 7 passes on the chain, because it is
  the moment the indexer and the keeper stop reading the chain and they need a
  fact that does not come from it. The bundle carries that record to every
  consumer.
- **Each consumer acts on the state and never on a list of its own.**

  | Consumer | Open | Closing | Closed |
  |---|---|---|---|
  | App | As today | The closing notice, and the screens that open positions are replaced | The closed view |
  | Indexer | Reads the chain | Reads the chain | Stops reading and keeps its rows |
  | Keeper | Every armed pass | The passes that back a close-out step | None |
  | Alerts | As today | As today, and the notices of section 10 | None |
  | Launch check | The full check | The full check, the closing switch expected on, and each day the count of open loans and offers and the earliest Closed day | The closed check: the switch is still on, ownership is unchanged, and the withdrawal, claim, cancel and slot-withdrawal paths are still routed |

- **A closed record the chain contradicts is an alarm.** If the record says
  closed and the chain shows the switch off, or a loan open, the launch check
  fails by name: positions would be open with no keeper behind them.
- **Reopening runs in the reverse order.** The record is set back to open
  first, so the indexer and the keeper are running again, and only then does
  governance switch closing off.

## 10. What users are told

**A planned wind-down** is announced before the switch. The recommended
notice is at least 30 days, so a borrower whose plan would have renewed a
loan has time to arrange repayment. From the announcement, every screen for
that network and every loan and offer on it shows the date new positions
stop, and every wallet with an open position or a plan gets the notice on
the channels it has linked. At the switch the screens that open positions
are replaced by the closing notice, each loan shows its own last day, and
the network's earliest Closed day is shown as the earliest day.

**An incident** has no notice. The switch is the notice, sent at once, and a
borrower whose plan was about to run has the loan's grace period to act.

Copy states facts and dates only. It does not say or imply that a balance is
at risk because a network is closing, and it does not point a user to any
other network or product.

## 11. Order of steps (outline for the runbook)

1. The owner's decision, recorded, with the announcement and its dates.
2. The switch, by governance on the announced day (or by the Pauser in an
   incident). Opening keeper passes are disarmed for the network. The app
   stops offering transfers of the platform token into it.
3. Closing runs. The daily check reports open loans, open offers and the
   earliest Closed day.
4. The Closed test passes on the chain.
5. Rewards: the budget for the last day is delivered, then the network
   leaves the expected sources and the token lane closes inbound.
6. The platform's own balances are returned to the treasury wallet.
7. The deployment record is set to closed in a reviewed commit. The indexer
   and the remaining keeper passes stop for the network, and the app serves
   the closed view.
8. The network's line stays on `.active-chains`, and the launch check moves
   to the closed check.

Signers, proposal text and readbacks for each step are the runbook's.

## 12. What is deliberately not done

- No loan is ended early and no position is moved to another network.
- No date ends the right to withdraw or to claim.
- No balance is swept on a user's behalf.
- No main network that has opened to users is taken off the list of networks
  the app knows.

## 13. Work this creates

| Piece | Owner |
|---|---|
| The closing switch, its view and event, asked through the Terms host | A contract builder, one card |
| The rate auction and the flash loan ask the same question | Their builders |
| Runbook section, the launch check's rule, the `.active-chains` header | Governance thread (#3858, part 2) |
| Network state in the deployment record and the bundle (the export script, the `Deployment` type) | Governance thread with the app-fixes thread |
| Closing and closed views, and the notices | App threads |
| Pass sets for a closing network | Keeper thread |
| The order for leaving the reward sources | Reward builder |
| Whether an unclaimed fallback gets a dated end | Design thread, its own card |
