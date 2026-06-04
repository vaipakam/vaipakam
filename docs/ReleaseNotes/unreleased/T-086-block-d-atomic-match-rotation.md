## T-086 Block D — Atomic match-rotation closes the v1 §15.3 race window

Block D ships the v2 atomic match-rotation path described in the
Round-6 design (`docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
§17) — the load-bearing piece that retires the v1 two-step cancel +
post sequence on the borrower's NFT-collateral-prepay-listing
Match flow.

Pre-Block-D, accepting an OpenSea offer ran in two transactions:
cancel the existing v1 listing, then post a fresh listing at the
new ask price. Between those two transactions every state-shift
vector — a flipped kill switch, a buffer change, a grace-period
boundary, a floor move — could leave the loan with no listing at
all, sitting on a destructive failure mode ("listing destroyed if
cancel succeeded but post reverted"). Block D folds the whole flow
into a single Seaport `matchAdvancedOrders` call that runs inside
the diamond. Either the entire sequence — cancel the old order,
build the canonical replacement, settle against the bidder's signed
order — succeeds atomically, or nothing changes on-chain and the
borrower's live listing stays intact.

Borrowers who never posted a v1 listing can still Match — the
atomic path supports `existingHash == 0` and skips the cancel half
of the rotation. The Match button no longer requires a live v1
row; the offers panel surfaces every acceptable signed offer the
moment one is detected by the OpenSea poller.

The shared wiring primitive (`LibPrepayListingWiring`) is now used
by every prepay-listing entry point — v1 fixed-price post + update,
v1 Dutch post + update, and v2 atomic match. Every path reverts
with the same `VaultNotDeployed(borrower)` symbol when the
borrower's vault is missing; `ExecutorNotSet` is reserved purely
for the legitimate governance-level "executor address never
configured" precondition.

The frontend offers panel no longer hard-gates Match on the
OpenSea collection fee-schedule fetch — that fetch is now
advisory. The atomic facet re-checks the bidder order's actual
fee sum on-chain at match time, so a transient
`/opensea/collection` outage no longer locks every Match button.
Decaying Dutch bidder offers are surfaced with a clear
"`decaying-bidder-offer`" reason and are unmatchable from the UI;
the atomic facet's on-chain shape gate rejects them too.

The indexer writes durable `match_mode` breadcrumbs for every
`PrepayListingMatched` event. The legacy dapp-side POST handler
cannot silently downgrade an event-sourced `atomic` row to
`v1-twostep` — the new `ON CONFLICT` clause preserves the atomic
match-mode signal and logs any attempted downgrade for operator
visibility.

The OpenSea SignedZone path (fee-enforced collections) fails closed
at the agent's signed-offer proxy boundary with a clear `422
opensea-fee-enforced-needs-fulfillment-data` response. Wiring the
OpenSea Fulfillment Data endpoint (POST
`/api/v2/offers/fulfillment_data`) to fetch the SIP-7 `extraData`
for fee-enforced collections is tracked as a Block D follow-up;
until that lands the dapp shows an accurate "this collection
requires server-signed fulfillment data — not yet supported"
message instead of routing a doomed match to Seaport.

Closes #345; implements the Round-6 design ratified in #344
(commit `870f49da`).
