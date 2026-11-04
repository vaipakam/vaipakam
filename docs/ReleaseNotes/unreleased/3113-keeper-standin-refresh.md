## Keeper — keeps the testnet sanctions stand-in fresh (PR #<n>)

On test networks, the delisting timelocks check a clearance answer from a stand-in for RedStone's Sanctions Oracle on BNB testnet. They refuse an answer whose list is older than seven days. Until now only the admin could refresh the stand-in, by hand, and on the 2026-11-04 deploy it had been stale for about fifteen days without anyone noticing. Automated delisting on the testnets had been closed the whole time.

The stand-in now has a refresher role. The admin names one address, the keeper, which may re-publish the admin's list unchanged and do nothing else. It can never flag or clear an address. Every publication now says on-chain who made it, the admin or the refresher.

A new hourly keeper duty reads the stand-in the attestor actually reads, and the smallest age limit among the timelocks that take their answers from it. A day before that limit, it refreshes the stand-in. The operators' chat is told when the stand-in is past the limit, when the keeper is not its named refresher, and when a refresh is refused. The duty refuses every mainnet and ships switched off.

The wiring script now names the keeper as the refresher when it is given one. It no longer reuses a stand-in built before the role. The stand-in already on BNB testnet predates the role, so it still has to be replaced, along with the attestor that reads it, before the keeper can take over. Until then it is refreshed by hand.

Closes #3113.

> Caveat: the current BNB testnet stand-in has no refresher role; the keeper can refresh only a stand-in deployed from this change.
