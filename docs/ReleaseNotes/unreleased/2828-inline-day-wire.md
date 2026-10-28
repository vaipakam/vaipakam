## Thread — The budget wire carries its one funded day inline (PR #3056)

Since #2821 a reward-budget remittance funds at most one day, but the wire
still carried that day as a rooted, chunked day list built for many days.
Every delivery therefore needed a second, permissionless call on the mirror
(indexing its chunk, or proving it when the delivery held no epoch) before
its day could land. The keeper's delivery-proof pass existed to make that
call.

The wire now names the funded day directly, beside the split, the era, and
the part and whole the delivery declares. The mirror's receiver moves to
generation 9 and refuses the old rooted shape by name, so a stray message
stays re-executable rather than being misread. On arrival the mirror records
the day, counts the delivery's part toward that day's landed sums and, where
reward custody is activated, opens the epoch and places it in the day's
arrival order, all in the one transaction. A day lands as soon as its last
part executes.

Placement in a day's order is bounded. An epoch that would have to pass more
than 128 later-arrived epochs to find its place is refused by name and left
for re-execution. Only epochs of one day landing out of arrival order, which
in practice means same-second ties, can come near that bound.

Everything that existed only for the second step is removed: the chunk index
and proof calls, the placement hints, the per-delivery index cursor, the
"not fully indexed" and multi-day withholding states, their errors, events
and views. Parking an epoch's remainder now takes one call once its day is
proven closed. The destination gas budget each remittance asks for is
re-derived from the new ingress, which now does the indexing and the part
count itself.

This changes the storage layout, so it reaches a chain only by fresh deploy,
as the rest of the #1566 reward work does. Closes #2828.

> Caveat: the keeper's delivery-proof pass calls entry points this change removes. It must stay unset on a chain running this build until the keeper change that retires it ships.
