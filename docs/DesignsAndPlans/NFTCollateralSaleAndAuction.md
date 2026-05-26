# NFT Collateral Sale + Grace-Period Auction (T-086 design)

**Status:** Design exploration · Not ratified · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279)

## 1. Problem statement

Today a borrower whose NFT (ERC721 or ERC1155) sits as collateral in a Vaipakam Vault has only two exits:

1. **Repay in full** — settle the loan from their own wallet, vault releases the NFT back.
2. **Default** — let grace expire, NFT goes to the lender (`DefaultedFacet.markDefaulted` for illiquid; `RiskFacet.triggerLiquidation` for liquid).

There's no path to **realize the NFT's market equity** while the loan is live. A borrower with an NFT worth substantially more than the loan can't unlock the difference except by paying off the loan first (which is the thing they couldn't do) or defaulting (which forfeits the equity).

Symmetrically, lenders facing a defaulting borrower receive the raw NFT and have to sell it themselves — instead of receiving the protocol-extracted cash equivalent.

Two scenarios this design covers:

**Scenario A — Borrower-initiated sale during active loan.** Borrower wants to sell the collateralized NFT on a third-party marketplace (OpenSea, Blur, Magic Eden). On match, proceeds flow into the vault, lender + treasury are paid out, remainder lands with the borrower. NFT transfers to the buyer atomically with debt settlement. If price doesn't cover debt + fees, the sale is blocked.

**Scenario B — Protocol-initiated grace-period auction.** Once grace expires, instead of immediately transferring NFT-to-lender, the protocol auctions the NFT at a reserve = debt + fees + liquidation fee. If a taker covers the reserve: cash distribution per the waterfall. If no taker by a deadline: fall through to NFT-to-lender (the existing default path stays as the unhappy-case backstop).

Both must work for ERC721 and ERC1155.

## 2. Threat model

What MUST be preserved:

- **Collateral lock invariant.** While a loan is active and not in a sale-settling state, the vault MUST NOT release the NFT to anyone except (a) the borrower on full repayment, (b) the lender on default, or (c) a settling buyer in the sale paths added here.
- **Settlement waterfall ordering.** Lender debt (principal + interest) is paid before treasury fee. Treasury fee before liquidation fee. Liquidation fee before borrower remainder. No path skips ahead.
- **No equity dilution.** A successful sale must not produce a state where the lender is short-paid OR the buyer ends up without the NFT after paying.
- **Consent capture.** The lender at offer-acceptance time must know whether the loan allows borrower-initiated sale (Scenario A) and/or grace-period auction (Scenario B). A lender who refuses either path must be able to decline at offer acceptance.

What can be relaxed (vs. today):

- The "NFT only ever leaves the vault to repayer-or-lender" invariant — the sale paths add a third class of authorized recipient (the settling buyer). The relaxation is OK because the buyer's atomic payment IS the borrower's repayment, with the buyer as the conduit.

What the threat model explicitly does NOT defend against (out of scope here, covered by other layers):

- Borrower picking a marketplace whose smart contracts are themselves malicious (general DeFi attack surface; same risk as any OpenSea user).
- Borrower listing at a price below market and leaving equity on the table — that's the borrower's choice, not a protocol failure.
- A buyer who reneges after partial commitment — addressed by atomicity requirements in each approach.

## 3. Why the obvious approach doesn't work

**Operator delegation to the borrower** is the first thing that comes to mind: have the vault call `setApprovalForAll(borrower, true)` or `approve(borrower, tokenId)` on the held NFT, then the borrower lists on OpenSea normally.

This breaks the collateral lock invariant. Once the borrower has operator rights, they can call `safeTransferFrom(vault, anyAddress, tokenId)` and walk the NFT out of the vault to anywhere — no marketplace needed, no settlement needed. Marketplaces require seller approval; once granted, the seller controls the NFT's destination.

So we need a different approach.

## 4. Approach inventory

Four approaches, each with a different position on the trade-off triangle: **third-party liquidity** vs **atomicity** vs **engineering lift**.

### 4.1 Claim-NFT + redemption gate

