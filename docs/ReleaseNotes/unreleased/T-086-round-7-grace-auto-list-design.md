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

Round-3.9 (against Codex round-9) fixes four follow-on issues
the round-3.8 rewrite exposed. First, the round-3.8 B-cond-2
predicate kept a `> recorded + 1` tolerance inherited from the
fixed-price aggregate inverse — but the schema-extended read
is direct (no arithmetic, no rounding) and the executor's
fill-time check is strict, so a 1-wei shortfall makes the
order unfillable while the tolerance no-ops; round-3.9 makes
the predicate strict (`>`) on the direct read. Second, the
round-3.8 claim that fixed-price doesn't have the borrower-
slack-vs-signed-legs ambiguity was incorrect — the fixed-
price post-time invariant only requires a buffered floor and
allows the borrower to land the +1 slack in
`consideration[2]`; round-3.9 upgrades the fixed-price
B-cond-2 path to use the same signed-legs predicate as Dutch.
Third, the round-3.3 B-cond-1 Dutch-current-ask variant fires
on every block of a healthy Dutch listing's decay window
above the floor, making B-cond-3a/b unreachable; round-3.9
carves Dutch out of B-cond-1 entirely (rotation owned by
B-cond-2 + B-cond-3a/b + B-cond-5). Fourth, the §18.14
implementation checklist still said "NO schema change" —
contradicting round-3.6's fee-leg snapshot AND round-3.8's
protocol-leg snapshot; round-3.9 documents both additive
extensions in the checklist with their accessors, storage
shape, wiring sites, and clearOrder coupling.

§18.12 test obligations renamed for the strict-shortfall
predicate (round-3.8's `+2` short tests become round-3.9's
`+1` short tests) and grown with four new fixed-price pin
tests symmetric to the Dutch pins, plus two B-cond-1 Dutch
carve-out tests.

Design-doc-only change in this PR. Contract implementation,
keeper-bot scanner wiring, and dapp surface are tracked as separate
follow-up Issues after the design ratifies.

Closes the design half of Issue #355.
