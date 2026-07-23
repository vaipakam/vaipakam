## Thread — Two-pass per-chain recycled funding resolution (PR #TBD)

The mesh's funding brain lands (#1222 M3 B2-a, records-only): on
post-cutover days, the canonical chain no longer sizes the recycled
reward budget against its own bucket alone. The absorption average
still sizes the day's coupled target, but funding now resolves per
chain: each chain's share of the target follows its finalized demand
weights, each chain funds its slice from its own recycled availability
first (the per-chain ledger the previous stage built), and the
canonical chain tops up shortfalls pro-rata from whatever remains of
its own availability after reserving its own slice — never
double-committing the same bucket. When a chain's availability can't
cover both sides of its target, the split happens at one allocation
point, pro-rata to the two side targets, so the same balance is never
spent twice. The day's stamped recycled budget becomes the sum of the
funded slices — identical to the previous single-pool sizing on a
single-chain deployment.

Each chain's funded figures are stamped per day: the per-side funded
budgets (the binding caps once consumed), the side-specific
global-equivalent numerators that make the existing claim math pay
exactly the funded amount on that chain, and the slice the chain will
be instructed to consume from its own bucket. The intended reservation
split — mirror-locally-funded slices against that chain's
availability, canonical-funded shares (own slice plus every top-up)
against the global ledger, both at capped committable amounts with
rounding dust trimmed — is computed and published per chain alongside
the stamp. The absorption average now folds in every mirror's accepted
day credits alongside the canonical chain's own series, accumulated at
report-acceptance time so a later change to the configured chain set
can never rewrite an already-accepted day (a review finding).

Deliberately, this stage changes NO live figure: the day's stamped
recycled budget, both outstanding-commitment ledgers, and every
claim/remittance consumer keep the previous single-pool values
byte-for-byte — a review round established that publishing the summed
per-chain figure while consumers still distribute it pro-rata would
move armed-day rewards and bucket consumption to the wrong chains, so
the resolution rides as pure records until the next stage flips the
consumers and arms the per-chain reservation ledger together.
Part of #1222.
