# The activation ceremony's ordering rule is a convention, not a guarantee

Part of the ongoing review of the activation procedure for the recycling
programme (see the M7 runbook triage).

The procedure tells an operator to send each chain its funding, wait for each to
confirm arrival, and only then announce the cutover day — because the
announcement is what opens the door for users to claim, and the funding is what
makes claims succeed. Doing it the other way round opens claims against funding
that has not arrived — and while the outstanding fund-safety item is undeployed
on a chain, that is not a harmless failed claim but a payout measured against a
balance that includes collateral belonging to borrowers.

The step that announces the day, though, can be triggered by anyone. It is
restricted to the main chain, not to the operator — the check is about which
chain the call arrives on, not who made it. So between the moment a day is
finalized and the moment the last chain confirms its funding, any account willing
to pay the messaging fee can announce it, and every claim gate opens early. No
amount of care on the operator's part prevents that, because the ordering was
never theirs to enforce.

The first attempt at a remedy was to remove the window by re-ordering the
ceremony — doing the funding and its confirmations before the irreversible step,
so the announcement afterwards had nothing left to open early. Review showed that
does not work, and would have made things worse.

It does not work because the only thing an announcement needs is for the day to
have been closed off for accounting; whether the cutover has happened is
irrelevant to it. So the announcement remains available to anyone from the moment
the day closes, on either side of the re-ordering.

It would have made things worse because a chain that receives the announcement
*before* the cutover records that it has already handled that day, and later
handling of the same day stops early — before the part that would have told it
the cutover date. The announcement the procedure relied on would therefore be
silently ineffective for that day. An ordering meant as a fix would have given
anyone a way to interfere with an irreversible step.

Two further corrections landed on that correction, and both matter to an operator
in the room.

**A spent day is not a lost chain.** An earlier draft said a chain in that state
could not be brought in at all. It can: every freshly assembled day carries the
current cutover date, so announcing a different untouched day works normally.
Only running out of eligible days is unrecoverable. Saying otherwise would have
had someone treat a fixable situation as ruined.

**And there is an enforceable gate after all — but it is narrower than it first
looked.** The messenger that carries these announcements can be paused by its
guardian, and pausing it does not stop the funding transfers, which travel a
different path. So the funding and its confirmations can be completed while
announcements are impossible, and the pause lifted immediately before announcing.

That closes the gap for the day being prepared, and only for that day. An
announcement may name any day that has been closed off for accounting, so the
moment the pause lifts, someone can announce a different one that is neither
funded nor yet handled on that chain — reaching the same exposure by another
route. The procedure therefore says to reconcile every announceable day before
lifting the pause, or to leave the messenger paused until the underlying
fund-safety fix is deployed there, and admits that on a chain with real history
the second may be the only honest answer.

There is one further trap in the mechanics. Lifting the pause is an owner action,
which after governance handover means a scheduled action with a delay — and the
timelock as deployed by default lets *anyone* execute a scheduled action once its
delay expires. Queuing the unpause in advance therefore hands away control of
when it happens: if the funding is still in flight at that moment, someone else
can execute the unpause and announce against an unfunded chain. The procedure now
says to run this only on a timelock whose executor is the operator's own
multi-signature wallet, with a fresh check immediately before execution. Queuing
late and watching for trouble is **not** an alternative: closing a day off for
accounting is itself something anyone can do, so during the waiting period
someone can create a fresh unfunded day, execute the ready unpause themselves,
and announce — faster than anyone watching could cancel.

Two smaller things were wrong in the same direction. Pausing does not reach an
announcement already on its way: one dispatched moments earlier still arrives and
takes effect, so the outstanding ones have to be accounted for individually
before the pause counts as a gate. And a day that has already been announced
without funding is not "handled" — its door is already open, and pausing the
sending side does not close it; only funding it, or containing the receiving
chain's claim path, does.

**The severity was also understated.** While the outstanding fund-safety item is
open, a claim arriving at a gate opened ahead of its funding does not simply
fail: the figure the payout is measured against is computed from the contract's
whole balance minus a few known reservations, and the balance has other owners —
including collateral belonging to borrowers. So an early announcement can result
in someone being paid out of that collateral, and it can happen before the
ceremony's own check for the fix is ever performed. This is treated as something
to contain now rather than a hazard scheduled for the activation day.


## A second gate that only bound one step

The same review pass found that the switch which turns on the expiry-and-sweep
behaviour carries its own list of things to confirm first, and that list was
missing one of them. The condition in question — an open fund-safety item about
how reward payouts are bounded — is written down as a blocker on the irreversible
activation step, and correctly so. But the sweep switch is deliberately separate
and may be thrown later, on its own; a condition attached only to the earlier
step does not reach it.

That matters because turning the sweep on moves more value through a balance the
programme shares with other claimants, two of which are user collateral. Until
payouts are bounded by what was actually delivered for rewards rather than by
whatever the balance happens to hold, enabling the sweep widens exactly the
exposure the activation gate exists to hold shut. The condition is now listed in
both places, with a note that deferring the step does not defer the condition.
