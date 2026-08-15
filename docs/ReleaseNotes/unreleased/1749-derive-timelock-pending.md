## Connected app — the pending-changes panel stops listing another network's queue (PR #1763)

The admin panel lists governance changes that have been scheduled and are
waiting out their delay. That list carried no record of which network it was
read from, so switching networks showed the previous network's queue.

This one lasted longer than the equivalent problem elsewhere in the app. The
panel deliberately does not re-read on a timer — an earlier attempt to do so
was withdrawn because rediscovering operations through a limited history window
could make a genuinely pending change disappear at the moment it became
executable, and a vanished proposal is worse than a stale one. The consequence
is that a list carried across a network switch stayed there until the page was
remounted, rather than for a frame.

The list is now labelled with the network and timelock it was read from, and the
panel reports that it is still reading when the label does not match. A network
with no timelock deployed is treated as a settled "nothing queued here" rather
than a perpetual loading state.

The decision not to re-read on a timer is unchanged.
