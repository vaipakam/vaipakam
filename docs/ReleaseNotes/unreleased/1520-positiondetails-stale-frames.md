# Position page: the listing-hold confirmation keeps up with the position it describes

Three moments on the position page where the screen briefly described the
previous state of something rather than the current one.

Switching chains while the position page is open now clears the listing-hold
confirmation as part of the switch, rather than just after it. Previously one
frame could show the confirmation earned on the chain you left, attached to the
loan of the same number on the chain you arrived at — and the confirmation is
one click from sending a cleanup, so it mattered that it belonged to the right
listing. The same applies to an open review: it closes with the switch.

When a listing's lifecycle ends and a new one begins, the confirmation now
un-latches in the same update that observes the new lifecycle. And when a
listing ends off-page — a buyer accepted it, or it was cancelled elsewhere —
the notice is consumed as the page renders rather than a beat later.

None of this changes which confirmations are shown or when they are earned. It
changes only whether a frame can be painted showing one that has just stopped
being true.
