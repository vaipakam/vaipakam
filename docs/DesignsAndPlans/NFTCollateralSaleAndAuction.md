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
1. Borrower calls `listForSale(loanId, askPrice)` with `askPrice ≥ outstandingDebt + fees`. Vault marks the loan "for sale at X."
2. Any buyer calls `buyCollateral(loanId)` with `msg.value == askPrice` (or ERC20 `transferFrom`).
3. Atomically: buyer's payment → lender (debt + interest) + treasury (fee) + borrower (remainder); NFT → buyer; loan → settled.

Pros:
- Cleanest architecturally — single contract, atomic, no external dependency
- No claim NFT proliferation, no Seaport coupling
- Easy to add bidding later (auction-style, English-style, Dutch) as separate facets

Cons:
- Zero external liquidity — buyers must come find Vaipakam-native listings on the Vaipakam frontend (or build their own scrapers). Most NFT buyers shop OpenSea-first.
- Borrowers lose the OpenSea audience entirely
- Need to build listing-discovery UX on the frontend (browse, filter, etc.)

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

For Scenario B (protocol-initiated grace-period auction): **use a protocol-controlled auction, also Vaipakam-native (Approach 4.3 shape).** The protocol posts the listing at a reserve = `outstandingDebt + interest + treasuryFee + liquidationFee`, with a configurable deadline. If a buyer hits the reserve, settlement waterfall runs. If not, fall through to the existing default flow (NFT-to-lender). Scenario B is a strict extension of A's primitives: same listing entry, same buy entry, different actor (protocol vs. borrower) and different reserve formula.

If Scenario A's Vaipakam-native marketplace shows clear liquidity-gap evidence in production (borrowers listing but no buyers within N days), upgrade to Approach 4.1 (claim-NFT) as the OpenSea route. Re-evaluate Approach 4.2 (Seaport ERC-1271) only if the engineering investment becomes justifiable by deep market data.

## 6. Settlement waterfall (shared)

Both scenarios share the same waterfall. Implement once as `LibCollateralSettlement.distribute(loanId, salePrice)`:

```
salePrice flow:
  ├─→ Lender:      principal + accrued interest (capped at salePrice if shortfall)
  ├─→ Treasury:    treasuryFee (BPS of interest)
  ├─→ Liquidator:  liquidationFee (Scenario B only, fixed BPS of salePrice)
  └─→ Borrower:    remainder (≥ 0)
```

Invariants:
- `salePrice ≥ principal + accruedInterest + treasuryFee + (liquidationFee if Scenario B)`
- If the inequality fails, the sale REVERTS in Scenario A (borrower's responsibility to set a viable askPrice). In Scenario B, the reserve is set above this floor by construction, so the inequality holds if a taker matched.

Lender accrual stops at the block of the settlement transaction.

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

1. **Ratify this design** (PR opens with `@codex review adversarial design-doc`; address findings; merge).
2. **Implement `LibCollateralSettlement`** — the shared waterfall library. Comprehensive unit tests.
3. **Implement `NFTSaleFacet`** — Scenario A's `listForSale` / `buyCollateral` / `cancelListing`. ERC721 only.
4. **Extend Offer struct** — add `allowsBorrowerSale` + `allowsGracePeriodAuction` flags. Migration: offer-level only, no loan-level retrofit.
5. **Wire UI** — listing creation, listing browse, buy flow. Frontend.
6. **Implement `NFTAuctionFacet`** — Scenario B's protocol-initiated auction. Reuses `LibCollateralSettlement`. ERC721 only.
7. **ERC1155 extension** — both facets, full-balance only.
8. **Re-evaluate Approach 4.1 vs. 4.2** — based on real liquidity-gap evidence from Steps 3-6 in production.

Each step is a separate PR. Steps 1-2 are foundational; 3-5 deliver Scenario A; 6 delivers Scenario B; 7 extends to ERC1155; 8 is a future-looking expansion.
