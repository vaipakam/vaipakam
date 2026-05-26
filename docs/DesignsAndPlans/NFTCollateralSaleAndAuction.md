# NFT Collateral Pre-Default Sale (T-086 design)

**Status:** Design exploration · Round 4 (architectural pivot + spec corrections) · Not ratified · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279) · Multi-marketplace expansion: [#281](https://github.com/vaipakam/vaipakam/issues/281)

> **History:**
> - Round 1 explored four approaches and recommended a Vaipakam-native marketplace.
> - Round 2 pivoted (per user direction) to Seaport ERC-1271 + protocol-controlled post-grace auction (Scenario B).
> - Round 3 dropped Scenario B (per user direction): "post grace period the normal flow should be followed — NFT to lender."
> - Round 3.1 addressed 5 Codex P1s on Round 3 (live-debt line-item, endTime tied to grace, restricted-zone, combined fees, all-transfer-paths lock).
> - **Round 4** (this revision) absorbs:
>   - A deep external architectural review (vault-bloat concern; reuse LibERC721.LockReason; LIF settlement seam; conduit allow-list; indexer/ABI/event wiring; intent-based alternative architecture)
>   - Codex's 10 inline findings on Round 3.1 (single-boundary spec, default-flow lock exemption, lender-NFT-holder routing, `msg.sender == seaport` zone gate, FULL_RESTRICTED order type, consent default flip, liquid-vs-illiquid post-grace branch)
>
> Round 4 keeps the Round-3 thesis (third-party Seaport, pre-default only, lender's default-flow expectation untouched) and corrects the architecture so the per-borrower UUPS vault stays a thin custodian — the heavy lifting moves to a new dedicated facet + listing-executor contract.

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
- Dutch / English / Vickrey auctions beyond fixed-price.
- Bid aggregation across marketplaces (v1 = OpenSea only; multi-marketplace via #281).
- Partial-balance ERC1155 sales — `FULL_RESTRICTED` only.
- Refinance / preclose during an active listing — mutually exclusive (listing must be cancelled first).
- **Post-grace protocol-controlled auction** (Round 2's Scenario B; Round 3+ dropped).
- **Lender-side tail-window optionality at grace expiry** (a v2 enhancement; the 23h-on-OpenSea / 24h-for-lender buffer with governance-configurable cool-down — designed in Round 3 but not v1-scope).
- **Intent-based protocol solver architecture** (§11; v2 direction).

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