Mint a separate ERC721 (per loan) representing "rights to settle this loan and claim the underlying collateral." Borrower lists the **claim NFT** (not the original) on OpenSea.

Flow:
1. Borrower calls `mintSaleClaim(loanId)` → vault mints a claim NFT to the borrower.
2. Borrower lists the claim NFT on OpenSea at a price = `(borrower-expected market value) - (outstandingDebt + fees)` (the equity portion).
3. Buyer purchases the claim NFT on OpenSea, paying the borrower the equity directly.
4. Buyer calls `redeemSaleClaim(claimTokenId)` on the vault, paying `outstandingDebt + fees` into the vault. Vault burns the claim, releases the original collateral NFT to the buyer, atomically credits lender + treasury.
5. **Reneging guard:** the claim NFT has a redemption deadline (e.g., 7 days). If unredeemed by deadline, the claim auto-voids and the borrower can repossess via `voidExpiredSaleClaim(loanId)`. The buyer who paid for the claim on OpenSea but didn't redeem in time is out the equity payment to the borrower — same shape as buying any auction lot and not paying gas to claim it.

Pros:
- Native third-party marketplace liquidity (OpenSea / Blur lists the claim NFT just like any other ERC721)
- Buyer pays equity directly to borrower (no protocol-side custody of fiat-equivalent value)
- Settlement-side atomicity guaranteed by `redeemSaleClaim` being atomic

Cons:
- Marketplaces show the claim NFT, not the underlying collateral. Buyers see a "rights to claim X" listing with metadata pointing at X. Confusing UX unless we standardize the claim-NFT metadata (image, description, "redemption deadline" trait, "underlying" trait pointing at the original NFT contract + tokenId).
- Reneging cost is borne by the buyer. If the buyer's wallet is unfunded for the redemption gas + the second `debt+fees` payment, they bought a worthless claim. The borrower walks away with the equity payment, the lender's loan keeps accruing.
- Claim NFTs proliferate — one per loan that opts in, plus voided/expired claims (cleanup needed).

Engineering lift: **Medium.** New `NFTSaleClaimFacet`, claim ERC721 contract (or reuse position-NFT pattern), `redeemSaleClaim` / `voidExpiredSaleClaim` entry points.

### 4.2 Seaport ERC-1271 vault-signed listings

The vault contract signs Seaport orders via ERC-1271, listing the collateral NFT on OpenSea directly. Borrower triggers the sign-and-list via a Vaipakam facet; the vault's ERC-1271 `isValidSignature` returns true only for orders whose Seaport `consideration` items route the proceeds correctly (lender ZONE, treasury ZONE, borrower ZONE, with reserve checks).

