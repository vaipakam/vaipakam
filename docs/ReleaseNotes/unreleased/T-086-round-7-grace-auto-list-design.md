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

Round-3.11 (against Codex round-11) closes three internal-
consistency issues round-3.10's edits exposed. First, §18.14's
fee-leg accessor section still documented the round-3.6 shape
`orderFeeLegs(bytes32) returns (bytes memory)` with calldata
decoding, contradicting round-3.10's typed `FeeLeg[]` getter
fix in §18.5 — implementers following the §18.14 checklist
would have reintroduced the bytes-wrap revert. Round-3.11
updates §18.14 to the corrected typed-getter shape. Second,
the §17.7 Block D reuse table still claimed
`IListingExecutorRecorder.recordOrder` was unchanged,
contradicting round-3.10's signature extension in §18.14 —
implementers would have missed updating the atomic-match
facet's call site and mock-recorder co-update. Round-3.11
documents the full extended signature in the Block D table.
Third, §18.12's opt-out test obligation said the borrower
posting a fresh listing auto-clears the opt-out flag, while
§18.7 (canonical) says the flag is sticky and requires
explicit `clearAutoListOptOut` — the round-3.4 wording left
both branches as "working assumption" tests, an ambiguity
round-3.11 resolves to §18.7's sticky semantics. The
test obligation is renamed
`test_autoList_requiresExplicitClearAfterBorrowerCancel`
and round-3.10's salt-collision section reference is
updated accordingly.

Round-3.10 (against Codex round-10) addresses five follow-on
issues across the schema-extension and grace-end boundary
surface. First, §18.5 Case B step 2's fee-leg snapshot was
written as a `bytes`-wrapped `abi.decode` against the
executor's `orderFeeLegs` accessor — but the accessor returns
the typed `FeeLeg[]` array directly, so the bytes wrap would
revert or corrupt the preserved legs and make fee-aware
rotations unfillable; round-3.10 fixes the snippet to call
the typed getter directly. Second, the §18.14 checklist said
post paths populate the new `_orderProtocolLegs` mapping
through the existing `IListingExecutorRecorder.recordOrder`
broadcast — but that signature doesn't carry
`consideration[0]` / `[1]` amounts, and deriving them from
`askPrice` is the borrower-slack bug the snapshot exists to
avoid; round-3.10 extends `recordOrder` to take
`signedLenderAmount` and `signedTreasuryAmount` explicitly,
forwarded by every post path. Third, round-3.6's B-cond-3b
underflow-guard branch SKIPPED rotation and relied on
B-cond-2 to catch the case; with round-3.8's switch to
signed-legs derivation, a pure governance buffer-bump (no
interest accrual) leaves a Dutch listing structurally
insolvent through grace because B-cond-2 doesn't fire on
unchanged legs; round-3.10 changes the guard semantics from
SKIP to FIRE rotation. Fourth, the salt-collision test was
written as a borrower-cancel-then-relist scenario — but §18.7
locks the auto-list path via the opt-out flag on borrower
cancel, so the test as written would either need to bypass
the opt-out or fail; round-3.10 refits the scenario to a
keeper post → diamond `updatePrepayListing` → keeper re-post
sequence (cleanly mirrors borrower's own re-list flow without
tripping the opt-out). Fifth, a stale "repay + Seaport fills"
parenthetical at the grace-end boundary contradicted the §0
table that already documents Seaport's `endTime` as exclusive
at the boundary; round-3.10 corrects the parenthetical to
repay-only.

Design-doc-only change in this PR. Contract implementation,
keeper-bot scanner wiring, and dapp surface are tracked as separate
follow-up Issues after the design ratifies.

Closes the design half of Issue #355.
