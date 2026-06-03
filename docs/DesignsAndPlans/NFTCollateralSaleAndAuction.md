# NFT Collateral Pre-Default Sale (T-086 design)

**Status:** Round 4 RATIFIED + SHIPPED (PRs #300 / #302 / #303 / #304 / #307 / #308 / #310 / #312 / #317 / #318 / #319 / #321). · Round 5 RATIFIED via PR #322 (2026-06-02). · **Round 5.1 errata** (this revision) — addresses Codex's post-merge review against `bc55c3f7` (5 P2 — corrected on-chain event names, sim-preflight feasibility, builder math precision, batched-cut deploy requirement). Spec-only; no semantic change to the Round-5 design. · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279) · Round-5 follow-ups: fee-legs [#313](https://github.com/vaipakam/vaipakam/issues/313), auction modes [#309](https://github.com/vaipakam/vaipakam/issues/309) · Multi-marketplace expansion: [#281](https://github.com/vaipakam/vaipakam/issues/281)

> **History:**
> - Round 1 explored four approaches and recommended a Vaipakam-native marketplace.
> - Round 2 pivoted (per user direction) to Seaport ERC-1271 + protocol-controlled post-grace auction (Scenario B).
> - Round 3 dropped Scenario B (per user direction): "post grace period the normal flow should be followed — NFT to lender."
> - Round 3.1 addressed 5 Codex P1s on Round 3 (live-debt line-item, endTime tied to grace, restricted-zone, combined fees, all-transfer-paths lock).
> - **Round 4** absorbed: deep external architectural review (vault-bloat concern; reuse LibERC721.LockReason; LIF settlement seam; conduit allow-list; indexer/ABI/event wiring; intent-based alternative architecture); Codex's 10 inline findings on Round 3.1 (single-boundary spec, default-flow lock exemption, lender-NFT-holder routing, `msg.sender == seaport` zone gate, FULL_RESTRICTED order type, consent default flip, liquid-vs-illiquid post-grace branch). **Shipped end-to-end** through steps 1–15 + the OpenSea integration (step 14) + the atomic terminal-cleanup follow-up (#317) + the Seaport.cancel emit (#316). Operator action remaining: D1 migration + OPENSEA_API_KEY provisioning + `VITE_AGENT_ORIGIN` on the deployed dapp build.
> - **Round 5** (this revision) absorbs the two Round-4 deferrals the deployed v1 left open:
>   - **Fee-legs for fee-enforced collections** (Issue [#313](https://github.com/vaipakam/vaipakam/issues/313); Codex round-1 P1 finding on PR #312). The 3-leg canonical shape works for collections that don't enforce protocol or creator fees on Seaport orders; for collections that do (royalty-enforcing collections + OpenSea's own protocol-fee model), the OpenSea Listings API rejects orders that omit the required fee legs. The on-chain order is still fillable via direct `Seaport.fulfillOrder`, but the OpenSea-UI surface is lost. Round 5 extends the canonical shape to N consideration legs (**up to 7 — 3 protocol legs + up to 4 fee legs, MAX_FEE_LEGS = 4**) so fee-enforced collections gain OpenSea-UI coverage.
>   - **Borrower-driven auction modes** (Issue [#309](https://github.com/vaipakam/vaipakam/issues/309); explicitly out-of-scope per Round 4 §12 line 347). For unique / illiquid NFTs, fixed-price posting is a price-discovery guess. Round 5 adds a Dutch path on Seaport (native `startAmount > endAmount` decay on the borrower leg) and a pragmatic English-via-OpenSea-Offers path (borrower watches incoming offers; `updatePrepayListing` lets them re-sign at the offer's price for a single-tx fill). Both modes coexist with the existing fixed-price flow; the borrower picks per listing.
>
> Round 4 kept the Round-3 thesis (third-party Seaport, pre-default only, lender's default-flow expectation untouched) and corrected the architecture so the per-borrower UUPS vault stays a thin custodian. **Round 5 preserves every Round-4 invariant** — the same lender-debt-coverage, the same `FULL_RESTRICTED` order type, the same grace-window boundary, the same vault-as-custodian custody model. The extensions are purely additive to the canonical order shape + facet posting surface.

## 1. Problem statement

Today a borrower whose NFT (ERC721 or ERC1155) sits as collateral in a Vaipakam Vault has only two exits:

1. **Repay in full** — settle the loan from their own wallet, vault releases the NFT back.
2. **Default** — let grace expire, NFT goes to the lender (`DefaultedFacet.markDefaulted` for illiquid NFT collateral; `RiskFacet.triggerLiquidation` for liquid assets).

There's no path to **realize the NFT's market equity** while the loan is live. A borrower with an NFT worth substantially more than the loan can't unlock the difference except by paying off the loan first (which is the thing they couldn't do) or defaulting (which forfeits the equity).

The "Auction to prepay loan" UX captures this: a single button on the borrower's loan card that posts the collateral NFT for sale on a third-party marketplace (OpenSea v1; multi-marketplace expansion via Issue #281), with proceeds flowing into the protocol-enforced settlement waterfall.

**Scope of this v1: pre-default only.** The listing window spans from loan-init through `loan.gracePeriodEnd` (inclusive of grace). When grace expires with no settled sale, the listing is cancelled and today's default flow runs:
- **Illiquid NFT collateral** → `DefaultedFacet.markDefaulted` (NFT to lender, existing flow unchanged).
- **Liquid collateral** (ERC721/1155 with both a Chainlink feed AND a deep AMM pool — see `OracleFacet`) → `RiskFacet.triggerLiquidation` (HF-based liquidation via 0x/1inch swap, existing flow unchanged).

Per-loan-type fallback branching is preserved exactly as today; this design adds no new code path on the post-default side.

ERC721 + ERC1155 both supported in v1 (full-balance only for ERC1155 — `FULL_RESTRICTED` Seaport order type; partial sales deferred).

## 2. Threat model

What MUST be preserved:

- **Collateral lock invariant.** While a loan is active, the vault MUST NOT release the NFT to anyone except (a) the borrower on full repayment, (b) the lender on default, or (c) a Seaport-approved conduit pulling the NFT atomically with a Seaport-routed payment that lands in the settlement waterfall.
- **Vault stays a thin custodian.** The per-borrower UUPS vault (`VaipakamVaultImplementation` + ERC1967Proxy per borrower) MUST NOT carry Seaport-specific logic, ERC-1271 implementation, zone-callback logic, or live-debt math. It exposes ONE new narrow Diamond-gated entry point (§4) for the listing flow. Per-borrower proxy code growth is real (every borrower in production carries a copy) and audit-surface growth on the custody contract is high-risk.
- **Marketplace-approval invariant.** Seaport-conduit operator approval on the collateral NFT MAY be granted only to addresses in a **governance-managed allow-list** (rotated via guardian + admin role + events on every rotation). NEVER to an EOA. NEVER to a hard-coded address (so a future conduit compromise doesn't become a permanent backdoor).
- **Settlement waterfall ordering.** Lender position-NFT holder paid first (principal + accrued interest), then treasury (combined `treasuryFee + precloseFee`), then borrower position-NFT holder (remainder). Enforced by Seaport's `consideration` items, not a separate post-sale distribution.
- **No equity dilution.** Lender consideration must cover live debt at fill time — partial lender settlement is forbidden (Seaport-revert on shortfall).
- **Settlement-time finality.** A successful Seaport fill MUST atomically: (a) transfer payment per consideration; (b) transfer NFT to buyer; (c) mark the loan `Settled` in vault storage; (d) settle the LIF / VPFI-discount rebate per `LibVPFIDiscount.settleBorrowerLifProper(loan)` — this is a **proper close**, not a default. Per CLAUDE.md, missing this seam causes the "every loan stuck active" indexer drift and VPFI rebate accounting incidents.
- **Lender default-flow expectation preserved.** If grace expires with no settled sale, the existing per-collateral-type default branch runs unchanged.
- **Consent capture.** `allowsPrepayListing` is an explicit, frozen-at-acceptance Offer/Loan flag, defaulting to **`false` (opt-in)** so integrators that omit the field can't silently enable the path.

What can be relaxed (vs. today):

- The "NFT only ever leaves the vault to repayer-or-lender" invariant — the sale path adds a third class of authorized recipient (the Seaport-routed buyer). Atomic; protocol-enforced.

Out of threat-model scope:

- Seaport / OpenSea protocol compromise — trust root, same as the rest of the NFT ecosystem.
- Borrower listing below market — borrower's choice; not a protocol failure.

## 3. Why operator delegation to the borrower fails

Granting the vault's `approve(borrower, tokenId)` on the collateral NFT lets the borrower call `transferFrom(vault, anyAddr, tokenId)` and walk the collateral out — collateral lock broken with no settlement.

The safe pattern is **vault approves the audited Seaport conduit** (a contract whose code we trust via governance allow-list + audit), not the borrower's EOA. The conduit can pull the NFT iff a matching paid Seaport order is being filled. The conduit cannot route the NFT elsewhere.

## 4. Architecture — facet + listing executor, NOT vault-injected

**Round 3.1 mistake corrected:** earlier rounds proposed putting ERC-1271 `isValidSignature` + Seaport zone `validateOrder` directly inside `VaipakamVaultImplementation`. That bloats every per-borrower proxy, expands the custody contract's audit surface, and ties future Seaport evolution to a vault upgrade. The Round-4 architecture mirrors the existing `PrecloseFacet` / `EarlyWithdrawalFacet` pattern: heavy lifting in facets + a dedicated singleton executor; vault gets one narrow instruction.

### 4.1 Components

1. **`NFTPrepayListingFacet`** (new Diamond facet, ADMIN-gated entry points + borrower-NFT-holder-gated user entry points)
   - `postPrepayListing(loanId, askPrice)` / `updatePrepayListing(loanId, newAskPrice)` / `cancelPrepayListing(loanId)`
   - `cancelExpiredPrepayListing(loanId)` (permissionless, callable after `block.timestamp ≥ loan.gracePeriodEnd`)
   - Computes the live floor, validates the askPrice + buffer, calls the **listing executor** to sign the Seaport order, calls the **vault** to grant per-token Seaport-conduit approval, sets the position-NFT lock via the existing `LibERC721._lock`.

2. **`CollateralListingExecutor`** (new singleton contract, NOT per-borrower)
   - Implements **ERC-1271 `isValidSignature`** (Seaport's signature gate at match time). Read-only; recomputes live debt at `block.timestamp`, validates the order's `consideration` line items against the live floor + lender-position-NFT-holder + treasury + borrower-position-NFT-holder, and verifies `block.timestamp < loan.gracePeriodEnd`.
   - Implements **Seaport zone `validateOrder`** (Seaport's post-fill state-mutation callback). REQUIRES `msg.sender == seaport` (the canonical Seaport address from the conduit-allow-list mapping). On a valid fill: marks the loan `Settled`, releases the position-NFT lock, calls `LibVPFIDiscount.settleBorrowerLifProper(loan)`, fires the same settled-loan events the existing `RepayFacet` terminal path fires.
   - Stores `orderHash → loanId` mapping at sign time so the zone can look up the right loan in `validateOrder`.
   - Is the **Seaport offerer** for prepay orders (vault transfers the NFT to the executor at sign time? OR vault retains custody and approves the conduit?). **See §4.3 below — vault retains custody.**
   - Singleton: deployed once, governance-controlled. Upgradeable via UUPS so Seaport-version upgrades or conduit rotations don't require per-borrower-vault changes.

3. **`VaipakamVaultImplementation`** — gets ONE new narrow Diamond-gated entry:
   - `setCollateralOperatorApproval(address nftContract, uint256 tokenId, address conduit, bool approved)` — wraps `IERC721.approve(conduit, tokenId)` (or `setApprovalForAll` for ERC1155, scoped to the conduit only) on the collateral NFT contract. Only callable by the Diamond (via the listing facet). The conduit address must be in the governance-managed allow-list.
   - That's it. Vault has zero new logic; it's the same thin custodian it is today.

4. **`LibERC721` extension** — add `LockReason.PrepayCollateralListing` to the existing enum. Lock + unlock the borrower-position NFT via the existing `_lock` / `_unlock` machinery. **Plus** a one-line fix to `LibERC721.setApprovalForAll` to call `_requireNotLockedForOwner(msg.sender)` (a new helper that reverts if the caller owns any locked token; uses a per-owner `lockedTokenCount` counter incremented in `_lock` / decremented in `_unlock`). This closes the gap Codex L118 flagged: today's `_lock` already protects `transferFrom` and `approve` but `setApprovalForAll` is unguarded.

5. **Offer + Loan struct extension** — `allowsPrepayListing` flag, default `false` (strict opt-in; see §7).

### 4.2 Conduit allow-list

**Round 5.1 errata note:** the Round-4 design draft described the allow-list as Diamond-stored with a single `ApprovedConduitSet` event. The shipped Round-4 code (PRs #300 / #303) chose to place the allow-list on the `CollateralListingExecutor` singleton instead — a cleaner trust boundary since the executor is the only caller that consults the list at sign + fill time — and emits a pair `ConduitApproved(address)` / `ConduitRevoked(address)` rather than a single set event. The Round 5.1 errata text below describes the shipped reality; the Round-4 design-intent prose was retired but is summarised here as the rationale for why the dapp watcher (§15.10(E)) subscribes to executor-emitted events.

The `CollateralListingExecutor` singleton stores a governance-managed `mapping(address conduit => bool approved) public approvedConduits`. Admin entry points on the executor (called by the deploy multisig → governance timelock post-handover):

- `addApprovedConduit(address conduit)` — `onlyOwner` (Round-4); emits `ConduitApproved(conduit)`.
- `removeApprovedConduit(address conduit)` — `onlyOwner`; emits `ConduitRevoked(conduit)`.

The diamond's `NFTPrepayListingFacet` validates against `executor.approvedConduits(conduit)` via a view call before invoking the vault's narrow approval setter. The vault itself performs ONLY the raw `IERC721.approve` (or `setApprovalForAll` for ERC1155) write — its natspec explicitly says the diamond MUST pre-validate the conduit (Round 5.1 errata — Codex P2 line 99: the design draft mistakenly said the vault itself does the allow-list lookup; the shipped Round-4 vault is the thin-custodian model from §4.1 invariant 2 and does NOT carry executor-state-reading logic). The executor's `validateOrder` re-checks `approvedConduits[ctx.conduit]` at fill time so that a conduit removed AFTER a borrower's sign-time write cannot still route a fill — defense-in-depth against a future-compromised conduit.

In short: validation is **facet-side at sign time + executor-side at fill time**; the vault is the custody-only data plane.

### 4.3 Vault is the offerer (because vault holds the NFT); ERC-1271 is a thin delegate

**Round 4.1 correction.** Earlier Round 4 said the executor was the offerer while the vault held custody — that contradicts Seaport's offer-transfer semantics (Seaport transfers offer items FROM the order's `offerer` address; if offerer ≠ holder, the transfer reverts). Round 4.1 corrects:

- **`VaipakamVaultImplementation` IS the offerer** because it holds the NFT.
- Vault implements ERC-1271 as a **thin 5-line delegate**:

```solidity
function isValidSignature(bytes32 hash, bytes memory) external view returns (bytes4) {
    address exec = LibVaipakamStorage.s().orderHashToExecutor[hash];
    if (exec == address(0)) return 0xffffffff; // INVALID
    return IListingExecutor(exec).isOrderValid(hash) ? 0x1626ba7e : 0xffffffff;
}
```

- `CollateralListingExecutor` (singleton) is the **Seaport zone** (still). The zone callback (`validateOrder`) is called by Seaport AFTER the offer + consideration transfers complete; the zone mutates loan state (marks settled, releases lock, calls LIF settlement). Zone ≠ offerer in Seaport; they can be different contracts.

The vault's ERC-1271 is 5 lines + one storage mapping (`orderHashToExecutor[hash] → executor`). It does NOT contain live-debt math, recipient validation, or grace-time checks — those stay in the executor. The vault grows by ~5 lines of audit surface; the heavy logic stays in the executor.

**New vault entries (Diamond-gated):**
- `setCollateralOperatorApproval(nftContract, tokenId, conduit, approved)` — already in Round 4
- `registerListingOrderHash(orderHash, executor)` — called by the listing facet at sign time; populates `orderHashToExecutor` so the vault's ERC-1271 can delegate
- `revokeListingOrderHash(orderHash)` — called on cancel / expire / successful fill

Vault keeps custody throughout: at sign time, vault grants per-token Seaport-conduit approval for the collateral NFT; at fill time, Seaport pulls the NFT from the vault using the conduit's approval; at zone callback, the executor mutates loan state and the lock releases. No NFT ever transfers vault→executor.

### 4.4 What this architecture is NOT

- NOT an intent-based protocol with off-chain signed intents + permissionless solvers (see §11 Alternative architecture below — that's the v2 direction worth exploring once v1 lands).
- NOT a Vaipakam-native marketplace (Round 1 rejected).
- NOT a vault-injected ERC-1271 (Rounds 3 / 3.1 were heading there; Round 4 corrects).

## 5. Settlement semantics

### 5.1 Sale authority binds to current position-NFT holders, not stored addresses

Both rules apply:

- **Borrower side:** `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` are authorized iff `msg.sender == borrowerNFT.ownerOf(loan.borrowerNftId)`. NOT `loan.borrower` (a snapshot of the original EOA).
- **Lender side:** the Seaport order's lender `consideration` recipient is set to `lenderNFT.ownerOf(loan.lenderNftId)` at order-sign time, AND re-checked in the executor's `isValidSignature` at fill time (in case the lender position-NFT transferred between sign and fill — the executor re-derives the recipient and rejects if the signed consideration doesn't match). This mirrors the existing `RepayFacet` / `ClaimFacet` pattern that already routes lender economics to the lender-position holder, not a snapshot address.
- `cancelExpiredPrepayListing` is permissionless.

### 5.2 Live-debt enforcement at the line-item level

ERC-1271 (called by Seaport at match time) recomputes:

```
liveFloor(loanId, block.timestamp)
    = principal + accruedInterest(block.timestamp)
    + (treasuryFeeBps + precloseFeeBps) × accruedInterest(block.timestamp) / 10000
```

The signed order's `consideration[0].endAmount` (lender amount) MUST be `≥ principal + accruedInterest(block.timestamp)`. The signed order's `consideration[1].endAmount` (treasury amount) MUST be `≥ (treasuryFeeBps + precloseFeeBps) × accruedInterest / 10000`. The total of `consideration[0] + consideration[1] + consideration[2]` (borrower remainder) MUST equal the order's signed price.

If any line item is below the live floor, ERC-1271 returns invalid → Seaport rejects the match. The borrower must `updatePrepayListing` (which re-signs with the live amounts) before a fill can succeed. The 2% buffer at listing time gives ~hours-of-fillability headroom depending on APR.

### 5.3 Borrower-position NFT transfer-lock via existing `LibERC721.LockReason`

Round 4 reuses the existing machinery. `LibERC721.LockReason` is extended:

```solidity
enum LockReason { None, PrecloseOffset, EarlyWithdrawalSale, PrepayCollateralListing }
```

The listing facet calls `LibERC721._lock(loan.borrowerNftId, LockReason.PrepayCollateralListing)` on `postPrepayListing` and `LibERC721._unlock(loan.borrowerNftId)` on `cancelPrepayListing` / successful Seaport fill (via the executor's zone callback) / `cancelExpiredPrepayListing`.

**Gap fix in LibERC721:** today's `_lock` clears `tokenApprovals[tokenId]` but NOT `operatorApprovals[owner][*]`. Today's `_requireNotLocked` is called from `transferFrom` and `approve` but NOT from `setApprovalForAll`. Result: an attacker-operator approved BEFORE the lock can `transferFrom` immediately after the lock releases on cancel. Fix:

1. Add `_requireNotLockedForOwner(address owner)` helper that reverts if `owner` has any locked token. Uses a new per-owner `lockedTokenCount` counter incremented in `_lock` / decremented in `_unlock`. O(1) check.
2. Call `_requireNotLockedForOwner(msg.sender)` from `setApprovalForAll`.

This patch is small (counter + one check) and tightens existing Preclose / EarlyWithdrawal flows too — the same gap exists there.

### 5.4 Default-flow lock-bypass

`DefaultedFacet.markDefaulted` and `RiskFacet.triggerLiquidation` need to transfer / burn the borrower-position NFT as part of their existing flows. Per Codex L92, a naive lock would block default until `cancelExpiredPrepayListing` runs — adding a liveness dependency.

**Resolution:** `markDefaulted` / `triggerLiquidation` call `LibERC721._unlock(borrowerNftId)` as their first step if the lock is `PrepayCollateralListing` — releasing the lock atomically with the default trigger. Other lock reasons (Preclose, EarlyWithdrawal) continue to behave as today (those flows have their own lifecycle). The unlock is unconditional once `block.timestamp ≥ loan.gracePeriodEnd` (which is the precondition for `markDefaulted` anyway), so there's no new liveness risk.

### 5.5 Settlement waterfall — Seaport consideration items

```
Seaport order:
  offerer:        CollateralListingExecutor (singleton)
  zone:           CollateralListingExecutor (same; receives validateOrder callback)
  orderType:      FULL_RESTRICTED  (REQUIRED — partial fills forbidden, see §5.6)
  startTime:      block.timestamp at sign
  endTime:        loan.gracePeriodEnd  (Seaport rejects fills past this — belt-and-braces)
  offer:
    [collateral NFT (ERC721 single token OR ERC1155 with full-balance amount)]
  consideration:
    [lender:    principal + accruedInterest                              → lenderNFT.ownerOf(loan.lenderNftId)]
    [treasury:  (treasuryFeeBps + precloseFeeBps) × accruedInterest/10000 → s.treasury]
    [borrower:  askPrice - lender - treasury  (≥ 0)                       → borrowerNFT.ownerOf(loan.borrowerNftId)]
```

Three properties Seaport enforces atomically: lender-debt-coverage (consideration items must all clear); NFT-exit-on-payment (NFT pulled iff payment routed); waterfall ordering.

### 5.6 FULL_RESTRICTED order type

Seaport's `restricted` family includes `FULL_RESTRICTED` (no partial fills) and `PARTIAL_RESTRICTED` (partial fills allowed). For ERC721 (offer is 1 NFT) partial doesn't make sense. **For ERC1155, partial would let a buyer acquire only some of the vaulted balance and still trigger the settlement callback** — closing the loan with partial payment. Per Codex L176 / L208, the spec MUST require `FULL_RESTRICTED` for both ERC721 and ERC1155 listings.

`CollateralListingExecutor` constructs only `FULL_RESTRICTED` orders. ERC1155 partial-balance sales remain out-of-scope for v1.

### 5.7 On-chain loan finalization — zone `validateOrder` with critical checks duplicated

Per Codex L179, `validateOrder` MUST require `msg.sender == seaport` (the canonical Seaport address). Otherwise an arbitrary external caller could force-close a loan by invoking the zone directly.

**Round 4.1 additional defence (Codex L123 catch):** Seaport's `validate()` function allows pre-registration of a signed order on-chain; subsequent fulfillments SKIP the `isValidSignature` callback. If someone calls `Seaport.validate(order)` after sign time, the vault's ERC-1271 delegate never runs at fill time → live-debt + recipient + grace checks bypassed.

**Resolution:** the same critical checks the ERC-1271 path runs MUST be duplicated in the zone callback. The zone callback fires for restricted orders REGARDLESS of pre-validation state, so checks here are not bypassable.

```solidity
function validateOrder(ZoneParameters calldata params) external returns (bytes4) {
    require(msg.sender == SEAPORT, "Not Seaport");

    // Round 4.1: look up the loan + conduit pinned at sign time.
    OrderContext memory ctx = orderContext[params.orderHash];
    require(ctx.loanId != 0, "Unknown order");
    require(approvedConduits[ctx.conduit], "Conduit no longer approved");
    require(loans[ctx.loanId].status == Active, "Loan not active");

    // Round 4.1: re-derive the live floor + recipients at THIS block.
    //  Defence against Seaport.validate() pre-registration which would
    //  bypass the ERC-1271 callback.
    uint256 floor = LibCollateralSettlement.liveFloor(ctx.loanId, block.timestamp);
    require(params.consideration.length == 3, "Bad consideration shape");
    require(
        params.consideration[0].amount >= principalPlusAccruedInterest(ctx.loanId),
        "Lender short-paid"
    );
    require(
        params.consideration[1].amount >= treasuryAndPrecloseFee(ctx.loanId),
        "Treasury short-paid"
    );
    require(
        params.consideration[0].recipient ==
            lenderNFT.ownerOf(loans[ctx.loanId].lenderNftId),
        "Wrong lender recipient"
    );
    require(
        params.consideration[2].recipient ==
            borrowerNFT.ownerOf(loans[ctx.loanId].borrowerNftId),
        "Wrong borrower recipient"
    );
    require(block.timestamp < loans[ctx.loanId].gracePeriodEnd, "Grace expired");

    // Atomic with Seaport's fill: lender + treasury + borrower paid; NFT exited.
    loans[ctx.loanId].status = Settled;
    LibERC721._unlock(loans[ctx.loanId].borrowerNftId);
    LibVPFIDiscount.settleBorrowerLifProper(loans[ctx.loanId]);  // ← LOAD-BEARING per CLAUDE.md
    emit LoanRepaid(ctx.loanId, /* via Seaport-prepay path */);

    return MAGIC_VALUE;
}
```

**Round 4.1 storage change (Codex L97 catch):** the `orderHashToLoan` mapping is extended to `orderHashToContext` storing `(loanId, conduit)` — so the zone can verify the conduit is still in the governance allow-list at settlement time. Without this, a conduit removed from the allow-list after sign time would still fill orders signed before removal.

The LIF settlement is the seam your external reviewer flagged. Every proper-close terminal path in this codebase (RepayFacet, PrecloseFacet direct + offset, RefinanceFacet) calls `LibVPFIDiscount.settleBorrowerLifProper(loan)`. A successful Seaport fill IS a proper close — so MUST call it. Missing it produces stuck-active loans + VPFI rebate accounting drift (the exact failure mode CLAUDE.md documents).

The `cancelExpiredPrepayListing` path does NOT call `settleBorrowerLifProper` — that's correct: it just releases the lock + cancels the Seaport order; the loan stays `Active` until the existing `markDefaulted` / `triggerLiquidation` machinery runs, at which point those facets call `forfeitBorrowerLif(loan)` (bad-path) as they do today.

## 6. Consent capture model

ONE flag on the Offer struct (visible to lender at acceptance), frozen into the Loan struct:

- `allowsPrepayListing` — pre-default borrower-initiated listing is allowed. **Default: `false` (strict opt-in)** — resolves Codex L191's contradiction (default-true silently enables the path for any integrator that omits the field).

The facet's `postPrepayListing` / `updatePrepayListing` revert if `!loan.allowsPrepayListing`. Cancellation paths are always allowed regardless of the flag.

Backward compatibility: existing loans (pre-this-PR) have `allowsPrepayListing = false` on the Loan struct (today's behavior preserved). New offers can opt in via the offer UI.

A lender who specifically wants the chance to receive the NFT directly on default (no third-party sale interfering) declines offers where `allowsPrepayListing == true`. Default of `false` means most lender behavior is preserved unless both sides explicitly consent.

## 7. ERC721 vs ERC1155

ERC721: standard Seaport offer shape; `FULL_RESTRICTED`.

ERC1155: offer specifies the full vaulted balance for that loan; `FULL_RESTRICTED` is REQUIRED (else a partial-balance fill would close the loan with partial payment — §5.6).

For v1: **full vaulted balance only**. Partial-balance sales deferred.

## 8. Boundary, race, and timestamp semantics

**Single boundary:** `loan.gracePeriodEnd`. The listing window is `[loan.initBlock, loan.gracePeriodEnd)`. Earlier rounds had wording inconsistency ("pre-grace only" while enforcement used grace end) — Round 4 standardizes on `gracePeriodEnd` everywhere.

**Authoritative boundary semantics (verified against existing code):**

| Path | Valid when | Source |
|---|---|---|
| `RepayFacet.repayLoan` | `block.timestamp <= gracePeriodEnd` | `RepayFacet.sol:283` rejects `> graceEnd` |
| `DefaultedFacet.markDefaulted` | `block.timestamp > gracePeriodEnd` | `DefaultedFacet.sol:217` rejects `<= graceEnd` |
| `RiskFacet.triggerLiquidation` (liquid) | HF < 1.0 OR `block.timestamp > gracePeriodEnd` | Existing flow unchanged |
| Seaport fill via this design (executor zone) | `block.timestamp < gracePeriodEnd` (endTime exclusive) | This design |

The three paths are **mutually exclusive across the boundary** with no same-block overlap:

- `block.timestamp < gracePeriodEnd`: repayment valid, Seaport fill valid, default invalid.
- `block.timestamp == gracePeriodEnd`: repayment STILL valid (last valid block), Seaport fill invalid (Seaport `endTime` is exclusive — match rejects on `>= endTime`), default invalid.
- `block.timestamp > gracePeriodEnd`: repayment invalid, Seaport fill invalid, default valid.

**Round 4.1 fix:** my earlier wording said `markDefaulted` becomes callable at `block.timestamp == gracePeriodEnd`. That was wrong — the existing code rejects until `block.timestamp > gracePeriodEnd`. Doc corrected to match.

**Same-block race protection (post-grace):** between `gracePeriodEnd` and the first `markDefaulted` call, anyone can call `cancelExpiredPrepayListing(loanId)` — it's the permissionless safety net that releases the lock even if no one has triggered the default yet.

## 9. Consent + indexer + ABI wiring (sequencing prerequisite)

Per CLAUDE.md and the indexer event-coverage script (`apps/indexer/scripts/check-event-coverage.mjs`), any new `state-change/loan-mutation` event must either be handled in `apps/indexer/src/chainIndexer.ts` OR consciously allow-listed in `DELIBERATELY_NOT_HANDLED` with a one-line reason. The new prepay-listing flow produces events on:

- `postPrepayListing` → `PrepayListingPosted(loanId, askPrice, orderHash)` — `state-change/loan-mutation`
- `updatePrepayListing` → `PrepayListingPosted` (overwrite shape) — `state-change/loan-mutation`
- `cancelPrepayListing` → `PrepayListingCancelled(loanId, orderHash, reason)` — `state-change/loan-mutation`
- `cancelExpiredPrepayListing` → `PrepayListingCancelled(loanId, orderHash, GraceExpired)` — same event with reason variant
- Successful Seaport fill (zone callback) → reuses existing `LoanRepaid` (or equivalent terminal event) — `state-change/loan-mutation`

Each event carries the `@custom:event-category state-change/loan-mutation` natspec tag so the guardrail picks it up.

**Sequencing additions** (vs Round 3.1):
- New step: add `NFTPrepayListingFacet` to `DiamondFacetNames.cutFacetNames()` + `SelectorCoverageTest._populateRoutedSet()` + `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` + `HelperTest.sol`.
- New step: run `bash contracts/script/exportFrontendAbis.sh` after the contract surface lands; commit the regenerated ABI JSONs.
- New step: typecheck `apps/{defi,keeper,indexer,agent}` after the ABI regen.
- New step: extend `apps/indexer/src/chainIndexer.ts` with handlers for the new events (or allow-list with rationale).

## 10. Open questions for ratification

1. **Native ETH vs ERC20 sale price** — Seaport's `consideration` items are token-typed. Should askPrice be ETH-only or also accept stablecoin? My default: ETH-only for v1, multi-asset deferred.
2. **The 2% buffer — protocol-configurable?** Governance-configurable, initialized to 200 bps. (My default.)
3. **OpenSea listing API integration boundary** — Vaipakam-run relayer vs frontend-side post-sign API call. **Operator-trust implications**: relayer = new infra + keys + monitoring; frontend-call = user takes a second action, mirror-cancel UX critical. Stale listings on OpenSea's book after on-chain cancel are a UX + minor grief vector. **Open and substantive.**
4. **Pre-deploy event-coverage migration** — adding the new events to `apps/indexer` is straightforward but needs migration coordination (D1 schema additions if any historical-listing surface lands too). Tracked here so it's not forgotten.

## 11. Alternative architecture worth naming (v2 direction)

**"Delegated signed intent + protocol solver."** The borrower (position-NFT holder) produces a signed EIP-712 intent: *"sell collateral X for ≥ live floor, with this consideration split, expiring at grace end."* The on-chain facet stores the intent hash + emits it. A permissionless solver (keeper, searcher, or even the frontend) constructs a valid Seaport order satisfying the intent and submits it via a thin protocol-owned bridge seller. The zone (or a post-fill hook) verifies the intent signature + on-chain conditions before calling the normal settlement path.

**Advantages:**
- Decouples the protocol from Seaport's exact callback model and order shape — Seaport upgrades or schema changes don't require facet upgrades.
- Multi-marketplace fan-out (Blur + Seaport + LooksRare) becomes a **solver choice**, not an on-chain listing choice. Solver competes to fill at the best price.
- Vault stays completely unchanged except for the narrow approval setter.

**Disadvantages:**
- More moving parts; replay protection on intents; potential MEV on the solver side; slightly more complex atomicity arguments.
- More design work to specify the intent schema, solver authorization, and the bridge-seller pattern.

Closer to modern intent-based designs (UniswapX, CowSwap, Bungee). Would make the multi-marketplace expansion (Issue #281) substantially cheaper later. **Worth a 1-2 page sketch as a v2 direction even if the direct zone path wins for v1 liquidity.**

## 12. Out of scope (deferred)

- Cross-chain NFT sales — NFTs aren't bridgeable in the general case.
- ~~Dutch / English / Vickrey auctions beyond fixed-price.~~ **Round 5 moves Dutch + English in-scope (§15). Vickrey-style sealed-bid auctions remain deferred.**
- Bid aggregation across marketplaces (v1 = OpenSea only; multi-marketplace via #281).
- Partial-balance ERC1155 sales — `FULL_RESTRICTED` only.
- Refinance / preclose during an active listing — mutually exclusive (listing must be cancelled first).
- **Post-grace protocol-controlled auction** (Round 2's Scenario B; Round 3+ dropped).
- **Lender-side tail-window optionality at grace expiry** (a v2 enhancement; the 23h-on-OpenSea / 24h-for-lender buffer with governance-configurable cool-down — designed in Round 3 but not v1-scope).
- **Intent-based protocol solver architecture** (§11; v2 direction).
- **Vickrey / sealed-bid auctions** — incompatible with OpenSea's offer-book UI; requires a custom commit-reveal surface. Deferred indefinitely.

## 13. Sequencing

1. **Ratify this Round-4 design** (this PR — `@codex review adversarial design-doc`; address any remaining findings; merge).
2. **`LibERC721` extensions** — add `LockReason.PrepayCollateralListing`, `_requireNotLockedForOwner` helper + `lockedTokenCount` counter, gate `setApprovalForAll` with the new helper. Comprehensive unit tests.
3. **`LibCollateralSettlement` floor formula** — `liveFloor(loanId, asOfTimestamp)` returning the closed-form pre-default floor. Unit tests.
4. **Extend Offer + Loan structs** — add `allowsPrepayListing` flag, default `false`. **MUST land before step 6 OR step 6 must hard-revert on missing flag.**
5. **`CollateralListingExecutor` singleton** — implements ERC-1271 + Seaport zone with `msg.sender == seaport` gate. Routes lender to lender-NFT-holder, treasury to s.treasury, borrower to borrower-NFT-holder. Calls `LibVPFIDiscount.settleBorrowerLifProper` in the zone post-fill path. Order construction helpers (FULL_RESTRICTED, endTime = gracePeriodEnd). UUPS upgradeable, ADMIN-owned (→ timelock + multisig post-handover).
6. **`NFTPrepayListingFacet`** — `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing`. Authority gated on `borrowerNFT.ownerOf(loan.borrowerNftId) == msg.sender`. Listing-lock via `LibERC721._lock(LockReason.PrepayCollateralListing)`. Gated on `loan.allowsPrepayListing == true`. ERC721 first; ERC1155 in step 9.
7. **Vault narrow entry** — `VaipakamVaultImplementation.setCollateralOperatorApproval(nftContract, tokenId, conduit, approved)`. Diamond-gated; conduit must be in the governance-managed allow-list.
8. **Conduit allow-list admin** — `addApprovedConduit` / `removeApprovedConduit` on the `CollateralListingExecutor` singleton (Round 5.1 errata — Codex P2 line 92: the Round-4 design draft proposed these on `AdminFacet` with guardian + `ADMIN_ROLE`; the shipped Round-4 code placed them on the executor with `onlyOwner` per the trust-boundary rationale in §4.2). Emits `ConduitApproved(address)` / `ConduitRevoked(address)` on every rotation. Owner is the admin multisig at deploy time → governance timelock post-handover; no Diamond-side facet role for this surface.
9. **Diamond facet + selector wiring** — `DiamondFacetNames.cutFacetNames()`, `SelectorCoverageTest`, `DeployDiamond.s.sol`, `HelperTest.sol`. Pre-deploy guardrails pass.
10. **Default-flow lock-bypass** — `DefaultedFacet.markDefaulted` + `RiskFacet.triggerLiquidation` call `LibERC721._unlock(borrowerNftId)` as their first step if the lock reason is `PrepayCollateralListing`.
11. **ABI export + consumer typechecks** — `bash contracts/script/exportFrontendAbis.sh`; `pnpm --filter @vaipakam/{defi,keeper,indexer,agent} exec tsc -b --noEmit`. Frontend imports the new selectors.
12. **Indexer event coverage** — extend `apps/indexer/src/chainIndexer.ts` with handlers for `PrepayListingPosted` / `PrepayListingCancelled`. `pnpm --filter @vaipakam/indexer check-event-coverage` passes.
13. **Frontend "Auction to prepay loan" UI** — borrower-side listing post + cancel + browse; listing-status banner on the loan card.
14. **OpenSea API integration** — listing-publish relayer OR frontend post-sign API call (per ratified open Q #3). Mirror-cancel logic.
15. **ERC1155 extension** — facet handles full-balance offers; `FULL_RESTRICTED` enforced.
16. **(Separate follow-up — Issue #281)** Multi-marketplace expansion.
17. **(Separate v2 design exploration)** Alternative intent-based architecture (§11) — 1-2 page design sketch; not v1-scope.

Each step is a separate PR. Steps 1-5 foundational; step 6 delivers the borrower-facing flow; steps 7-10 wire the vault + admin + default exemption; steps 11-12 finalize ABI + indexer; step 13 ships the UI; step 14 wires OpenSea; step 15 extends ERC1155; steps 16-17 are follow-ups.

This is meaningfully more steps than Round 3.1 because Round 4 added: the governance allow-list (step 8), the indexer event coverage (step 12), and the default-flow exemption (step 10). The architectural correctness improvements justify the extra wiring; the per-borrower-vault stays clean.

---

# Round 5 additions

> The remainder of this doc is the **Round 5** addendum — fee-legs handling (§14, Issue [#313](https://github.com/vaipakam/vaipakam/issues/313)) and auction modes (§15, Issue [#309](https://github.com/vaipakam/vaipakam/issues/309)). Round 4 (§1–§13) describes the shipped v1.

## 14. Fee-legs for fee-enforced collections (Issue #313)

### 14.1 The gap Round 4 left open

The Round-4 canonical order shape (§5.5) hard-codes exactly three consideration legs: lender, treasury, borrower. For NFT collections that DO NOT enforce protocol fees or creator royalties on Seaport orders, this works end-to-end — the borrower's listing publishes on OpenSea, a buyer fills, settlement waterfall completes.

For collections that DO enforce fees (most modern royalty-respecting collections + every collection on OpenSea's "required fees" list), the OpenSea Listings API rejects orders that omit the required fee legs at submission time. On-chain, the order is still valid + fillable via a direct `Seaport.fulfillOrder` call (Vaipakam's executor doesn't care about OpenSea's fee schedule), but the OpenSea-UI surface is lost — buyers can't discover or fulfill the order through OpenSea's marketplace.

Round 5 closes this gap by extending the canonical shape to allow **up to 7 consideration legs** — the 3 protocol legs plus up to 4 fee legs (OpenSea protocol fee + up to 3 creator-side recipients for collections with artist splits / DAO shares; see §14.5 for the cap rationale). The extension is purely additive — collections that don't enforce fees continue to use the 3-leg form unchanged.

### 14.2 Economic model — borrower pays the fees

The fee legs come out of the **borrower's remainder**, not the lender or treasury legs:

```
askPrice = lenderLeg                 (live floor at sign-time)
         + treasuryLeg               (live floor share at sign-time)
         + sum(feeLegs)              (OpenSea + royalty, denominated in askPrice * bps / 10000)
         + borrowerRemainder         (residual to borrower-position-NFT holder)
```

Rationale: the borrower is the party choosing to use OpenSea-UI as their distribution channel. Lender + treasury legs are protocol invariants and stay coverage-checked at fill time. Fee legs are the borrower's cost-of-distribution. The dapp surfaces the trade-off in the post UI ("at 7.5% combined fees on a $X ask, your remainder is $Y").

An alternative considered: split fees between lender + borrower. Rejected — it muddies the lender-coverage invariant (lender would need to opt into accepting fee dilution at offer-acceptance time) and breaks the clean `_assertOrderContent` separation between protocol-required and discretionary legs.

### 14.3 Fee-rate source — OpenSea Collection API at post time

OpenSea exposes a per-collection fee schedule on the Collection API response at `https://api.opensea.io/api/v2/collections/{slug}`; the response body carries a `fees` array of `{recipient, basis_points, required}` entries (Codex P3 line 519 — there is no separate `/fees` sub-route). The fee schedule is borrower-supplied at post time (the dapp fetches it before constructing the order); fee-rate freshness is the dapp's responsibility.

Fresh-fetch trade-offs considered:
- **Per-post fetch (chosen).** Dapp calls the OpenSea API on every `postPrepayListing` click — the rate is at most one HTTP round-trip stale, and a borrower whose listing rejects at submission can simply re-post.
- D1-cached with daily refresh — rejected. A stale snapshot could route a creator-royalty leg to a recipient OpenSea has since rotated, causing OpenSea-side rejection AND draining the borrower's remainder to a dead recipient.
- On-chain (ERC-2981 `royaltyInfo`) — rejected for v1 because OpenSea's protocol fee leg isn't ERC-2981-derivable; it's an OpenSea policy parameter. Could land as a defense-in-depth cross-check in v2 (compare borrower-supplied royalty leg against ERC-2981 read; reject if recipients diverge).

The dapp's pre-flight on a fee-enforced collection:
1. Fetch `/api/v2/collections/{slug}` via the agent Worker proxy (CORS-blocked direct browser call → routes through `apps/agent` with `OPENSEA_API_KEY` server-side). The fee schedule is in the response body's `fees` array (per OpenSea's current Collection API shape — NOT a separate `/fees` sub-endpoint).
2. Filter to entries where the marketplace enforces a non-zero `basis_points` — Round 5 v1 includes only required fees; optional fees are skipped to keep the borrower's remainder maximal.
3. Compute leg amounts: `feeAmount[i] = askPrice * feeBps[i] / 10000`.
4. Construct the canonical order with `consideration[3..]` = fee legs.
5. Post on-chain via `postPrepayListing` (extended signature, §14.5).
6. Submit to OpenSea Listings API — succeeds because required fee legs are present.

### 14.4 Executor validation — relax 3-leg cap; keep coverage checks

Round 5 changes to `CollateralListingExecutor._assertOrderContent`:

- **Length check relaxed.** Was: `consideration.length == 3`. Now: `3 ≤ consideration.length ≤ 3 + MAX_FEE_LEGS = 7`.
- **Lender + treasury coverage checks unchanged.** Indices 0 + 1 remain the lender + treasury legs; their recipients + minimum amounts validate against live floor exactly as in Round 4 §5.7.
- **Borrower leg index unchanged.** Index 2 remains the borrower-remainder leg routed to `borrowerNftOwner`.
- **Fee legs at indices 3 … (3 + feeLegsCount - 1).** Each MUST use the loan's `principalAsset` (same ERC20 as the protocol legs). Each MUST have a non-zero amount. **Recipients are NOT validated against an on-chain allowlist** — this is the key simplification. A borrower who lies about fee recipients (e.g., routes a "fake" royalty leg back to themselves) gains nothing economically (the leg is paid from their own remainder; they receive what they would've received anyway minus the extra ERC20-transfer gas), and gains nothing on the OpenSea side (OpenSea's submission-time fee enforcement is what catches mis-stated fees, not the on-chain executor).

The executor's job is to protect the protocol's economics (lender + treasury + grace + lock). Whether the borrower's remainder is paid as one leg or split across self-attributed fee legs is a borrower-side detail with no protocol consequence.

**Known griefing vector — "ghost listing" via reverting fee recipient.** A borrower can set a fee recipient to a contract address whose `receive()` / token transfer hooks revert. Such a listing PASSES every sign-time check (`_assertOrderContent` doesn't transact; it just verifies shape) AND publishes on OpenSea (OpenSea's API doesn't simulate transfers). Any `Seaport.fulfillOrder` attempt reverts during the fee-transfer phase, leaving the listing "visible but unfillable." A malicious borrower could use this to grief buyers (waste their simulation gas) or to force their loan toward a default outcome the lender prefers — e.g., a lender who specifically wants the underlying NFT can collude with a borrower-controlled "fee" address to deliberately stall the sale path.

The protocol's safety invariants hold regardless: the borrower-position-NFT lock + the default-flow lock-bypass (§5.4) ensure `DefaultedFacet.markDefaulted` runs at grace expiry, the lender receives the NFT, and the failed-fill state has no residual effect. So this is a UX / discovery-cost vector, not a solvency vector.

Mitigation surface (dapp-side, NOT contract-side):

- **Attack surface is narrower than the original prose suggested, with two distinct categories of recipient-validating tokens (Round 5.1 errata — Codex P2 line 446 + Codex round-5 P2 line 450).** A plain `IERC20.transfer` on a vanilla ERC20 does NOT invoke the recipient contract's `receive()` or any other recipient-side hook — only native-ETH transfers do, and only for `receive()`/`fallback()`. BUT two classes of supported principalAsset tokens can still revert based on recipient:
  - **Blocklist-style tokens** — token-side compliance logic that fails on specific addresses (USDC's OFAC blocklist; some stablecoins' freeze-account checks; jurisdictional-compliance ERC20s).
  - **Hook-enabled ERC20-compatible tokens** — ERC777 (calls `tokensReceived` on the recipient via ERC1820 registry), ERC1363 (`onTransferReceived` callback), and a small set of "ERC20-with-callback" wrappers that pass type-check on the executor's `assetType == ERC20` gate AND can have their `transfer` reverted by a hostile recipient's hook code. The protocol's principalAsset registration does NOT reject these — the executor's `_assertOrderContent` only checks `itemType == ERC20`, not "vanilla ERC20 with no recipient hook." So a borrower whose loan principal is e.g. an ERC777 wrapper CAN deliberately pick a recipient contract whose `tokensReceived` reverts, producing the exact ghost-listing vector the §14.4 mitigation exists to surface.
  For the typical unhooked ERC20 (DAI, WETH, vanilla wrappers, most lending-protocol tokens), a transfer to ANY non-zero address succeeds and the "ghost listing" vector via transfer-revert structurally cannot apply. The agent's recipient-validating-token allow-list (below) MUST include BOTH categories so the pre-flight covers hook-enabled tokens, not just blocklist tokens.
- **Sim-transfer pre-flight MUST use state-DIFF overrides on the sender's balance** to be feasible at all (Round 5.1 errata; corrected in round-5 from generic "stateDiff/stateOverride"). A naive `eth_call` from the agent (a zero-balance address) hits the principalAsset's sender-balance check first and reverts there — producing a false positive on every recipient regardless of whether the recipient itself would have rejected. Corrected pattern: the agent issues `eth_call` with a **`stateDiff`** payload (NOT `stateOverride`) that PATCHES the sender's balance slot. Generic `stateOverride` REPLACES the account's storage, which for proxy tokens (USDC, USDT) wipes out the implementation/admin slots and produces a broken simulation. `stateDiff` preserves the rest of storage. Viem: `simulateContract({ stateOverride: [{ address: token, stateDiff: { [slot]: value } }] })` — the OUTER param is named `stateOverride` but the INNER per-account field MUST be `stateDiff`, not `state`. Ethers / `eth_call` JSON-RPC: use `stateDiff` field per the `eth_call` 3rd-positional-arg spec.
- **Balance-slot computation is token-specific (Round 5.1 errata — Codex P2 line 449).** Writing into a token's balance mapping requires knowing the storage SLOT INDEX of that mapping in the token contract's layout; the index is NOT exposed in the ERC20 ABI and varies across implementations: standard OZ ERC20 uses `slot 0` for `_balances`; USDC's mainnet implementation is a proxy whose storage layout puts the balance mapping at a different slot; tokens using ERC-7201 namespaced storage compute the slot via the namespace recipe; some custom tokens hold balances in a packed struct. So "look up `slot_index` and override" is under-specified.
- **Required per-token agent config (Round 5.1 errata).** The agent's recipient-validating-token allow-list (described next) MUST carry, for each entry, **the resolved balance-slot identifier** (a single uint256 for straight-mapping layouts; the ERC-7201 namespace hash for namespaced layouts; a small `(slot, packOffset)` tuple for packed-struct layouts). Operators populate the slot via one of three methods at config-time (NOT at request-time, since slot computation requires either source or storage probing):
  1. Read the token's verified Etherscan source + extract the mapping declaration position (e.g. `mapping(address => uint256) private _balances;` is the first storage variable → slot 0 for a contract with no inherited state);
  2. Use Foundry's two-step probe (Round 5.1 errata — Codex P2 line 455): `cast index address <holder_addr> <candidate_slot>` first computes the mapping-entry slot via `keccak256(abi.encode(holder, candidate_slot))`, then `cast storage <token> <computed_slot> --rpc-url <rpc>` reads the value at that slot. **Linear-scan `<candidate_slot>` over `0..N` for `N≈30`** (Round 5.1 errata round-2 — Codex P2: storage slots are NOT ordered by holder balance or any monotonic property, so binary search structurally cannot work — every slot must be probed individually). The slot whose computed-storage equals the holder's `balanceOf(holder)` return value is the right one. **The probe MUST use a holder with a known NON-ZERO balance** (Round 5.1 errata round-3 — Codex P2 line 455: a zero-balance holder reads zero from every untouched mapping entry AND from every unrelated slot, so the scan would pick the first zero-returning slot — almost always the wrong slot. Pick a known whale address for the token: Etherscan's "Top Holders" tab for mainnet, the Anvil fork's pre-funded address for local rehearsals, or a faucet address for testnets. **Additionally, the operator MUST verify the chosen slot by writing a state-override and confirming `balanceOf(holder)` changes accordingly**: `cast call <token> "balanceOf(address)" <holder> --override-state-diff <token>:<computed_slot>:<test_value> --rpc-url <rpc>` (Round 5.1 errata round-5 — Codex P2 line 458: the correct flag is `--override-state-diff`, NOT `--override-state`. `--override-state` REPLACES the entire account's storage with just `{slot: value}` — for proxy tokens like USDC that's catastrophic because it removes the proxy implementation pointer + admin slots, leaving `balanceOf` to fail or read through broken state even with a correct candidate slot. `--override-state-diff` PATCHES just the named slot, preserving the rest of storage; this is the right primitive for slot verification on any proxy / stateful token) — if the returned balance equals `<test_value>`, the slot is correct; if not, the slot is wrong and the operator continues the scan. This positive-verification step closes the false-positive failure mode of accepting a wrong slot at face value). The single-command form `cast storage <token> <addr>` does NOT do mapping resolution — it treats the second argument as a raw slot number, so it would either return the wrong storage or revert; the two-step `cast index` + `cast storage` pattern is required.
  3. Reuse a published registry (e.g. `defi-wonderland/erc20-balance-slot` or similar community-maintained mapping). For each supported chain × supported token combination, the value lives in the agent's wrangler config under `RECIPIENT_VALIDATING_TOKENS[chainId][token].balanceSlot`. New tokens require an operator config update; the registry is intentionally not derivable at runtime to avoid an unbounded fallback that silently produces false positives.
- **The pre-flight lives on a dedicated endpoint, NOT on `/opensea/collection/{slug}` (Round 5.1 errata round-3 — Codex P2 line 457).** `/opensea/collection/{slug}` is a pure Collection API proxy and only has access to the collection slug + the fee schedule it returns; the sim-transfer needs the loan's `principalAsset` (which the proxy doesn't know), the chain/token allow-list entry, a state-overridable sender address, and the computed fee amounts (which depend on the borrower's gross ask, not on the collection alone). The agent exposes a SEPARATE endpoint `POST /opensea/feeRecipientPreflight` that takes `{chainId, principalAsset, askPrice, feeLegs: [{recipient, basisPoints}]}` from the dapp (the dapp computes the amounts client-side from the Collection API response + the gross ask before posting), runs the state-override sim-transfer for every recipient on the `recipient-validating-token allow-list AND with a populated balanceSlot`, and returns per-recipient verdicts `[{recipient, verdict: "passed" | "rejected_by_token" | "not_applicable"}]`. Block A.7 specifies both endpoints; the Collection proxy stays narrow.
- For tokens NOT on the list — OR on the list but missing a `balanceSlot` (e.g. a newly-added entry not yet populated) — the per-recipient verdict is `"not_applicable"` (NOT a false-confident "passed"). The borrower may still publish either way; this is informational defense-in-depth, not a gate.
- **Hook-token operator-discrimination caveat (Round 5.1 errata round-5 — Codex P2 line 460).** For hook-enabled tokens (ERC777 / ERC1363 / similar), the recipient's hook is called with `operator` AND `from` (and other context — see [EIP-777](https://eips.ethereum.org/EIPS/eip-777)). The sim-transfer's `from` address is the agent's chosen state-override sender (a deterministic test address that is NEITHER the eventual Seaport buyer NOR the borrower's vault); a hostile fee recipient can write a hook that accepts the test sender + rejects only the real Seaport/conduit operator at fill time, producing a green-check sim and a ghost listing simultaneously. The pre-flight cannot perfectly simulate this for hook tokens because the eventual buyer's address is unknown at post-time. Two-pronged mitigation:
  1. The per-recipient verdict for hook-enabled tokens is downgraded to `"passed_sender_specific"` (NOT `"passed"`) so the dapp UI surfaces the residual uncertainty: "this recipient accepts a test transfer — does NOT guarantee the actual buyer's transfer will succeed."
  2. The agent additionally runs a "common operator" rotation: it tries the sim with a few representative from-addresses (the executor singleton, the canonical Seaport address per chain, a known whale, the borrower's vault) and reports each. Any rejection on any of the representative sender set downgrades the overall verdict to `"rejected_by_token"`. This catches naive sender-discriminating reverts but cannot catch a sophisticated attacker who specifically allows-list all the sim senders + rejects only the random EOA buyer who happens to fulfill at fill time.
- The hook-token uncertainty is acknowledged in the spec rather than worked around because there is no on-chain primitive that lets us know the buyer's address before they sign + broadcast their fulfillment. The dapp's UI explainer for `"passed_sender_specific"` makes this honest to the borrower. Implementation reference: viem's `simulateContract` + `stateOverride` parameter (with `stateDiff` per-account field), or the matching ethers `provider.call({ stateOverrides })` pattern.
- The `apps/defi` post UI shows the appropriate signal: "✓ checked" / "⚠ rejected by token" / "not applicable" + a one-click "publish anyway" override for the flagged case, plus a brief inline explainer for non-applicable so borrowers understand the absence of a green check isn't an alarm.

Contract-side hard-gates (e.g., "fee recipients must be EOAs") are explicitly rejected — most legitimate royalty recipients are contracts (multisigs, 0xSplits, OpenSea's fee collector). Banning contract recipients would break legitimate fees on most royalty-respecting collections.

### 14.5 Contract surface changes

**`NFTPrepayListingFacet`** — extended posting signature. One unified `FeeLeg` struct works for both fixed-price and Dutch modes; fixed-price callers pass `startAmount == endAmount` and Seaport's amount interpolation collapses to a constant. Dutch callers (§15.2) pass `startAmount > endAmount` for proportional decay.

```solidity
struct FeeLeg {
    address recipient;
    uint96 startAmount;     // amount at order.startTime;  non-zero
    uint96 endAmount;       // amount at order.endTime;    non-zero
}

function postPrepayListing(
    uint256 loanId,
    uint256 askPrice,
    uint256 salt,
    bytes32 conduitKey,
    FeeLeg[] calldata feeLegs       // NEW — 0 to MAX_FEE_LEGS (=4) entries
                                    //       for fixed-price, callers set
                                    //       startAmount == endAmount.
) external returns (bytes32 orderHash);

function updatePrepayListing(
    uint256 loanId,
    uint256 newAskPrice,
    uint256 newSalt,
    bytes32 newConduitKey,
    FeeLeg[] calldata feeLegs       // NEW — same shape; same MAX cap
) external returns (bytes32 newOrderHash);
```

**Why uint96 amounts.** Each fee leg fits in 2 storage slots with `(address recipient: 20B) + (uint96 startAmount: 12B)` packing into slot 0 and `(uint96 endAmount: 12B) + (20B pad)` in slot 1. `uint96` covers 7.9 × 10^28 wei per leg — vastly above any realistic fee amount for any ERC20. The facet's bounds-checked narrowing cast on input mirrors the existing `LoanIdOverflow` / `AskPriceOverflow` pattern from `CollateralListingExecutor`.

**Buffer + fees math precision (Grok finding B).** The Round-4 facet's `_requireAskCoversFloor(askPrice, lenderLeg, treasuryLeg, cfgPrepayListingBufferBps)` was written against the 3-leg world: it checks `askPrice ≥ (lenderLeg + treasuryLeg) × (1 + bufferBps/10000)`, i.e. the gross ask covers protocol legs PLUS the 2% fillability buffer (so a tiny floor drift doesn't immediately fail the order's coverage check). Under N-leg, the validation rule the facet MUST enforce is:

- `lenderLeg + treasuryLeg + sum(feeLegs.startAmount) + borrowerLeg.startAmount == askPrice` (sum-of-considerations equality for the start state),
- `lenderLeg × (1 + bufferBps/10000) + treasuryLeg × (1 + bufferBps/10000) + sum(feeLegs.startAmount) ≤ askPrice`, equivalently `borrowerLeg.startAmount ≥ (lenderLeg + treasuryLeg) × bufferBps / 10000`. The buffer applies ONLY to the protocol legs — fee legs are fixed amounts the borrower agreed to pay; they're not subject to drift like the live-floor protocol legs are.
- `borrowerLeg.startAmount ≥ 0` after the buffer math (already implied by the above; spelled out so the facet error message is clean).

Naively applying the old `_requireAskCoversFloor` to gross ask and THEN deducting fees can produce a negative borrower remainder. The Block A facet validation step (A.2) explicitly enforces the above rule, not a copy of the 3-leg formula.

**Backwards compatibility — explicit selector replacement (Codex P1, line 644).** Adding `FeeLeg[]` to `postPrepayListing` / `updatePrepayListing` changes both Solidity selectors. The diamondCut sequencing CANNOT treat this as "no new selectors":

1. The new selectors (with `FeeLeg[]`) must be ADDED via `diamondCut(.., FacetCutAction.Add)`.
2. The old selectors (without `FeeLeg[]`) must be REMOVED via `diamondCut(.., FacetCutAction.Remove)`. Old four-argument callers are NOT ABI-compatible with the new shape.
3. `DiamondFacetNames.cutFacetNames()` is unchanged (same facet), but `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` MUST be updated to emit the new selectors; `SelectorCoverageTest._populateRoutedSet()` mirrors it.
4. Frontend ABI re-export (`exportFrontendAbis.sh`) + consumer typecheck cycle picks up the breaking signature change as a TS compile error — consumers (apps/defi, apps/indexer, apps/agent) are co-updated.

No wrapper functions retained for old callers — the only on-chain consumer was the Round-4 dapp + indexer, both being co-updated. A clean ABI break is cleaner than a permanent legacy selector.

**`LibPrepayOrder`** — `_components` accepts an optional `feeLegs` array, appends them to the `consideration` array after the borrower leg. Each fee leg's `(startAmount, endAmount)` flows directly into the corresponding `ConsiderationItem.startAmount / endAmount` so Seaport's native interpolation handles Dutch decay without any custom executor math.

**`CollateralListingExecutor.OrderContext`** — extended to record the **full `FeeLeg[]` array** AND the auction-mode-specific fields (`endAskPrice`, `auctionEndTime`, mode tag). The #316 `_tryCancelOnSeaport` path rebuilds the canonical `OrderComponents` at cleanup time and forwards `Seaport.cancel`; that reconstruction needs every signed input that fed into the original hash — including each fee leg's recipient + start + end amounts AND the Dutch decay parameters, since Seaport's `getOrderHash` is a one-way cryptographic digest and cannot be inverted.

Storage cost per recorded listing (each FeeLeg = 2 slots, see "Why uint96 amounts" above):

| Mode | Fields added beyond #316's 4-slot baseline | Total slots (MAX_FEE_LEGS = 4) |
| --- | --- | --- |
| Fixed-price, 0 fee legs | none — `FeeLeg[]` length slot reads zero | 4 |
| Fixed-price, 4 fee legs | +1 length slot + 4 legs × 2 slots = +9 | 13 |
| Dutch, 0 fee legs | +1 slot (`endAskPrice uint128 \| auctionEndTime uint64 \| mode flag uint8`) | 5 |
| Dutch, 4 fee legs | Dutch +1 + fee +9 | 14 |

Worst-case 14 slots × ~20K gas per cold SSTORE ≈ 280K gas added to the post path. Acceptable for a pre-launch architecture; if this proves too costly at scale, v2 can move fee-leg storage to a separate keccak256-keyed sub-mapping (one SLOAD per leg at cancel time) instead of the inline dynamic-array layout.

**Hard cap on fee legs.** `MAX_FEE_LEGS = 4` enforced by the facet's validation. Four covers the realistic worst case — collections with artist splits or DAO shares typically have 3+ royalty recipients in addition to OpenSea's protocol fee; OpenSea's Collection API returns the full required-fees array, and a cap of 2 (the original sketch) would exclude legitimate collections from the OpenSea-UI surface. The executor's iteration cost (linear scan, ~3K gas per extra leg) is dwarfed by Seaport's per-consideration-transfer cost; the cap is primarily a DoS bound, not a gas-budget bound. If OpenSea's schedule ever requires more than 4 required legs, lift the cap in a follow-up.

### 14.6 Dapp + agent + indexer changes

- **`apps/agent`** — new `/opensea/collection/{slug}` proxy endpoint returning the full Collection API response body (the `fees` array lives inside; no separate `/fees` sub-route — consistent with Block A.7 and §14.3's API correction). CORS-locked, rate-limited, uses server-side `OPENSEA_API_KEY`.
- **`apps/defi`** — `useNFTPrepayListing` hook fetches the fee schedule at post time; pre-fills the post UI with computed fee amounts + the resulting borrower remainder. Borrower can NOT override the fees (would cause OpenSea rejection); the UI is read-only on fee fields.
- **`apps/indexer`** — `prepay_listings` table grows two columns: `fee_legs_json` (the recorded fee schedule) + `borrower_remainder` (denormalized for analytics). `PrepayListingPosted` event payload carries the **full `FeeLeg[]` array as event data** (NOT just an indexed `feeLegsRoot` hash) — the indexer needs the recipient + amounts to populate `fee_legs_json` from the chain log in the autonomous-fallback publish path (when the borrower's browser closed between tx-confirm and the dapp's POST). A hashed root would force a separate fetch + decode trip and break the indexer's "self-contained log" invariant. The legs are NOT indexed (no topic-hash filtering needed); they ride as ABI-encoded data.
- **OpenSea API publish** — `apps/agent`'s `POST /opensea/listing` accepts the extended consideration array as-is; the indexer's `openseaPublish.ts` fallback path same.

### 14.7 Out of scope for Round 5 fee-legs

- ERC-2981 cross-check (defense-in-depth — v2).
- Splitting fees between lender + borrower (rejected — see §14.2).
- Optional (non-`required`) OpenSea fees — borrower pays only required fees in v1.
- Fee schedules for non-OpenSea marketplaces — multi-marketplace per #281.
- Caching the per-collection fee schedule on-chain — would need a keeper-driven refresh, deferred to v2 alongside the multi-marketplace work.

## 15. Auction modes — Dutch + English (Issue #309)

### 15.1 Why the Round-4 "fixed-price-only" decision needs revisiting

For floor-priced collections (high-volume PFPs, common 1/1s with active markets), fixed-price posting is a low-friction UX — the borrower picks the current floor + 2% buffer and the listing fills reliably within hours. For UNIQUE / illiquid NFTs (1-of-1 art, low-trade-volume PFPs, collections with thin order books), the Round-4 flow forces the borrower to guess the market: too-high asks sit stale through the grace window and force a default fallback; too-low asks leave equity on the table.

Round 5 adds two auction modes that coexist with Round 4's fixed-price flow. The borrower picks per listing — the modes are orthogonal to the fee-legs work (§14), the lock model (§5.3), and the grace boundary (§8).

### 15.2 Mode A — Dutch decay on Seaport (on-chain only)

Seaport's `OrderComponents` natively supports linear price decay across the order's `startTime → endTime` window via `startAmount > endAmount` on each consideration item. Round 5 uses this to decay the **borrower-remainder leg** linearly from `startAmount = borrower_max` down to `endAmount = borrower_min` while keeping lender + treasury legs FIXED at the projected-max floor at `endTime`.

Why fix lender + treasury at the projected-max-floor:
- Lender + treasury legs must cover live floor at fill time (Round-4 invariant). Live floor monotonically increases with accrued interest **assuming the floor formula's governance inputs (treasuryFeeBps, precloseFeeBps, etc.) stay fixed.**
- If those legs decayed alongside the borrower leg, a late fill would under-pay lender + treasury — executor-revert.
- Fixing them at the floor projected at `endTime` (the latest possible fill, under sign-time governance config) guarantees lender + treasury are always over-covered **for any t < endTime where governance params haven't moved.** The over-coverage is absorbed by the borrower remainder (smaller decayed payout).

**Governance-mutation qualifier.** This coverage guarantee holds ONLY while the floor formula's governance inputs (treasuryFeeBps, precloseFeeBps, the live floor formula itself) stay unchanged between signing and fill. A mid-auction `ConfigFacet.setFeesConfig(...)` call that raises `treasuryFeeBps` (Round 5.1 errata — the shipped surface bundles treasury + loan-initiation fees under one setter, not a discrete `setTreasuryFeeBps`) raises the live floor; the signed `lenderLeg + treasuryLeg` may then under-cover, and the executor's fill-time check reverts (`Lender short-paid` / `Treasury short-paid`). Protocol safety is preserved — there's no under-payment, just an unfillable auction — but the listing is effectively frozen until the borrower pays gas to `updatePrepayListing` with new projections. v1 explicitly ACCEPTS this trade-off. See §15.10(A) for the dapp-side mitigation.

**Alternative considered + rejected: freeze sign-time governance params into `OrderContext` + re-derive floor against the frozen values at fill time.** Would eliminate the mid-auction gov-bump revert (auction stays fillable under the original params). Rejected for two reasons:

1. **A later governance DECREASE in fees would let a listing keep filling at an above-current-policy protocol take.** If treasuryFeeBps drops from 200 → 100 bps mid-auction, fills against the frozen sign-time 200 bps would over-pay treasury — borrower remainder dilutes for no reason and the protocol can't honour the freshly-published lower take.
2. **Storage + derivation cost.** Recording the resolved `lenderLeg + treasuryLeg` curve (parameterized by the frozen fee params + the live debt formula's input slots) would add ~3 slots to `OrderContext` AND require the executor to carry a snapshot of the fee formula's implementation pointer (or reach into a stored bps tuple and re-derive). The pinned-max-at-endTime model (current §15.2) achieves the same lender + treasury coverage guarantee with fewer slots and one floor read per fill.

The "live read at fill time + observable re-sign banner on `ConfigFacet.FeesConfigSet` events" model (Round 5.1 errata — corrected from the design draft's `TreasuryFeeBpsSet` to the actual shipped event name) keeps the executor's coverage check as the single source of truth and acknowledges drift via UX, not via stale-param settlement.

Posting interface (Codex P3 line 554 — declare both post + update here so the canonical ABI is in one place):

```solidity
function postPrepayDutchListing(
    uint256 loanId,
    uint256 startAskPrice,        // total order value at startTime
    uint256 endAskPrice,          // total order value at endTime (≥ projected lender + treasury at endTime)
    uint256 auctionEndTime,       // > block.timestamp + MIN_AUCTION_WINDOW, ≤ loan.gracePeriodEnd
    uint256 salt,
    bytes32 conduitKey,
    FeeLeg[] calldata feeLegs     // §14.5 unified shape; startAmount may differ from endAmount
                                  // (fees decay alongside the borrower leg on Dutch)
) external returns (bytes32 orderHash);

function updatePrepayDutchListing(
    uint256 loanId,
    uint256 newStartAskPrice,
    uint256 newEndAskPrice,
    uint256 newAuctionEndTime,
    uint256 newSalt,
    bytes32 newConduitKey,
    FeeLeg[] calldata feeLegs
) external returns (bytes32 newOrderHash);
```

The update entry point is required (Codex P2 line 668) so the borrower can recover from §15.10 drift (governance bump, lender-NFT rotation, conduit revoke, etc.) without `cancelPrepayListing` + `postPrepayDutchListing` — which would release and re-take the lock, opening a brief griefing window where someone could try to re-list against the same NFT. Atomic rotation keeps the lock continuous, the borrower-position NFT stays bound to the in-flight auction at all times.

Per-leg derivation at sign time (Codex P2 line 546 — fee legs need explicit start/end amounts, NOT bps; the unified `FeeLeg` shape in §14.5 already carries both):
- `lenderLeg.startAmount = lenderLeg.endAmount = liveFloor.lenderShare(loanId, auctionEndTime)` (projected lender share at `endTime` under sign-time governance config)
- `treasuryLeg.startAmount = treasuryLeg.endAmount = liveFloor.treasuryShare(loanId, auctionEndTime)`
- Each `FeeLeg[i]` is borrower-supplied (computed by the dapp from `bps[i] × startAskPrice / 10000` and `bps[i] × endAskPrice / 10000` for OpenSea-required fee schedules) and flows through unchanged. The executor recomputes nothing here — Seaport's native interpolation between `feeLegs[i].startAmount` and `feeLegs[i].endAmount` produces the live amount at fill time, and OpenSea's marketplace UI accepts the order if its fee enforcement sees the right `bps × currentPrice` ratio at submission. The contract surface carries amounts, not bps, because amounts are what Seaport hashes into the order.
- `borrowerLeg.startAmount = startAskPrice - lenderLeg.startAmount - treasuryLeg.startAmount - sum(feeLegs[i].startAmount)`
- `borrowerLeg.endAmount = endAskPrice - lenderLeg.endAmount - treasuryLeg.endAmount - sum(feeLegs[i].endAmount)`

Sign-time invariants the facet enforces before any state mutation:
- `auctionEndTime > block.timestamp + MIN_AUCTION_WINDOW` (with `MIN_AUCTION_WINDOW = 1 hour` as the starting v1 floor — protects against accidentally posting an already-expired or sub-block-window auction that locks the borrower's NFT but can never fill).
- `auctionEndTime ≤ loan.gracePeriodEnd` — auction window cannot extend past grace.
- **Start-state solvency (Codex P2 line 591):** `startAskPrice ≥ lenderLeg + treasuryLeg + sum(feeLegs.startAmount)` — borrower remainder at `startTime` must be ≥ 0. Without this, a Dutch listing with large upfront fees could underflow the `borrowerLeg.startAmount = startAskPrice − lenderLeg − treasuryLeg − sum(feeLegs.startAmount)` derivation before the borrower-monotonicity check below has a chance to flag a malformed input.
- `endAskPrice ≥ lenderLeg + treasuryLeg + sum(feeLegs.endAmount)` — borrower remainder at `endTime` must be ≥ 0.
- `startAskPrice ≥ endAskPrice` — total order value monotonicity.
- `feeLegs[i].startAmount ≥ feeLegs[i].endAmount` for every fee leg — Seaport per-item monotonicity.
- **Derived borrower-leg monotonicity (Codex P2 line 577).** The above are NOT sufficient: it's possible to construct a parameterization where fee amounts decay FASTER than the total ask, leaving `borrowerLeg.startAmount < borrowerLeg.endAmount` — which would violate Seaport's per-item monotonicity on consideration[2] specifically. The facet MUST also explicitly check `borrowerLeg.startAmount ≥ borrowerLeg.endAmount` after deriving both values. Without this check, a malformed dapp call could produce a Seaport order that's rejected at fill time with a confusing per-item interpolation error rather than a clean sign-time revert.

**Seaport order `endTime` for Dutch (Grok finding C).** The signed `OrderComponents.endTime` for a Dutch listing MUST be `auctionEndTime`, NOT `loan.gracePeriodEnd`. This is what stops Seaport's native amount interpolation at the intended auction close — past `auctionEndTime`, Seaport rejects the order at submission as expired and no fill is possible. The on-chain `prepayListingOrderHash` binding + the borrower-position-NFT lock persist until explicit cancel or `cancelExpiredPrepayListing` (callable after `gracePeriodEnd`). This means the Dutch listing has TWO terminal-time boundaries layered:

- **Seaport-side `auctionEndTime`** — interpolation stops, no further fills accepted by Seaport regardless of zone state.
- **Protocol-side `gracePeriodEnd`** — the lock + listing bookkeeping persist; the borrower can `cancelPrepayListing` or re-list with a new Dutch shape at any t < gracePeriodEnd; permissionless `cancelExpiredPrepayListing` becomes callable at gracePeriodEnd.

The facet's post-time check still enforces `auctionEndTime ≤ loan.gracePeriodEnd` so the Seaport boundary never exceeds the protocol boundary. The dapp's loan-card UI surfaces both boundaries: "Auction ends in 3h (no more fills); grace ends in 18h (cancel available)."

Executor validation at fill time:
- Same `_assertOrderContent` as §14.4 (length 3–7 — up to 3 protocol legs + up to 4 fee legs, types, recipients, lender + treasury coverage).
- Coverage check compares lender + treasury legs against `liveFloor(block.timestamp)`, NOT against the projected-max. Since the projected-max ≥ live floor at any t < endTime AND governance config stayed unchanged, coverage is always satisfied. Under a mid-auction governance bump, the check correctly reverts (see "Governance-mutation qualifier" above + §15.10(A)).
- Grace check unchanged: `block.timestamp < loan.gracePeriodEnd` — preserved as belt-and-braces against any future Seaport boundary semantics change.

UX surfacing: the dapp shows the borrower the current decayed price ("price right now: $X; in 6h: $Y; ends at: $Z"), updated live from a one-second ticker. Banner on the loan card shows the time-remaining + current price.

### 15.3 Mode B — English via OpenSea Offers (pragmatic v1)

True on-chain English auctions require either a custom Seaport zone that intercepts buyer-side offers and routes them through the multi-leg consideration model, or a wrapper contract that holds the NFT and runs the bid lifecycle. Both add substantial contract surface AND require buyers to interact with non-OpenSea-native order shapes (OpenSea's "make offer" UI only generates single-leg offers paying the seller-of-record).

Round 5 ships a **pragmatic English path** that reuses the existing fixed-price flow + the borrower's discretion:

1. Borrower posts a **regular fixed-price listing** at `startAskPrice` (could be projected max value, could be a deliberately-high reserve).
2. Bidders see the listing on OpenSea and place **collection offers** or **item offers** below the ask. Standard OpenSea UX — no Vaipakam-specific surface needed.
3. The dapp polls OpenSea's offers API for the loan's NFT and surfaces incoming offers to the borrower (banner on the loan card, sortable by amount).
4. **Buffer + floor + required-fees filter (Codex P2 line 566 + line 617).** The dapp marks an offer as "Acceptable" only when, after the dapp re-computes the required fee legs against `offer_value`, the resulting `borrowerLeg.amount ≥ 0` AND `offer_value ≥ (lenderLeg + treasuryLeg) × (1 + cfgPrepayListingBufferBps / 10000) + sum(feeLegs.amount)`. Two parts of this constraint:
   - The protocol-leg buffer applies to lender + treasury only (per §14.5's buffer math — fee legs are fixed-amount obligations, not buffered drift).
   - On fee-enforced collections, the gross offer must additionally cover the required fees. A naive `offer_value ≥ liveFloor × (1 + bufferBps)` filter would mark an offer "acceptable" that still leaves a negative borrower remainder once fees are deducted, and `updatePrepayListing` would revert at the sum-equality check. The dapp's filter MUST include required fees in the threshold to avoid this UX failure.
   - Offers below the combined threshold are surfaced (visibility) but greyed out (action-disabled) — surfacing the buffer + fees in the UI is what prevents a borrower from clicking "Match" on an offer that would bounce at re-sign.
5. When the borrower likes an acceptable offer, they click **"Match offer"** in the dapp. The dapp calls `updatePrepayListing(loanId, newAskPrice = offer_value, …)` to rotate the canonical order to the offer's price.

   **Fee-leg re-derivation on fee-enforced collections (Grok finding 4 + Codex P2 line 623).** If the collateral collection enforces fees, the dapp MUST RE-FETCH the OpenSea fee schedule from the agent proxy against the NEW gross ask (`offer_value`) at the moment of "Match offer" click — NOT recompute from a session-cached snapshot. Same reasoning §14.3 used to reject D1 caching: a fee schedule may have changed required-recipient set OR bps between the original listing post and the offer-match moment; a stale snapshot could route a creator-royalty leg to a recipient OpenSea has since rotated, or could under-compute the now-required amount, causing OpenSea-side rejection AND draining the borrower's remainder to a dead recipient.
   The dapp's `useNFTPrepayListing` hook fires a fresh `GET /opensea/collection/{slug}` via the agent proxy, recomputes `feeAmount[i] = offer_value × feeBps[i] / 10000` from the FRESH response, then passes the freshly-computed `FeeLeg[]` to `updatePrepayListing`. The extra one-RTT cost is paid for by correctness.
6. **The bidder fulfills (Codex P2 line 567).** After the rotation lands on-chain, the dapp surfaces a sharable link OR notifies the bidder out-of-band ("the seller has matched your offer at $X; complete the purchase here"). The BIDDER calls `Seaport.fulfillOrder` on the rotated listing — they are the buyer providing the listing's multi-leg consideration. The bidder's original OpenSea OFFER is NOT the order being settled; only the rotated LISTING settles. (Bidders are the ones who supply the multi-leg consideration; if the borrower fulfilled their own rotated listing they'd be buying their own collateral and funding the lender + treasury split from their own wallet — economic nonsense.)

What this gives up:
- **Race window.** Between the borrower's `updatePrepayListing` (step 5) and the bidder's `Seaport.fulfillOrder` (step 6), ANY buyer can fulfill the rotated listing — the offer-acceptance is NOT bound to the originating bidder. Sniping the bidder out of the price they bid is a real possibility. The dapp UI MUST warn ("Once you match, any buyer can fulfill at the matched price within ~N minutes. Notify your bidder before clicking Match.") and v2 could add a custom-zone or matched-orders flow that atomically rotates + fulfills in one tx, binding to the specific bidder. v1 explicitly accepts the race for shipping-velocity reasons.
- Not on-chain bid auditability — the dapp's offer ranking is OpenSea-API-derived.

What it gives:
- **Zero new contract surface.** Reuses `updatePrepayListing` end-to-end.
- **Real price discovery.** Borrower sees actual market interest before committing to a price.
- **Same atomicity** as fixed-price — Seaport's atomic offer-and-consideration fulfillment, executor's zone callback for state finalization.

This is the "English mode" the user picked. If the race-window UX proves painful in production, v2 can add a tighter bidder-binding via a custom-zone or matched-orders flow (atomic match-rotation in a single tx, eliminating the snipe window).

**Alternative considered + rejected for v1: atomic bidder-binding via Seaport `matchOrders`.** Buyer-side OpenSea Offers are single-leg orders (`offer = ERC20 → seller`); our settlement requires the multi-leg `lender + treasury + borrower` consideration. A `matchOrders` flow would construct a Vaipakam-side counter-order (offer = NFT-from-vault, consideration = the 3-or-more legs) at the moment of "Match offer" click and atomically match it against the bidder's existing offer via `Seaport.matchOrders` — settlement happens in one tx, no race window.

Rejected for v1 for three reasons:

1. **Substantial new contract surface.** A `matchOrders`-aware facet method needs to generate the Vaipakam-side order on-the-fly, verify the bidder's offer's bytes match what the dapp claimed, route the bidder's ERC20 payment through the executor's split, AND ensure the bidder's offer's consideration recipient (which the bidder signed against) aligns with the matched outcome. Each step adds audit surface.
2. **Bidder-side UX.** Bidders who placed standard OpenSea offers expect their offer to be either accepted (single-leg fulfillment) or rejected. A `matchOrders` settlement that pulls their ERC20 through an unexpected multi-leg route may produce confusing OpenSea-side states (the offer shows "filled" with the buyer never having interacted post-offer-placement).
3. **OpenSea API integration depth.** The agent would need to fetch the bidder's full signed offer bytes (not just the offer summary) to feed into `matchOrders`. That requires deeper API-key permissioning than the read-only schedule + listings POST we use today.

The dapp-side race-window warning + the v2 escape hatch is the right v1 trade-off; the bidder-binding can mature as a Round 6 addition once we have production signal on whether the race actually bites.

### 15.4 Reserve-tracks-floor — resolved

Issue #309's open Q1 ("reserve = live floor as interest accrues"): Round 5 resolves this by FIXING lender + treasury legs at the projected-max-floor at `auctionEndTime` (§15.2). The reserve doesn't "track" the floor — it pre-pays the floor's maximum, with the borrower absorbing the over-coverage as a smaller decayed remainder. This is the simplest path that keeps the Round-4 lender-coverage invariant intact without making the executor re-quote floor at fill time (which would require breaking Seaport's signed-amount immutability).

### 15.5 Auction window vs grace window — resolved

Issue #309's open Q2: enforced at the facet by `require(auctionEndTime ≤ loan.gracePeriodEnd, AuctionExceedsGrace)`. Borrower can pick any auction window shorter than the grace window; the facet defaults to `auctionEndTime = loan.gracePeriodEnd` if the borrower passes 0.

### 15.6 Lock reason — unified

Issue #309's open Q3: both Dutch and English modes use the existing `LibERC721.LockReason.PrepayCollateralListing`. No new lock reason. The lock semantics (grant conduit approval to vault; release on cancel / fill / grace-expire) are identical across all three modes (fixed / Dutch / English).

### 15.7 Lending-asset-only consideration — unchanged

Issue #309's open Q4: all consideration items in all modes use `loan.principalAsset` exclusively. Same Round-4 invariant.

### 15.8 Dutch decay shape — linear only for v1

Issue #309's open Q5: Seaport's native interpolation is linear (item amount = startAmount - (currentTime - startTime) × (startAmount - endAmount) / (endTime - startTime)). Stepped / accelerating decay would require a custom zone-side amount-recomputation hook. Round 5 sticks with linear for v1; if borrower demand surfaces for non-linear decay, v2 can add a zone-hook.

### 15.9 Out of scope for Round 5 auction work

- **True on-chain English auctions** (bidder-binding, no race window). Deferred — pragmatic English (§15.3) covers the user value at near-zero contract cost.
- Sealed-bid / Vickrey auctions (incompatible with OpenSea UI; see §12).
- Multi-collateral auctions (one listing for several NFT lots). Deferred to a separate card.
- Cross-chain auction relay. Out of scope by §12 (no cross-chain NFT sales in v1).
- Lender-side veto of auction price within the grace window. v2 design choice.

### 15.10 Known UX-fragility points for auction modes

The Round-4 fixed-price flow's two-percent buffer absorbs small floor drifts within a single block. Auction modes' longer fillability windows (hours to days) expand the surface for **external-state changes to silently invalidate a signed listing**. None of these break protocol safety — they break UX. Calling them out so the dapp surfaces them honestly:

**(A) Governance-induced under-coverage (Dutch only).** §15.2 fixes lender + treasury legs at the projected-max-floor at `auctionEndTime` based on the `treasuryFeeBps` (and any other fee bps) CURRENT at sign time. If governance bumps those parameters mid-auction, the live floor at fill time can exceed the signed leg amounts → executor reverts the fill (`Lender short-paid` / `Treasury short-paid`). The Dutch listing becomes unfillable until the borrower pays gas to `updatePrepayListing` with new projections.

Same risk exists today for fixed-price listings, but the surface is smaller — fixed-price asks are usually filled within hours, so the mid-listing-governance-bump window is narrow. Dutch auctions configured close to grace-end widen the window proportionally.

Mitigation: the dapp surfaces a banner "governance has bumped treasuryFeeBps since this listing was posted; click to re-sign" on the loan card whenever it detects a mismatch between the signed pctx and a fresh read. **The dapp watches `ConfigFacet.FeesConfigSet(uint16 treasuryFeeBps, uint16 loanInitiationFeeBps)`** emitted from `setFeesConfig` (Round 5.1 errata — Codex P2 line 556: the original "TreasuryFeeBpsSet" name in the design draft does not exist in the shipped code, which bundles treasury + loan-initiation fees under a single `FeesConfigSet` payload). On any `FeesConfigSet` event, the dapp re-reads the live floor for every live listing tied to the affected loans and surfaces the re-sign banner where the new floor exceeds the signed coverage.

**(B) Implicit borrower over-payment on early Dutch fills.** §15.2 fixes lender + treasury at the projected-max-floor at `auctionEndTime`. A buyer who fills the Dutch listing at `t = startTime` (before any decay) pays the lender + treasury MAX projection — i.e., the borrower's loan settles paying as if it had run to grace-end, even though it didn't. The over-coverage flows to lender + treasury (not refunded to the borrower).

For a 7-day grace with 8% APR, the over-payment is ~0.15% of principal — small in absolute terms but real. The dapp's Dutch posting UI MUST surface this: "If your listing fills today, you'll pay $X more than today's live floor as a safety margin. The margin shrinks as the auction approaches its end time." The borrower CAN choose to shorten the auction window (`auctionEndTime` closer to `block.timestamp`) to reduce the over-coverage; this is a borrower-controlled trade-off.

**(C) Lender-position-NFT rotation invalidates the recipient binding.** §5.1 invariant: the executor re-derives `consideration[0].recipient = lenderNftOwner` at fill time. If the lender transfers their position-NFT mid-auction (whether innocently as a portfolio rotation or maliciously to grief the borrower), the signed order's stored `lenderRecipient` no longer matches the current holder → executor reverts the fill.

For fixed-price this is a single-block rotation race; for Dutch + English it's a longer window. A malicious lender who specifically wants the underlying NFT (and would prefer the default path) can deliberately rotate their position-NFT during a borrower's auction window to force-revert all fills.

The protocol's safety holds: the borrower can `cancelPrepayListing` + `updatePrepayListing` (rotating the executor's recorded `lenderRecipient`); the lock + grace boundary prevent a stuck state. But the borrower pays gas + loses fillability time.

Mitigation: the dapp watches `Transfer(lenderNftId)` events on the lender-position-NFT contract for any loan with a live prepay listing. On a detected rotation, the borrower sees an alert + a one-click "re-sign listing" action. v2 could add an executor-side automatic re-derivation, but that breaks Seaport's signature-vs-order-shape immutability assumption and is rejected for v1.

**(D) Treasury rotation invalidates the recipient binding.** Same mechanism as (C) but for the treasury address. The shipped executor re-derives `pctx.treasury` LIVE from `s.treasury` at fill time, and `AdminFacet.setTreasury` emits `TreasurySet`. A governance rotation between sign and fill produces a `WrongTreasuryRecipient` revert in the zone callback. Dapp mitigation: subscribe to `TreasurySet` events on the diamond and surface a re-sign banner on all live listings — symmetric to (C)'s lender-NFT-rotation watcher. Governance rotation of the treasury is rare in normal operation but possible during e.g. multisig key rotation; flagged here so dapp authors don't omit the watcher because they assume rotations never happen.

**(E) Conduit revocation breaks the signed order at fill time (Codex P2 line 674).** The shipped executor re-checks `approvedConduits[ctx.conduit]` in both ERC-1271 (`isOrderValid`) AND in the zone callback (`validateOrder`). If governance removes the borrower's chosen conduit from the allow-list during a multi-day Dutch / English listing, every signed order referring to that conduit becomes unfillable — Seaport reverts on the ERC-1271 sign-time path, and a `Seaport.validate()` pre-registration would still trip the zone's conduit re-check at fill time. The protocol's safety holds (no under-payment; the unfillable state is a clean stop); the UX cost is the borrower discovering the listing went dead and paying gas to re-list with a still-approved conduit. **Dapp mitigation: subscribe to `ConduitApproved(address)` / `ConduitRevoked(address)` events on the `CollateralListingExecutor`** (Round 5.1 errata — Codex P2 line 707: the original "ApprovedConduitSet on the diamond" wording in the design draft was wrong on both counts; the allow-list lives on the executor singleton, NOT in `LibVaipakam.Storage` on the diamond, and the executor emits a pair of revocation events, not a single set event). Post a banner whenever a conduit referenced by the borrower's live listings gets revoked.

**(F) Executor rotation orphans the signed Seaport zone (Codex P2 line 674).** The signed Seaport order is permanently zoned to whichever `CollateralListingExecutor` address was current at sign time. The diamond's `executorFinalizePrepaySale` callback accepts ONLY from `s.collateralListingExecutor` — i.e., the current executor. If governance rotates the executor (`PrepayListingFacet.setCollateralListingExecutor`) during a borrower's live auction, three outcomes:

1. The OLD executor's ERC-1271 + zone callback still run against the signed order (Seaport doesn't care that the diamond's pointer moved).
2. The old executor's zone callback calls `executorFinalizePrepaySale` on the diamond → the diamond's privileged-caller gate rejects because `msg.sender == OLD_executor ≠ s.collateralListingExecutor` → fill reverts.
3. The borrower must `cancelPrepayListing` + re-post against the NEW executor.

Protocol safety holds (executor rotation is admin/governance — the rotation event is observable on-chain). Dapp mitigation: watch the diamond's `CollateralListingExecutorUpdated` event; on a detected rotation, surface "your live listings are zoned to the previous executor; click to re-sign against the new one." v2 could add a per-loan executor pin (record sign-time executor in Loan / listing storage and bypass the current-executor check), but that creates its own audit surface — v1 explicitly accepts the rotation rare-event UX cost.

**(G) Grace-bucket schedule change shifts the fill-time grace boundary (Codex P2 line 674).** The Round-4 executor derives `graceEnd` LIVE from `ConfigFacet.setGraceBuckets(loan.durationDays)` at fill time, while the Seaport order's signed `endTime` was hash-bound at post time using the schedule current then. Two governance-mutation failure modes:

- **Bucket shortened mid-auction:** the live `graceEnd` becomes earlier than the signed `endTime`. OpenSea still shows the listing as live (Seaport interpolation continues until the signed `endTime`), but the executor's `block.timestamp < graceEnd` re-check (§5.7) now rejects fills past the new earlier boundary. Buyers see a "valid" order revert.
- **Bucket lengthened mid-auction:** less severe — Seaport's signed `endTime` is now earlier than the live `graceEnd`. The auction expires on Seaport's schedule (correctly); the protocol's grace continues a bit longer. The borrower can re-list within the extended grace.

Mitigation: dapp watches `GraceBucketsUpdated` events on the diamond; auctions affected by a bucket change get a re-sign / re-list banner. Contract-side, freezing the grace-bucket schedule into the order at sign time would require storing the resolved `graceEnd` in `OrderContext` AND having the executor compare against the stored value instead of the live read — explicitly NOT done in v1 because it would let stale orders fill past current-policy boundaries (worse outcome than the current cleanly-rejected fills).

**(H) Global pause kills fills until unpause (Codex P2 line 653).** The shipped `PrepayListingFacet.executorFinalizePrepaySale` callback carries `whenNotPaused` (see `contracts/src/facets/PrepayListingFacet.sol:148`), as do borrower-side cancel / update paths. While the diamond is in the `Paused` state — emergency response, planned maintenance, etc. — every Seaport-valid fill arrives at the zone callback and reverts at the pause check. OpenSea continues to show the listing as live; buyers waste sim gas attempting to fulfill. Same UX failure mode as the other §15.10 cases. Dapp mitigation: subscribe to the diamond's `Paused` / `Unpaused` events and post a high-visibility banner on every live listing card during the pause window: "Vaipakam is paused — fills will fail until resume; your listing is preserved." On `Unpaused`, the banner clears automatically. Protocol safety holds (the pause is the desired emergency posture; the executor reverting on attempted fills is *exactly* the intended behaviour). Worth listing here so dapp authors don't omit the watcher because pause is "rare" — operationally common during pre-launch tuning + post-launch incident response.

These eight cases are *known* and *acknowledged*; the dapp's role is to surface them clearly so borrowers aren't surprised. The Round-4 §316 cleanup machinery (PR #321) already handles cancel-time drift gracefully by emitting `SeaportCancelSkipped` — these new UX-fragility cases just produce that breadcrumb a few more times.

## 16. Round 5 sequencing

Three step blocks. **They share contract files** (`LibPrepayOrder`, `NFTPrepayListingFacet`, `CollateralListingExecutor`, the `IListingExecutorRecorder` interface, the indexer's `PrepayListingPosted` event shape, the `prepay_listings` D1 schema) and have a real dependency order (Codex P3 line 695):

- **Block A is the prerequisite.** It relaxes the executor's 3-leg cap to `[3, 7]` (A.3), unifies `FeeLeg{recipient, uint96 startAmount, uint96 endAmount}` (A.1), and extends the `recordOrder` interface to carry `FeeLeg[]` (A.10). Without A's relaxed cap, the Dutch builder in B can't construct fee-enforced orders past 3 legs; without A's unified `FeeLeg` shape, B has nowhere to put start/end amounts.
- **Block B depends on A.** Block B's `_componentsDutch` builds on A's `_components` shape; Block B's `OrderContext` extension layers on top of A's `FeeLeg[]` extension (B.4); Block B's `_assertOrderContent` reuses A's relaxed length cap.
- **Block C depends on A only for fee-enforced collections.** On fee-free collections, C is pure dapp polish and can ship independently. On fee-enforced collections, C needs A's fee-re-derivation surface (§15.3 step 5).

The dependency is "A enables B and (some of) C," not "all independent." Implementer guidance: do NOT split A's contract changes between PRs or land B before A — the executor's length cap and the `OrderContext` schema must be in place before B's facet selectors can build correctly. **Within Block A itself, A.1–A.11 ALL ship as one atomic PR** — the contract changes (A.1–A.5 + A.10), the ABI re-export (A.6), AND the consumer-side agent/dapp/indexer updates (A.7–A.9 + A.11). See "No consumer-deploy split" below — A.5's `diamondCut.Remove` is the forcing function; splitting consumers into follow-up PRs would land a production-outage window between the contract deploy and the consumer deploy.

**Block A — Fee-legs extension (#313)**

A.1. **`LibPrepayOrder._components` accepts an optional `feeLegs[]` array**, computes the borrower-leg amounts as `borrowerLeg.startAmount = askPrice − lenderLeg − treasuryLeg − sum(feeLegs.startAmount)` and `borrowerLeg.endAmount = askPrice − lenderLeg − treasuryLeg − sum(feeLegs.endAmount)`, THEN appends each fee leg as a `ConsiderationItem` with `startAmount = feeLeg.startAmount` / `endAmount = feeLeg.endAmount`. **The subtraction MUST land before the append (Round 5.1 errata — Codex P2 line 740):** if implementers literally "append fee legs after the borrower leg" without re-deriving the borrower leg from the post-fees gross, the total consideration sums to `askPrice + sum(feeLegs)` and the borrower receives the pre-fee remainder — contradicting §14.2 / §14.5's borrower-pays-fees model AND producing orders whose gross differs from the dapp's displayed `askPrice`. For fixed-price callers `feeLeg.startAmount == feeLeg.endAmount`, so both derivations collapse to the same value; the subtract-then-append shape is the same for Dutch (Block B) and just produces decaying borrower-leg amounts naturally.
A.2. **`NFTPrepayListingFacet`** — extend `postPrepayListing` / `updatePrepayListing` signatures with `FeeLeg[]`. Validate `0 ≤ feeLegs.length ≤ MAX_FEE_LEGS (=4)`; each `recipient != address(0)`, `startAmount > 0`, `endAmount > 0`. **For the fixed-price path, require `startAmount == endAmount` on every fee leg** (Codex P2 line 700) — fixed-price orders have no decay surface, and accepting `startAmount > endAmount` would produce a hybrid "decaying fixed-price" listing whose cancel-path reconstruction (no auction-mode tag) couldn't rebuild the original shape. The `>=` form is reserved for Dutch entry points (§15.2 / Block B). Sum-of-considerations equality check: `askPrice == lender + treasury + borrower.amount + sum(feeLegs.amount)` (single amount since start == end on this path).
A.3. **`CollateralListingExecutor._assertOrderContent`** — relax length cap to `[3, 3 + MAX_FEE_LEGS] = [3, 7]`; preserve every existing check (recipient indices 0+1 = lender + treasury, principalAsset on the protocol legs, lender + treasury coverage against live floor). **Add an explicit loop over consideration[3..N] (Codex P2 line 723)** asserting each fee leg's `itemType == ERC20`, `token == loan.principalAsset` (same ERC20 as the protocol legs), `identifierOrCriteria == 0`, `amount > 0` (where `amount` is the live Seaport-interpolated value at fill time). Without this explicit per-leg loop, a malformed call could record a "canonical" order with fee legs in a different token or zero amount — the protocol legs would settle correctly while the OpenSea-side fee enforcement (which expects principalAsset legs) breaks the listing's submission or post-fill obligations. The loop costs ~3K gas per extra leg; no executor-side recipient validation (per §14.4's "economically neutral if borrower lies" reasoning).
A.4. **`OrderContext` extension** — record the full `FeeLeg[]` array (2 slots per leg) + the fee-legs length slot for #316 cancel-time reconstruction. Update `_tryCancelOnSeaport` to rebuild the canonical `OrderComponents` including the fee legs.
A.5. **Selector replacement via diamondCut.** Adding `FeeLeg[]` to `postPrepayListing` / `updatePrepayListing` changes both Solidity selectors. The deploy script's diamondCut step (or a follow-up cut on already-deployed networks) MUST:
- ADD the new selectors via `FacetCutAction.Add`,
- REMOVE the old selectors via `FacetCutAction.Remove`.
Update `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` and `SelectorCoverageTest._populateRoutedSet()` to emit the new shape. `DiamondFacetNames.cutFacetNames()` is unchanged (same facet).
A.6. **ABI re-export + consumer typecheck.** Run `exportFrontendAbis.sh`; `pnpm --filter @vaipakam/{defi,indexer,agent} exec tsc -b --noEmit` MUST fail at consumer call sites — co-update the apps in the same PR.
A.7. **`apps/agent`** — TWO new endpoints (Round 5.1 errata round-3 — Codex P2 line 457: the sim-transfer pre-flight CANNOT live on the Collection proxy because the proxy lacks loan/principalAsset/amount context):
- `GET /opensea/collection/{slug}` — pure Collection API proxy returning the full Collection API body (fees array lives inside the response, NOT a separate `/fees` endpoint). CORS-locked, rate-limited, uses server-side `OPENSEA_API_KEY`. Stateless; no per-loan context.
- `POST /opensea/feeRecipientPreflight` — accepts `{chainId, principalAsset, askPrice, feeLegs: [{recipient, basisPoints}]}` from the dapp; runs the state-override sim-transfer (§14.4) against the `RECIPIENT_VALIDATING_TOKENS[chainId][principalAsset]` allow-list entry; returns per-recipient verdicts. CORS-locked, rate-limited, no API key needed (the call is direct RPC against the chain's public/configured RPC). Same allow-list config flows in here as in §14.4; tokens off the list return `"not_applicable"` per-recipient.
A.8. **`apps/defi`** — `useNFTPrepayListing` fee fetch + pre-flight; pre-filled fee UI; ghost-recipient sim-transfer pre-flight check (§14.4).
A.9. **`apps/indexer`** — new D1 columns `fee_legs_json` + `borrower_remainder`; extend `PrepayListingPosted` handler to decode the full `FeeLeg[]` from event data (NOT just an indexed root) and persist them.
A.10. **`IListingExecutorRecorder` interface extension (Grok finding D).** The `recordOrder` signature on `IListingExecutorRecorder.sol` AND on `CollateralListingExecutor` MUST grow a `FeeLeg[] feeLegs` parameter alongside the existing `(orderHash, loanId, conduit, conduitKey, salt, startTime, askPrice)` shape from PR #321. The executor is a UUPS singleton — the upgrade is an `_authorizeUpgrade`-gated proxy implementation swap, NOT a re-deploy. Block A includes this UUPS upgrade step. The mock `MockListingExecutorRecorder.sol` in the test corpus is co-updated.

**Same-transaction batched deploy is REQUIRED (Round 5.1 errata — Codex P2 line 752).** When the recorder's signature changes, EITHER deploy order produces a broken transient state:
- **UUPS upgrade FIRST then `diamondCut`:** the old facet selectors still routed in the diamond call the new executor's `recordOrder` with the OLD argument count → ABI mismatch reverts every borrower's `post`/`update` call until the cut lands.
- **`diamondCut` FIRST then UUPS upgrade:** the new facet selectors call the old executor's `recordOrder` with the NEW argument count → same ABI mismatch in the opposite direction.

A "tight back-to-back tx" pattern is NOT sufficient — even one block between the two tx's leaves a window where every listing mutation reverts. The deploy script MUST execute both state mutations **in the same on-chain transaction** via a single call to a multicall target. **Forge's `broadcast` block alone does NOT satisfy this** (Round 5.1 errata — Codex P2 line 765): per Foundry's scripting docs, `startBroadcast` makes each subsequent external call a separate transaction in the broadcast tx-list. The script-side EOA-sequential pattern recreates the exact transient ABI-mismatch outage the rule is meant to prevent.

- **For the post-handover (governance-timelock) deploy:** the operator submits ONE governance proposal that bundles both calls via a multicall payload — OZ `TimelockController.executeBatch(targets, values, payloads, ...)` if using TimelockController; Gnosis Safe `multiSend` if using a Gnosis-Safe-fronted timelock; etc. The proposal queues + executes once both targets pass the same governance window. ONE tx, both state mutations.
- **For the pre-handover (admin-multisig) deploy:** the deploy script invokes the admin multisig's batched-execution surface (Gnosis Safe `execTransaction` with a `multiSend` payload, or similar). The Forge script's role is to PREPARE the multicall payload — encode the two calldata blobs, hash them, and submit them as a single multisig transaction. The script itself does NOT execute the upgrade + cut sequentially as EOA calls.
- **For the testnet / Anvil rehearsal deploy** (Round 5.1 errata — Codex P2 line 773 — corrected): the simplest naive helper (a `BatchCaller` contract that just forwards two arbitrary calls in one tx) does NOT work in isolation, because `DiamondCutFacet.diamondCut` and the executor's `_authorizeUpgrade(...) onlyOwner` would treat the helper as `msg.sender` — which is NOT the diamond owner or the executor owner, so both targets would revert and the rehearsal "succeeds" by failing-loud (defeating the purpose). The rehearsal MUST mirror the mainnet ownership structure:
  1. **Deploy a minimal Gnosis Safe** in 1-of-1 mode with the dev EOA as the single signer. Use the canonical Gnosis Safe deployment kit (Anvil rehearsals deploy the kit locally first; testnet + mainnet rehearsals reuse the chain's canonical addresses). **Round 5.1 errata round-2 — Codex P2 line 774:** there is NO pre-existing Gnosis Safe deploy plumbing in this repo today; Block A adds the deploy script as a new deliverable. See `contracts/script/utils/DeployGnosisSafe.s.sol` to be added in Block A; it depends on **the full Safe deployment-kit address-set** being recorded in `contracts/deployments/<chain>/external.json` (a new artifact alongside `addresses.json`):
     - `SafeProxyFactory` — creates new Safe proxies.
     - `Safe` (a.k.a. the **GnosisSafe singleton / MasterCopy**) — the implementation each Safe proxy delegates to. **Round 5.1 errata round-5 — Codex P2 line 780:** recording only the factory was insufficient; the proxy factory's `createProxyWithNonce(singleton, initializer, saltNonce)` REQUIRES a singleton address. Omitting it would point the deployed proxy at `address(0)` or a wrong singleton, producing a broken Safe before the rehearsal even started.
     - `MultiSend` (or `MultiSendCallOnly` for higher-security deployments) — the library invoked by `delegatecall` from the Safe to batch the diamondCut + UUPS upgrade in one tx (the actual delegatecall target — without this address the multicall encoder has no library to target).
     - `CompatibilityFallbackHandler` — optional but commonly needed for Safe v1.4.x+ to support EIP-1271 / EIP-712 isValidSignature semantics if any downstream surface needs it. Block A records the address but the multicall flow doesn't depend on it; included for completeness so future surfaces don't need to add a follow-up.
  2. **Transfer ownership of the Diamond + executor to the Safe.** Diamond ownership uses **`IERC173.owner()` / `IERC173.transferOwnership(safe)`** (Round 5.1 errata round-2 — Codex P2 line 773: `IDiamondLoupe` only exposes facet inspection; ownership is on the `IERC173` interface the Diamond exposes via `OwnershipFacet`); the executor proxy uses `OwnableUpgradeable.transferOwnership(safe)`. Both transitions happen in the pre-Block-A deploy fixture; Block A's deploy script asserts both owners are the Safe before submitting the multicall.
  3. **Encode the diamondCut + UUPS upgrade calldata as a Gnosis `MultiSend` payload and execute via Safe.** Important (Round 5.1 errata round-2 — Codex P2 line 773): the `MultiSend` library MUST be invoked via `Operation.DelegateCall (= 1)` in the Safe's `execTransaction`, not via regular `Operation.Call`. With a regular call, the Safe would just transfer to the MultiSend contract's address (and the bundled sub-calls would never execute against the Safe's identity); with delegatecall, the sub-calls execute in the Safe's context so `msg.sender` for the Diamond + executor remains the Safe owner and the `onlyOwner` checks pass.
- **Reference implementation:** see `contracts/script/multicallDeploy.s.sol` + `contracts/script/utils/DeployGnosisSafe.s.sol` + `contracts/script/utils/encodeMultiSend.sol` (TO BE ADDED in Block A — first time we need any of these; will set the precedent for B.4's second iteration and for any future recorder extension). The mainnet deploy reuses the same multicall encoder against the production Safe / timelock signer set.

The atomic-PR rule (next paragraph) addresses code-level consistency; this requirement addresses on-chain-state consistency at deploy time. Both layers must hold for a clean rollout.
A.11. **Indexer event-coverage guardrail (Grok finding F).** Run `pnpm --filter @vaipakam/indexer check-event-coverage` after the extended `PrepayListingPosted` event lands; either handle the new shape OR add a deliberate `DELIBERATELY_NOT_HANDLED` entry with a one-line reason (per CLAUDE.md's event-coverage discipline).
A.12. **Tests** — facet unit tests for fee-leg validation (length cap, sum equality, buffer math); executor tests for length 3 / 4 / 5 / 6 / 7; integration test for end-to-end fee-enforced collection flow; UUPS upgrade rehearsal test for the executor swap.

**Block B — Dutch decay (#309 Mode A)**

B.1. **`LibPrepayOrder._componentsDutch`** — new builder that takes `startAskPrice` + `endAskPrice` + `auctionEndTime` + `FeeLeg[]`; computes per-leg `startAmount` / `endAmount` per §15.2. Lender + treasury legs get fixed `(start, end) == (projectedMax, projectedMax)`. Borrower leg gets `(startAskPrice - …, endAskPrice - …)`. Fee legs flow through with their own `(startAmount, endAmount)` so OpenSea-required-fee percentages are honoured at every block of the auction.
B.2. **`NFTPrepayListingFacet`** — new `postPrepayDutchListing` + `updatePrepayDutchListing` entry points (the **update path is required** so the borrower can recover from §15.10 drift without cancel-and-repost — see Codex P2 line 668). Same conduit + ERC1271 + lock semantics as `postPrepayListing`. The update path mirrors the existing fixed-price `updatePrepayListing`: atomically clears the old `OrderContext`, re-stamps with a new `(orderHash, startAskPrice, endAskPrice, auctionEndTime, feeLegs)` tuple, keeps the borrower-position-NFT lock continuous so no re-locking race opens. Validate (both entry points), all checks from §15.2 — repeated here so the sequencing checklist is self-contained (Codex P2 line 740):
- `auctionEndTime > block.timestamp + MIN_AUCTION_WINDOW (=1h)`,
- `auctionEndTime ≤ loan.gracePeriodEnd`,
- **start-state solvency**: `startAskPrice ≥ projectedLenderLeg + projectedTreasuryLeg + sum(feeLegs.startAmount)` (prevents borrower-leg underflow at startTime — Codex P2 line 591),
- **end-state solvency**: `endAskPrice ≥ projectedLenderLeg + projectedTreasuryLeg + sum(feeLegs.endAmount)`,
- `startAskPrice ≥ endAskPrice` — total order monotonicity,
- every `feeLegs[i].startAmount ≥ feeLegs[i].endAmount` — per-fee-leg monotonicity,
- **derived borrower-leg monotonicity**: `borrowerLeg.startAmount ≥ borrowerLeg.endAmount` after computing both from the above (catches the case where fees decay faster than the total ask — Codex P2 line 577 / 740).
B.3. **`CollateralListingExecutor`** — no changes to fill-time validation. Existing `_assertOrderContent` works as-is (Seaport's amount interpolation happens before the zone callback; the executor sees the resolved amounts at fill time, and the relaxed length cap from Block A.3 already covers Dutch's 3-7 leg range).
B.4. **`OrderContext` + recorder interface extension for Dutch fields (Codex P2 line 720).** Block A's recorder change only added `FeeLeg[]`; Block B MUST extend `IListingExecutorRecorder.recordOrder` AGAIN to thread `endAskPrice` + `auctionEndTime` + auction-mode tag through to the executor. Without this, the facet has no way to stamp the Dutch fields into `OrderContext`, and `_tryCancelOnSeaport` reconstruction for Dutch listings will be missing hash-bound inputs → fast-cancel skip path fires → stale OpenSea listings linger.

**Preferred shape (decided here, not TBD at implementation — Grok finding 2):** the recorder grows ONE multi-mode `recordOrder` overload carrying every signed field plus a `uint8 mode` tag (`0 = fixed-price`, `1 = dutch`). For fixed-price posts the Dutch fields (`endAskPrice`, `auctionEndTime`) are passed as zero and the facet asserts `mode == 0`; for Dutch posts the facet asserts `mode == 1` and the fields are non-zero per §15.2 validation. This keeps the interface flat (one overload instead of two or three), avoids overload-disambiguation surface area, and lets the executor's `OrderContext` use the mode tag to pick the correct `LibPrepayOrder.componentsForCancel` variant. The executor's `OrderContext` extends to record the new fields. Packed into one slot: `uint128 endAskPrice + uint64 auctionEndTime + uint8 mode flag + 56-bit padding`. Includes the second UUPS upgrade rehearsal of this Round (after Block A's). The `MockListingExecutorRecorder.sol` mock co-updates.

**Same-transaction batched deploy is REQUIRED (Round 5.1 errata — Codex P2 line 752).** Same reasoning as A.10's batched-deploy requirement applies here: when the recorder's signature changes again (FeeLeg[] in A.10 + Dutch fields in B.4), the UUPS upgrade and the diamondCut MUST land in one transaction to avoid a transient ABI-mismatch outage between borrower listing mutations and the executor. Re-use the multicall deploy pattern set up in A.10 (`contracts/script/multicallDeploy.s.sol`); Block B's deploy script extends the existing pattern rather than introducing a parallel one. This is the third (and final, for v1) time the recorder interface changes; v2 work that touches it must continue the same discipline.
B.5. **Selector wiring + event shape (Grok finding 2 — preference now stated, not TBD).** `postPrepayDutchListing` AND `updatePrepayDutchListing` are both new selectors added via diamondCut. `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` extended; `SelectorCoverageTest._populateRoutedSet()` mirrors. **Preferred event shape:** extend the existing `PrepayListingPosted` / `PrepayListingUpdated` events with optional Dutch fields (`endAskPrice`, `auctionEndTime`, `mode`) defaulting to zero / `mode=0` for fixed-price posts. Rationale: keeps the indexer's event-coverage allowlist + handler set tight (one handler per shape, not two), keeps the D1 schema's `auction_mode` column as the single discriminator, and matches the recorder's multi-mode overload (B.4) — same shape on both contract sides. The alternative (split into `PrepayDutchListingPosted` / `PrepayDutchListingUpdated` events) was considered + rejected: doubles the indexer's surface area + the `check-event-coverage` allowlist for no clear benefit.
B.6. **ABI re-export + consumer typecheck** for the new selector.
B.7. **`apps/defi`** — Dutch posting UI; live decayed-price banner with current price ticker; over-payment surface per §15.10(B).
B.8. **`apps/indexer`** — new D1 columns `auction_mode` (enum: fixed/dutch) + `auction_end_time` + `end_ask_price`. Extend the existing `PrepayListingPosted` / `PrepayListingUpdated` handlers to decode the optional Dutch fields (`mode`, `endAskPrice`, `auctionEndTime`) added in B.5 and persist them into the new D1 columns. Do NOT add separate Dutch events / handlers — that path was explicitly rejected in B.5 (would double the indexer's `check-event-coverage` allowlist surface for no benefit), and this checklist must match.
B.9. **Tests** — facet unit tests (sign-time validation including `MIN_AUCTION_WINDOW` + monotonicity); integration test for sign-mid-decay fill; sniper-snipe test for the open Dutch window.

**Block C — English via OpenSea offers (#309 Mode B)**

C.1. **`apps/agent`** — new `/opensea/offers/{loanId}` proxy that returns active offers for the loan's collateral NFT.
C.2. **`apps/defi`** — offers panel on the loan card; "Accept (re-list at offer price)" button wired to `updatePrepayListing`.
C.3. **No contract changes.** The dapp reuses the existing `updatePrepayListing` end-to-end.
C.4. **`apps/indexer`** — log accepted-offer breadcrumbs (which offer the borrower matched) for analytics — optional, v1.1.
C.5. **Tests** — dapp integration test for fetch-offers + re-list flow.

Each block lands as 1–3 PRs depending on size. Block A is the largest (contracts + dapp + indexer + worker proxy). Block B is contracts + dapp + indexer. Block C is dapp-only.

**Required ordering:** A must merge before B.

**Atomic Block A cut (Codex P2 line 759 — TWO findings):** The Block A contract changes A.1, A.2, A.3, A.4, A.5, **AND A.10 (recorder-interface extension + UUPS upgrade)** MUST land in ONE atomic PR. A.10 is a contract/interface change that A.4's `OrderContext` extension depends on — without `IListingExecutorRecorder.recordOrder` carrying the new `FeeLeg[]`, the facet has no way to stamp fee-leg data into the executor, so the new fields in `OrderContext` would never get populated and `_tryCancelOnSeaport` reconstruction would silently skip fee-leg orders. A.10's UUPS implementation swap also lives in this atomic PR.

**No consumer-deploy split.** The dapp / agent / indexer changes (A.7, A.8, A.9, A.11) ALSO MUST be in the SAME atomic PR (or in a release-gated rollout that deploys all of them before the diamondCut lands on production). A.5's diamondCut REMOVES the old 4-argument `postPrepayListing` / `updatePrepayListing` selectors; the moment that cut lands on a deployed Diamond, every call from a still-old dapp / indexer fallback path hits removed selectors and reverts with `FunctionNotFound`. Splitting consumers into follow-up PRs would create a production outage window between the contract deploy and the consumer deploy. The atomic-merge constraint extends to the entire Block A surface.

A.6 (ABI re-export) + A.6's typecheck gate naturally fail at merge time if the consumer code wasn't co-updated, which is the structural enforcement of this rule.

**C scheduling:**

- **C on fee-free collections** can ship **in parallel with or slightly ahead of A** (Grok finding 6) — it's pure dapp polish on the existing `updatePrepayListing` surface, no contract dependency. Worth doing first for early production signal on whether the race-window UX (§15.3) needs v2's tighter bidder-binding.
- **C on fee-enforced collections** requires A — needs the fee re-derivation surface from §15.3 step 5 + the relaxed length cap.

The product-level recommendation: ship C-on-fee-free first (fast English UX signal), land A in parallel (unblocks fee-enforced collections), then extend C to cover fee-enforced + land B (Dutch) for the unique-NFT case.

---

# Round 6 additions

> The remainder of this doc is the **Round 6** addendum — atomic
> match-rotation via Seaport `matchOrders` (§17, Issue
> [#333](https://github.com/vaipakam/vaipakam/issues/333)). Round 5
> (§14–§16) describes the shipped v1.1; Round 6 closes the race window
> §15.3 deliberately accepted for v1.

## 17. Atomic match-rotation via Seaport `matchOrders` (Issue #333)

### 17.1 Why Round 6 now (pre-live posture)

§15.3 deliberately shipped the v1 Match flow with a documented race
window — between the borrower's `updatePrepayListing(newAsk =
offer_value)` rotation tx and the bidder's separate
`Seaport.fulfillOrder`, **any third-party buyer can snipe the rotated
listing at the matched price**. The bidder who placed the OpenSea offer
is NOT bound to the matched order; sniping the bidder out of the price
they bid is a real outcome.

The original deferral reasoning ("ship v1 fast; revisit if production
signal shows the race actually bites") presumes a live deploy where the
v1 race is observable. **Vaipakam is still pre-live** (see
[[project_platform_prelive]]) — there is no production signal because
there is no production. Two strategic considerations now flip the
"defer" calculus:

1. **Adding the atomic path POST-mainnet means coordinating an
   ABI-breaking facet swap with live borrower listings already
   in-flight** — an order of magnitude harder than landing it now.
   Pre-live the contract change is cheap; v1 listings have never
   existed.
2. **The race window's reputational cost is asymmetric.** A bidder
   sniped on Vaipakam's English flow in the first month of mainnet
   reads as protocol design negligence even if mathematically rare;
   the dapp tooltip mitigation (Phase 6, PR #340) helps but cannot
   fully eliminate the perceived footgun.

Round 6 closes the race window with a single new facet selector +
agent-proxy extension before the on-chain English path becomes
borrower-observable on mainnet. It supersedes §15.3's v1 two-step Match
flow entirely; the v1 selectors stay on the diamond (still useful for
manual re-sign on floor drift without a Match event) but the dapp's
Match button rewires to the new selector.

### 17.2 The race window v1 ships with (recap)

§15.3's v1 English flow:

1. Borrower posts a fixed-price listing at `startAskPrice` (max value).
2. Bidders place OpenSea collection / item offers below the ask.
3. Dapp surfaces "Acceptable" offers.
4. Borrower clicks Match → dapp calls
   `updatePrepayListing(newAsk = offer_value, freshFeeLegs)`.
5. The bidder (or anyone) calls `Seaport.fulfillOrder` on the rotated
   listing.

Race-window source: step 4 publishes the rotated listing to OpenSea's
order book; ANY observer can call `fulfillOrder` between the rotation
tx landing and the bidder's `fulfillOrder` tx landing. The bidder has
no atomic bond to the matched order.

### 17.3 Architecture — new sibling facet, reused executor

**Facet topology decision (ratified 2026-06-03 with user):** new
sibling facet `NFTPrepayListingAtomicFacet`. Rationale:

- `NFTPrepayListingFacet` is already 1,183 lines (16 storage-mutating
  external functions). Adding the matchOrders selector to it pushes
  the EIP-170 budget harder and forces a facet split later anyway.
- A new facet isolates the new bidder-bytes verification + matchOrders
  surface for a focused audit pass — auditors can scope to one file +
  its tests rather than re-reading the whole prepay-listing surface.
- V1 selectors stay byte-for-byte unchanged on `NFTPrepayListingFacet`
  — no consumer migration risk for `postPrepayListing` /
  `updatePrepayListing` / `cancelPrepayListing` callers.

**Executor — minimal delta, NOT zero delta** (Codex round-1 P2 #344):
`CollateralListingExecutor`'s zone callback path (`validateOrder` →
`executorFinalizePrepaySale`) and its conduit allow-list + ERC-1271
delegate are reused verbatim. **But the executor IS modified in two
small ways** that Block D must carry as a UUPS implementation swap:

1. **New mode constant `PREPAY_MODE_ATOMIC_MATCH`** alongside the
   existing `PREPAY_MODE_FIXED_PRICE` + `PREPAY_MODE_DUTCH`. The
   executor's `_assertOrderContent` mode-dispatch + the cancel-time
   reconstruction in `_componentsForCancel` both currently revert
   `UnknownPrepayMode(mode)` for any other constant; both need to
   recognise the new mode + dispatch to a `_assertOrderContentAtomic`
   helper (verifies the counter-order shape Block D commits to in
   §17.7).
2. **`recordOrder` interface extension is NOT required** — the existing
   `recordOrder(orderHash, loanId, conduit, conduitKey, salt,
   startTime, askPrice, endAskPrice, auctionEndTime, mode, feeLegs)`
   signature already carries everything the atomic-match path needs;
   atomic-match calls pass `endAskPrice == askPrice` and
   `auctionEndTime == 0` (same as fixed-price).

Executor changes are deployed via the standard UUPS upgrade flow (see
the executor's `_authorizeUpgrade(onlyOwner)` path). The audit scope
extends to the executor diff (mode constant + the two `_assertOrderContent`
+ `_componentsForCancel` branches), NOT just the new facet.

The zone callback + diamond callback (`executorFinalizePrepaySale`,
ERC-1271 delegate, conduit allow-list) are byte-for-byte unchanged —
settlement runs through the same code as a v1 fill.

**Agent-proxy extension:** `apps/agent` gains a NEW top-level route
`GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}`
returning the bidder's full signed Seaport `OrderComponents` +
signature + any `CriteriaResolver` needed for collection-criteria
offers (§17.8). The existing
`GET /opensea/offers/{chainId}/{contract}/{tokenId}` (offers-list)
endpoint stays untouched — it serves the "browse offers" pre-Match
path. Distinct top-level prefix (`signed-offer` vs `offers`) avoids
the router-ordering footgun on the shared `/opensea/offers/` GET
handler (Codex round-3 P2 #344). The new endpoint is hit exactly
once per Match click; the dapp passes
`(chainId, contract, tokenId, orderHash)` it already has from the
prior offers-list response.

### 17.4 The new selector

```solidity
function matchOpenSeaOffer(
    uint256 loanId,
    BidderOrder calldata bidder,        // decoded OrderComponents + sig
    bytes32 expectedBidderOrderHash,    // dapp-supplied; must match re-derived
    CriteriaResolver[] calldata resolvers, // empty for item offers
    FeeLeg[] calldata feeLegs,          // freshly re-fetched at click time
    uint256 salt,
    bytes32 conduitKey
) external nonReentrant whenNotPaused returns (bytes32 vaipakamOrderHash);
```

The `BidderOrder` struct is the Seaport `OrderComponents` shape (offer
items, consideration items, offerer, zone, orderType, startTime,
endTime, zoneHash, salt, conduitKey, counter) PLUS the bidder's
`signature` bytes PLUS the OpenSea SignedZone `extraData` bytes
(Codex round-6 P2 #344 — required for fee-enforced collections that
use SIP-7 zone validation). Decoded from the agent's signed-offer
response on the dapp side; passed as calldata.

Returns the Vaipakam-side counter-order's hash for indexer + dapp
breadcrumb purposes (mirrors `postPrepayListing`'s `bytes32 orderHash`
return).

**Authority gate** (Codex round-4 P1 #344). The selector MUST also
gate `msg.sender == VaipakamNFTFacet(address(this)).ownerOf(loan.
borrowerTokenId)` — identical to v1 `postPrepayListing`'s
`NotPositionHolder(loanId, msg.sender, holder)` check. Without it
any third party who finds an acceptable OpenSea offer could
force-settle a borrower's loan without the borrower's consent (the
proceeds route correctly to the borrower's vault, but the borrower
loses agency over WHEN their loan closes). The gate also subsumes
sanctions screening on the borrower side (via `_assertNotSanctioned`
on `msg.sender`, same shape v1 entry points use). Two reverts in
the §17.4 surface:
- `NotPositionHolder(loanId, msg.sender, holder)` — borrower lost
  ownership of the position-NFT (sold / transferred).
- `SanctionedAddress(msg.sender)` — borrower is on the sanctions
  oracle (Tier-1 entry, same gate as v1 `postPrepayListing`).

### 17.5 Bidder-offer bytes verification

**Ratified 2026-06-03 with user:** protocol re-derives the bidder's
`orderHash` via `Seaport.getOrderHash(bidder.components)` and reverts
`BidderOrderHashMismatch(expected, derived)` if it differs from the
dapp-supplied `expectedBidderOrderHash`. Same belt-and-braces shape
PR #307 fixed for the Vaipakam-side: borrower-controlled inputs cannot
move; the bidder's signature only authorises exactly the bytes we
decoded.

**Expected-hash pinning — pinned from the offers LIST, not the
signed-bundle response** (Codex round-1 P2 #344). The dapp's flow:

1. Dapp displays the offers panel via the shipped agent route
   `GET /opensea/offers/{chainId}/{contract}/{tokenId}` (Codex
   round-5 P3 #344 — the dapp resolves `(chainId, contract, tokenId)`
   from `loan.collateralAsset` + `loan.collateralTokenId` + the
   active chain context). That response carries the orderHash for
   each offer. The dapp pins the chosen offer's orderHash from THIS
   payload before any subsequent fetch.
2. Borrower clicks Match on offer with `pinnedOrderHash`.
3. Dapp hits
   `GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{pinnedOrderHash}`
   — orderHash is in the URL path, so the agent's response is bound
   to it. The agent's response is the signed `OrderComponents` +
   signature + resolvers.
4. Dapp passes `(decodedComponents, pinnedOrderHash, sig, resolvers)`
   to the on-chain selector — `expectedBidderOrderHash` is
   `pinnedOrderHash`, NOT a fresh recompute from `decodedComponents`.
5. On-chain re-derive: `Seaport.getOrderHash(decodedComponents)` →
   compared against `pinnedOrderHash`. Any drift (compromised agent
   substituting a different valid signed offer at the bundle step)
   reverts `BidderOrderHashMismatch`.

The pin happens at the offers-list step (step 1), NOT at the
signed-bundle step (step 3). A compromised bundle endpoint that
returns DIFFERENT bytes than the pinned hash can no longer slip a
substitute offer through the on-chain check.

**Sanity-check on `getOrderStatus`** — explicitly NOT used to gate
fillability (Codex round-1 P2 #344). Seaport's `getOrderStatus`
returns `(isValidated, isCancelled, totalFilled, totalSize)`; for
ordinary off-chain-signed OpenSea offers, `isValidated == false`
because the order has never been pre-validated on-chain. Treating
`!isValidated` as "not fillable" would reject every normal offer.

The protections we actually need are:
- **Signature validity** — Seaport's own `matchAdvancedOrders` runs
  the bidder's signature check natively; an invalidly-signed bundle
  reverts inside Seaport, not in our facet.
- **Bidder counter bump** — handled by Seaport's own signature
  validation at match time, NOT by our hash check (Codex round-6 P3
  correction). The decoded `OrderComponents` carry the bidder's
  pre-bump `counter` (snapshotted at agent-fetch); our `Seaport.
  getOrderHash(decodedComponents)` re-derive matches the pinned hash
  cleanly. The revert fires later inside `matchAdvancedOrders` —
  Seaport reads the offerer's CURRENT counter and the order's bound
  counter doesn't match, so Seaport reverts with `InvalidSigner` /
  `BadSignatureV` / equivalent. Borrower's dapp surfaces "this
  offer is no longer valid" and refreshes the offers list.
- **On-chain cancellation** — bidder calling Seaport's `cancel(order)`
  flips `isCancelled = true`. We DO check `isCancelled` explicitly,
  but the `totalFilled >= totalSize` check needs a guard (Codex
  round-2 P1 #344): for an off-chain-signed offer that's never been
  touched on-chain, `getOrderStatus` returns
  `(isValidated=false, isCancelled=false, totalFilled=0,
  totalSize=0)`, which makes `0 >= 0` true and would reject every
  normal offer. The correct check is:
  ```
  if (isCancelled) revert BidderOrderNotFillable(reason: Cancelled);
  if (totalSize != 0 && totalFilled >= totalSize)
      revert BidderOrderNotFillable(reason: FullyFilled);
  ```
  The `totalSize != 0` guard lets ordinary fresh offers through
  (zero denominator means "never recorded on-chain", which Seaport's
  own match-time path handles natively) while still catching the
  "this offer was already filled by someone else" race once Seaport
  has recorded the order.

**No `Seaport.validate(bidderOrder)` call.** That would pre-register
the order in Seaport's state. If our `matchOrders` then reverts
(e.g., for any §17.6 invariant breach), we'd have mutated Seaport
state we don't own. The orderHash compare + the targeted cancel/fill
check give us the same guarantees without the side-effect.

**Bidder order SHAPE invariant** (Codex round-1 P2 #344). Beyond the
hash + cancellation checks, the facet hard-asserts the bidder's
`OrderComponents` shape BEFORE constructing the Vaipakam-side
counter-order and BEFORE invoking `matchAdvancedOrders`:

- `bidder.offer.length == 1` — exactly one offer item. Reverts
  `BidderOrderShapeMismatch(reason: ExtraOfferItems)` if not.
- `bidder.offer[0].itemType == ERC20` — must be an ERC20 (no extra
  NFTs or native ETH wrapped via Seaport's NATIVE itemType).
- `bidder.offer[0].token == loan.principalAsset` — the §17.6 token-
  identity invariant.
- `bidder.offer[0].startAmount == bidder.offer[0].endAmount` —
  fixed-amount offer; reject any Dutch-decay bidder offer (rare on
  OpenSea, but supported by the underlying Seaport order type).
- **Bidder consideration layout** (Codex round-6 P2 #344 —
  significantly relaxed from round-1's `length == 1`). OpenSea
  fee-enforced collections require the bidder's signed Offer to
  carry fee legs in its consideration array (see
  [OpenSea's fee docs](https://docs.opensea.io/docs/opensea-fees#where-to-set-fees));
  rejecting `length > 1` would refuse every fee-enforced offer.
  Instead the facet validates the consideration's STRUCTURE:
  - `bidder.consideration.length ∈ [1, 1 + MAX_BIDDER_FEE_LEGS]`
    where `MAX_BIDDER_FEE_LEGS` is the same `5` cap Block A used
    for the seller-side counter (1 NFT + up to 5 fee legs).
    Reverts `BidderOrderShapeMismatch(reason: ExtraConsiderationItems)`
    only if the length exceeds the cap.
  - `bidder.consideration[0]` MUST match the expected NFT shape
    (item position 0 is positional in OpenSea's offer schema):
    itemType ∈ {ERC721, ERC1155, ERC721_WITH_CRITERIA,
    ERC1155_WITH_CRITERIA}, `token == loan.collateralAsset`,
    `recipient == bidder.offerer` (bidder receives the NFT — NOT
    an attacker-supplied address).
  - `bidder.consideration[1..]` (if any) MUST all be ERC20 fee
    legs in `loan.principalAsset`. For each `i ∈ [1, length)`:
    `itemType == ERC20`, `token == loan.principalAsset`,
    `startAmount == endAmount` (no Dutch decay on fee legs).
    Recipients are bidder-signed and trusted (OpenSea / creator
    addresses baked into the signed order); the facet does NOT
    re-derive them, but the dapp's §17.10 fee-schedule
    cross-check ensures the bidder's offer carries the expected
    fee shape against the LIVE OpenSea collection-fee schedule.
  - **Sum invariant** (load-bearing): `Σ(consideration[i].
    startAmount for i ∈ [1, length)) ≤ bidder.offer[0].startAmount
    - MIN_PROTOCOL_TAKE`, where `MIN_PROTOCOL_TAKE` is the floor +
    buffer + Vaipakam's own protocol legs (lender + treasury +
    borrower remainder). Reverts
    `BidderOrderShapeMismatch(reason: FeeLegsExceedAvailable)`
    if bidder fees would consume so much of the offer that the
    protocol legs can't be fully paid. Computed at facet entry
    against `freshFeeLegs` from §17.10.
- **NFT quantity exact-match** (Codex round-2 P1 #344). The bidder's
  consideration-item amount MUST equal the full collateral quantity
  being settled:
  - For ERC721 / ERC721_WITH_CRITERIA itemTypes:
    `consideration[0].startAmount == endAmount == 1`. Standard ERC721
    semantics; a bidder offer asking for `amount > 1` is malformed.
  - For ERC1155 / ERC1155_WITH_CRITERIA itemTypes:
    `consideration[0].startAmount == endAmount == loan.collateralQuantity`.
    The full vaulted balance gets sold as one lot; the §17.9 fulfillment
    pairs the Vaipakam offer item (NFT amount = `loan.collateralQuantity`)
    with the bidder consideration item. Without this exact-match check,
    OpenSea's common `amount = 1` ERC1155 collection offer would settle
    the loan in full while only delivering 1 unit on the bidder side —
    and the §17.9.bis `recipient = executor` defense-in-depth would
    then receive the remaining `loan.collateralQuantity - 1` units as
    "unspent offer items" (lost to the executor's sweep helper). Hard-
    reverts `BidderOrderShapeMismatch(reason: NftAmountMismatch)`
    before any state mutation.
  - The startAmount + endAmount equality on the NFT item is also
    asserted (no Dutch-decay NFT amount; matches the §17.5-bis
    offer-side fixed-amount rule).
- `bidder.consideration[0].identifierOrCriteria` semantics depend on
  itemType: for ERC721/ERC1155 (item offer) it must equal
  `loan.collateralTokenId`; for *_WITH_CRITERIA (collection offer)
  it's a Merkle root, and §17.8's CriteriaResolver supplies the
  proof + actual identifier at match time. The §17.5 hash-rederive
  binds the criteria root to the bidder's signature, so the
  resolver can only prove inclusion against the root the bidder
  actually signed.

**Why this matters.** `Seaport.matchAdvancedOrders` takes a
`recipient` parameter; any offer items NOT consumed by a
`Fulfillment` get routed to that recipient. The §17.9 fulfillment
layout consumes only `bidder.offer[0]`. If the bidder's order has
extra offer items (e.g., a second ERC20, or an NFT the bidder also
signed for), those extras get transferred to `msg.sender` (the
borrower) on match. A compromised agent that surfaces a
maliciously-crafted multi-item bidder order would let a borrower
silently receive tokens they didn't expect — which on its own is
"free", but can also be a vector:

- A revert-on-transfer token that grief-aborts the whole match.
- A wash-trading or sandwich vector where the bidder signs for
  extra outflows expecting them to be ignored by an honest match,
  then a forensic-trail-poisoning row in chain history.
- Approval-front-running setups via approved-on-transfer hook
  tokens.

The shape invariant closes all of these — if the bidder's order
isn't EXACTLY 1 offer item + 1 consideration item in the expected
shape, the facet reverts before any state is touched.

### 17.6 Token-identity invariant — bidder paymentToken == loan.principalAsset

**Load-bearing invariant** (called out by the user during ratification):
the bidder's offer-item `token` MUST equal the loan's
`principalAsset`. The facet reverts
`BidderPaymentTokenMismatch(expected, actual)` otherwise.

Reason: §15.7 ("Lending-asset-only consideration") is invariant across
all modes. The counter-order's consideration legs are
1-for-1-routed from the bidder's offer item via `Fulfillment[]`;
Seaport cannot transmute WETH→USDC inside a match. If we accepted a
bidder offer in a token ≠ `loan.principalAsset`, the lender would be
paid out in the wrong asset, repayment accounting would break, and
§15.7 would be silently violated.

The dapp's offer filter (§15.3 step 4) already implicitly enforces
this — its "Acceptable" comparison
`offer_value ≥ floor + buffer + fees` is denominated in the loan's
lending asset and is meaningless if the bidder's offer is in any other
token. The on-chain check is the belt-and-braces guard against a
compromised agent proxy surfacing an offer in the wrong token.

**No WETH↔ETH normalization layer needed.** Native ETH is NOT and has
never been a supported `principalAsset` shape anywhere in the protocol
— every offer / loan / repay / listing path discriminates on
`AssetType ∈ {ERC20, ERC721, ERC1155}` and the prepay-listing facet
already reverts `UnsupportedPrincipalForV1` for non-ERC20 principal.
A borrower who wants to "lend ETH" wraps to WETH9 (an ERC20) at offer
creation; OpenSea's "make offer" flow also always wraps to WETH on
the bidder side. The bidder's paymentToken and the loan's
principalAsset are therefore both ERC20s by construction; the
token-identity invariant collapses to a simple `==` check with no
normalization layer.

Confirmed by the codebase verification 2026-06-03 (no `msg.value`, no
`.call{value:}`, no `address(0)`-as-principal handling in
`OfferCreateFacet` / `OfferAcceptFacet` / `LoanFacet` / `RepayFacet`).
This is a contract-policy invariant, not an out-of-scope deferral.

### 17.7 Counter-order construction

The new facet constructs a Vaipakam-side counter-order on-the-fly.
**The counter-order does NOT include OpenSea/creator fee legs**
(Codex round-6 P2 #344 correction); those legs are in the BIDDER's
consideration array per §17.5-bis (signed by the bidder, enforced by
OpenSea's SignedZone at fill time). Vaipakam's consideration carries
ONLY the protocol legs:

```
offerer:      borrower's vault (holds the NFT)
zone:         CollateralListingExecutor (FULL_RESTRICTED)
offer:        [{ itemType: ERC721 or ERC1155,
                token: loan.collateralAsset,
                identifier: loan.collateralTokenId,
                amount: loan.collateralQuantity }]
consideration: [
  { token: loan.principalAsset, amount: lenderLeg,    recipient: lenderNftOwner },
  { token: loan.principalAsset, amount: treasuryLeg,  recipient: s.treasury },
  { token: loan.principalAsset, amount: borrowerRem,  recipient: borrowerNftOwner }
]
orderType:    FULL_RESTRICTED
startTime:    block.timestamp
endTime:      pctx.graceEnd
zoneHash:     0x0
salt:         (facet-supplied)
conduitKey:   (facet-supplied; must be approvedConduits[conduit])
counter:      seaport.getCounter(vault)
```

**Three legs always (lender + treasury + borrower remainder)**; the
bidder's signed Offer carries fee legs in ITS consideration if any
apply (verified by §17.5-bis). The facet computes:
- `bidderFeeTotal = Σ(bidder.consideration[i].startAmount for i ∈ [1, length))`
- `borrowerRem = bidder.offer[0].startAmount - lenderLeg - treasuryLeg - bidderFeeTotal`

Reverts `AtomicMatchInsufficientForBorrower(borrowerRem)` if
`borrowerRem < 0` (i.e., bidder's signed fees + protocol legs exceed
the offer value). This is the §17.5-bis sum invariant enforced at
the facet boundary.

The facet calls `LibPrepayOrder.buildAndHash(...)` (or a small wrapper
that recomputes floor + remainder from `offer_value - bidderFeeTotal`)
and emits a **dedicated `PrepayListingMatched` event** (NOT
`PrepayListingPosted` — Codex round-1 P3 #344, ratifying §17.16 Q2).
Atomic matches are SHORT-LIVED
on-chain (the same tx posts and settles); emitting `PrepayListingPosted`
on a match would split indexer semantics ("listing is live now") from
the immediate `executorFinalizePrepaySale` settlement. The indexer
handles `PrepayListingMatched` end-to-end without a transient "live
listing" row.

```solidity
event PrepayListingMatched(
    uint256 indexed loanId,
    address indexed matcher,           // borrower (msg.sender)
    bytes32 indexed vaipakamOrderHash,
    bytes32 bidderOrderHash,
    address bidder,
    uint256 offerValue,
    address paymentToken,              // == loan.principalAsset
    address conduit,
    bytes32 conduitKey,
    address executor,
    FeeLeg[] feeLegs
);
```

The existing `PrepayListingPosted` event stays bound to the v1
`postPrepayListing` flow only (manual borrower-side post + the
`updatePrepayListing` re-sign-on-floor-drift path).

**The `borrowerRem` (consideration item 3) is the per-match remainder
computed from `offer_value - lenderLeg - treasuryLeg - bidderFeeTotal`.**
This is the borrower's profit on the match. Must be ≥ 0; the facet's
floor + buffer assertion (`_requireAskCoversFloorWithFees`, existing
helper, called with `effectiveAsk = offer_value - bidderFeeTotal`)
reuses without modification.

### 17.8 Criteria-based collection offers

OpenSea offers come in three flavours:

- **Item offers**: `consideration = [{ ERC721/1155, specificTokenId → bidder }]`.
  Vanilla `Seaport.matchOrders` works; `CriteriaResolver[]` is empty.
- **Wildcard collection offers**: `consideration = [{ ERC721/1155, criteria=0x0, → bidder }]`.
  Requires `matchAdvancedOrders` with one resolver
  `{ orderIndex: 0, side: Consideration, index: 0, identifier: loan.collateralTokenId, criteriaProof: [] }`.
- **Traited collection offers**: `consideration = [{ ERC721/1155, criteria=Merkle-root, → bidder }]`.
  Requires `matchAdvancedOrders` with a real Merkle proof. **The
  agent proxy fetches the proof from OpenSea's API** alongside the
  signed-bundle.

**Round 6 supports all three.** Implementation uses
`Seaport.matchAdvancedOrders` unconditionally — vanilla item-offer
calls pass an empty `CriteriaResolver[]` and the call collapses to the
basic-match path internally.

### 17.9 Fulfillment[] layout

**Seaport's fulfillment mechanic — important clarification** (Codex
round-6 P1 #344). `matchAdvancedOrders` takes a `Fulfillment[]`
array. Each `Fulfillment` aggregates a SET of offer items (matched
on itemType+token+identifier+offerer) and a SET of consideration
items (matched on itemType+token+identifier+recipient). Seaport's
internal `_applyFulfillment` decrements the matched offer item's
`endAmount` by the consideration aggregate after each Fulfillment;
the SAME `FulfillmentComponent { orderIndex: 0, itemIndex: 0 }` MAY
appear in multiple Fulfillments, with Seaport tracking the
remaining balance.

The match settles iff the FINAL balance on every offer item is
exactly zero AND every consideration item is paid in full (the
`OrderFulfilled` invariant). If any consideration is short-paid or
any offer item is over-consumed, Seaport reverts the whole match.

For the atomic-match:
- Order 0: bidder's existing OpenSea offer (offer items: ERC20
  paymentToken; consideration items: [NFT → bidder] + zero or more
  fee legs).
- Order 1: Vaipakam-side counter-order (offer items: NFT;
  consideration items: [lender, treasury, borrower]).

The bidder's `offer[0]` (ERC20 amount = `offer_value`) is split
across:
1. All bidder consideration fee legs (positions [1..]); these are
   paid out of the bidder's own offer to the bidder's signed fee
   recipients.
2. Vaipakam's three consideration legs (lender, treasury,
   borrower).

Vaipakam's `offer[0]` (NFT) settles bidder's `consideration[0]`
(NFT → bidder).

Fulfillments — computed on-chain in the facet:

```
n_bidderFees = bidder.consideration.length - 1   // positions [1..]

// (A) Bidder offer-item amount → bidder's own fee legs.
for i in 1..bidder.consideration.length:
  Fulfillment {
    offerComponents: [{ orderIndex: 0, itemIndex: 0 }],
    considerationComponents: [{ orderIndex: 0, itemIndex: i }],
  }

// (B) Bidder offer-item amount → Vaipakam's three protocol legs.
for j in 0..3:
  Fulfillment {
    offerComponents: [{ orderIndex: 0, itemIndex: 0 }],
    considerationComponents: [{ orderIndex: 1, itemIndex: j }],
  }

// (C) Vaipakam offer item (NFT) → bidder's consideration[0] (NFT).
Fulfillment {
  offerComponents: [{ orderIndex: 1, itemIndex: 0 }],
  considerationComponents: [{ orderIndex: 0, itemIndex: 0 }],
}
```

Total Fulfillments: `n_bidderFees + 4` (3 protocol legs + 1 NFT
leg + n_bidderFees fee legs). For a typical fee-enforced collection
with 2 fee legs (OpenSea platform + creator royalty) that's 6
Fulfillments; for a fee-free collection (no fee legs) it's 4.

**Balance verification** at fulfillment construction time (on-chain
double-check before invoking Seaport — defense-in-depth, even
though Seaport will catch the violation):

```
total_consumed = bidderFeeTotal + lenderLeg + treasuryLeg + borrowerRem
assert(total_consumed == bidder.offer[0].startAmount)
```

If this assert fails, the facet reverts
`AtomicMatchBalanceMismatch(consumed, available)` before invoking
Seaport (saves a Seaport revert with a less informative error
message).

**Same-offer-item-in-multiple-Fulfillments is the canonical
Seaport pattern** for multi-leg sales — this is how OpenSea's own
listing fulfillments split a buyer's payment across seller +
platform + royalty recipients via Seaport. Block D's unit test
exercises a 6-Fulfillment match against a mocked Seaport to confirm
the `_applyFulfillment` decrementing works as designed.

### 17.10 OpenSea fee handling (verified-passthrough, not reconstructed)

**The bidder's signed Offer is the authoritative fee source** (Codex
round-6 P2 #344 correction). For fee-enforced collections, OpenSea
bakes the platform-fee + creator-royalty legs into the bidder's
consideration array at the moment the bidder signs the offer; those
legs are bound by OpenSea's SignedZone (SIP-7 / SIP-12) `extraData`
which the zone validates at fulfillment time.

**Vaipakam's counter-order does NOT add fee legs** (drops the round-5
mistake of putting fees on both sides). Instead the dapp +
on-chain facet **verify** the bidder's fee legs against the live
OpenSea collection-fee schedule:

1. Dapp hits `GET /opensea/collection/{slug}` to fetch the live fee
   schedule (same shape as §15.3 step 5).
2. Dapp computes expected fee amounts against `bidder.offer[0].
   startAmount` and compares to `bidder.consideration[1..]`:
   - Expected recipients must match exactly (set-equality).
   - Each fee amount = `offer_value × feeBps[i] / 10000`; the
     bidder's signed amount must equal that (no over-charge).
3. If verification fails, the dapp greys out the Match button with
   "this offer's fee structure doesn't match the live collection
   schedule — refresh"; the borrower cannot trigger
   `matchOpenSeaOffer` against an off-spec bidder offer.

**On-chain side**: the facet does NOT re-verify against an oracle
(no on-chain fee schedule exists for OpenSea collections); the
§17.5-bis sum invariant (`Σ(bidder fees) + protocol legs ≤
offer_value`) is the load-bearing on-chain check. Off-spec bidder
fee distributions are caught dapp-side; the on-chain side only
asserts the math balances.

**Why this is safer than the round-5 design**: putting fee legs in
Vaipakam's counter-order would mean Vaipakam-side authorisation of
the OpenSea fee recipients (the borrower's vault would sign through
the executor's ERC-1271 path for "yes, this NFT can be sold with
these fees going to these addresses"). That's a wider attack
surface than necessary — the bidder already signed the same fees
via OpenSea's signing oracle.

### 17.11 Vault wiring + executor recordOrder + pre-existing-listing auto-clear

The new facet's flow at matching time (after all validation passes):

**STEP 0 — MANDATORY pre-existing-listing auto-clear** (Codex round-1
P2 #344, ratifying §17.16 Q3). The normal Match flow starts from a
state where the borrower has already posted a v1 listing — meaning
`s.prepayListingOrderHash[loanId] != bytes32(0)` AND
`LibERC721.lockOf(borrowerTokenId) == LockReason.PrepayCollateralListing`.
The atomic-match facet MUST clear both before its own `_lock` step
or the lock check reverts `BorrowerNFTAlreadyLocked` and the whole
Match button path is broken.

The auto-clear runs the same effects as `cancelPrepayListing` against
the existing listing, in this order:

a. Read `existingHash = s.prepayListingOrderHash[loanId]`. **If zero,
   skip ALL of steps b–g** (borrower clicked Match without ever
   posting first; supported but rare — the offers list is normally
   only populated for posted listings). Codex round-2 + round-4 P3
   #344 — emitting `PrepayListingCanceled(bytes32(0))` for a
   never-posted listing creates a false cancellation row in the
   indexer history. Step g (the canceled-event emit) is part of the
   sequence being skipped, not "skip b-f and fall through to g".
b. Resolve `pinnedExecutor = s.prepayListingExecutor[loanId]`.
   Defensive `revert ExecutorNotSet()` if zero (matches v1
   `_cancel:1090` — non-zero `existingHash` invariably pairs with
   non-zero `pinnedExecutor` since post/update write both
   atomically; the guard exists for migration-mid-rollout safety).
c. `LibERC721._unlock(borrowerTokenId)` — releases the v1 lock so
   the upcoming step 3 lock-acquire succeeds.
d. Clear storage slots: `delete s.prepayListingOrderHash[loanId]`,
   `delete s.prepayListingExecutor[loanId]`.
e. `pinnedExecutor.clearOrder(existingHash)` — the shipped
   recorder cleanup method (Codex round-2 P2 #344); its
   implementation runs the best-effort on-Seaport cancel via
   `_tryCancelOnSeaport` (emits `SeaportCancelSkipped` on revert
   per the §316 pattern). Called AFTER the storage delete so a
   downstream revert can't leave a dangling executor entry.
f. **Vault-side cleanup** — call
   `LibPrepayListingWiring.unwire(s, loan, existingHash)` (Codex
   round-4 P2 #344 — same library the new facet uses to wire on
   step 5; the v1 `_cancel:1111-1120` block refactors to call this
   helper too). The library performs:
   - **ERC721 only**: `vault.setCollateralOperatorApproval(
     loan.collateralAsset, loan.collateralTokenId, address(0),
     false)` — clears the per-token approval that the prior wiring
     granted. **ERC1155 deliberately leaves the operator-wide
     approval in place** (v1 comment at NFTPrepayListingFacet.sol
     lines 1103-1110): for ERC1155 there's no per-token approval
     surface, and the orderHash-binding revoke below is the
     authoritative safety primitive (without ERC-1271 saying "yes,
     this hash is mine", no fill can succeed regardless of
     operator-approval state). This matches the shipped Seaport
     ERC1155 conduit pattern.
   - **Both asset types**: `vault.revokeListingOrderHash(existingHash)`
     — invalidates the ERC-1271 binding. After this, the vault
     answers `INVALID` for any Seaport signature query against
     `existingHash`, so even if a Seaport-side replay attempt
     somehow occurred against the dangling order it can't fill.
g. Emit `PrepayListingCanceled(loanId, msg.sender, existingHash,
   reason: ReplacedByMatch)` — new `CancelReason` enum value
   distinguishes this from manual / expired cancels for indexer
   semantics.

Steps b–g are atomic with the rest of the match (whole tx reverts on
any failure downstream); the existing listing is canceled if and only
if the match settles. No "partial replacement" state is reachable.

**STEP 1 — Construct counter-order components.**

**STEP 2 — Re-derive** `vaipakamOrderHash` via `Seaport.getOrderHash`.

**STEP 3 — Lock the borrower NFT.**
`_lock(borrowerTokenId, LockReason.PrepayCollateralListing)` — same
lock the v1 path uses. The lock releases at zone-callback time via
`executorFinalizePrepaySale`.

**STEP 4 — Pin the order on the executor + restamp the diamond
slots** (Codex round-3 P2 #344). Three storage writes:
- `executor.recordOrder(vaipakamOrderHash, loanId, ...,
  PREPAY_MODE_ATOMIC_MATCH, feeLegs)` — pins the counter-order in
  the executor's `orderContext` map so the executor's ERC-1271
  delegate returns true when Seaport queries via the vault.
- `s.prepayListingOrderHash[loanId] = vaipakamOrderHash` — **the
  load-bearing restamp**. Step 0(d) cleared this slot for the
  pre-existing v1 listing; without the restamp the shipped
  `PrepayListingFacet.executorFinalizePrepaySale` finalize-path
  (which reads the slot to find the orderHash to revoke on the
  vault) sees `bytes32(0)` and skips the revoke, leaving the new
  atomic-match's vault ERC-1271 binding alive after settlement.
- `s.prepayListingExecutor[loanId] = address(executor)` — paired
  with the orderHash restamp so the finalize path resolves the
  same executor the recordOrder pinned.

**STEP 5 — Wire the vault** (Codex round-4 P2 #344). The v1 helper
`NFTPrepayListingFacet._wireVaultForListing` is `private` and
therefore not callable from the new sibling facet. Block D extracts
the helper body into a **new internal library
`LibPrepayListingWiring`** (the small library naming convention v1
already uses for `LibPrepayOrder`, `LibPrepayCleanup`) with two
external `internal` entry points the new facet calls:

- `LibPrepayListingWiring.wire(s, loan, orderHash, conduit, executor)`
  — performs the asset-type-aware approval grant (per-token for
  ERC721 via `setCollateralOperatorApproval`; operator-wide for
  ERC1155 via `setCollateralOperatorApprovalERC1155`) AND calls
  `vault.registerListingOrderHash(orderHash, executor)` to pin the
  ERC-1271 mapping. Same effects as the v1 private helper, just
  reachable from outside `NFTPrepayListingFacet`.
- `LibPrepayListingWiring.unwire(s, loan, orderHash)` — the
  symmetric cleanup the §17.11 step 0(f) auto-clear runs (ERC721-only
  `setCollateralOperatorApproval(..., address(0), false)` + always
  `vault.revokeListingOrderHash(orderHash)`).

**v1 site update**: `NFTPrepayListingFacet._wireVaultForListing` +
the `_cancel` vault-cleanup block (lines 1111-1120) refactor to call
the library — same effects, new home. Adds a single library to the
audit scope; saves duplicating the wiring logic in the new facet.

(Round-2 design draft's `bindListingOrderHash` was a method-name
error; the shipped vault method is `registerListingOrderHash`.)

Without step 5 the vault returns the failure value when Seaport
queries `isValidSignature` and `matchAdvancedOrders` reverts on the
Vaipakam-side signature check.

**STEP 6 — Settle** (Codex round-5 P2 #344 — full AdvancedOrder
wrapping). `Seaport.matchAdvancedOrders` does NOT accept bare
`OrderComponents + signature`; both sides must be wrapped as
Seaport `AdvancedOrder { parameters, numerator, denominator,
signature, extraData }` structs. The facet constructs the two
AdvancedOrders inline:

```solidity
AdvancedOrder[] memory orders = new AdvancedOrder[](2);

// Index 0 — bidder's order (Codex round-6 P2 #344 — extraData
// passthrough required for OpenSea SignedZone fee-enforced
// collections).
orders[0] = AdvancedOrder({
    parameters: _toOrderParameters(bidder.components),  // OrderComponents minus counter
    numerator:   1,                                      // full-fill
    denominator: 1,
    signature:   bidder.signature,
    extraData:   bidder.extraData                        // SIP-7 zone authorisation
});

// Index 1 — Vaipakam counter-order
orders[1] = AdvancedOrder({
    parameters: _vaipakamOrderParameters(...),           // built from §17.7
    numerator:   1,
    denominator: 1,
    signature:   "",                                     // ERC-1271 path; no off-chain sig
    extraData:   ""
});

seaport.matchAdvancedOrders(orders, resolvers, fulfillments, recipient);
```

Where `recipient` is set to the **executor's address, not
`msg.sender`** (see §17.9.bis below); this defangs ERC20 leakage
from a malformed bidder bundle that somehow gets past the §17.5-bis
shape check.

**Why `numerator = denominator = 1`**: a full-fill on both orders.
Seaport's partial-fill mechanic uses these as a fraction; passing
1/1 settles each order to completion in one call. The bidder's
single-leg offer + Vaipakam's single-NFT offer don't support
partial fills under our shape invariant anyway.

**Bidder's `extraData` MUST pass through** (Codex round-6 P2 #344
correction). OpenSea's SignedZone (SIP-7) for creator-fee-enforced
collections requires the bidder's signed `extraData` blob (carrying
OpenSea's signing oracle authorisation) to be passed unmodified to
`matchAdvancedOrders`. Hard-coding `extraData = ""` on the bidder
order would revert at the SignedZone validation step even when the
signature and components are correct.

The agent's `GET /opensea/signed-offer/{...}/{orderHash}` endpoint
returns the bidder's `extraData` alongside the components +
signature; the dapp threads it into the BidderOrder struct; the
facet copies `bidder.extraData` into `orders[0].extraData`.

**Vaipakam-side `extraData = ""` is correct**: the Vaipakam
counter-order uses FULL_RESTRICTED with our own
`CollateralListingExecutor` zone callback path, not OpenSea's
SignedZone, so no `extraData` payload is needed.

**`OrderParameters` vs `OrderComponents`**: identical fields EXCEPT
`OrderComponents` carries `counter` (read by Seaport to validate
the bidder's nonce-equivalent), while `OrderParameters` carries
`totalOriginalConsiderationItems` (a length value Seaport uses for
its consideration-array bounds check). The facet's
`_toOrderParameters(components)` helper drops `counter`, sets
`totalOriginalConsiderationItems = components.consideration.length`,
and copies all other fields. Block D includes a unit test confirming
the conversion is byte-stable.

Atomic effects: if step 6 reverts, every prior storage write reverts
with it (Solidity tx semantics, including the step-0 auto-clear). If
step 6 succeeds, the zone callback fired during the match runs
`executorFinalizePrepaySale` which (matching the shipped v1 finalize
path byte-for-byte — Codex round-4 P3 #344):
1. Reads `s.prepayListingOrderHash[loanId]` (restamped at step 4 →
   `vaipakamOrderHash`) and `s.prepayListingExecutor[loanId]`.
2. Calls `vault.revokeListingOrderHash(vaipakamOrderHash)` —
   invalidates the ERC-1271 binding.
3. Deletes `s.prepayListingOrderHash[loanId]` +
   `s.prepayListingExecutor[loanId]`.
4. Flips loan status, unlocks the borrower NFT, settles LIF.

(Note: the shipped v1 finalize-path does NOT explicitly clear the
per-token ERC721 operator approval — the NFT transfer to the bidder
that Seaport just executed auto-clears the approval as a side effect
of `IERC721.transferFrom`. Round-3 design draft listed this as a
finalize-path effect; corrected here to match shipped behavior.)

No orphan state. The restamp at step 4 is the load-bearing fix that
keeps the new atomic-match's vault binding from leaking past
settlement.

### 17.9.bis matchAdvancedOrders `recipient` — set to the executor

`matchAdvancedOrders(orders, resolvers, fulfillments, recipient)`:
Seaport routes any UNCONSUMED offer items (offer items not paired
to a consideration via `fulfillments`) to `recipient`. The §17.9
fulfillment layout consumes exactly the bidder's `offer[0]` and the
Vaipakam-side `offer[0]`, so in the happy path there's nothing left
over and `recipient` doesn't receive anything.

But in the defense-in-depth posture: if the §17.5-bis bidder-shape
check is somehow bypassed (logic bug, future Seaport upgrade
changing offer-item semantics), any unspent bidder offer items would
flow to `recipient`. Setting `recipient = executor` rather than
`msg.sender` means the leakage lands at a code-controlled address
with no `withdraw` surface, NOT at the borrower's EOA where it could
be silently swept by a malicious tx in the same block.

**Asymmetric outcome by leaked-item type** (Codex round-3 P3 + round-4
P2 #344):

- **ERC20 leakage** can land at the executor — ERC20 transfers don't
  call recipient hooks. The executor adds a simple
  `sweepStrayTokens(token, to)` helper restricted to `onlyOwner`
  (governance / timelock post-handover) so post-mortem recovery is
  possible without re-deploying.
- **ERC1155 leakage** **fails the entire match closed**. Seaport's
  ERC1155 execution path uses `safeTransferFrom`, which calls
  `onERC1155Received` on the recipient. The executor is
  **deliberately NOT an `ERC1155Holder`** — its base contract
  doesn't implement that hook, so any Seaport-attempted ERC1155
  transfer to the executor reverts → whole match reverts (Solidity
  tx atomicity). No leak, no settlement, no orphan state.
- **ERC721 leakage CAN STRAND** (Codex round-4 P2 correction). Unlike
  ERC1155, Seaport's ERC721 path uses ordinary `transferFrom`, NOT
  `safeTransferFrom` — so `onERC721Received` is NOT called and
  the NFT lands on the executor regardless of whether the executor
  implements the hook. The "fail-closed by construction" claim I
  made in round-3 was wrong for ERC721. To handle this case the
  executor exposes a second sweep helper:
  `sweepStrayERC721(token, tokenId, to) onlyOwner` for governance
  recovery of stranded ERC721 items. (Recovery still requires
  governance action; the recipient redirection just keeps the
  stranded NFT off the borrower's EOA where it could be
  attacker-swept.)

**Primary defense is the §17.5-bis shape invariant** (offer-item
single + correct token + correct NFT shape; round-2 P1 added the
NFT-amount exact-match for ERC1155). The recipient-redirection +
sweep helpers exist as recovery surfaces for the case where a future
hardfork or Seaport upgrade introduces a loophole the shape check
doesn't cover; they are NOT a substitute for the shape check.

Scope-of-claim refined: §17.5-bis + ERC1155 receiver-hook absence
close ERC20 + ERC1155 leakage paths by construction. ERC721 leakage
relies on the §17.5-bis check + governance recovery via
`sweepStrayERC721`; an ERC721 backstop "by construction" would need
either a Seaport upgrade adding `safeTransferFrom` to its ERC721
path (out of our control) OR a custom Vaipakam-side receiver wrapper
on the executor that consumes ERC721 transfers — explicitly not
worth the audit surface for a path that requires a §17.5-bis
bypass to reach.

### 17.12 Bidder-side OpenSea state after matchOrders

Seaport emits `OrderFulfilled(bidderOrderHash, bidder, zone, recipient,
offer, consideration)` when the bidder's offer is matched. OpenSea's
indexer ingests that and marks the bidder's offer as **filled** in the
collection's offer book. From the bidder's perspective:

- They get the NFT they bid for (`consideration[0]` → bidder).
- Their ERC20 was pulled (`offer[0]` X → counterparties).
- Their OpenSea inbox shows "offer filled".

This is the same outcome shape as a vanilla `Seaport.fulfillBasicOrder`
acceptance. **The "bidder UX confusion" §15.3 worried about in v1
deferral does not materialise** — Seaport's `OrderFulfilled` event is
the protocol's canonical fill signal regardless of which fulfill /
match entry point produced it. OpenSea's indexer treats all fills
identically.

Out-of-band notification: the dapp can optionally surface "Your offer
on Loan #X was matched — settlement landed in tx Y" via the existing
push channel (see `feedback_push_notifications`), but this is UX
polish, not a contract concern.

### 17.13 v1 Match flow deprecation + dapp migration

Post-merge of the contract PR + dapp PR:

- `OpenSeaOffersSection`'s Match callback rewires from
  `updatePrepayListing(newAsk = offer_value, freshFeeLegs)` to
  `matchOpenSeaOffer(loanId, signedBundle, expectedHash, resolvers, freshFeeLegs, salt, conduitKey)`.
- The v1 `updatePrepayListing` selector stays on the diamond. Still
  useful for **manual re-sign on floor drift** (borrower posts at
  reserve; after a few hours interest eats through the buffer;
  borrower re-signs at a slightly higher ask — no Match event
  involved).
- The dapp's `useNFTPrepayListing` hook keeps `updatePrepayListing`
  for the manual-resign path; adds a new `matchOpenSeaOffer` method
  for the Match button.
- The MEV race-window tooltip Phase 6 added on the Match button is
  removed — there is no race window.
- The #335 indexer breadcrumb (PR #343, dapp-side POST after each
  Match) stays — it's the analytics signal for "which offer the
  borrower matched", which is meaningful regardless of whether the
  fill was atomic or two-step. The match-source POST fires from the
  same `onReceiptAvailable` callback after `matchOpenSeaOffer` lands.

### 17.14 Threat model — adversarial cases

| Case | Outcome | Why safe |
|---|---|---|
| Bidder cancels OpenSea offer mid-flight (off-chain via OpenSea API) | OpenSea's offer book stops surfacing it; dapp filters it out on next refresh. If the borrower already clicked Match, the tx lands → `Seaport.getOrderStatus` returns `cancelled=false` (off-chain cancels don't on-chain-cancel) → match proceeds, bidder pays. (Off-chain cancels don't bind on-chain.) | Bidder accepted this risk by placing a signed on-chain-bindable offer. |
| Bidder calls `Seaport.incrementCounter` between agent-fetch and Match-tx | The agent's bundle returned `OrderComponents` carrying the bidder's PRE-bump `counter` (decoded from the signed bytes at the agent's fetch moment). The on-chain re-derive hashes those same pre-bump components → matches the pinned hash → `BidderOrderHashMismatch` does NOT fire (Codex round-5 P3 correction). The revert actually comes from Seaport itself at `matchAdvancedOrders` time: Seaport reads the offerer's CURRENT counter and the order's bound counter no longer matches, so Seaport reverts the match with `InvalidSigner` / `BadSignatureV` / equivalent. Borrower's dapp surfaces "this offer is no longer valid; the bidder canceled it" and refreshes. (No facet-side revert needed — Seaport's own signature path catches it.) | Counter bump invalidates the bidder's signature at Seaport's validation step, AFTER our facet's hash check passes. |
| Live floor drifts above `offer_value × (1 - buffer)` between offer-surface and Match-tx | Facet's `_requireAskCoversFloorWithFees(loanId, offer_value, buffer, freshFeeLegs)` reverts. Borrower's dapp shows "this offer is no longer acceptable; floor moved" and refreshes. | Same protection as v1 `updatePrepayListing`. |
| Compromised agent's signed-bundle endpoint returns a DIFFERENT valid bidder offer for the requested orderHash | The dapp's `expectedBidderOrderHash` was pinned from the EARLIER `/opensea/offers/{loanId}` LIST response (§17.5 step 1), NOT from the bundle response. The on-chain re-derive on the substitute bundle's `OrderComponents` produces a different hash than the pinned one → revert `BidderOrderHashMismatch`. | Pinning the expected hash from the list-step (not the bundle-step) is the load-bearing mitigation — see §17.5 expected-hash pinning. |
| Compromised agent serves a maliciously-multi-item bidder bundle (extra offer items, extra consideration items, NFT-recipient address swap) | §17.5-bis bidder-shape invariant rejects: extra offer items / extra consideration items / wrong NFT recipient / non-ERC20 paymentToken / non-fixed-amount offer all revert `BidderOrderShapeMismatch` BEFORE `_lock` and BEFORE `matchAdvancedOrders`. The defense-in-depth fallback: even if a future bug bypassed the shape check, `matchAdvancedOrders(recipient = executor)` (§17.9.bis) catches any unspent leakage at a code-controlled address, not the borrower's EOA. | Shape invariant at the facet boundary + recipient-redirection on Seaport. |
| Mismatched paymentToken (compromised agent surfaces a USDC offer for an ETH-principal loan) | Facet's `BidderPaymentTokenMismatch` revert (§17.6). | Token-identity invariant. |
| Reorg between dapp-fetch and Match-tx land | Bidder's offer counter could be different; getOrderHash + getOrderStatus revalidate at current chain state. Match-tx either lands cleanly or reverts cleanly. | All Seaport state is on-chain at match time. |
| Match-orders reverts mid-match (e.g., bidder's ERC20 balance dropped below `offer_value`) | All prior tx effects revert (lock, record, vault wiring). Loan stays Active; dapp shows the bidder's offer as "unfillable — bidder funds insufficient" on next refresh. | Solidity tx atomicity. |
| Bidder is sanctioned wallet | T-086's sanctions Tier-1 gate doesn't apply to the BIDDER (they're not interacting with the diamond — Seaport pulls their tokens via the conduit). This is the OpenSea operator's responsibility, not Vaipakam's. The borrower IS interacting with the diamond via `matchOpenSeaOffer` so the borrower's sanctions check runs at facet entry (existing `_assertNotSanctioned`). | Bidder's wallet behaviour is OpenSea's perimeter; borrower's wallet is ours. |

### 17.15 EIP-170 + audit considerations

**Facet size estimate:** the new facet has 1 external selector +
helpers for bidder-bytes decoding + fulfillment layout. Estimated 400-
600 LOC compiled → ~6-9 kB deployed runtime. Well under EIP-170's
24,576-byte ceiling. `FacetSizeLimitTest` covers it once added.

**Audit scope:** the new facet + the touched-by-Block-D portions of
the executor + the new library. Auditors focus on:
- **New facet `NFTPrepayListingAtomicFacet`** — bidder-bytes decoding
  correctness (no integer overflow, no untrusted-call surface beyond
  `seaport.getOrderHash` + `seaport.getOrderStatus` which are
  view-only); §17.5-bis shape invariant; fulfillment layout (must
  route every bidder offer-item amount-share to a Vaipakam
  consideration item, no leakage); token-identity invariant
  enforcement; §17.11 step 0 + step 4 storage-ordering correctness;
  borrower-holder gate + sanctions check.
- **Executor diff** (Codex round-4 P2 #344 — IN scope, not excluded).
  The Block D UUPS swap adds: `PREPAY_MODE_ATOMIC_MATCH` recognised
  by `_assertOrderContent` mode-dispatch; cancel-time reconstruction
  branch in `_componentsForCancel`; `sweepStrayTokens(token, to)`
  + `sweepStrayERC721(token, tokenId, to)` `onlyOwner` recovery
  helpers (§17.9.bis). Auditors verify the new mode-dispatch
  branch matches the §17.7 counter-order shape, the cancel
  reconstruction reuses fixed-price components, and the sweep
  helpers can't be invoked outside `onlyOwner`.
- **New library `LibPrepayListingWiring`** — `wire` + `unwire`
  internal entry points; the v1 `NFTPrepayListingFacet._cancel`
  vault-cleanup block + `_wireVaultForListing` body refactored
  through this library (private→library extraction so the new
  sibling facet can reuse). Auditors verify the refactor preserves
  v1 behavior for the post / update / cancel paths byte-for-byte.

**Out of scope for Round 6 audit** — the executor's zone callback
(`validateOrder`), the diamond's `executorFinalizePrepaySale`,
conduit allow-list management, ERC-1271 delegate signature path,
the vault's `registerListingOrderHash` / `revokeListingOrderHash`
mappings. All shipped + audited as part of v1; Block D reuses them
verbatim with no surface change.

### 17.16 Open questions for ratification

1. **Where does the bidder-side OpenSea platform fee belong?**
   OpenSea collection offers don't include a buyer-side platform-fee
   consideration item (the fee comes out of the seller side as part of
   `feeLegs[]`). Confirming: the freshly-fetched `feeLegs` against
   `offer_value` includes BOTH OpenSea's platform fee leg AND the
   creator-royalty leg for fee-enforced collections, all sized to
   `offer_value`. The agent proxy's `/opensea/collection/{slug}` fee
   schedule already returns both (verified against the Block A path's
   fee-re-derivation). **No change needed; flagging for completeness.**

2. **Event shape — RESOLVED 2026-06-03 (Codex round-1 P3 #344).** The
   atomic-match path emits a NEW `PrepayListingMatched` event ONLY,
   NOT `PrepayListingPosted`. Atomic matches are short-lived on-chain
   (post + settle in the same tx); emitting `PrepayListingPosted` on
   a match would split indexer semantics. The `PrepayListingMatched`
   event shape is specified in §17.7. The auto-clear of any
   pre-existing v1 listing emits `PrepayListingCanceled` with a new
   `CancelReason.ReplacedByMatch` enum value.

3. **WETH↔ETH normalization — resolved 2026-06-03.** The protocol is
   ERC20-only by construction; native ETH was never a valid
   `principalAsset`. The token-identity invariant collapses to a
   simple `==` check with no normalization layer. See §17.6 final
   paragraph.

4. **Pre-existing-listing auto-clear — RESOLVED 2026-06-03 (Codex
   round-1 P2 #344).** The atomic-match facet runs auto-clear as
   STEP 0 of the match flow — mandatory, not optional. Without it the
   borrower NFT's existing lock collides with the new lock-acquire and
   every normal Match button press would revert. Full step sequence
   in §17.11 step 0.

5. **Dapp v1 fallback — RESOLVED 2026-06-03.** No fallback. v2 ships
   the full agent + dapp + facet in one atomic merge (same shape as
   Round 5 Block A's atomic-merge constraint). A half-fallback
   creates a worse outage shape than a clean revert; the §17.18
   atomic-merge constraint is now load-bearing for the rest of the
   design.

### 17.17 Out of scope for Round 6

- **Non-OpenSea offers** (Blur, LooksRare, X2Y2). Multi-marketplace
  expansion is Issue [#281](https://github.com/vaipakam/vaipakam/issues/281).
- **Multiple bidder orders matched in one tx** (single bidder per
  match — Seaport supports this but the UX is borrower-confusing).
- **Bidder reputation / sanctions on Vaipakam side** — bidder
  perimeter is OpenSea's, not Vaipakam's (§17.14 last row).
- **Intent-based protocol-solver architecture** (§11). Still a v3
  direction; Round 6's matchOrders flow is the targeted fix.

### 17.18 Sequencing

Round 6 ships as **one atomic Block D** with three sub-stages
co-merging in lockstep (per the §16 "no consumer-deploy split" rule
that worked for Round 5 Block A):

**D.1 — Contracts.**
- New facet `NFTPrepayListingAtomicFacet` with the single
  `matchOpenSeaOffer` selector + the helpers from §17.5–17.9.
- New event `PrepayListingMatched` (per §17.16 Q2, ratified).
- New `CancelReason.ReplacedByMatch` enum value emitted by §17.11
  step 0's auto-clear.
- New `PREPAY_MODE_ATOMIC_MATCH` constant in `PrepayTypes.sol`.
- **`CollateralListingExecutor` UUPS implementation swap** (per
  §17.3 "minimal delta, NOT zero delta"): the new mode constant
  recognised by `_assertOrderContent` (adds `_assertOrderContentAtomic`
  helper) AND by the cancel-time reconstruction in
  `_componentsForCancel` (atomic-match paths reuse the same Seaport
  components shape as fixed-price for cancel purposes); new
  `sweepStrayTokens(token, to)` + `sweepStrayERC721(token, tokenId,
  to)` `onlyOwner` helpers (per §17.9.bis recovery surface — ERC20
  + ERC721 leakage recovery; ERC1155 fails closed via receiver-hook
  absence). Audit scope explicitly includes the executor diff.
- **New library `LibPrepayListingWiring`** (Codex round-4 P2 #344):
  extracts the v1 `NFTPrepayListingFacet._wireVaultForListing` body
  (which is `private` and not callable from the new sibling facet)
  + the cleanup half of `_cancel:1111-1120` into two `internal`
  entry points: `wire(s, loan, orderHash, conduit, executor)` and
  `unwire(s, loan, orderHash)`. v1 sites refactor to call the
  library — same effects, new home. Both the new sibling facet
  (§17.11 step 5 + step 0(f)) and v1 `NFTPrepayListingFacet`
  consume the library; saves duplicating wiring logic. Audit verifies
  the v1 refactor preserves behavior byte-for-byte.
- **NO `VaipakamVaultImplementation` change** (Codex round-4 P3 #344
  correction). The shipped vault already exposes
  `registerListingOrderHash` / `revokeListingOrderHash` +
  `setCollateralOperatorApproval` / `setCollateralOperatorApprovalERC1155`;
  Block D consumes these unchanged. No UUPS proxy swap, no contract
  change. The round-3 design draft scheduled a vault UUPS swap
  unnecessarily; that line is removed.
- Facet-addition 7-site checklist (see
  `feedback_facet_addition_checklist`): `DiamondFacetNames`,
  `SelectorCoverageTest` (×2 sites), `FacetSizeLimitTest`,
  `DeployDiamondIntegrationTest`, `DeployDiamond.s.sol`, `SetupTest`,
  `HelperTest`, `exportFrontendAbis.sh` `FACETS=()`,
  `packages/contracts/src/abis/index.ts` re-export, indexer event-coverage
  allowlist for `PrepayListingMatched`.

**D.2 — `apps/agent`.**
- New `GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}`
  endpoint (Codex round-4 P2 #344 — distinct top-level prefix from
  the existing `/opensea/offers/{chainId}/{contract}/{tokenId}`
  offers-list handler, so the broad `url.pathname.startsWith(
  '/opensea/offers/')` GET branch in `apps/agent/src/index.ts`
  doesn't swallow it). Returns the bidder's signed `OrderComponents`
  + signature + any `CriteriaResolver[]`. Per-IP rate-limited
  (60 req/min/IP, same shape as the other agent POSTs).
- OpenSea API permission delta documentation — confirms the existing
  API tier returns `signature` on the order envelope (verified for
  the dapp's read-only schedule + listings POST tier; the
  signed-offer endpoint uses the same tier).
- Pricing impact note for the operator: the new endpoint hits the
  same OpenSea API quota as the existing offers list endpoint
  (1 RTT per Match-click; negligible).

**D.3 — `apps/defi`.**
- `useNFTPrepayListing.matchOpenSeaOffer(loanId, offer, freshFeeLegs)`
  hook method — fetches signed-bundle from agent, calls the new
  selector, fires the #335 indexer breadcrumb POST in the same
  `onReceiptAvailable` callback shape Round 5 PR #343 established.
- `OpenSeaOffersSection` Match callback rewires to the new method.
- MEV race-window tooltip removed (no more race window).
- `apps/indexer` `chainIndexer.ts` handler for `PrepayListingMatched`
  + `prepay_listings.matched_via` column (NULL = v1 fixed-price /
  Dutch path, `'atomic'` = Round 6 match).

**D.4 — Tests.**
- Foundry: 6-8 cases in
  `contracts/test/NFTPrepayListingAtomicFacetTest.t.sol` covering
  every §17.14 threat-model row + happy-path item + wildcard + traited
  collection offers + ERC1155 collateral.
- Frontend integration test for the Match-button rewire.
- Indexer unit test for `PrepayListingMatched` ingestion.

**Atomic-merge constraint:** D.1 + D.2 + D.3 + D.4 land in ONE PR.
Same shape as Round 5 Block A's no-consumer-split rule — the v1
two-step Match button can't half-work with the new facet, and the
new facet's selector isn't called by anything until the dapp wires
it. The ABI re-export + typecheck gate is the structural enforcement.

**Codex review depth:** ultra (multi-agent cloud review) given the
new contract surface + the consequence of getting the bytes-decode /
fulfillment-layout wrong. Per
`feedback_blocking_review_process` + the user's standing
`feedback_architecture_iteration` (expect 3-6 rounds for security /
architecture changes).
