# Release Notes — 2026-11-16

The new app gains Auto-lend end to end: a lender can set up a standing instruction to keep lending when repaid, then add money, take back money not yet lent, change the limits, stop, or start again, with each step reviewed against the protocol's own dry run. The keeper drops its last unused copy of the old runner lease.

## alpha05 — change an Auto-lend's limits, or start it again

Each Auto-lend card on Positions in the new app now offers a change of its limits, and a stopped one offers to start again; an ended one can be given a later end date. Both open the setup's own form on the limits recorded now, so only what is typed changes: the most lent out at once, the smallest loan and the keeper-only setting keep their recorded values unless they are entered. Money may be added in the same transaction, behind the same exact approval as a setup; adding nothing is allowed.

The protocol replaces the recorded terms in place, so the review says what that costs, beside the protocol's own dry run from the wallet. The short wait before the next loan starts again, even for limits that are kept. A priority-routing opt-in is switched off, and the review says so, or says that it could not read it. Loans already made keep the terms they were made on. A most-at-once at or below the amount already counted against it is allowed, and stated: no new loan is made until enough of those loans end. A smallest loan above the most at once, or above the money that would wait to be lent, is refused before the dry run.

The finish card measures the step from the transaction's own logs, as a setup's does. The user guides in all ten languages describe the change and the restart.

Advances #3624 (epic #3180).

_Committed 2026-11-16 08:59 UTC (7c33b66ec)._
<!-- assembled-fragment: 3180-alpha05-autolend-change.md sha256=a289079cca8ce11ed13983e268507f7a7c6be63709f7f8b789668f039ea4c6f8 -->

## alpha05 — add money to Auto-lend, take back money not lent, and stop

Each Auto-lend card on Positions in the new app now offers the steps that fit where it stands: add money while it can still lend, take back money that is not lent while some waits, and stop it while it runs. Each step opens its own review, read at one block, which is the protocol's own dry run from the wallet and states every figure the step binds and what it means: money added above the most lent at once waits until loans end, nothing promises a fill, and a stop ends new loans at once while open loans run to their end.

Adding money needs a running Auto-lend that has not reached its end date, neither asset nor the protocol paused, and an approval of exactly the amount, which is put back if the step fails. Taking money back is capped at the money not lent; it stays open while one asset is paused but closes while the whole protocol is, and its route is stated the way a vault withdrawal's is, so with protected mode on the payment waits out the delay or stays in the vault. A stop on its own stays open even while the protocol is paused. A stop can also take back the money not lent; the two go in one batched transaction, so the Auto-lend is never stopped with its take-back failing alone. A stop that leaves nothing set aside ends the Auto-lend entirely, and the protocol drops it from the wallet's list; its finish card stays on screen, saying so, until it is closed.

Each finish card measures the step from the transaction's own logs and the token's moves between the wallet and its own vault. The user guides in all ten languages now describe these steps. Changing the limits and starting again follow in the next part of #3624.

Advances #3624 (epic #3180).

_Committed 2026-11-16 07:34 UTC (62a264311)._
<!-- assembled-fragment: 3180-alpha05-autolend-manage.md sha256=f22b8ebb857448de6d7eb966c2a1a8c88b439ca2f5332b76697c91fdadf80d6d -->

## alpha05 — Auto-lend setup on Lend, and Auto-lend on Positions

The new app's Lend page now asks one question after the pair: post a one-time offer, or keep lending when repaid. The second choice sets up Auto-lend, the lender's standing instruction to the protocol. The lender sets the amount, the lowest rate, the loan-to-value ceiling, the longest term, an optional end date and whether pro-rata borrowers are taken; Advanced mode adds the most lent out at once and the smallest loan. Every figure is parsed exactly, and the term is checked against the network's live maximum.

The review is the protocol's own dry run from the wallet, read at one block. It states every figure the setup binds, including the smallest loan resolved from the network's floor, the first time a loan is possible after the terms-age wait, and what is not promised: no borrower takes it directly, a matching service fills requests that fit, and nothing guarantees a fill. The end-date wording follows the lend-until design: no new loan is agreed to run past it. A risk-access step the protocol would check at each fill is offered before the setup, so fills do not fail later for it.

The terms and the money are sent as one transaction through the protocol's multicall, after an approval of exactly the amount, so the terms are never recorded without the money behind them. The finish card measures the outcome from that transaction's own logs and the token's move into the wallet's vault. Positions now lists each Auto-lend with what waits to be lent, what is lent now, its limits and whether it is lending, ended or stopped.

"Auto-lend" now means the standing intent everywhere in the app. The older auto-post-on-deposit switch, which nothing acts on, is renamed in the protocol console to say so, pending its removal in #3691. Adding money, taking unlent money back, changing the limits and stopping follow in the next part of #3624.

Advances #3624 (epic #3180).

> Caveat: managing an Auto-lend (add, withdraw, change, stop) is not in this part; the Positions card says so.

_Committed 2026-11-16 05:03 UTC (04afc171d)._
<!-- assembled-fragment: 3180-alpha05-autolend.md sha256=cb356e0ee7c258d5298717f9a05df9d2345951ce1793d0fcc40b8108116689b5 -->

## Old copy of the keeper's runner lease removed (#3550)

The keeper's one-runner lease, which stops a second keeper from running at the same time, moved into the keeper's own private database in #1722. The old copy in the database the indexer, agent and keeper share was kept for one release, so a keeper machine still on the older build could keep claiming its lease during the update.

The keeper machine now runs a build that claims only in its private database, and nothing else ever read the old copy. A drop-only migration removes it, so the shared database no longer carries a writable table with a misleading name.

Closes #3550

_Committed 2026-11-16 02:46 UTC (866110925)._
<!-- assembled-fragment: 3550-drop-shared-keeper-runner-lease.md sha256=372e6ebdb863564cd6fe2a8b92a6ade4611d8f8d638c9e6b13cac005e7ef54ae -->
