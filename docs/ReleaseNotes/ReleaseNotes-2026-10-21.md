# Release Notes — 2026-10-21

Today forced sales began to measure what they actually sold and received. A route that sells less than it was offered, or delivers less than it reported, is undone on its own and the next route is tried, and every sale is booked at the measured figures. That change has not reached the testnets yet: testnet refreshes wait until the current waves of work are done. Base now records the remote messenger each reward-budget remittance was bound to, and the keeper reports a remittance that was sent to a mirror since replaced. A new keeper pass closes, finalizes and broadcasts each reward day by itself. It ships switched off, so nothing runs until an owner arms it. The old shared copies of the keeper's five tables were dropped, now that the keeper's own database holds them.

## Thread — Forced sales sell exactly what they offer (PR #2609)

Every swap the protocol makes now measures what actually happened rather than
trusting what the route reported. Before this change, a liquidation route that
sold only part of the collateral was booked as if it had sold all of it. The
unsold part stayed in the protocol's balance with nothing recording whose it
was. Proceeds were also booked at the figure the route reported, even when
fewer tokens arrived. Now, on every forced sale the protocol checks two things
itself: how much collateral left its balance, and how much of the proceeds
reached it. The sale is then booked at those measured figures, so proceeds a
route under-reports are credited to the loan rather than left in the
protocol's balance with no record of whose they are. The forced sales are Health-Factor liquidation (full, partial and
split route), time-based default, periodic-interest auto-liquidation, the
lender's fallback retry, and treasury asset conversion.

A route that sold less than it was offered, or delivered less than it
reported, is refused and undone: its partial sale is reversed and the next
route in the caller's list is tried in the same transaction, just as for a
route that failed outright. Each route now runs in a step of its own inside
the transaction, which is what lets one route's sale be reversed while the
next is tried. When no route sells the whole amount, each path's existing
handling applies unchanged: a liquidation or default enters the in-kind
fallback, which pays the lender first.

This follows the platform's lender-first principle for liquidations, decided
by the owner on 2026-10-20: the lender is paid as fully as the market allows
before the borrower receives anything. A partial sale must never leave unsold
collateral that could reach the borrower while the lender is still owed. The
refused route falls through rather than stopping the whole transaction so that
a stale quote cannot halt the routes behind it. Otherwise a borrower adding a
token's worth of collateral before each attempt could make every quote stale
and stall the liquidation indefinitely. A split-route liquidation, which
divides one sale across several venues at once, stays all-or-nothing: a short
leg reverses the whole split and the liquidation stays open to the ordinary
route list.

Swap-to-repay is the one swap that may still sell less than it is offered,
because the borrower is repaying and the offered amount is only an upper bound.
It now uses the measured spend from the same shared rule, and unsold collateral
stays pledged in the borrower's vault as before. The three swap adapters
(aggregator, Uniswap V3, Balancer V2) now hand back only what their own call
did not spend. Before, they returned their whole balance of the input token.
Under the new rule, a stray token transfer to an adapter would then look like
unsold collateral and make every exact sale through it fail.

Operators: the step that runs each route is a new Diamond component, so every
testnet Diamond needs the normal facet refresh (the all-facets refresh carries
it) before the refreshed liquidation and default code runs. A Diamond that
routes the selling facets without it stops with a named error rather than
treating every route as failed. The BNB testnet Uniswap V3 adapter needs
redeploying and re-registering to pick up the adapter change. Base Sepolia
and Arbitrum Sepolia use the test adapter, which already sells the full
amount. Closes #2472.
<!-- assembled-fragment: 2472-swap-exact-spend.md sha256=adda3b3263d12b176426d111c4a6f9b0b7371d6fcca6d76d45a087633966a4c7 -->

## Keeper — retire the old shared copies of its five tables (PR #2611)

The keeper moved its operational state to its own database in October
(#2450). Five of those tables (health-factor band state, the commitment
scan and day records, and the remit acknowledgement log and frontier) had
started out in the shared database. A one-time copy moved their rows on
2026-10-18. Since then the shared copies have been dead state: nothing
writes them, and the only reader left was a check that watched them for a
legacy keeper still writing there. That check ran on every keeper tick and
in every keeper deploy. It could not see a legacy keeper that only deleted
rows, and because it read all five shared tables on every tick, any one
failed read among them skipped the whole tick.

This change retires the copies instead of watching them. A new shared
migration drops the five tables, and nothing else. It is safe whichever
keeper build is serving when it lands: the previous build already treated a
missing table as retired. The copy script and its checks are removed. The
keeper's deploy now applies and verifies the private migrations and then
verifies the shared schema, as before. The machine's per-tick gate checks
only that the private migrations are applied. The copy's completion record
stays in the private database as history. Nothing reads it.

