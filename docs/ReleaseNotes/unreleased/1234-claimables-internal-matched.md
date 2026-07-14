# Claimables feed includes internally matched loans (#1234)

The indexer's claimables endpoint — the candidate layer behind the
classic app's Claim Center — listed only repaid, defaulted, and
liquidated loans. An internally matched loan is just as terminal and
just as claimable, and the Claim Center already verifies and labels
it correctly once it knows to look; the missing status meant an
internally matched position's claim could stay invisible in that
app's indexer-fed list until another discovery source surfaced it.

The endpoint now includes internally matched loans. Nothing changes
about authority: the app still confirms every candidate on chain
before showing a claim as actionable.
