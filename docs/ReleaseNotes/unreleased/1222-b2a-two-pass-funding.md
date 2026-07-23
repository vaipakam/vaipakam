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
budgets (the binding caps), the side-specific global-equivalent
numerators that make the existing claim math pay exactly the funded
amount on that chain, and the slice the chain will be instructed to
consume from its own bucket. Reservations split by funding source —
mirror-locally-funded slices reserve against that chain's availability
in a per-chain outstanding ledger, canonical-funded shares (own slice
plus every top-up) reserve in the global outstanding ledger — both at
the capped committable amounts, dust-trimmed so reservations can never
exceed what exists. The absorption average itself now folds in every
mirror's accepted day credits alongside the canonical chain's own
series (counted once, never twice).

Nothing is broadcast or consumed from these records yet: the next
stage ships each chain its own funded figures and consumption
instructions, and the netting stage sizes remittances against them.
Pre-cutover days are untouched. Part of #1222.
