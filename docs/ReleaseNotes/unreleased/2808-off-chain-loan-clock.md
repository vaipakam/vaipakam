## Thread — Off-chain deadlines follow the loan clock (PR #<n>)

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

The periodic-interest reminders now spend one more request per chain per
run, so a run reaches one loan fewer before its allowance runs out. The
reminder window is days wide, so a loan left for a later run is still
reached in time. The keeper's deadline checks and the app's loan pages follow
in their own changes. Refs #2808.
