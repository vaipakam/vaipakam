# The activation ceremony's ordering rule is a convention, not a guarantee

Part of the ongoing review of the activation procedure for the recycling
programme (see the M7 runbook triage).

The procedure tells an operator to send each chain its funding, wait for each to
confirm arrival, and only then announce the cutover day — because the
announcement is what opens the door for users to claim, and the funding is what
makes claims succeed. Doing it the other way round leaves people meeting an
empty balance.

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
the cutover date. The re-broadcast the procedure relied on would therefore be
silently ineffective for that chain, and since the cutover date can only be set
once, that chain could not be brought in at all. An ordering meant as a fix would
have handed anyone a way to disrupt an irreversible step.

What the procedure says instead is honest about what it can and cannot do: choose
a day the receiving chains have not already handled, confirm that per chain right
before announcing, line up several such days in advance rather than one, keep the
gap between closing a day and announcing it short, and escalate rather than
improvise if every candidate has been used up. A real fix belongs in the protocol
— a restriction on who may announce, or a way of carrying the date that does not
depend on an untouched day — and is recorded as follow-up work rather than
pretended away here.

Nothing here is exploitable for gain. The costs are a user meeting a failed claim
on a gate that opened early and, in the pre-cutover case, a chain that cannot be
brought in.


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
