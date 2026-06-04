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

Round-3.7 (against Codex round-7) corrects the Dutch B-cond-2
reverse derivation to be bufferless — matching the shipped
`NFTPrepayDutchListingFacet._assertDutchSolvency` invariant,
which only enforces `endAskPrice >= protocolLegs + endFeeSum`
(no buffer) — and switches B-cond-3b's Dutch floor-crossing
time formula from floor- to ceiling-division so the
Seaport-truncating price-at-tick semantics don't report
`t_floor` one tick early at the boundary. Test obligations
updated with the two pin tests.

Design-doc-only change in this PR. Contract implementation,
keeper-bot scanner wiring, and dapp surface are tracked as separate
follow-up Issues after the design ratifies.

Closes the design half of Issue #355.
