## Connected app — a network switch no longer shows the previous chain's listing marker (PR #TBD)

Three hooks track a "pending" record the user created from this device — a
position listed for sale, a posted offset offer, a posted refinance offer.
Each remembers the record's id locally so the app can offer to cancel it, and
each re-read that local memory whenever the wallet switched network or the
loan changed.

That re-read happened *after* the screen had already been drawn, so for one
frame the app displayed the previous chain's remembered id. On a network
switch that meant briefly offering a cancel action against an offer belonging
to a different chain. Clicking in that window would have failed rather than
cancelled the wrong thing, but it was still a control the user should never
have been shown. The re-read now happens while the screen is being computed,
before anything is painted, so the stale frame no longer exists. Seeding the
value once at startup would not have fixed this on its own — it would have
frozen the first chain's id and never noticed the switch, which is exactly
what the after-the-fact re-read was there to catch.

Four related places in the same hooks were reviewed and deliberately left as
they are, each now recording why. Three of them reconcile the device's memory
against what the chain actually reports — the memory is written to storage and
also decides which record the app re-verifies, so making it a purely computed
value would leave the app checking a record it had just disproved. The fourth
is the "your listing ended elsewhere" notice, which has to outlive the
condition that raised it: the moment the notice is shown the app clears the
stale memory, so a computed value would appear and vanish in the same instant
instead of waiting to be dismissed.

This is the first of several passes over this class of finding; the underlying
check stays advisory until the remaining cases are judged.
