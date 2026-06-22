## Thread — Eager consolidation for the multi-loan internal match (PR #<n>)

Completes the #594 / #658 eager close-out consolidation arc. The multi-loan
internal-match liquidation path — where two loans (or three in an A→B→C→A
chain) that are liquidatable in opposing directions settle against each other
at oracle price instead of through an aggregator — now consolidates every
participating loan to its current position-NFT holder before it settles. So a
transferred borrower or lender position carries its collateral lien,
reward-accrual entry, and VPFI fee/stake checkpoint to the live holder, exactly
like the other close-out hosts. Each leg's VPFI is also re-stamped after its
collateral leaves the vault. This was the last host in the arc; the platform's
close-out consolidation guarantee now spans the whole family.

**Why it was deferred until now (and how it was unblocked):** the internal-match
executors sit at the exact viaIR per-function stack ceiling — the 3-way executor
compiled with zero slack, so any added local (the consolidation hook) overflowed
it. The fix returns the per-leg moved/incentive amounts in a lean **memory
struct** instead of a six-value stack tuple: the values live in memory rather
than on the stack at the (inlined) call boundary, and each is written as
computed so all six are never live at once. That freed the headroom for the
consolidation + restamp hooks. The matchable/incentive scratch values were also
block-scoped, and the post-settle restamps keyed off the live loan-struct
pointers, to keep the deep tail under the limit.

**Funds were never at risk** on this path — internal-match proceeds already
reached the current holder through the standard `lenderClaims` / `claimAsBorrower`
claim path (`ownerOf`- and sanctions-gated). This change closes the remaining
position-effect accounting gap. FallbackPending legs are a benign no-op (their
collateral is in Diamond custody and the consolidation primitive excludes them).

Closes #691. Part of #658.
