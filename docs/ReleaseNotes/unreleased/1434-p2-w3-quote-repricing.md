## Thread — P2-w3: the mirror quotes its own compensation, and a funded day reprices (PR #TBD)

Third build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§1.4, §1.5, §2.1, §2.3 — slice 3 of §8). The compensation's sizing
input now originates where the evidence lives: the zeroed mirror
itself. A permissionless, batched accumulator walks the day's own
reward entries and prices each at the counterfactual fair share — the
delta the chain would have priced at had its report made the day's
finalization — computed entirely from finalization-frozen data, with a
conservation identity proving the walk covered every entry before the
quote may dispatch. The quote is deliberately UNCAPPED — the sum every
settlement path is bounded above by, because forfeit settlement prices
without the per-user ceiling by design — while each payment still
applies its own path's ceilings; an admin reset valve recovers a day
whose permissionless accumulation was mis-ordered, and a day whose
frozen pool figures have not arrived refuses to quote rather than
wrongly resolving to zero. The quote travels to the canonical chain on its own wire
kind and lands as evidence, never funding: manual compensation for a
quoted day is bounded per side by the standing quote, an unquoted day
cannot be manually funded at all, and a both-sides-zero quote resolves
the day terminally on the mirror before dispatch while clearing the
canonical chain's manual-funding anchor — nothing to compensate. The
standing quote is bound to the sending deployment's identity, stamped
into the wire by the messenger itself: a re-delivery from the same
deployment refreshes it, a divergent one is refused, and an operator
clear releases a stale binding after a mirror redeployment — so a
delayed wire from a retired deployment can never overwrite newer
evidence or spuriously clear a day's funding anchor.

The repricing closes the loop the earlier slices left open: a funded
compensated day now prices through the ordinary claim machinery at the
same quoted delta — one shared implementation feeds the quote, the
pricing fold, the commitment report and the payment decomposition, so
the quoted figure and the paid figure cannot diverge. The day becomes
payable only once its delivered per-side pool covers that side's full
quoted sum, a wait keyed on the amount present rather than any message
arrival; an underfunded day defers whole (never a trimmed payout), a
lapsed day retires at zero with its loss recorded at the lapse, a
resolved-zero day prices zero, and an open zeroed day keeps deferring
so no reward entry is silently retired while compensation is still
possible. This includes the constraint-17 day whose excluded
denominator is zero — the case the ordinary pricing can never reach —
which now pays under the mirror's own local denominator. Ordinary
armed mirror days are untouched: the blanket mirror pricing halt
stays exactly where it was until the halt-lift slice. Part of #1434
(P2); umbrella #1349.