Flow:
1. Borrower calls `listOnSeaport(loanId, askPrice, deadline)`.
2. Vault constructs the Seaport order: offer = collateral NFT; consideration = `[debt+interest → lender, treasury fee → treasury, remainder → borrower]`.
3. Vault publishes the order ID (off-chain via OpenSea API; or on-chain via Seaport's order book).
4. Buyer matches on OpenSea normally. Seaport calls vault's ERC-1271 `isValidSignature`; vault verifies the order matches the stored expected shape; returns valid.
5. Seaport executes the transfer + consideration distribution atomically. Lender receives debt+interest, treasury receives fee, borrower receives remainder, NFT goes to buyer.
6. After successful execution, vault marks the loan settled (callback from Seaport, or borrower / keeper triggers `markSettledAfterSeaport(loanId)`).

Pros:
- Native OpenSea liquidity, native UX (collateral NFT listed directly)
- Atomicity via Seaport's match logic
- No claim-NFT proliferation

Cons:
- Significant engineering lift: ERC-1271 logic, Seaport order construction, consideration verification, post-execution callback wiring
- Requires Seaport to be deployed on every chain where Vaipakam operates (BNB, Polygon mainnet, etc.) — most major chains have it, but coverage is not universal
- Tight coupling to Seaport's order schema; any Seaport upgrade requires Vaipakam re-verification
- Pre-execution state mutation: the listing is signed but not executed. Between signing and execution, the loan's `outstandingDebt + fees` is shifting (interest accrues). The consideration amounts in the signed order may go stale → either we re-sign on a schedule (operator burden), or we accept a small over-pay to the lender (treasury writes back the difference)

Engineering lift: **High.** New `NFTSeaportListingFacet`, ERC-1271 implementation on the vault, consideration schema verification, post-execution callback handling.

### 4.3 Vaipakam-native marketplace

Bypass third-party marketplaces entirely. Vaipakam implements its own listing + bidding primitives on-chain.

Flow:
1. **Current borrower-position NFT holder** (NOT the original `loan.borrower` address — see §6.1 below) calls `listForSale(loanId, askPrice)` with `askPrice ≥ liveSettlementFloor(loanId)` (live floor, recomputed at call time; see §6.2). Vault marks the loan "for sale at X."
2. While the listing is active, the **borrower-position NFT is transfer-locked** (see §6.3). The current holder can cancel via `cancelListing(loanId)` to release the lock.
3. Any buyer calls `buyCollateral(loanId)` with `msg.value == askPrice` (or ERC20 `transferFrom`). The vault rechecks `askPrice ≥ liveSettlementFloor(loanId)` at execution time and reverts if interest accrual has pushed the floor above the listed askPrice (see §6.2).
4. Atomically: buyer's payment → settlement waterfall (§6); NFT → buyer; loan → settled; borrower-position NFT burned.

Pros:
- Cleanest architecturally — single contract, atomic, no external dependency
- No claim NFT proliferation, no Seaport coupling
- Easy to add bidding later (auction-style, English-style, Dutch) as separate facets

Cons:
- Zero external liquidity — buyers must come find Vaipakam-native listings on the Vaipakam frontend (or build their own scrapers). Most NFT buyers shop OpenSea-first.
- Borrowers lose the OpenSea audience entirely
- Need to build listing-discovery UX on the frontend (browse, filter, etc.)
- Long-lived listings need active-floor monitoring (the listed price can fall below the live floor as interest accrues; the listing then becomes un-fillable until re-listed). UX must show "listing expires when floor crosses askPrice" so borrowers don't get surprised.

Engineering lift: **Low** for the contract; **Medium** for the listing-discovery frontend.

### 4.4 Hybrid — Vaipakam-native primary + claim-NFT secondary

Default to the Vaipakam-native marketplace (4.3) for borrower-initiated sales. Layer the claim-NFT path (4.1) as an opt-in for borrowers who specifically want OpenSea liquidity. The two paths share the same settlement waterfall (handled by a `LibCollateralSettlement` library); they differ only in how the buyer is matched.

Pros:
- Conservative baseline (4.3) with optional reach (4.1) layered on top
- Settlement library is shared → one place to audit the waterfall
- Borrower picks the trade-off (private buyer via Vaipakam vs. wider OpenSea reach)

Cons:
- Two implementation paths to maintain
- Two consent flags in the offer (allows-Vaipakam-sale, allows-claim-NFT-issuance)

Engineering lift: **Medium-High** total.

## 5. Recommendation

For Scenario A (borrower-initiated sale): **start with Approach 4.3 (Vaipakam-native marketplace).** It's the smallest engineering lift, the cleanest atomicity story, and gives the protocol full control over the settlement waterfall. The trade-off — losing third-party liquidity — is real but bounded: borrowers who urgently need to exit can use the native marketplace; borrowers who want to wait for an OpenSea buyer can do so AFTER repaying (the existing flow). We learn whether the liquidity gap is the bottleneck before investing in Seaport / claim-NFT complexity.

For Scenario B (protocol-initiated grace-period auction): **use a protocol-controlled auction, also Vaipakam-native (Approach 4.3 shape).** The protocol posts the listing at a reserve based on **debt-floored fees, not sale-price-floored fees** (closed-form reserve, see §6.4), with a configurable deadline. Interest accrual on the underlying loan **freezes at grace expiry** (see §6.2) so the reserve target stays stable across the auction window. If a buyer hits the reserve, settlement waterfall runs. If not, fall through to the existing default flow (NFT-to-lender). Scenario B is a strict extension of A's primitives: same listing entry, same buy entry, different actor (protocol vs. borrower), different reserve formula, and different accrual semantics during the listing.

If Scenario A's Vaipakam-native marketplace shows clear liquidity-gap evidence in production (borrowers listing but no buyers within N days), upgrade to Approach 4.1 (claim-NFT) as the OpenSea route. Re-evaluate Approach 4.2 (Seaport ERC-1271) only if the engineering investment becomes justifiable by deep market data.

## 6. Settlement semantics (shared invariants)

Both scenarios share the same payout code (`LibCollateralSettlement.distribute`) and the same set of invariants. The next four subsections call out the four invariants that the first draft of this doc either understated or got wrong; the adversarial Codex review on PR #280 raised every one of them.

### 6.1 Sale authority binds to current borrower-position NFT, not stored borrower address

The codebase issues a borrower-position ERC721 at loan initiation (see `VaipakamNFTFacet.mintNFT`). Transferring that NFT transfers all borrower-side rights (interest payments, prepayments, claims). Sale authority MUST follow the same rule:

- `listForSale(loanId, askPrice)` and `cancelListing(loanId)` are authorized iff `msg.sender == borrowerNFT.ownerOf(loan.borrowerNftId)` at call time.
- A snapshot of `loan.borrower` (the original EOA) is NOT used for authorization. After a borrower-NFT transfer, the new holder is the sale authority.
- Keeper-bot authorization for sale flows is OUT OF SCOPE in v1 — keepers can trigger liquidations and (in v2 of this design) grace-period auctions, but the borrower-initiated sale is borrower-NFT-holder-only. Adding a keeper-delegated sale entry is a follow-up after the base flow is in place.

### 6.2 Live-accrual recompute at every settlement boundary

Interest accrues per-block on active loans. The first draft had two related bugs the Codex review caught:

- Scenario A: a borrower lists at `askPrice = currentFloor + 1 wei`. Three weeks later, accrued interest has pushed the floor above the askPrice. A buyer who calls `buyCollateral` would short-pay the lender if the contract uses the listing-time floor.
- Scenario B: similar dynamic. Protocol posts at grace expiry. Auction runs for 72 hours. A bid at the original reserve underpays the lender by 72 hours of accrued interest.

Two complementary fixes:

- **Scenario A — settlement-time floor recheck.** `buyCollateral` recomputes `liveSettlementFloor(loanId)` at execution-block and reverts with `ListingFloorExceeded(askPrice, liveFloor)` if `askPrice < liveFloor`. The borrower's listing is now un-fillable; the borrower must `cancelListing` and re-list at a higher price. UX surfaces "listing expires when floor crosses askPrice" so this isn't a surprise.
- **Scenario B — accrual freeze at grace expiry.** When the protocol posts a grace-period auction, the loan's `interestAccrualEnd` snapshot is set to `gracePeriodEnd`. All subsequent settlement math uses the frozen accrual. If the auction fails (no taker) and falls through to NFT-to-lender, the lender takes the NFT directly — the frozen-accrual amount is never read, so no harm. If the auction succeeds, the reserve is stable for the buyer's whole bidding window.

These two fixes are different in shape (recheck vs. freeze) because the two scenarios have different actors at risk: Scenario A's borrower-set askPrice is borrower-controlled, so the protocol enforces by reverting; Scenario B's reserve is protocol-controlled, so the protocol enforces by freezing the floor.

### 6.3 Borrower-position NFT transfer-lock during active listing

While Scenario A's listing is active OR Scenario B's auction is posted, the loan's borrower-position NFT is transfer-locked: `safeTransferFrom` on the borrower-NFT contract reverts with `BorrowerNftLockedDuringSale(loanId)`. The lock is set on `listForSale` / `postGraceAuction` and released on `cancelListing` / `buyCollateral` / auction-deadline-expiry.

Without this lock, two race conditions exist:
- Borrower A lists. Buyer matches. Borrower A transfers borrower-position NFT to Borrower B mid-execution. Who receives the borrower-remainder? With the lock, the question can't arise: transfer reverts while listing is active. Without the lock, contention requires an explicit ordering rule.
- Borrower A lists. Borrower A transfers borrower-position NFT to Borrower B. Buyer matches. Borrower B receives the proceeds (per §6.1). But Borrower B may not know about the active listing they inherited — surprise sale. The lock surfaces the listing to Borrower B BEFORE the transfer (they have to wait for cancel or settlement).

### 6.4 Settlement waterfall (with closed-form Scenario B reserve)

```
salePrice flow:
  ├─→ Lender:      principal + accruedInterest          (HARD REQUIREMENT)
  ├─→ Treasury:    treasuryFee = treasuryFeeBps × interest / 10000
  ├─→ Liquidator:  liquidationFee = liquidationFeeBps × debt / 10000
  │                                                       (Scenario B only;
  │                                                        debt-based, NOT
  │                                                        salePrice-based)
  └─→ Borrower:    remainder = salePrice - (above)        (≥ 0)
```

**Lender-debt-coverage invariant (HARD).** The settlement REVERTS if `salePrice < principal + accruedInterest + treasuryFee + (liquidationFee if Scenario B)`. There is no shortfall-capped lender payout; partial lender settlement is forbidden. The first draft had "(capped at salePrice if shortfall)" — that contradicted both the no-equity-dilution threat model (§2) and the §3 reasoning. Codex caught it; it's now gone.

**Closed-form reserve (Scenario B).** The first draft defined `liquidationFee = liquidationFeeBps × salePrice` AND `reserve = debt + interest + treasuryFee + liquidationFee` — a circular dependency. Codex caught it. Resolution: the liquidation fee is `liquidationFeeBps × debt` (debt-based, not salePrice-based). Reserve becomes:

```
liveSettlementFloor(loanId, scenarioB=true)
    = principal + accruedInterest
    + treasuryFeeBps × accruedInterest / 10000
    + liquidationFeeBps × principal / 10000
```

Non-circular. Computable at listing-time. Stable across the auction window because Scenario B freezes accrual at grace expiry (§6.2).

For Scenario A:
```
liveSettlementFloor(loanId, scenarioB=false)
    = principal + accruedInterest
    + treasuryFeeBps × accruedInterest / 10000
```
(No liquidation fee in Scenario A — the borrower initiates voluntarily.)

Borrower remainder is whatever's left after all three protocol-side recipients are paid in full. If the sale was at exactly the floor, the borrower gets zero — and the threat-model is preserved (no underpay, no dilution). If the sale was above the floor, the borrower gets the equity.

## 7. Consent capture model

Both flags live on the Offer struct (not the Loan struct) so the lender sees them at acceptance:

- `allowsBorrowerSale` — Scenario A is allowed. Default: `true` (most flexible for borrower).
- `allowsGracePeriodAuction` — Scenario B is allowed. Default: `true` (better for the protocol's loan-recovery outcomes; lender prefers cash over a raw NFT).

The offer-creation UI exposes both as toggles. Acceptance freezes them into the resulting Loan struct. The lender at acceptance sees the flags and can decline if they want a strict NFT-to-lender outcome on default.

Backward compatibility: existing loans (no flags in the struct) default to BOTH being `false` (the existing behavior). Migration is an offer-level field, not a loan-level retrofit, so existing loans are unaffected.

## 8. ERC721 vs ERC1155

ERC721 is the simpler case (one token per loan; full custody). The flow above describes ERC721.

ERC1155 needs two extensions:
- The vault holds a **balance** (multiple units of the same token ID); listings can be for partial-balance amounts.
- Settlement releases the listed units atomically with payment; the residual balance stays in the vault.

For Scenario A's first cut, **restrict ERC1155 sales to the full vaulted balance** (no partial sales). Partial-balance sales add complexity (which units to release, what happens to the partial residual on default) that doesn't justify the first-implementation lift. Add partial-balance support in a follow-up.

For Scenario B, similar: grace-period auction sells the full vaulted balance. No partial liquidation.

## 9. Open questions for ratification

1. **Reserve formula for Scenario B.** Is `outstandingDebt + interest + treasuryFee + liquidationFee` the right floor? Should we add a market-tracking premium (e.g., `1.1 ×` to leave room for buyer price discovery)?
2. **Auction deadline default.** How long does Scenario B's auction stay open before falling through to NFT-to-lender? 24h? 72h? Borrower-configurable at offer time?
3. **Liquidator vs. treasury for the liquidation fee.** Existing default flow has no fee (NFT just goes to lender). Scenario B introduces a `liquidationFee` — should it go to the keeper who triggered the auction (incentive), to the treasury (revenue), or split?
4. **Native + ERC20 sale price.** Should askPrice be ETH-only, or also accept stablecoin payment? If multi-currency, how do we price the reserve consistently? Most NFT marketplaces use a chain-native + WETH default.
5. **Sale before delinquency vs. only after some condition.** Should Scenario A be allowed from day 1 of the loan, or only after some condition (e.g., HF < 2.0, or 80% through the loan term)? Day-1 is simpler; conditional adds gating complexity.

## 10. Out of scope (deferred)

- Cross-chain NFT sales (NFT on chain X, buyer on chain Y). NFTs aren't bridgeable in the general case; the sale happens on the chain the NFT lives on.
- Dutch / English / Vickrey auction mechanics beyond fixed-price + reserve.
- Bid aggregation across marketplaces (operator chooses one venue per listing).
- Partial-balance ERC1155 sales (Section 8).
- Renegotiation / refinancing during a live sale listing (the existing `RefinanceFacet` and the new sale listing are mutually exclusive: a borrower with an active sale listing can't refinance, and vice versa).

## 11. Sequencing

The original draft had Scenario A's facet (`NFTSaleFacet`) merging before the offer-flag extension that captures lender consent. Codex caught the inversion: shipping sale entry points before consent fields means borrower-initiated sales could exist without a lender opt-in, breaking the §2 consent invariant. Resolved by reordering — **consent-field rollout strictly before sale entry points**, AND the sale facet's `listForSale` is gated on `loan.allowsBorrowerSale == true` so it physically cannot execute on a pre-consent-field loan.

1. **Ratify this design** (this PR — `@codex review adversarial design-doc`; address findings; merge).
2. **Implement `LibCollateralSettlement`** — the shared waterfall library (§6.4). Comprehensive unit tests, including the lender-debt-coverage revert path and the closed-form reserve math.
3. **Extend Offer + Loan structs** — add `allowsBorrowerSale` + `allowsGracePeriodAuction` flags on both. Default both to `false` on the Loan struct (existing loans), `true` on new Offers. Migration: offer-level only, no loan-level retrofit. **Critical: this MUST land before step 4 OR the sale facet's entry points must hard-revert on missing flag fields.**
4. **Implement `NFTSaleFacet`** — Scenario A's `listForSale` / `buyCollateral` / `cancelListing`. ERC721 only. Authorization binds to current borrower-position NFT holder (§6.1). Borrower-position NFT transfer-lock during active listing (§6.3). Live-accrual recompute at settlement boundary (§6.2). `listForSale` requires `loan.allowsBorrowerSale == true` — physically gated so step 4 cannot ship a working sale flow without step 3's consent fields.
5. **Wire UI** — listing creation, listing browse, buy flow. Frontend.
6. **Implement `NFTAuctionFacet`** — Scenario B's protocol-initiated auction. Reuses `LibCollateralSettlement`. ERC721 only. Accrual-freeze-at-grace-expiry semantics (§6.2). Gated on `loan.allowsGracePeriodAuction == true`.
7. **ERC1155 extension** — both facets, full-balance only. (Partial-balance sales deferred per §8.)
8. **Re-evaluate Approach 4.1 vs. 4.2** — based on real liquidity-gap evidence from Steps 4-6 in production.

Each step is a separate PR. Steps 1-2 are foundational; **step 3 is the consent-gate prerequisite for everything below it**; 4-5 deliver Scenario A; 6 delivers Scenario B; 7 extends to ERC1155; 8 is a future-looking expansion.