What still keeps a second keeper out is the one-runner lease. The cutover
check was only ever defence in depth. Rolling back to a keeper build that
reads the shared copies is no longer possible, because the tables are gone.
The runbook's cutover section now records what happened and where the
procedure went. Closes #2560.
<!-- assembled-fragment: 2560-retire-shared-keeper-tables.md sha256=8693d1f8471fbef6ad88f5d62000bb4c1335f9a6856fc9c6070595a6fd6c2d31 -->

## Rewards — every remittance records where it was sent, and the keeper reports one sent to a replaced mirror (PR #2607)

A reward-budget remittance waits on Base, reserved, until the destination
mirror acknowledges it, and the keeper sends that acknowledgement once the
mirror shows a receipt. If a mirror is redeployed on its own with a new
messenger and Base's lane re-pointed at it, a remittance sent before that
executes, if at all, behind the old messenger. The new mirror never holds its
receipt, so the keeper waited for
it forever and nothing said so. No live case exists today, but BNB Testnet was
redeployed on its own on 2026-10-18.

Base now records, for every remittance it sends, the remote messenger the
message was bound to, which is the one adapter on the destination that can
ever execute it. A new read returns that record beside the adapter the lane
names now. Only the adapter is recorded because it is the whole route: the
destination adapter hands the message to whichever receiver it has registered
when the message executes, so a receiver replaced behind the same adapter still
receives it, and a replaced adapter never will. A remittance is refused, before
any value moves, when the destination has no remote messenger declared, and the
fee quote refuses it by the same rule, so every remittance leaves with a route
Base can name. The keeper still acknowledges any remittance whose receipt the
configured mirror holds. Each run it now reads the receipt of every
reservation in that run's slice, which is up to 200 in-flight reservations and
300 released ones, rotating through any larger backlog over later runs. It
works the two kinds side by side. Each kind's alerts go out as soon as that
kind is classified, alongside its acknowledgements, and the released backlog
never holds up the in-flight acknowledgements, which keep first call on the
run's send budget. Its reads stop early enough to leave the acknowledgements
time, and a destination whose read is still unanswered then is left unread
for that run rather than waited on. Where a run can read only part of a long
list, it starts each run at a different point, so the same reservations are
not the ones left unread every time. Each destination's fees are quoted
beside the others' before anything is sent, and a quote still unanswered
shortly before the run's deadline is given up for that run. Only an
acknowledgement whose fee was quoted takes one of the run's sends, and the
sends are handed out round the destinations in turn, in-flight ones first and
released ones with what is left, so a slower destination, or one whose quotes
fail, never takes or holds another destination's share. Each destination's
acknowledgements then go out in their own lane, beside the others, so a
broadcast stuck on one destination holds up only that destination. So neither a backlog, nor a slow
destination, nor a slow send, nor a slow alert channel can hide a remittance it
cannot make or hold up one it can on another destination. An alert is still sent when the keeper cannot read its record of
open alerts, or its record of past acknowledgement attempts; in that second
case the run sends no acknowledgements, since that record is what paces them.
A remittance whose receipt the keeper cannot read is reported as one it can
neither read nor acknowledge, rather than dropped with a log line, and its
route is still read from Base and stated. That covers a chain the keeper has
no RPC or deployment for, and a chain whose Diamond answers the receipt read
with an error, such as a deployment entry naming a Diamond without that read;
the alert says which. If that route is a retired adapter, it is reported as
the retired case, since fixing the destination would not reach a receipt
behind the old adapter. The keeper's first reads of Base's ledger now stop
early enough to leave the rest of the run time, and a ledger read that fails
or does not answer in time, or a failure to read the keeper's own record of
where its scan stands, no longer stops the released backlog from being
classified and acknowledged that run. A ledger scan cut short works the
reservations it did read and resumes at the first one it did not, rather than
starting the same window again from scratch; a first stretch it cannot read at
all is passed and read again on the scan's next round, rather than holding
every later run at it, and the record of how far the ledger is settled never
passes an unread reservation. The runbook's recovery step that
restores a retired adapter now requires the remittance automation to be
switched off first and held off until the redeploy's values are back, since
Base sends everything to that chain through the same record. A reservation with no
receipt is reported to ops, never left waiting in silence, in two cases. The
first is a remittance sent through an adapter the lane no longer names. The
second is a Pending remittance still without a receipt more than 8 hours after
its send, the window after which CCIP needs a message executed by hand, whatever
its route. For that one the alert says the cause is not known to the keeper:
the message may be waiting for manual execution, or it may have executed at a
receiver since replaced behind the same adapter, which the route record cannot
see. One post per run covers every remittance of a kind, however many there
are. Each is listed with its destination, its age, the adapter it was sent to
and the one the lane names now (or that Base has no record of it), the CCIP
message id and the amount. A released remittance also shows what it still
waits on: its stranded share, the fact that the share is not stamped yet, or
the compensation gate it holds. When the gate could not be read that run, the
alert says whether it holds the gate is not known, and the keeper sends no
acknowledgement on that unread value. The post says that settling it is an operator
decision. For a Pending remittance that means manual execution, finalizing it only
when the destination receipt shows it consumed (forced finalization records
consumption with a zero received figure and clears any compensation gate, so a
quarantined or provisional receipt is acknowledged from its Diamond instead),
or releasing it when it will never execute. For a released
one, a late acknowledgement or a recovery record. Each alert re-posts daily
and clears once its remittance is settled, its receipt appears or its reason
no longer holds. The deployment
runbook's drain section now says what to do.

