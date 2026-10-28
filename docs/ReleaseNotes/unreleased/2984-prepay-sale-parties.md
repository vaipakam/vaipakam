## Thread — Read the parties a prepay-sale sanctions sync screens (PR #3049)

The two prepay-sale sanctions syncs (the loan-keyed listing sync and the
offer-keyed parallel-sale sync) now each have a read-only twin that returns
whether a listing is live and the exact recipients the sync would screen
for it: the live borrower-position holder and the recorded fee-leg
recipients for a loan's listing; the fee-leg recipients and either the
offer's creator (before acceptance) or the live borrower-position holder
(after it) for an offer's listing.

The sync and its read build that set through one shared rule inside each
facet, so the two cannot drift. The sync's behaviour is unchanged: it
screens the same parties in the same order and cancels on the same
condition.

Why: the keeper's sanctions backstop (#2984) needs to know whether a sync
is due. Without these reads it would have had to rebuild the party set from
indexed events, and the pinned executor and the offer listing's order hash
had no public read at all. With them every input to that decision is an
on-chain read.

Advances #2984. Fresh-deploy only, like the rest of the all-waves set.
