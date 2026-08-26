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
route. The procedure therefore says to leave the messenger paused until the
property that matters holds — that a claim against a day whose funding has not
arrived cannot consume value belonging to anything else, which deploying the
outstanding fund-safety item does not by itself guarantee — for the whole mesh,
not one chain, because the
pause is global and the single-destination form of the announcement can name a
chain that was removed from the list. Reconciling every announceable day first
was considered and does not work; the reasons are below with the rest of the
dead ends.

There is one further trap in the mechanics. Lifting the pause is an owner action,
which after governance handover means a scheduled action with a delay — and the
timelock as deployed by default lets *anyone* execute a scheduled action once its
delay expires. Queuing the unpause in advance therefore hands away control of
when it happens: if the funding is still in flight at that moment, someone else
can execute the unpause and announce against an unfunded chain. The procedure now
does not offer this route at all on a chain that is still unfixed. Restricting
who may lift the pause controls only the lifting: closing a day off for
accounting is itself something anyone can do, so a fresh day can appear after any
check, including in the moment the lifting happens. Both the restricted-executor
version and the queue-late-and-watch version are in the dead-end list below, with
that reason.

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


## Five procedures, all refuted — and what the document says instead

Successive review rounds refuted every operational procedure built on the pause,
and each refutation was correct. Re-ordering the ceremony does not help, because
announcing a day depends only on the day having been closed off. Pausing, funding
the day in hand, and unpausing does not help, because the announcement may name
any closed day and unpausing frees all of them at once. Reconciling every such day
first does not help, because a day already announced without funding is already
open and closing a day off is something anyone can do at any time. Containing the
receiving chain's claims meanwhile does not help, because the same single switch
that stops claims also stops the funding arriving — so the condition being waited
for can never be met. And restricting who may lift the pause does not help,
because that controls only the lifting, not what someone else may have created in
the meantime.

The procedure therefore stops offering alternatives and states the one branch
that survives, and it is **mesh-wide, not per chain**: while any chain the
announcements can reach lacks the property that matters — that a claim against a
day whose funding has not arrived cannot consume value belonging to anything
else — the whole sender stays paused and nothing is propagated anywhere. It
cannot be narrowed to the unsafe chain, because the pause is a single switch and
lifting it for the others also re-enables the single-destination form, which can
name the unsafe chain directly. The outstanding fund-safety item does not by itself
guarantee that; some of its permitted remedies protect borrowers' collateral
while still letting such a claim take another day's reward funding.

Two chains are exempt from that block rather than caught by it, and saying so
matters as much as the block itself: one whose route has been fully dismantled
cannot be reached at all, and one that was removed from the lists and whose
qualifying history has already been used up cannot be reopened. Without those
exemptions an operator would stop all reward messaging indefinitely over a
retired chain. That is
expensive — it stops other reward messaging and leaves the chain out of the
cutover — and it is the only option in the list that has not been argued away.
The five that were is kept in the document as a dead-end list, with the reason
each fails, so nobody re-derives them under time pressure.
