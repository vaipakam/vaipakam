## Thread — Global pause keeps repay open and credits every open loan

A global pause used to freeze everything, repay and add-collateral
included, while every loan's due date and grace window kept running. The
unpause sits behind the 48-hour Timelock, so a pause that outlasted a
grace window let anyone default the loan the moment it was lifted, and a
borrower could not repay or top up collateral to avoid it. This change
implements owner decision D2 (2026-10-20). Full repayment, partial
repayment and adding collateral now stay open under a global pause.
Everything else stays paused: offers, accepts, matches, claims,
withdrawals, liquidations, defaults, swap-to-repay and the keeper-driven
settlement steps.

The protocol now keeps a record of every paused interval. The paused time
since a loan started is added to that loan's due date and grace end. The
late fee runs from the moved due date, and periodic-interest checkpoints
move the same way. Every part of the protocol that reads a loan deadline
now reads it from one place. A pause that came after a loan was already
defaultable puts the loan back inside its grace window for as long as the
pause lasted. That is deliberate: the alternative would favour whoever
defaults fastest after the unpause. Interest still accrues by elapsed
time, and a borrower who does not want it can repay during the pause.

Two new reads disclose this. One returns an open loan's original due
date, its pause credit, and its effective due date and grace end. The
other pages the pause record. A new event marks each closed manual pause
interval. The due date announced when a loan starts is the original one,
and after a pause the new read is the source of truth. The indexer,
keeper and app changes that consume the new read are tracked as a
follow-up. A sale listing's price floor still hedges interest only to the
original grace end. After a long pause, a fill late in the extended window
can therefore be refused as short. The borrower can still repay, or post
the listing again. Whether a loan may still be listed for sale, and the
remaining term the listing carries, follow the moved due date.

A chain upgraded in place while paused, or during an auto-pause window,
counts that pause from the upgrade on, before anyone lifts it, rather
than only once it ends, so repayment stays open against the moved
deadlines during it. A later pause never drops it from the record.

The change reaches a chain only by a fresh deploy or the all-facets
in-place refresh. The two curated refresh scripts refuse a Diamond from
before it. Closes #668 and #935.
