## T-086 Round-7 design doc — grace-period auto-list-at-floor

Adds §18 to `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
describing a permissionless protocol-driven auto-listing primitive
that fires when a loan enters its grace window. The new entry
point can post a fresh fixed-price Seaport listing — or rotate an
existing high-ask listing down — to the protocol-mandated floor
(principal + interest + treasury fee + the configured buffer)
without needing any oracle, off-chain attestation, or borrower
action.

The motivation is that today's grace window can pass with the NFT
unsold whenever the borrower either never posted a listing or
posted at an aspirational price. The protocol-leg floor is already
known on-chain; anyone reading the chain can compute the ask that
makes the lender whole. The new function exposes that as a
permissionless trigger, same trust model as
`cancelExpiredPrepayListing` and `markDefaulted`.

Post-grace flow stays unchanged — the NFT still transfers to the
lender in-kind at grace expiry if the listing hasn't filled. Round
3's drop of Scenario B (post-grace protocol-controlled auction)
stays in place. Round 7 lives entirely inside the grace window.

Round-3.7 (against Codex round-7) switched B-cond-3b's Dutch
floor-crossing time formula from floor- to ceiling-division so
the Seaport-truncating price-at-tick semantics don't report
`t_floor` one tick early at the boundary, and corrected the
B-cond-2 derivation to be bufferless. Round-3.7 added three
B-cond pin tests: `test_autoList_dutchB2FiresAtBareEndFloor`,
`test_autoList_dutchB2FiresAfterAccrualPastBareEndFloor`, and
`test_autoList_dutchB3bUsesCeilDivisionAtBoundary`.

Round-3.8 (against Codex round-8) supersedes round-3.7's
B-cond-2 Dutch derivation: the round-3.7 formula compared live
legs against `endAskPrice - endFeeSum`, which treats the
borrower's signed slack as protocol coverage and misses the
case where the borrower padded the slack entirely into
`consideration[2]` (the borrower leg) — leaving lender +
treasury at the bare post-time floor. Any live-leg increase
past the signed amounts makes the order unfillable while
B-cond-2 no-ops, leaving stale listings through grace.
Round-3.8 introduces an executor schema extension — parallel
to round-3.6's fee-leg snapshot — that records the signed
lender + treasury amounts at sign time, and B-cond-2 compares
live legs against those directly. The four B-cond-2 pin tests
are updated to cover the borrower-slack case and the
asymmetric per-leg rotation gates. Round-3.8 also corrects a
stale "all time computations use truncating integer division"
sentence in the B-cond-3b rounding-policy paragraph that
contradicted round-3.7's ceiling-division t_floor formula.

Design-doc-only change in this PR. Contract implementation,
keeper-bot scanner wiring, and dapp surface are tracked as separate
follow-up Issues after the design ratifies.

Closes the design half of Issue #355.
