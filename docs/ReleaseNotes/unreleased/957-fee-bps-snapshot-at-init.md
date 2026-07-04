## Thread — Snapshot the fee rates a loan is born under (PR #<n>)

Every loan now records the two protocol fee rates it was originated under —
the treasury fee (the cut taken from lender interest at settlement) and the
loan-initiation fee — the moment the loan is created. Previously both were
read live from the governance config at the time the fee was actually taken,
which meant a governance retune landing while a loan was open could change
that loan's economics after the fact: a loan originated at a 1% treasury cut
could be settled at a higher cut months later if governance had moved the knob
in between. Fixing the rates at loan origination removes that surprise — an open
loan settles at the economics it was created under, regardless of any later
retune.

The treasury fee is the load-bearing half: it is charged at settlement, so
its live-read was the real exposure. Every settlement and close-out path — full
and partial repayment, preclose, refinance, periodic interest, swap-to-repay,
time-based default, HF-liquidation, and the parallel-sale floor — now reads the
loan's snapshotted rate instead of the live knob. The loan-initiation fee is
charged once, up front, at the moment the loan is created, so there is no
later re-read to protect; its snapshot is kept as a per-loan economics receipt,
surfaced through the existing loan-details view and on the loan-initiated
companion event, so anyone — the frontend, a log-only indexer or subgraph, or an
auditor — can see exactly what rate a given loan paid without reconstructing the
governance-config history. A lender-sale-vehicle accept, which is a
secondary-market position transfer that deliberately skips the initiation fee,
correctly records a zero initiation-fee receipt (no fee was charged), as does an
NFT/ERC-1155 rental (rentals are priced on the prepay-and-buffer model, not the
ERC-20 initiation fee), while the underlying loan keeps the rate it was truly
originated under.

A loan created before this change carries no snapshot; those (and only those)
fall back to the live config, preserving the prior behaviour exactly. Because
the resolved rate is always stored — never a bare zero — the zero value
unambiguously marks a pre-change loan. One thing the snapshot deliberately does
not promise: it is taken when the accept transaction executes, not when the
offer is signed, and the signed acceptance terms do not bind the fee rates, so a
retune landing between signing and inclusion still applies to the new loan (the
existing submit-time re-read already narrows that window). What it guarantees is
that no retune after origination can move an open loan's economics — the
dominant, long-lived exposure, because the treasury fee is taken at settlement.

Closes #957. Completes the last open contract item of the #921 alpha02 review
tranche (the remaining #958 indexer item is off-chain and deferred).
