# NFT Collateral Pre-Default Sale (T-086 design)

**Status:** Round 4 RATIFIED + SHIPPED (PRs #300 / #302 / #303 / #304 / #307 / #308 / #310 / #312 / #317 / #318 / #319 / #321). · Round 5 (fee-legs extension + auction modes) NOT ratified · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279) · Round-5 follow-ups: fee-legs [#313](https://github.com/vaipakam/vaipakam/issues/313), auction modes [#309](https://github.com/vaipakam/vaipakam/issues/309) · Multi-marketplace expansion: [#281](https://github.com/vaipakam/vaipakam/issues/281)

> **History:**
> - Round 1 explored four approaches and recommended a Vaipakam-native marketplace.
> - Round 2 pivoted (per user direction) to Seaport ERC-1271 + protocol-controlled post-grace auction (Scenario B).
> - Round 3 dropped Scenario B (per user direction): "post grace period the normal flow should be followed — NFT to lender."
> - Round 3.1 addressed 5 Codex P1s on Round 3 (live-debt line-item, endTime tied to grace, restricted-zone, combined fees, all-transfer-paths lock).
> - **Round 4** absorbed: deep external architectural review (vault-bloat concern; reuse LibERC721.LockReason; LIF settlement seam; conduit allow-list; indexer/ABI/event wiring; intent-based alternative architecture); Codex's 10 inline findings on Round 3.1 (single-boundary spec, default-flow lock exemption, lender-NFT-holder routing, `msg.sender == seaport` zone gate, FULL_RESTRICTED order type, consent default flip, liquid-vs-illiquid post-grace branch). **Shipped end-to-end** through steps 1–15 + the OpenSea integration (step 14) + the atomic terminal-cleanup follow-up (#317) + the Seaport.cancel emit (#316). Operator action remaining: D1 migration + OPENSEA_API_KEY provisioning + `VITE_AGENT_ORIGIN` on the deployed dapp build.
> - **Round 5** (this revision) absorbs the two Round-4 deferrals the deployed v1 left open:
>   - **Fee-legs for fee-enforced collections** (Issue [#313](https://github.com/vaipakam/vaipakam/issues/313); Codex round-1 P1 finding on PR #312). The 3-leg canonical shape works for collections that don't enforce protocol or creator fees on Seaport orders; for collections that do (royalty-enforcing collections + OpenSea's own protocol-fee model), the OpenSea Listings API rejects orders that omit the required fee legs. The on-chain order is still fillable via direct `Seaport.fulfillOrder`, but the OpenSea-UI surface is lost. Round 5 extends the canonical shape to N consideration legs (up to 5) so fee-enforced collections gain OpenSea-UI coverage.
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

The Diamond stores a governance-managed `mapping(address => bool) approvedConduits` in `LibVaipakam.Storage`. Admin entry points on `AdminFacet` (or a new `NFTPrepayAdminFacet`):
- `addApprovedConduit(address conduit)` — guardian + ADMIN_ROLE (post-handover: timelock + multisig)
- `removeApprovedConduit(address conduit)` — guardian + ADMIN_ROLE
- Both emit `ApprovedConduitSet(conduit, approved)` events with `@custom:event-category state-change/admin-mutation` natspec so the indexer event-coverage script picks them up.

The vault's `setCollateralOperatorApproval` reverts if the `conduit` is not in the allow-list at call time. The executor's `validateOrder` ALSO checks that `msg.sender == seaport && conduitOf(order) ∈ approvedConduits` to prevent a future-compromised conduit from receiving fill notifications.

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
8. **Conduit allow-list admin** — `addApprovedConduit` / `removeApprovedConduit` on `AdminFacet` (or new admin facet). Guardian + ADMIN_ROLE → timelock + multisig post-handover. Events on every rotation.
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

Round 5 closes this gap by extending the canonical shape to allow **up to 5 consideration legs** — the 3 protocol legs plus up to 2 fee legs (OpenSea protocol fee + creator royalty, per OpenSea's typical schedule). The extension is purely additive — collections that don't enforce fees continue to use the 3-leg form unchanged.

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

OpenSea publishes a per-collection fee schedule at `https://api.opensea.io/api/v2/collections/{slug}/fees` returning an array of `{recipient, basis_points, required}` entries. The fee schedule is borrower-supplied at post time (the dapp fetches it before constructing the order); fee-rate freshness is the dapp's responsibility.

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

- The `apps/agent` `/opensea/collection/{slug}/fees` proxy SHOULD optionally execute a sim-transfer pre-flight check (use `eth_call` to simulate a 1-wei transfer to each fee recipient via the principalAsset). Recipients that revert get flagged "Warning: this collection's fee recipient does not accept transfers — your listing will be unfillable."
- The `apps/defi` post UI surfaces the warning + lets the borrower choose to publish anyway (their right) or pick a fee-free collection alternative.

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

- **`apps/agent`** — new `/opensea/collection/{slug}/fees` proxy endpoint (CORS-locked, rate-limited, uses server-side `OPENSEA_API_KEY`).
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

**Governance-mutation qualifier.** This coverage guarantee holds ONLY while the floor formula's governance inputs (treasuryFeeBps, precloseFeeBps, the live floor formula itself) stay unchanged between signing and fill. A mid-auction `setTreasuryFeeBps` raises the live floor; the signed `lenderLeg + treasuryLeg` may then under-cover, and the executor's fill-time check reverts (`Lender short-paid` / `Treasury short-paid`). Protocol safety is preserved — there's no under-payment, just an unfillable auction — but the listing is effectively frozen until the borrower pays gas to `updatePrepayListing` with new projections. v1 explicitly ACCEPTS this trade-off (freezing governance params in the order shape would mean storing them in OrderContext and re-deriving floor against the stored params at fill time, which would let a listing keep filling at obsolete floors after governance changes — worse outcome). See §15.10(A) for the dapp-side mitigation.

Posting interface:

```solidity
function postPrepayDutchListing(
    uint256 loanId,
    uint256 startAskPrice,        // total order value at startTime
    uint256 endAskPrice,          // total order value at endTime (≥ projected lender + treasury at endTime)
    uint256 auctionEndTime,       // ≤ loan.gracePeriodEnd (enforced)
    uint256 salt,
    bytes32 conduitKey,
    FeeLeg[] calldata feeLegs     // same shape as §14.5; fees decay proportionally
) external returns (bytes32 orderHash);
```

Per-leg derivation at sign time (Codex P2 line 546 — fee legs need explicit start/end amounts, NOT bps; the unified `FeeLeg` shape in §14.5 already carries both):
- `lenderLeg.startAmount = lenderLeg.endAmount = liveFloor.lenderShare(loanId, auctionEndTime)` (projected lender share at `endTime` under sign-time governance config)
- `treasuryLeg.startAmount = treasuryLeg.endAmount = liveFloor.treasuryShare(loanId, auctionEndTime)`
- Each `FeeLeg[i]` is borrower-supplied (computed by the dapp from `bps[i] × startAskPrice / 10000` and `bps[i] × endAskPrice / 10000` for OpenSea-required fee schedules) and flows through unchanged. The executor recomputes nothing here — Seaport's native interpolation between `feeLegs[i].startAmount` and `feeLegs[i].endAmount` produces the live amount at fill time, and OpenSea's marketplace UI accepts the order if its fee enforcement sees the right `bps × currentPrice` ratio at submission. The contract surface carries amounts, not bps, because amounts are what Seaport hashes into the order.
- `borrowerLeg.startAmount = startAskPrice - lenderLeg.startAmount - treasuryLeg.startAmount - sum(feeLegs[i].startAmount)`
- `borrowerLeg.endAmount = endAskPrice - lenderLeg.endAmount - treasuryLeg.endAmount - sum(feeLegs[i].endAmount)`

Sign-time invariants the facet enforces before any state mutation:
- `auctionEndTime > block.timestamp + MIN_AUCTION_WINDOW` (with `MIN_AUCTION_WINDOW = 1 hour` as the starting v1 floor — protects against accidentally posting an already-expired or sub-block-window auction that locks the borrower's NFT but can never fill).
- `auctionEndTime ≤ loan.gracePeriodEnd` — auction window cannot extend past grace.
- `endAskPrice ≥ lenderLeg + treasuryLeg + sum(feeLegs.endAmount)` — borrower remainder at `endTime` must be ≥ 0.
- `startAskPrice ≥ endAskPrice` — Seaport's interpolation requires `startAmount ≥ endAmount` per leg; violating this means an item's amount would INCREASE over time, breaking Dutch decay semantics.
- `feeLegs[i].startAmount ≥ feeLegs[i].endAmount` for every fee leg — same Seaport monotonicity rule.

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
4. **Buffer + floor filter (Codex P2 line 566).** The dapp only marks an offer as "Acceptable" when `offer_value ≥ liveFloor × (1 + cfgPrepayListingBufferBps / 10000)`. Offers below this threshold are surfaced but greyed out — accepting them would revert at re-sign because `_requireAskCoversFloor` enforces the listing buffer on every `updatePrepayListing` call, not just on the initial post. Surfacing the buffer in the UI is what prevents a borrower from clicking "Accept" on an offer that would just bounce.
5. When the borrower likes an acceptable offer, they click **"Match offer"** in the dapp. The dapp calls `updatePrepayListing(loanId, newAskPrice = offer_value, …)` to rotate the canonical order to the offer's price.

   **Fee-leg re-derivation on fee-enforced collections (Grok finding 4).** If the collateral collection enforces fees, the dapp MUST RE-FETCH the OpenSea fee schedule against the NEW gross ask (`offer_value`) before calling `updatePrepayListing` — applying the original high-fixed-price fee amounts to a lower offer-matched ask would either:
   - over-state the fees (lender + treasury + stale-fees > offer_value → reverts at the sum-equality check), or
   - mismatch what the OpenSea API expects (bps × current_price), causing the re-listed order to be rejected at submission.
   The dapp's `useNFTPrepayListing` hook recomputes `feeAmount[i] = offer_value × feeBps[i] / 10000` from the same Collection API response cached earlier in the session (one fetch per collection per session is enough since fee schedules rarely change intra-session), then passes the freshly-computed `FeeLeg[]` to `updatePrepayListing`.
6. **The bidder fulfills (Codex P2 line 567).** After the rotation lands on-chain, the dapp surfaces a sharable link OR notifies the bidder out-of-band ("the seller has matched your offer at $X; complete the purchase here"). The BIDDER calls `Seaport.fulfillOrder` on the rotated listing — they are the buyer providing the listing's multi-leg consideration. The bidder's original OpenSea OFFER is NOT the order being settled; only the rotated LISTING settles. (Bidders are the ones who supply the multi-leg consideration; if the borrower fulfilled their own rotated listing they'd be buying their own collateral and funding the lender + treasury split from their own wallet — economic nonsense.)

What this gives up:
- **Race window.** Between the borrower's `updatePrepayListing` (step 5) and the bidder's `Seaport.fulfillOrder` (step 6), ANY buyer can fulfill the rotated listing — the offer-acceptance is NOT bound to the originating bidder. Sniping the bidder out of the price they bid is a real possibility. The dapp UI MUST warn ("Once you match, any buyer can fulfill at the matched price within ~N minutes. Notify your bidder before clicking Match.") and v2 could add a custom-zone or matched-orders flow that atomically rotates + fulfills in one tx, binding to the specific bidder. v1 explicitly accepts the race for shipping-velocity reasons.
- Not on-chain bid auditability — the dapp's offer ranking is OpenSea-API-derived.

What it gives:
- **Zero new contract surface.** Reuses `updatePrepayListing` end-to-end.
- **Real price discovery.** Borrower sees actual market interest before committing to a price.
- **Same atomicity** as fixed-price — Seaport's atomic offer-and-consideration fulfillment, executor's zone callback for state finalization.

This is the "English mode" the user picked. If the race-window UX proves painful in production, v2 can add a tighter bidder-binding via a custom-zone or matched-orders flow (atomic match-rotation in a single tx, eliminating the snipe window).

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

Mitigation: the dapp surfaces a banner "governance has bumped treasuryFeeBps since this listing was posted; click to re-sign" on the loan card whenever it detects a mismatch between the signed pctx and a fresh read.

**(B) Implicit borrower over-payment on early Dutch fills.** §15.2 fixes lender + treasury at the projected-max-floor at `auctionEndTime`. A buyer who fills the Dutch listing at `t = startTime` (before any decay) pays the lender + treasury MAX projection — i.e., the borrower's loan settles paying as if it had run to grace-end, even though it didn't. The over-coverage flows to lender + treasury (not refunded to the borrower).

For a 7-day grace with 8% APR, the over-payment is ~0.15% of principal — small in absolute terms but real. The dapp's Dutch posting UI MUST surface this: "If your listing fills today, you'll pay $X more than today's live floor as a safety margin. The margin shrinks as the auction approaches its end time." The borrower CAN choose to shorten the auction window (`auctionEndTime` closer to `block.timestamp`) to reduce the over-coverage; this is a borrower-controlled trade-off.

**(C) Lender-position-NFT rotation invalidates the recipient binding.** §5.1 invariant: the executor re-derives `consideration[0].recipient = lenderNftOwner` at fill time. If the lender transfers their position-NFT mid-auction (whether innocently as a portfolio rotation or maliciously to grief the borrower), the signed order's stored `lenderRecipient` no longer matches the current holder → executor reverts the fill.

For fixed-price this is a single-block rotation race; for Dutch + English it's a longer window. A malicious lender who specifically wants the underlying NFT (and would prefer the default path) can deliberately rotate their position-NFT during a borrower's auction window to force-revert all fills.

The protocol's safety holds: the borrower can `cancelPrepayListing` + `updatePrepayListing` (rotating the executor's recorded `lenderRecipient`); the lock + grace boundary prevent a stuck state. But the borrower pays gas + loses fillability time.

Mitigation: the dapp watches `Transfer(lenderNftId)` events on the lender-position-NFT contract for any loan with a live prepay listing. On a detected rotation, the borrower sees an alert + a one-click "re-sign listing" action. v2 could add an executor-side automatic re-derivation, but that breaks Seaport's signature-vs-order-shape immutability assumption and is rejected for v1.

**(D) Treasury rotation invalidates the recipient binding.** Same mechanism as (C) but for the treasury address. Governance rotation is rare; flagged here for symmetry.

These four cases are *known* and *acknowledged*; the dapp's role is to surface them clearly so borrowers aren't surprised. The Round-4 §316 cleanup machinery (PR #321) already handles cancel-time drift gracefully by emitting `SeaportCancelSkipped` — these new UX-fragility cases just produce that breadcrumb a few more times.

## 16. Round 5 sequencing

Three step blocks; each block can ship independently — fee-legs (§14) and auction modes (§15) don't share contract files.

**Block A — Fee-legs extension (#313)**

A.1. **`LibPrepayOrder._components` accepts an optional `feeLegs[]` array**, appends each as a `ConsiderationItem` with `startAmount = feeLeg.startAmount` and `endAmount = feeLeg.endAmount`. For fixed-price callers the two values are equal.
A.2. **`NFTPrepayListingFacet`** — extend `postPrepayListing` / `updatePrepayListing` signatures with `FeeLeg[]`. Validate `0 ≤ feeLegs.length ≤ MAX_FEE_LEGS (=4)`; each `recipient != address(0)`, `startAmount > 0`, `endAmount > 0`, `startAmount ≥ endAmount`; sum-of-considerations equality check (`startAskPrice == lender + treasury + borrower.startAmount + sum(feeLegs.startAmount)`; same for endAmount).
A.3. **`CollateralListingExecutor._assertOrderContent`** — relax length cap to `[3, 3 + MAX_FEE_LEGS] = [3, 7]`; preserve every other check (recipient indices 0+1, principalAsset, lender/treasury coverage).
A.4. **`OrderContext` extension** — record the full `FeeLeg[]` array (2 slots per leg) + the fee-legs length slot for #316 cancel-time reconstruction. Update `_tryCancelOnSeaport` to rebuild the canonical `OrderComponents` including the fee legs.
A.5. **Selector replacement via diamondCut.** Adding `FeeLeg[]` to `postPrepayListing` / `updatePrepayListing` changes both Solidity selectors. The deploy script's diamondCut step (or a follow-up cut on already-deployed networks) MUST:
- ADD the new selectors via `FacetCutAction.Add`,
- REMOVE the old selectors via `FacetCutAction.Remove`.
Update `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` and `SelectorCoverageTest._populateRoutedSet()` to emit the new shape. `DiamondFacetNames.cutFacetNames()` is unchanged (same facet).
A.6. **ABI re-export + consumer typecheck.** Run `exportFrontendAbis.sh`; `pnpm --filter @vaipakam/{defi,indexer,agent} exec tsc -b --noEmit` MUST fail at consumer call sites — co-update the apps in the same PR.
A.7. **`apps/agent`** — new `/opensea/collection/{slug}` proxy returning the full Collection API body (fees array lives inside the response, NOT a separate `/fees` endpoint).
A.8. **`apps/defi`** — `useNFTPrepayListing` fee fetch + pre-flight; pre-filled fee UI; ghost-recipient sim-transfer pre-flight check (§14.4).
A.9. **`apps/indexer`** — new D1 columns `fee_legs_json` + `borrower_remainder`; extend `PrepayListingPosted` handler to decode the full `FeeLeg[]` from event data (NOT just an indexed root) and persist them.
A.10. **`IListingExecutorRecorder` interface extension (Grok finding D).** The `recordOrder` signature on `IListingExecutorRecorder.sol` AND on `CollateralListingExecutor` MUST grow a `FeeLeg[] feeLegs` parameter alongside the existing `(orderHash, loanId, conduit, conduitKey, salt, startTime, askPrice)` shape from PR #321. The executor is a UUPS singleton — the upgrade is an `_authorizeUpgrade`-gated proxy implementation swap, NOT a re-deploy. Block A includes this UUPS upgrade step. The mock `MockListingExecutorRecorder.sol` in the test corpus is co-updated.
A.11. **Indexer event-coverage guardrail (Grok finding F).** Run `pnpm --filter @vaipakam/indexer check-event-coverage` after the extended `PrepayListingPosted` event lands; either handle the new shape OR add a deliberate `DELIBERATELY_NOT_HANDLED` entry with a one-line reason (per CLAUDE.md's event-coverage discipline).
A.12. **Tests** — facet unit tests for fee-leg validation (length cap, sum equality, buffer math); executor tests for length 3 / 4 / 5 / 6 / 7; integration test for end-to-end fee-enforced collection flow; UUPS upgrade rehearsal test for the executor swap.

**Block B — Dutch decay (#309 Mode A)**

B.1. **`LibPrepayOrder._componentsDutch`** — new builder that takes `startAskPrice` + `endAskPrice` + `auctionEndTime` + `FeeLeg[]`; computes per-leg `startAmount` / `endAmount` per §15.2. Lender + treasury legs get fixed `(start, end) == (projectedMax, projectedMax)`. Borrower leg gets `(startAskPrice - …, endAskPrice - …)`. Fee legs flow through with their own `(startAmount, endAmount)` so OpenSea-required-fee percentages are honoured at every block of the auction.
B.2. **`NFTPrepayListingFacet`** — new `postPrepayDutchListing` entry point. Same conduit + ERC1271 + lock semantics as `postPrepayListing`. Validate `auctionEndTime > block.timestamp + MIN_AUCTION_WINDOW (=1h)`, `auctionEndTime ≤ loan.gracePeriodEnd`, `endAskPrice ≥ projectedLenderLeg + projectedTreasuryLeg + sum(feeLegs.endAmount)`, `startAskPrice ≥ endAskPrice`, every `feeLegs[i].startAmount ≥ feeLegs[i].endAmount`.
B.3. **`CollateralListingExecutor`** — no changes to fill-time validation. Existing `_assertOrderContent` works as-is (Seaport's amount interpolation happens before the zone callback; the executor sees the resolved amounts at fill time, and the relaxed length cap from Block A.3 already covers Dutch's 3-7 leg range).
B.4. **`OrderContext`** — extend to record `endAskPrice` + `auctionEndTime` + auction-mode tag for #316 cancel-time reconstruction. Mode tag distinguishes "rebuild as fixed-price" from "rebuild as Dutch" — without it, the cancel path can't know whether to pass `startAmount == endAmount` or `startAmount > endAmount` to `LibPrepayOrder.componentsForCancel`. Packed into one slot: uint128 endAskPrice + uint64 auctionEndTime + uint8 mode flag + 56-bit padding.
B.5. **Selector wiring** — `postPrepayDutchListing` is a new selector added via diamondCut. `DeployDiamond.s.sol._getNFTPrepayListingFacetSelectors()` extended; `SelectorCoverageTest._populateRoutedSet()` mirrors. New facet event `PrepayDutchListingPosted` (or extend the existing `PrepayListingPosted` shape — TBD at implementation; affects indexer migration).
B.6. **ABI re-export + consumer typecheck** for the new selector.
B.7. **`apps/defi`** — Dutch posting UI; live decayed-price banner with current price ticker; over-payment surface per §15.10(B).
B.8. **`apps/indexer`** — new D1 columns `auction_mode` (enum: fixed/dutch) + `auction_end_time` + `end_ask_price`. Extend `PrepayListingPosted` handler (or add a new `PrepayDutchListingPosted` handler) for the Dutch shape.
B.9. **Tests** — facet unit tests (sign-time validation including `MIN_AUCTION_WINDOW` + monotonicity); integration test for sign-mid-decay fill; sniper-snipe test for the open Dutch window.

**Block C — English via OpenSea offers (#309 Mode B)**

C.1. **`apps/agent`** — new `/opensea/offers/{loanId}` proxy that returns active offers for the loan's collateral NFT.
C.2. **`apps/defi`** — offers panel on the loan card; "Accept (re-list at offer price)" button wired to `updatePrepayListing`.
C.3. **No contract changes.** The dapp reuses the existing `updatePrepayListing` end-to-end.
C.4. **`apps/indexer`** — log accepted-offer breadcrumbs (which offer the borrower matched) for analytics — optional, v1.1.
C.5. **Tests** — dapp integration test for fetch-offers + re-list flow.

Each block lands as 1–3 PRs depending on size. Block A is the largest (contracts + dapp + indexer + worker proxy). Block B is contracts + dapp + indexer. Block C is dapp-only.

**Ordering recommendation:** A → B → C. Block A unblocks fee-enforced collections (a real coverage gap pre-launch); Block B adds the most value for unique NFTs; Block C is a small dapp polish on top.

**Alternative: parallelize C with A (Grok finding 6).** Block C reuses the existing `updatePrepayListing` end-to-end with zero new contract selectors, zero `OrderContext` changes, zero ABI churn, and zero indexer storage additions. It can ship in parallel with (or even slightly ahead of) Block A — the bidder-fetching dapp UX gives early production signal on whether the race-window UX (§15.3) is painful enough to justify v2's tighter bidder-binding before investing heavily in Dutch (B). The dependency is weak: Block C only needs Block A's fee-re-derivation surface (§15.3 step 5) for fee-enforced collections; on fee-free collections it ships independently. Worth considering if the team wants real-world feedback on English UX sooner.
