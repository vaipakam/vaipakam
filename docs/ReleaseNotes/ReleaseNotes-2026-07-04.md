# Release Notes — 2026-07-04

This edition closes out the **#921 contract-hardening umbrella** — the tranche of
race-window and hidden-terminal fixes surfaced by the alpha02 review. Three of its
items land here: the **sanctions-gate coverage sweep** (#921 item 2, closing four
Tier-1/Tier-2 gaps so every fund-touching entry point screens flagged wallets),
the **per-loan fee-bps snapshot** (#921 item 6 — a loan now settles at the
treasury and initiation-fee rates it was *originated* under, so a mid-loan
governance retune can never rewrite an open loan's economics), and
**on-chain-authoritative claimables** (#921 item 7, so a `fallback_pending`
lender claim surfaces without any indexer change). Alongside them the
**lender position-sale listing** (#951) now completes on-chain, the close-out
sweep gains **frozen-surplus escrow hardening** (#981), and the testnet surface
moves forward with the **alpha02 review-findings remediation** (#988), a
**faucet + oracle/swap mock deploy script**, **VPFI enablement**, and
**live block-driven refresh**. With this, every contract-level item of #921 (and
the related #951) is complete and the umbrella is closed.

## Lender position-sale listing now works on-chain (#951)

The lender's "list my loan position at my own rate" flow (`createLoanSaleOffer`, the Option-2 early-withdrawal path) could not complete on a real chain — every attempt reverted at the wallet step. Two independent blockers, both now fixed:

1. **Reentrancy collision.** Listing a position creates an internal offer to represent the sale, but that create re-entered the same reentrancy guard the listing call already held, so it reverted every time. The listing now routes through the internal offer-create entry point (the same pattern the preclose-offset flow already uses), which doesn't re-take the guard — and it passes the exiting lender through as the offer's real creator, so proceeds and cancel rights bind to the seller (not to a keeper that may have submitted the listing on their behalf).

2. **Zero-collateral validation.** The sale is represented as a borrow-style offer with no collateral posted (the real collateral stays on the live loan being sold, not re-posted). The borrower-offer ceiling check — which caps how much can be borrowed against posted collateral — treated the zero collateral as "zero borrowing allowed" and rejected the listing. Protocol-authored sale vehicles are now exempt from that ceiling, mirroring the exemption they already had from the risk-access gate.

These bugs were invisible to the test suite because every passing test stubbed the internal offer-create hop, so the real cross-facet path never ran. The fix adds an **unmocked** regression test that posts the sale offer for real (with the ceiling branch active) and confirms it lands as a genuine borrower-type offer owned by the exiting lender.

Making the listing actually post revealed that the rest of the flow — accept, complete, cancel, and offer-mutation — had never run end-to-end either, so the whole lifecycle was redesigned coherently (see `docs/DesignsAndPlans/LenderSaleVehicleRedesign.md`):

- **Accept auto-completes without re-entering the guard.** Accepting a sale offer completes it in the same transaction, and that completion re-entered the reentrancy guard the acceptance already held — so every sale *acceptance* would have reverted. Completion now runs through an internal, guard-free entry (the same pattern the offset flow uses).
- **One consistent identity for the whole sale.** The exiting lender's position is now *consolidated to its current holder at listing time* — re-anchoring both the stored lender-of-record and any held-for-lender balance to whoever actually owns the position NFT (the seller). This is the same "consolidate before a terminal action" step every other close-out path already performs. With it, the party who lists, the party the buyer pays, the party settlement is charged against, and the vault physically holding the proceeds are all the same address, so a position transferred on the secondary market before listing can no longer split those apart. (A position carrying unresolved held VPFI can't be unified this way and is refused at listing until that's cleared.)
- **A listed sale is frozen.** Once listed, the sale offer is immutable (the seller can't change its amount, rate, or collateral out from under a pending buyer) and can only be taken through the direct accept path, not the range/partial matcher (a position sale is all-or-nothing).
- **The buyer signs the *live* position, not a listing-time snapshot (bind-to-live redesign).** The earlier passes pinned the sale price, collateral, and term to a snapshot taken at listing, then patched each field that could drift between listing and acceptance (partial-repay shrinks principal, a withdrawal or auto-liquidation shrinks collateral, the remaining term shrinks every block). That was an open-ended tail — the remaining term changes continuously, so no snapshot check ever converges. The flow was reworked so the buyer's signed acceptance binds directly against the loan's **live, immutable/discrete facts**: principal must equal the loan's current principal (a repay between viewing and signing simply forces a correct re-sign for the smaller position), the term must equal the loan's *original fixed* duration (the maturity date is fixed at origination and never drifts; the shrinking "days remaining" is shown live in the UI but never signed), and the collateral is bound as a **floor** — the live collateral must be at least what the buyer signed, so a reduction fails the buyer's floor while a harmless top-up only improves the position and passes. The seller's asking rate remains bound to the offer (it genuinely is the seller's fixed ask). This dissolves the whole class of drift bugs structurally instead of patching them field by field, and removes the listing-time collateral snapshot entirely.
- **A position can't be sold two ways at once.** While an Option-2 listing is live, the instant-exit direct-sale path (Option 1) is blocked for the same loan — otherwise the position could be handed to a direct buyer while the standing listing was still open for a second buyer to accept. The seller cancels the listing first.
- **No double origination fee on a resale.** Accepting a sale listing is a secondary-market position transfer, not a fresh loan — the underlying loan already paid its 0.1% origination fee when it was first taken. That fee is no longer charged a second time on the sale, so the seller receives the full sale price.
- **Preview matches reality.** The matcher's pre-submit preview now reports a sale-vehicle offer as non-matchable, mirroring what the on-chain match would do, so a matching bot never wastes a transaction submitting a pair that always reverts.
- **A drained position can't be sold — enforced at the signature, not a snapshot.** A borrower-initiated collateral withdrawal is still refused outright while a lender-sale listing is live (the seller cancels first to change collateral). For the *permissionless* reduction paths too — a periodic-interest auto-liquidation that sells collateral to cover a shortfall — the buyer's signed collateral floor (bound `>=` the live collateral, above) catches it: if the live collateral has fallen below what the buyer signed, the acceptance reverts. The listing-time collateral snapshot the earlier pass introduced is removed; there is nothing to store, clean up, or drift.
- **A borrower can't buy their own debt's lender side — resolved against the *current* borrower.** If the linked loan's own borrower accepted the sale vehicle, the position would migrate onto them, leaving an active loan where the lender and the borrower are the same party (a party owing itself — broken accounting). That's rejected, and the check now resolves the loan's borrower by *who currently holds the borrower position NFT*, not a stored address that can go stale if the borrower side changed hands on the secondary market since origination. The borrower exits by repaying or preclosing, never by buying the lender position.
- **The buyer is re-screened against the loan's *current* borrower.** A sale acceptance runs the same counterparty compliance check the instant-exit direct-sale path already applied — validating the incoming buyer against the loan's continuing borrower, again resolved as the current position-NFT holder rather than the stored origination address. (No effect on the permissionless retail deploy, where these checks are disabled; it keeps the two sale paths consistent for the gated industrial variant.)
- **A listing that outlives its loan is torn down automatically.** If a listed loan reaches a terminal state without a sale — the borrower repays it, it defaults, it is liquidated — the listing is now torn down as part of that terminal step: the lender position NFT is unlocked (so the holder isn't left with a permanently frozen NFT), the dangling sale offer is marked cancelled (so it drops out of the open book and can't be accepted against a loan that no longer exists), and both link directions are cleared. This is wired into the single loan-status transition chokepoint, so *every* terminal path — repay, default, liquidation, internal match — tears the listing down uniformly; none can forget it.
- **The accept preview mirrors the live-bound reality.** The read-only accept preview reads the live loan (not the listing snapshot): it quotes the live principal and collateral the buyer would sign, shows no origination fee for a sale-vehicle acceptance (matching the fee-free execution), and surfaces the two structural blockers — the linked loan is no longer active, or the viewer is the loan's own current borrower — so the UI can disable "Accept" without a wasted transaction. The lender-intent matcher preview gained the same sale-vehicle "non-matchable" signal the offer-matcher preview already had, so an intent solver never submits a fill that always reverts.
- **Upgrade deploys route the internal completion step.** The redeploy tooling now also routes the internal auto-complete entry point (not only the public one), so a diamond refreshed via the facet-redeploy path — not just a fresh deploy — can complete a sale acceptance instead of reverting on an unrouted internal call.

**Phase 1 scope:** lender position-sale is supported for loans with **ERC-20 collateral**. A loan whose collateral is an NFT is rejected at listing for now, because the sale vehicle holds no collateral of its own (it stays on the live loan) and the accept / complete / cancel paths would otherwise try to move an NFT that was never escrowed. NFT-collateral lender-sale is a tracked follow-up (#974).

**User impact:** the position-sale *listing* UI was feature-gated off pending this fix (the instant-exit sell-to-a-buy-offer path was unaffected and stayed available). Re-enabling the listing surface is tracked separately (#927).

Two follow-up correctness fixes from the v2 review: a sale acceptance now charges the **live** loan principal (not the stale offer amount) — the fund movement, the temporary sale-vehicle loan, and its emitted events all use the live value the buyer signed, so a partial-repay drift between listing and acceptance can never make the buyer over- or under-pay. And the accept path now honors the **cancelled-offer** marker: once a stale sale listing is torn down, its offer can no longer be accepted as an ordinary offer.

Closes #951.

## Sanctions-gate coverage sweep — 4 entry points hardened (#921 item 2)

An earlier fix (#953) found that one reward-claim method had slipped through the
protocol's sanctions classification without its screen — proof that the
classification wasn't self-enforcing. This is the follow-up audit: **every**
external method that either creates protocol state or moves value was reviewed
against its intended sanctions posture, and the gaps were closed.

The protocol screens wallets against an on-chain sanctions oracle in two tiers:
**value-creating / value-receiving entry points** screen the acting wallet up
front, while **close-out paths** (repaying, default resolution, liquidation)
stay open so an honest counterparty can always be made whole even if the other
side is flagged — a flagged party's *proceeds* are frozen at the destination
rather than the transaction being blocked. The sweep confirmed the main entry
points were already screened correctly and found four that were not:

- **Backstop eligibility opt-in** — staging an offer for a protocol-treasury-
  backed fill now screens the wallet, so a party flagged after posting its offer
  can no longer line it up for treasury capital.
- **Partial collateral withdrawal** — pulling excess collateral back out of an
  active loan now screens the wallet (this is a discretionary withdrawal, not a
  close-out, so a flagged wallet is simply refused — the collateral stays
  backing the loan and no one is harmed).
- **Parallel-sale listing** — listing an offer's collateral for sale now screens
  both the lister and the sale's fee recipients, matching the equivalent
  per-loan listing flows (this surface had been missed entirely).
- **Swap-to-repay surplus** — when a borrower closes out by swapping collateral
  and the swap returns more than the debt, the surplus owed to a *flagged*
  current holder is now frozen (parked, not handed over) instead of sent straight
  to their wallet. The close-out itself still completes, so the honest lender is
  always made whole. The surplus is parked in the **stored borrower's** vault
  (which always exists, from the collateral posted at origination) rather than the
  current holder's — a freshly-transferred borrower position may belong to a
  wallet that never opened a vault, and the protocol refuses to open one for a
  flagged wallet, so parking it there would have reverted and *bricked* the
  must-complete close-out. It is recorded as its own claimable row so the holder
  can withdraw it through the normal borrower-claim path once they are delisted;
  without that row the frozen principal (a different asset from the loan's
  collateral, which already occupies the borrower's claim slot) would have been
  permanently stuck. If the surplus is VPFI it is also reserved against the
  unstake path until claimed, so the stored borrower can't drain a transferred
  position's proceeds. (Codex #981 P1/P2.)

A **coverage matrix** documenting the classification rule and every method's
verdict now lives at `docs/DesignsAndPlans/SanctionsGateCoverageMatrix.md`, and a
**regression guardrail** pins the fixed entry points so a future edit that drops
one of these screens fails the test suite.

## Close-out sweep completion + frozen-surplus escrow hardening (#981 / Codex #986)

The first pass hardened the swap-to-repay-full **surplus**, but review (#981)
found the same freeze-at-source treatment was missing on five sibling close-out
surfaces. All are now completed through a single shared helper so the
swap-to-repay family cannot drift:

- **Swap-to-repay lender leg** — a lender flagged after origination no longer
  bricks an honest borrower's swap-to-repay close: the lender proceeds are parked
  in the lender's own vault (frozen behind the claim gate) instead of reverting.
- **Collateral pull for a self-flagged borrower** — pulling a flagged borrower's
  own collateral out for the swap (and returning any unspent remainder) now runs
  under the same move-out exemption the other forced close-outs use, so it
  completes rather than bricking. The exemption is deliberately kept *narrow* —
  never open across the external swap.
- **Swap-to-repay partial** — this discretionary, loan-stays-open path now
  screens the direct payees (the current lender and borrower holders) and refuses
  a flagged one outright (a flagged party's must-complete escape is the full
  swap-to-repay, which freezes). Symmetric with ordinary partial repayment.
- **Fusion intent settlement** — the resolver-filled swap-to-repay terminal, which
  previously had no sanctions handling at all, now applies the identical freeze
  pattern (lender leg + surplus) and returns any residual collateral under a
  move-out window.
- **Backstop fill** — the offer creator is now re-screened at fill time, not only
  at eligibility opt-in, so a borrower flagged in the intervening window can't
  have a treasury-funded loan originated to them.

**Frozen-surplus escrow hardening.** Two subtler leaks in the parked-proceeds
model were closed. A frozen surplus is now reserved against the stored party's
spend path for **every** asset (not just VPFI), so a transferred position's
proceeds can't be consumed as offer/intent capital before the rightful holder
claims. Frozen **VPFI** owed to a delistable holder is now kept out of the vault
owner's fee-discount tier via a dedicated counter (scoped precisely so a user's
own pledged/listed VPFI is never wrongly excluded). A surplus-only close (all
collateral consumed) now keeps the loan open until the surplus is claimed, so the
delisted holder can always reach it. And the frozen-surplus lane is surfaced in
the claim read views (per-loan, by position NFT, and in the dashboard) with its
own claim event, so a holder can discover funds that would otherwise be invisible.

Closes #954. Addresses #981.

## Thread — Snapshot the fee rates a loan is born under (#957 / PR #989)

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

## Thread — alpha02 testnet-review findings remediation (#988)

Five fixes from the 2026-07-03/04 live-testnet review, all in the
alpha02 frontend.

**Terminal loans can no longer offer a live Repay (OBS-2).** The
position page previously trusted the indexer row for its action gate,
so with a lagging indexer a loan that had already been liquidated
on-chain still showed a working "Repay this loan" button (the write
would fail confusingly). The page now takes one cheap live status read
and reconciles the row where it is built — badge, action, cards, and
receipts all inherit the on-chain truth, always overriding toward the
more-settled state, with a banner explaining that the lists are
catching up. The repay submit path independently re-checks the live
status and stops with a clear message before any approval or wallet
prompt when the loan is no longer repayable.

**"You need more X" now says how much more (F-005).** Everywhere the
shortfall is computable — the pre-submit balance gate, the eligibility
checklist, and the add-collateral / partial-repay inputs — the message
states the missing amount (e.g. "about 0.002 more WETH") instead of
just naming the asset.

**Secondary-market buyers now see their claims (#958 parity).** The
Claim Center's candidate discovery unions the wallet's indexed loans
with the on-chain enumeration of position NFTs the wallet currently
holds, so a claim attached to a purchased position is found even though
the wallet was never the loan's original party. Chain-discovered loans
are confirmed by the same live ownership + claimability checks as
indexed ones.

**An empty market is now distinguishable from a stale one (F-003).**
The Offer Book, guided matching, and rental browse surfaces show a
"this list last updated N ago and may be behind" note whenever the
indexer's ingest cursor has positively stalled (reusing the freshness
stamp the stats endpoint already serves) — so "no offers right now" is
never confidently rendered from a stalled snapshot. Unknown freshness
shows nothing rather than crying wolf.

**VPFI "warming up" names its target.** While the time-weighted
discount catches up to a fresh deposit, the status card now states the
qualified tier's discount (and the current effective figure when
non-zero) instead of a vague "higher tier".

Also verified with no code change needed: no protocol read path can
fall back to a public RPC endpoint when the per-chain RPC env vars are
set (OBS-1 — the only public fallbacks are the env-unset defaults and
the deliberate mainnet ENS display transport), and the post-write
replica race (F-002) is judged acceptably mitigated by the per-block
live-sync layer plus the submit-time live re-reads every money flow
already performs.

## Thread — alpha02 claimables are on-chain-authoritative (#921 item 7 / #958)

alpha02's Claim Center no longer depends on the indexer to decide what's
collectable. Previously it read the indexer's `/claimables` endpoint
(which lists only terminal statuses) and merged `fallback_pending`
lender loans back in client-side — a gap, because the indexer
deliberately does not mirror `FallbackPending` (it's transient and
reversible, and reversible state doesn't belong on shared indexer infra
that apps/defi also reads).

The Claim Center now works the way apps/defi's already does: the indexer
stays the fast approximate candidate layer (the wallet's own loans via
`useMyLoans`), and the chain is the authority. For each candidate loan
the hook confirms on-chain that the wallet still holds that side's
position NFT (`ownerOf`) and that `getClaimable(loanId, isLender)`
reports an unclaimed, actionable payout (mirroring ClaimFacet's own
guard, including the Phase-5 borrower LIF rebate). A `fallback_pending`
lender loan now surfaces naturally — `getClaimable` reports the
recoverable collateral the claim-time fallback resolves — so the
client-side special-case merge is gone, and a sold or fully-settled
position no longer shows a phantom claim.

The honesty contract is preserved: a per-loan revert means "not
claimable this side" and is excluded, while a transport failure means
"couldn't confirm" and collapses the whole result to unavailable rather
than a confident short list that could hide real funds. The
secondary-market parity gap that existed when this thread started —
a pure position-NFT buyer, never an original party to the loan, wasn't
discovered because the candidate set was only the wallet's own loans —
was closed later in this same batch: the candidate set now unions the
indexed loans with the on-chain position-NFT enumeration
(`getUserPositionLoansPaginated`), so chain-held positions are found
even when the indexer has never heard of the wallet (see the #988
remediation thread).

## Thread — Live block-driven refresh (WebSocket-preferred)

alpha02 now reflects on-chain transactions in the UI within a block
instead of waiting on the 30-second indexer poll. A single mounted
`LiveChainSync` component watches the head block and, on each new block,
invalidates only the transaction-driven query caches (offers, loans,
positions, claimables, vault balances, sale/refinance pendings) —
static config (protocol fees, tier tables, token metadata, curated
lists) is deliberately left alone so a fast block cadence doesn't churn
reads that never move per block. Two transaction-driven surfaces are
deliberately NOT in the block-driven set: per-loan keeper enables and
the VPFI snapshot. Their toggles patch the cache with the mined value
at the call site, and a block-driven refetch through a lagging public
RPC could overwrite that patch with pre-transaction state — they
reconcile via their own interval refetch instead.

The layer is transport-adaptive. When a chain has a WebSocket RPC URL
configured (new optional `VITE_<CHAIN>_WSS_URL` env vars, defaulting to
the HTTP key with `_RPC_URL` → `_WSS_URL`), the wagmi transport wraps it
in a `fallback` ahead of HTTP and viem's block watcher uses
`eth_subscribe('newHeads')` — a true push, so reflection is near-instant.
Without a WS URL it transparently falls back to HTTP block polling
(~4s), still far tighter than the old 30s cadence, and any WS drop
degrades to the HTTP transport without breaking reads. Invalidations are
throttled (min 4s) and pause while the tab is hidden so a burst of blocks
or a backgrounded tab can't storm the indexer. A user's own action still
refreshes its own keys synchronously at the call site, unchanged — this
adds ecosystem-wide freshness (other users' fills, repayments,
liquidations) on top.

Operators opt in per deploy by setting the `_WSS_URL` env vars (e.g. the
dRPC endpoints already in use expose the same path over `wss://`). No
indexer or Worker changes are required.

## Thread — Testnet faucet + oracle/swap mock deploy script

The alpha02 website gains a testnet **faucet**: a dedicated `/faucet`
route where a connected user on a test network can self-mint the mock
assets the review and demo flows need — a liquid test token (`tLIQ`),
an illiquid test token (`tILQ`), and a rentable ERC-4907 test NFT
(`vRENT`) — plus a small "Get test assets" nudge on Home and a
testnet-only sidebar link. The whole surface is **double-gated**: it
does anything only when the read chain's `testnet` flag is set AND the
consolidated deployments bundle carries a `testnetMocks` block for that
chain. On any mainnet slug the route explains itself and points home
instead of exposing an unrestricted `mint`. Writes go straight to the
mock token contracts (not the Diamond); the NFT mint uses a
client-random 256-bit token id so concurrent reviewers never collide.

Alongside it, a new reproducible Foundry script,
`contracts/script/DeployTestnetMocks.s.sol`, deploys the faucet assets
and wires the *faucet's own* liquid tokens into the Diamond's oracle so
"mint tLIQ → it classifies liquid" holds end-to-end: a mock Chainlink
feed + registry and a mock Uniswap-V3 `asset/WETH` pool above the $1M
depth floor per liquid token (Tier 1), plus a **registered
`MockSwapAdapter`** — the venue the Phase-7a HF-liquidation failover
(`LibSwap.swapWithFailover`) actually routes through (Tier 2). The
script seeds that adapter with a float of every liquid faucet token;
for loans in other principals, fund the **`mockSwapAdapter`** address
from `.testnetMocks` (NOT the `ZeroExProxyMock` — that is the legacy
0x-proxy shape, wired for completeness but ignored by the Phase-7a
path). The illiquid token is left unwired on purpose so the in-kind
default flows stay exercisable. The script reuses already-deployed
assets via the `FAUCET_*` overrides (idempotent re-runs) and persists
every address to the per-chain `addresses.json` under a single
`.testnetMocks` object — the exact shape the `TestnetMocks` interface
in `packages/contracts/src/deployments.ts` consumes. Run
`exportFrontendDeployments.sh` afterwards to fold it into the bundle.

Wallet visibility: after a successful ERC-20 faucet mint the banner
offers "Add \<symbol\> to MetaMask" (the standard watch-asset prompt;
declining is not an error), so the minted balance shows up in the
user's wallet immediately. The VPFI page gets the same affordance —
an "Add VPFI to MetaMask" button in the discount-status card, shown
only once the connected user actually holds VPFI in their wallet or
their vault, so nobody is nudged to track a token they don't have.

Base Sepolia already carries the deployed faucet trio (`tLIQ`, `tILQ`,
`vRENT`); the oracle/swap wiring is applied when an operator with the
admin + risk-admin roles runs the script (deployer + admin broadcasts).
Until then the faucet mints work but `tLIQ` reads illiquid — expected,
not a regression. Follow-ups: top up the **`mockSwapAdapter`** float
with output tokens for any loan principal outside the seeded faucet
set before exercising HF liquidation (the legacy `ZeroExProxyMock`
needs no funding — the Phase-7a path ignores it), and run the same
script on Arbitrum Sepolia.

## Thread — Testnet VPFI enablement script

Adds `contracts/script/DeployTestnetVPFI.s.sol`, an operator-run one-shot
that activates the otherwise-dormant VPFI fee-discount surface on a
testnet Diamond so it can be reviewed end-to-end. On a fresh testnet
deploy the VPFI token exists but is not registered in the Diamond
(`getVPFIToken()` returns the zero address), so every discount/tier read
is zero and the `/vpfi` page correctly shows "not available on this
chain".

The script registers VPFI (`setVPFIToken`), points the discount quote at
the (oracle-priced) WETH reference and sets a symbolic testnet
wei-per-VPFI rate, and — from the treasury that holds the full initial
supply on testnet — transfers VPFI to up to four configurable recipient
wallets so they can deposit VPFI and climb the tier ladder (100 / 1,000 /
5,000 / 20,000 VPFI → 10 / 15 / 20 / 24 % fee discount, all on-chain
defaults). It deploys no new contracts and needs no `deployments.json`
change — `vpfiToken` is already recorded, and the token's minter is the
Diamond, so VPFI can only be distributed from the existing treasury
holdings, not freshly minted from an EOA.

Testnet-only (guards the supported testnet chain ids); never a mainnet
slug. Companion to `DeployTestnetMocks.s.sol` (oracle + faucet mocks).
