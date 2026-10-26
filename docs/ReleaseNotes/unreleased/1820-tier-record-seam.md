## Thread — VPFI tier record refreshed at the balance, pushed once per action (PR #TBD)

A user's VPFI fee-discount tier record on Base used to be refreshed by each
facet that moved their VPFI, one call site at a time. A path that nobody
wired left the record behind the balance: lending VPFI through an offer
(the escrow going into the vault on create and back out on cancel) and the
buyer's price pull when accepting a listed loan sale never refreshed it, so
the user was priced on a balance they no longer held, or not priced on one
they now did, until some unrelated movement. The refresh now sits where the
balance is written: the tracked vault counter's deposit and withdraw, and the
writes of the VPFI held back from a transferred position's holder. Every path
that changes a user's tracked VPFI refreshes their record there, including
any added later, and the twenty-odd per-facet stamps are gone. A movement
in the middle of an action is recorded as it happens, so the day's minimum
sees a balance that dipped and recovered within one action.

Refreshing the record and pushing the tier to the mirrors are now separate.
The record updates at once. While an action holds the Diamond's reentrancy
guard (or a 1inch fill holds the fill lock), the user is queued instead of
pushed, and when the action releases the guard each queued user's tier is
pushed once, carrying the tier they hold at the end. A settlement that moves
one user's VPFI five times commits one push, not five. The broadcast-free
"local" stamps are retired with it: a time-based default, a fallback custody
move and a reward credited to the vault now push like every other movement
(the health-factor liquidation already did), so no close-out leaves the
mirrors waiting for the user's next action. An unguarded entry point pushes
where it writes, as before. A Diamond whose tier push host is missing now
fails with a named error instead of being mistaken for one with no tier
accumulator.

This touches every facet that moves funds, so it reaches a chain only by a
fresh deploy or the all-facets in-place refresh; the curated refresh scripts
refuse a Diamond from before it. Closes #1820 and #2849.
