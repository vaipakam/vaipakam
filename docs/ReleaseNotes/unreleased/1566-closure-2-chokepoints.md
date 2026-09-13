## #1566 closure 2 — the delivered-funding ledger measures what moves (PR #TBD)

The reward-funding ledger on a mirror chain used to count by vintage: the paid
side was charged only for coordinated-mode days, inside the claim walk, and the
received side counted only deliveries whose every day was at or after the
chain's switch into coordinated mode. The balance that ledger protects is not
vintage-aware — a legacy payout and a coordinated payout spend the same VPFI —
so an ordinary-schedule claim could draw on delivered backing the bound had
already counted as available, and the bound reported itself satisfied. The
#1566 design calls this closure 2, "the ledger measures the wrong noun".

This change moves the charge to the two places reward value actually leaves,
and makes each of them a bound rather than a record. A claim hands its
genuinely-new component to the delivery step, which refuses the whole claim
before any transfer if that component exceeds what has been delivered and not
yet paid, and otherwise charges the ledger by exactly that amount. Within one
claim the coordinated-mode days are priced against what is left after the
ordinary-schedule slice, so a funding shortfall still defers those days rather
than refusing the whole claim, and the read-only preview quotes what the claim
will actually pay under the same order. The test that decides whether an
unclaimed reward's expiry clock runs measures the same total, so a claimant
whose claim would be refused for want of delivered funding is never counted as
able to claim, and a forfeiture or expiry that the delivered funding cannot yet
cover is deferred rather than failing the whole batch. Forfeited
and expired reward value enters the recycle bucket only through a reward
operation that refuses, charges and credits in one act. The generic
"credit the bucket with this label" entry is gone: each of the three proven
non-reward inflows (the notification tariff, the Full tariff, a spend-gated
perk purchase) has its own operation that verifies the tokens arrived before
crediting, and any other source has no door. On the received side the
authenticated new portion of a delivery is counted whatever days it funds;
compensation credits count at ingress and confirmation promotes nothing, so a
later demotion reverses exactly what the credit added. The two administrative
writers (the role-transition retirement and the one-shot paid seed) are kept.

The charge is taken only where the ledger is live, the mirror role; the
canonical column arrives with slice 4. No deployed chain has an armed mirror or
a non-zero ledger, so no live figure changes. The cutover apparatus the design
specifies for a chain that does — a migration mode, an open legacy
reconciliation epoch with ingress-stamped packet identities, the bounded
reclassification and restitution rules — is the second closure-2 PR and is
deliberately not approximated here. Refs #1566, #1956, #1349.
