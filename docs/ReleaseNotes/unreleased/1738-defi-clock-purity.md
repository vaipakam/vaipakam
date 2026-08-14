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

Nine places read the clock this way. Six of them decided something — whether a
deadline had passed, whether a health signal was stale, whether a cooldown was
still running — and those are the ones that could show the wrong state. The rest
were counting down for display.

All nine now share one small piece of machinery that keeps time and refreshes
about once a minute, replacing two separate hand-rolled copies that had grown up
in different files. A component that needs to know what time it is now gets a
clock that keeps ticking, rather than needing someone to remember to build one.

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
