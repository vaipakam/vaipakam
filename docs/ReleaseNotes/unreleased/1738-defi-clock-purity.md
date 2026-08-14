# apps/defi: expiry surfaces no longer freeze at the moment the page loaded

Several parts of the lending app decided things like "has this grace period
closed", "is this loan overdue" and "is the indexer still fresh" by reading the
clock once, while drawing the screen. A value read that way never changes again
for as long as the page stays open. The comparison is correct at the instant it
runs and then quietly stops being true.

What that looked like in practice: open a loan page a few minutes before its
grace period ends, leave it open, and the action surface keeps offering itself
after the deadline has passed. The page has no idea anything changed, because
nothing prompted it to look at the clock again.

This is not a newly discovered risk. One page already carried a fix for exactly
it, added earlier with a note explaining that a page opened before the boundary
"would keep showing the action surface forever" otherwise. The fix was correct —
but it was applied to one deadline, and the same page's *other* deadline, a few
lines above, went on reading the clock directly. So one half of the page updated
and the other half did not.

Nine places read the clock this way, and they did not all need the same answer.

Six now share one small piece of machinery that keeps time and refreshes about
once a minute, replacing two separate hand-rolled copies that had grown up in
different files. Those are the genuine deadline surfaces: grace periods, overdue
loans, a cooldown, and two countdowns.

The other three turned out not to want a clock at all. Two were asking whether
the app was still successfully reaching the chain, and the honest answer to that
comes from whether the last check succeeded, not from how long ago a number last
moved — a distinction that cost two review rounds to get right, because a
plausible-looking staleness threshold hid it. The third was asking whether a
queued governance change had matured, which is a fact about the chain's clock,
not the administrator's; a machine running fast would otherwise be told an
operation was ready while the network still refused it. That one now takes its
answer from the chain alone.

An attempt to also make that governance panel refresh itself the moment a queued
change matures was written and then withdrawn during review, and the reasoning is
worth recording. The panel finds queued changes by scanning a bounded window of
recent chain history. A change queued with a long delay falls out of that window
before it matures, so a refresh triggered at the maturity moment would come back
empty and make the pending change *disappear* from the dashboard — at exactly the
moment an administrator needs to act on it. A momentary network failure had the
same effect. The panel is therefore left as it was: it can show a stale countdown
until the page is reloaded or the chain switched, which is recoverable, rather
than risk removing a live proposal from view, which is not. Refreshing it properly
means asking the timelock for its active operations directly instead of
rediscovering them from history, and is tracked separately.

Two details worth recording, because both were places this could have gone
wrong. Some of these readings sat below a point where the component can bail out
early; a naive move would have put the new clock there too, which breaks the
rule that a component must ask for the same things in the same order every time
— the same class of fault that caused a live crash on the Create Offer screen
not long ago. Those were lifted above the early exits instead. And the refresh
interval is a minute, not a second: these are deadlines measured in hours and
days, and a faster tick would redraw the screen constantly for no visible gain.

No visual or behavioural change on a freshly loaded page. The difference only
appears on a page left open across a deadline, which is where it was wrong
before.
