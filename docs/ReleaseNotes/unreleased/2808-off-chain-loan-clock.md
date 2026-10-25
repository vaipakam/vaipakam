## Thread — Off-chain deadlines follow the loan clock (PR #2822)

Since the D2 pause change (#668 / #935), a pause moves every open loan's due
date and grace end later by the time the protocol spent paused since the loan
started. The contracts enforce the moved dates, but the indexer and the agent
still worked from the original ones, so after a pause they would have
reminded people too early and shown dates the chain no longer applies. This
change moves both onto the same rule the contracts use, written once in the
shared library and fed by one copy of the protocol's pause record.

The indexer now keeps the pause record beside the grace schedule it already
stored, refreshes it on every pause, and serves each active loan's original
due date, the pause credit, the moved due date and grace end. When it cannot
establish the pause record it says the dates are unknown and why, instead of
serving the original ones. Calendar reminders use the moved due date and are
held while a pause is in force, since the date is still moving; a pause that
moves a loan's due date re-arms its reminders for the new date. The
periodic-interest reminders work from the moved payment deadline, and a
reminder whose deadline a pause moved says by how much and why. Contracts
deployed before the loan clock have never moved a deadline, so on those
chains (the current testnets until their next refresh) nothing changes.

Dating a loan from its own start also needed the indexer's copy of that start
to be right. When a borrower hands an obligation to a replacement borrower,
the loan stays open but starts a new term: new collateral, rate, duration and
start time. The indexer used to record only the new borrower and keep the old
term, so it would have dated the loan from the exiting borrower's term. It now
reads the new term from the chain at the handover and records it.

The periodic-interest reminders now spend one more request per chain per
run, so a run reaches one loan fewer before its allowance runs out. The
reminder window is days wide, so a loan left for a later run is still
reached in time.

The keeper works from the moved due date too. Its liquidation pass decides
whether a partial liquidation is still allowed against the moved date, which
is what the contract checks, so a loan a pause kept in term is no longer sent
straight to a full liquidation. Its auto-refinance warning before grace counts
the time left to the moved date, and is held while a pause is in force. When
the keeper cannot read the pause record it skips the loan, or the chain's
warnings, for that run and says why, rather than acting on the original date.
The app's loan pages follow in their own change. Refs #2808.
