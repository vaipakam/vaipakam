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

The fix is to remove the window rather than police it. The day used for this is
deliberately one from before the cutover, and funding such a day does not depend
on the cutover having happened — so the funding and its confirmations can all be
done *before* the irreversible step, leaving the announcement afterwards with
nothing to do but carry the date to a day that is already funded. There is then
no interval in which a finalized, unfunded day is sitting there for anyone to
announce.

Where that ordering is not possible, the procedure now says what to do instead:
keep the gap short, and treat an early announcement by someone else as an
expected event rather than an emergency — the day still funds when the transfer
lands, and stopping to investigate lengthens exactly the gap that caused it.

Nothing here is exploitable for gain. The cost of the race is a user meeting a
failed claim on a gate that opened a few minutes early.


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
