## Thread — small contract fixes from the open-issues sweep (PR #TBD)

A fresh offer can no longer be cancelled during its first five minutes,
whatever the partial-fill setting says. The cooldown used to apply only
while partial-fill matching was switched on, so a creator could watch an
accept arrive and cancel ahead of it on a direct-accept book. An expired
offer can still be cancelled at any time, and a partly filled offer still
cancels its unfilled part straight away. Past the cooldown, a cancel and an
accept are an ordinary race and whichever lands first wins; the spec now
says so. Closes #664.

The dashboard's claim list and its claim counts now list exactly what a
claim call would pay. The claim facet and the dashboard read one shared
rule for which loan statuses can be claimed and whether each side still has
something to pay. So an NFT return, which carries an amount of zero, now
shows up as a claim, and a row on a loan the claim would refuse is not
listed. Closes #941.

Operators can now read back every setting they can change. AdminFacet has
getters for the aggregator-adapter pause and the peer-protocol LTV read
pause (#1637). Each of the eight chain-level oracle setters (Chainlink
registry, the USD and ETH denominators, WETH, the ETH price feed, the stable
peg feeds, the v3 factory and the sequencer uptime feed) and the four
backstop switches now emits an event carrying the previous and new value,
and the indexer's configuration snapshot listens for them, so no published
setting changes silently any more (#2685). The notification-fee event's
argument is renamed to say it is a VPFI quantity (#1934).

Two new read-only views. One returns the seller floor, held ceiling and
expiry a standing sale listing recorded, plus what is held for the lender
now, so a seller can see what they agreed to (#2672). The other returns the
highest position-NFT id ever allocated, so the NFT verifier can tell a
burned token from one that was never minted (#2529, used by the app).

Housekeeping: the active-loans page view now documents that it can skip a
loan if the list changes between pages (#942), and leftover wording about
the removed VPFI buy flow is gone from the deploy scripts, the cross-chain
NatSpec and the gas snapshot (#2804).

> Caveat: these are contract changes for the all-waves fresh deploy; they reach the testnets only then.
