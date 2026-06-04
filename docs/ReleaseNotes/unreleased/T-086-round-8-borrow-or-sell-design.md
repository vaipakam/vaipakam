## T-086 Round-8 design doc — borrow-OR-sell optionality at offer creation

Adds §19 to `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
describing a single unifying primitive that lets the borrower
authorize, at offer-creation time, that their collateral NFT may
sit on an OpenSea (or Seaport-conformant) listing denominated in
the offer's principal asset at a reserve at-or-above the protocol
floor. The listing is allowed to remain live AS-IS through the
offer-pending → loan-active → grace lifecycle, with the executor's
zone callback branching on `loan.status` to decide which settlement
waterfall applies at fill time.

The motivation is that today a borrower whose NFT's market price
drifts above their loan target during the offer-pending phase has
to cancel-then-list-then-recreate (five steps, multiple txs, NFT
spends time outside the vault). Round-8 collapses that to a single
opt-in flag at offer creation; whichever path fires first
(lender-accept vs. buyer-fill) wins, the other is invalidated by
the existing offer-status / loan-status checks at the EVM level —
no race-window class to design against.

The three structural simplifications: (1) lending-asset-only
removes all swap / oracle / slippage exposure at settlement;
(2) above-floor-only reuses Round-7's solvency invariant verbatim
— there is no below-floor branch to handle; (3) listing persists
across offer-accept makes the offer-pending → loan-active
transition zero-tx, since the orderHash stays valid (offerer +
counter don't change).

The pre-loan branch's settlement waterfall is dramatically simpler
than the active-loan branch: there are no protocol legs to satisfy,
so the only fail-fast check is the lending-asset constraint. The
active-loan branch is unchanged from Round-4 + Round-7.

Design-doc-only change in this PR. Contract implementation, dapp
wiring, and indexer event handling are tracked as separate follow-
up Issues after the design ratifies.

Closes the design half of Issue #358.
