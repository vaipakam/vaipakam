## Keeper — each protocol upkeep step gets its own send share (PR #3156)

The keeper's protocol upkeep pass runs seven steps on every chain it serves
(expiring buybacks, the loan-to-value tier refresh, the prepay-sale
sanctions sync, the tier push retry, the tier exclusion refresh, the reward
index compaction and the sanctions flag refresh). Until now they shared one
budget of ten sends per chain per run, taken in that order, so a long
backlog in an early step could use all ten and leave the later steps
nothing to send with, run after run.

Each step now has its own share of the run's sends, and the shares add up
to the run's bound. A step that reaches its share stops for this run, the
run's report names it ("step-budget-reached"), and its remaining work waits
for the next run. The other steps keep their sends whatever the first one
found.

The steps that work through a list of candidates (expiring buybacks, the
prepay-sale recipients still to commit, the reward index users to compact)
now start at a different place in that list each run, so a candidate at the
end of a long list is reached instead of being skipped every time.

Nothing about what a step sends, or when it decides a send is due, has
changed; only how many sends each step may make in one run and where it
starts.

Closes #3093. The close-out and return-transport release loops have the
same start-of-list bias; that is tracked in #3155.
