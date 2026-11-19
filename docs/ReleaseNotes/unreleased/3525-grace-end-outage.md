## Indexer, app and shared loan clock — grace ends moved by a sequencer outage

Since #3410 the contracts move a loan's grace end that falls inside a layer-2
sequencer outage, or the recovery window after it, to the end of that window,
so a borrower who could not send a repayment while the network was down can
still repay. The due date does not move. Off-chain surfaces that worked out
the grace end themselves did not see the move, and during or just after an
outage they could tell a borrower the grace period was over while the chain
still accepted the repayment.

The shared loan clock now takes the Diamond's own outage window, read through
`getSequencerOutageWindow` rather than from the uptime feed, so the rule has
one source. Every caller must pass the window, so none can leave it out by
accident.

The indexer re-reads the window every two minutes into its configuration
snapshot (migration 0106). The loan routes serve the moved grace end, say
whether an outage moved it, and say when the window is unknown: never read,
more than ten minutes old, or a database without the migration. The calendar
sweep holds the "grace has ended" notice until the moved end has passed, and
withholds it while the window is unknown, because that notice is never
retracted.

The connected app reads the window with every live loan snapshot. Its loan
page countdown, partial repayment, close-out, preclose and refinance checks,
and the payoff permit's last fillable moment all use the moved grace end.
When the window could not be read, the app never says the grace period is
over and never refuses on it; it says the deadline may be later, and the
chain decides.

Part of #3525. The keeper passes read the deadline on-chain or only use the
due date, which an outage does not move, and alpha05's surfaces are left to
that app's own work.