Base's cross-chain trust is unchanged: it still accepts acknowledgements only
from the lane's current peers. Recording the route is what makes the case
visible; it does not, and should not, let a retired mirror's acknowledgement
through. The contract half reaches a chain by fresh deploy (owner decision
O1 = A). That is the deploy policy, not a runtime dependency: the remote
messenger is read from the messenger's existing public getter, which every
deployed messenger already answers. A Base Diamond deployed earlier records no route, and the keeper treats its
remittances as route unknown, exactly as before. Closes #2561.
<!-- assembled-fragment: 2561-remit-route-record.md sha256=bf981b4bc18c0250015fdfc3ea5dff9d21492b3445c1a4bfe6fbc055d02c1381 -->

## Keeper — reward days now close, finalize and broadcast by themselves (PR #2616)

The cross-chain interaction-reward cycle needs three permissionless calls every UTC day: each chain reports the day's interest (`closeDay`), Base finalizes the day once every expected chain has reported or the grace window has run out (`finalizeDay`), and Base broadcasts the finalized totals back to the mirrors (`broadcastGlobal`). Until now nothing made those calls on a live chain; the keeper's simulations made them by hand. A launched reward programme would have sat with every day open: mirrors unreported, nothing finalized, nothing for the remit pass to fund, and nothing mirror users could claim.

A new keeper pass, `rewardDayClose`, makes them. It runs every 15 minutes on every reward chain and works every elapsed day not yet worked through, however late it is first armed or however long the keeper is down, plus at least the last 14 days. Days stuck longer are worked a bounded number per run, each in turn, after the recent days, so a stuck day never takes the sends a recent day still inside Base's grace needs.

**Nothing irreversible is done on an assumption.** A close stamps a report sent for good, and a finalization is final, so each waits while any of its preconditions is unknown, and the ops channel is told what it is waiting on. One standing alert per chain names every held step and why, taken from the same judgement that holds it, so no hold is silent; it also says when finalized days are not broadcast because a list cannot be read:

- every reward clock involved must be known to start at the same moment as Base's (a day number has to cover the same hours everywhere). A clock that differs holds closes and finalizations, and so does one that is not known: never read, read from a Diamond the chain no longer names, or on a chain the keeper does not serve;
- the whole channel a mirror's report travels must read, on both ends and in the same run, as wired to accept it: the mirror's messenger sends to the chain its Diamond names as Base through a transport that carries its channel, sends on Base's own CCIP lane and names Base's transport, and on Base that transport attributes this chain's CCIP lane to this chain and accepts this chain's messages and channel from this chain's transport and messenger, and delivers them to Base's canonical reward messenger, which forwards them to Base's Diamond. A report is sent once and its fee paid even when the far end would refuse it, so a link that is wrong or unread holds every close, and the alert names the link. Each chain's CCIP lane is checked against the selectors the deploy scripts configure, from one table in the shared contracts package that a test pins to theirs. That chain must also read as the canonical reward chain in the same run (a role can change, so it is never taken from an earlier read, and a keeper that does not serve Base closes no day);
- Base's expected-source list must be readable, non-empty and include Base itself, and coverage is judged chain by chain, never by counting reports;
- a mirror that would send an older report shape sends none for a day Base has finalized, could finalize now, or whose finalization it cannot read, since Base would refuse it after the fee is paid. The shape is read from both ends of the send: the messenger must take the newer shape, and the mirror Diamond's own reporter must send it (a newer messenger also takes the older shape an older reporter sends). While the reporter's shape cannot be read, it counts as the older one.

On a mirror the pass pays the messenger's own quote for the report fee (the messenger refunds any unused part), and still reports a day Base has already finalized, since Base keeps the chain-wide figures that report carries. It says when the mirror is missing from Base's expected-source list, since Base then refuses every report it sends (#2618 tracks letting a detaching chain's last report through).

On Base it broadcasts each finalized day to every mirror it is owed (the current destination list, every mirror on the expected-source list, any destination the day has had, and any chain it serves or has sent to that the contract says has standing in the day), confirms delivery by reading the mirrors it serves, flags one still missing after two hours, and re-sends after six to the mirrors still lacking it only. What a send reached is read from the messenger's own events in the receipt, not from the list as read before sending. A send whose receipt was not seen counts as sent, so it is never paid for twice inside the re-send interval; one the node refused outright is not. A day's broadcast is done only when every send it is owed is confirmed, never because one of them landed. The notice of a day finalized with chains missing names the chains from the finalization's own events, so a later change to the expected-source list cannot change it; a day the keeper never saw open is judged against the list and marked so. While the keeper cannot read its own record of having seen a day open, it makes no notice for that day and says so, so a day it saw open is never judged as one it did not.

The pass works a chain only on that chain's own facts. Each run first reads its reward role, current day, pause state, reporter configuration and reward clock, and checks that the Diamond its RPC reaches names itself the chain it is configured as (an RPC pointed at another chain, where a Diamond sits at the same address, would otherwise be worked as this one). If any of that fails, nothing on the chain is worked or judged, and one alert says so. Every other chain it reads is checked the same way, and one that fails is treated as unreadable for that run, never as unserved. A Diamond moved in place between canonical and mirror operation, a mirror rebound to another Base, or a mirror whose Base Diamond was replaced, is worked afresh in its new role (a report already sent to the old Base is never taken as delivered to the new one); the old work's open alerts are closed with a notice. When a chain's Diamond itself is replaced, the keeper's deployment reset, which clears every open ops alert of that chain, now first posts one notice naming the alerts it closes, so no condition an operator was told of disappears without word. On Base a day leaves the owed list only once the lists read again, just before settling, as its broadcast was judged against, so a destination added mid-run is still sent the day. A Diamond without the single-destination broadcast falls back to the send to every destination. Such a Diamond can neither say whether a chain on neither list is owed a day nor reach it, so the pass keeps every such chain it knows of as owed and says so, until the chain is listed or the Diamond is upgraded. A mirror keeps a day owed until Base has finalized it, since a report Base has counted is still left out if the chain leaves the expected-source list first; whether a landed report was counted into a finalized day is not readable on Base yet (#2626), so nothing is said either way about such a day.

The pass sends nothing while one of the keeper's own transactions is still unmined, so a close or finalization whose receipt was not seen is never sent a second time behind it. A day a failed read keeps from being worked is named in the standing alert, with what could not be read (the announcement of a finalized day's zeroed chains included), and so is a run that stopped sending on a fault that repeats (no signing key, a send the node refused such as for want of gas or the CCIP fee, a receipt not seen, an RPC that does not answer), until a run sends without it.

**Every alert lives by one judgement.** Each run judges every alert it raised and every one it would raise, from what that run read: raised while its condition holds, closed only when a read shows it gone, left standing while nothing read settles it. A day stays on the owed list while an alert on it stands or a due one is undelivered. A statement of something that cannot change (Base finalized a day without this chain; a report that left through a messenger rotated in after the checks, where the keeper cannot read Base) holds its day only until delivered. An alert that can never be judged again here, because it is about a chain the keeper no longer serves, is closed with a notice saying why and where to look, and so is every alert of a chain that leaves the reward set, or that the keeper is no longer configured to serve, or about a Diamond the chain no longer names (an alert belongs to its Diamond, like the record of owed days). The old Diamond's alerts are closed from the keeper's configuration, so they close even while the new Diamond's own reads keep failing.

The shape and channel checks are reads before the close, which sends through whatever messenger the Diamond holds when it runs; a rotation in between cannot be prevented by a keeper. The pass reads each close's receipt and says so when the report left through another messenger. Binding the clock, route, shape and expected-source checks to the calls themselves is a contract change, tracked in #2621.

The pass keeps its state only in the keeper's private work queue, so it needs no migration. The reward messenger's and the CCIP transport's ABIs are now exported as standalone contracts, so the keeper prices fees and reads the report channel from compiled ABIs. The pass is split into small modules (reads that return known or unknown, a pure planner, one store, one alert judgement), so each rule lives in one place.

The pass ships switched off, behind `REWARD_DAY_CLOSE_ENABLED` (on top of `KEEPER_ENABLED`), and needs the owner's OK to arm. The two-chain Anvil simulation now runs the daily close through this pass instead of making the calls itself. Closes #2612.
<!-- assembled-fragment: 2612-reward-day-close-pass.md sha256=f428541f637fc984b27083e7354b20a0c93d430c69dff16b24b9242fb3650a7f -->
