# NFT Collateral Sale + Grace-Period Auction (T-086 design)

**Status:** Design exploration · Round 2 (post-pivot) · Not ratified · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279)

> **History:**
> - Round 1 explored four approaches and recommended a Vaipakam-native marketplace (Approach 4.3).
> - Codex adversarial review on PR #280 surfaced four P1s + two P2s — addressed in commit `ee4453d1`.
> - User input then **pivoted away from Vaipakam-native marketplace toward third-party-marketplaces-only via Seaport ERC-1271** (Approach 4.2). The protocol becomes the seller-of-record on every listing; borrower controls price pre-grace; price snaps to floor post-grace; multi-marketplace expansion as a separate follow-up.
>
> This is the Round 2 redraft reflecting the pivot.

## 1. Problem statement

Today a borrower whose NFT (ERC721 or ERC1155) sits as collateral in a Vaipakam Vault has only two exits:

1. **Repay in full** — settle the loan from their own wallet, vault releases the NFT back.
2. **Default** — let grace expire, NFT goes to the lender (`DefaultedFacet.markDefaulted` for illiquid; `RiskFacet.triggerLiquidation` for liquid).

There's no path to **realize the NFT's market equity** while the loan is live. A borrower with an NFT worth substantially more than the loan can't unlock the difference except by paying off the loan first (which is the thing they couldn't do) or defaulting (which forfeits the equity).

Symmetrically, lenders facing a defaulting borrower receive the raw NFT and have to sell it themselves — instead of receiving the protocol-extracted cash equivalent.

The "Auction to prepay loan" UX captures this: a single button on the borrower's loan card that posts the collateral NFT for sale on third-party marketplaces (OpenSea v1; Blur / LooksRare / X2Y2 / Magic Eden in v2+), with proceeds flowing into the vault's settlement waterfall instead of to the borrower directly.

The two operational modes share the same plumbing but differ in WHO controls the price:

**Pre-grace (active loan).** Borrower clicks "Auction to prepay loan," sets an asking price at or above the protocol-computed floor `principal + accruedInterest + preclose fee + 2% buffer`, and the vault posts a Seaport order. Buyer matches → atomic settlement.

**Post-grace.** Pre-grace listing (if any) auto-re-prices to the post-grace floor `principal + (accrued-up-to-grace-expiry interest) + late fee + liquidation fee + 2% buffer`. If no pre-grace listing existed, the protocol posts a fresh one at this floor. Borrower can no longer modify the listing. If unfilled by the configurable post-grace window (default 7 days), fall through to the existing default flow (NFT-to-lender).

Both must work for ERC721 and ERC1155.

## 2. Threat model

What MUST be preserved:

- **Collateral lock invariant.** While a loan is active and not in a sale-settling state, the vault MUST NOT release the NFT to anyone except (a) the borrower on full repayment, (b) the lender on default, or (c) a marketplace-contract pulling the NFT atomically with a Seaport-routed payment that lands in the vault's settlement waterfall.
- **Marketplace-approval invariant.** The vault MAY grant `setApprovalForAll(seaportConduit, true)` (or per-token `approve`) to a known, audited Seaport conduit contract. The vault MUST NEVER grant operator approval to any EOA (in particular, NEVER to the borrower or the loan.borrower address). This is the rule that makes the third-party-marketplace path safe — the marketplace's contract code controls atomicity, not a human.
- **Settlement waterfall ordering.** Lender debt (principal + accrued interest) is paid before treasury fee. Treasury fee before liquidation fee. Liquidation fee before borrower remainder. No path skips ahead. The waterfall is enforced by Seaport's `consideration` items, not by a separate post-sale distribution transaction.
- **No equity dilution.** A successful Seaport match must not produce a state where the lender is short-paid OR the buyer ends up without the NFT after paying. Lender-debt-coverage is a HARD revert condition; partial lender settlement is forbidden.
- **Consent capture.** The lender at offer-acceptance time MUST know whether the loan allows pre-grace sale and/or post-grace auction. A lender who refuses either path MUST be able to decline at offer acceptance.

What can be relaxed (vs. today):

- The "NFT only ever leaves the vault to repayer-or-lender" invariant — the sale paths add a third class of authorized recipient (the Seaport-routed buyer). The relaxation is OK because the buyer's atomic payment IS the borrower's repayment, with Seaport's `consideration` distribution as the conduit.

What the threat model explicitly does NOT defend against (out of scope here):

- Seaport itself being malicious or compromised. Treated as a trust root; we're trusting OpenSea's audited Seaport contracts the same way the rest of the NFT ecosystem does. If Seaport is compromised, our worst case is the same as every other NFT protocol's worst case.
- Borrower listing at a price below market and leaving equity on the table — that's the borrower's choice; not a protocol failure.
- A Seaport-side reneging (order signed, never filled) — Seaport's order lifecycle handles this; we trust the protocol's signature/cancellation semantics.

## 3. Why operator delegation to the borrower fails

**Operator delegation to the borrower** is the first thing that comes to mind: have the vault call `setApprovalForAll(borrower, true)` or `approve(borrower, tokenId)` on the held NFT, then the borrower lists on OpenSea normally.

This breaks the collateral lock invariant. Once the borrower has operator rights, they can call `safeTransferFrom(vault, anyAddress, tokenId)` and walk the NFT out of the vault to anywhere — no marketplace needed, no settlement needed. Marketplaces require seller approval; once granted, the seller controls the NFT's destination.

**Operator delegation to the marketplace conduit** is the safe pattern, and is what this design uses. The vault approves the Seaport conduit contract (OpenSea's audited code). The conduit can pull the NFT iff a matching buy order has paid the consideration into the vault's settlement-waterfall recipients. The conduit cannot route the NFT elsewhere; it cannot pull without a matching paid buy.

So: approval-to-EOA = NO; approval-to-audited-marketplace-contract = YES.

## 4. Approaches considered (and rejected, briefly)

Round 1 of this doc weighed four approaches: claim-NFT redemption gate (4.1), Seaport ERC-1271 protocol-as-seller (4.2), Vaipakam-native marketplace (4.3), hybrid (4.4). User input narrowed the design to **4.2 only** based on:

- **Maximum third-party liquidity** (the whole point of "Auction to prepay loan" — buyers shop OpenSea-first; we go to where they are)
- **Vault keeps full control of the NFT** (approval-to-marketplace, NOT to borrower)
- **No in-built marketplace** (deliberate — we don't want to compete with OpenSea on UX or liquidity discovery)

The rejected approaches:
- **4.1 Claim-NFT redemption gate** — buyer-reneging risk (buyer pays equity on OpenSea, never redeems). Adding a redemption deadline mitigates but doesn't eliminate. The mental model is also confusing for buyers: they list a "rights-to-claim" NFT, not the actual collateral.
- **4.3 Vaipakam-native marketplace** — no external liquidity. Borrowers and buyers would have to come find Vaipakam-native listings on the Vaipakam frontend. Fails the "go where the buyers are" goal.
- **4.4 Hybrid (4.3 default + 4.1 optional)** — two paths to maintain, two consent flags to gate, splits engineering investment. If we're going third-party, go third-party fully.

The remainder of this doc is the Round-2 design for 4.2.

## 5. Recommendation (Round 2)

**Approach 4.2: Seaport ERC-1271, protocol-as-seller.** The vault implements ERC-1271 `isValidSignature(orderHash, encodedConditions)` returning valid only for Seaport orders whose `consideration` items route the proceeds correctly (lender, treasury, liquidator on post-grace, borrower remainder). The vault signs the order; OpenSea (and follow-up marketplaces) see a vault-listed NFT; buyers match normally.

**Borrower's only on-chain action** is calling Vaipakam's facet (`postPrepayListing(loanId, askPrice)` pre-grace, `cancelPrepayListing(loanId)`). The facet validates inputs, constructs the Seaport order, signs via ERC-1271, and emits an event that the frontend / backend relays to OpenSea via OpenSea's listing API. The borrower never touches Seaport directly.

**Post-grace conversion**: a separate facet entry (`convertToPostGraceListing(loanId)`) that anyone can call once `block.timestamp > loan.gracePeriodEnd`. It:
1. Snapshots `interestAccrualEnd = gracePeriodEnd` (accrual freeze; see §6.2).
2. Computes the post-grace floor.
3. If a pre-grace listing exists, cancels the existing Seaport order; signs a fresh one at the post-grace floor.
4. If no pre-grace listing exists, signs a fresh Seaport order at the post-grace floor.
5. Starts the post-grace window timer.

If unfilled by `postGraceWindow` (default 7 days), anyone can call `fallThroughToDefault(loanId)`, which:
1. Cancels the Seaport order.
2. Invokes the existing `DefaultedFacet.markDefaulted` flow.
3. NFT goes to lender per today's default semantics.

## 6. Settlement semantics

### 6.1 Sale authority binds to current borrower-position NFT holder, not stored borrower address

(Unchanged from the Round-1 amendment.)

The codebase issues a borrower-position ERC721 at loan initiation (see `VaipakamNFTFacet.mintNFT`). Transferring that NFT transfers all borrower-side rights. Sale authority MUST follow the same rule:

- `postPrepayListing(loanId, askPrice)` and `cancelPrepayListing(loanId)` are authorized iff `msg.sender == borrowerNFT.ownerOf(loan.borrowerNftId)` at call time.
- A snapshot of `loan.borrower` (the original EOA) is NOT used for authorization. After a borrower-NFT transfer, the new holder is the sale authority.
- `convertToPostGraceListing` and `fallThroughToDefault` are permissionless (any address can call them once their respective conditions are met). They don't require borrower-NFT-holder authority — they're protocol-level state transitions any keeper or external party can trigger.

### 6.2 Live-accrual recompute + Scenario B freeze

(Refined from the Round-1 amendment.)

- **Pre-grace listings:** `postPrepayListing` computes the floor at call time using current accrued interest. The borrower picks an askPrice at or above the floor + the 2% buffer. Between listing-post and Seaport-match, interest keeps accruing. If accrued interest moves the floor above the listed askPrice, the listing becomes un-fillable — Seaport's ERC-1271 callback on a match attempt validates the live `consideration` amounts against the live floor; if `askPrice < liveFloor`, ERC-1271 returns invalid, Seaport rejects the match. The borrower must `cancelPrepayListing` and re-list at a higher price. The 2% buffer gives ~hours-to-days of fillability headroom depending on the loan's APR.
- **Post-grace listings:** `convertToPostGraceListing` snapshots `interestAccrualEnd = gracePeriodEnd`. All subsequent settlement math uses the frozen accrual. The post-grace floor is stable for the whole `postGraceWindow` (default 7 days). If the auction succeeds, the buyer pays the frozen floor and the lender gets the (frozen) full debt. If the auction fails (no taker by `postGraceWindow`), the lender takes the NFT directly via the existing default flow — the frozen amount is never read.

### 6.3 Borrower-position NFT transfer-lock during active listing

(Unchanged from the Round-1 amendment.)

While a Seaport listing is active for `loanId`, the loan's borrower-position NFT is transfer-locked: `safeTransferFrom` on the borrower-NFT contract reverts with `BorrowerNftLockedDuringSale(loanId)`. The lock is set on `postPrepayListing` / `convertToPostGraceListing` and released on `cancelPrepayListing` / successful Seaport match / `fallThroughToDefault`.

### 6.4 Settlement waterfall — Seaport `consideration` items

The waterfall is enforced by Seaport's `consideration` array, NOT by a separate post-sale distribution transaction. When the vault signs a Seaport order, the order encodes the consideration items:

```
Seaport order:
  offer:
    [collateral NFT (ERC721 or ERC1155 with quantity)]
  consideration:
    [lender:    principal + accruedInterest      → loan.lender address]
    [treasury:  treasuryFeeBps × interest / 10000 → s.treasury]
    [liquidator: liquidationFeeBps × principal / 10000 → keeper-or-treasury per ratified open Q  (post-grace only)]
    [borrower:  remainder                         → borrowerNFT.ownerOf(loan.borrowerNftId)]
```

On a successful match, Seaport atomically:
1. Pulls payment from the buyer.
2. Splits payment per the consideration array (each recipient is paid in order).
3. Pulls the NFT from the vault.
4. Delivers the NFT to the buyer.

If any consideration item can't be paid (insufficient buyer payment for the full sum), Seaport reverts the entire match. So the lender-debt-coverage HARD requirement is enforced by Seaport's own protocol semantics — we don't need a separate revert path in our code, just need to construct the consideration items correctly.

**Closed-form floors (no circular dependency):**

```
preGraceFloor(loanId)
    = principal + accruedInterest
    + preclose_fee_bps × accruedInterest / 10000

postGraceFloor(loanId)
    = principal + accruedInterestAtGraceExpiry
    + late_fee_bps × principal / 10000
    + liquidation_fee_bps × principal / 10000
```

Both are **debt-floored**, not sale-price-floored — no circular math. The 2% buffer sits ON TOP of these floors at askPrice/listing-price computation time; it's not part of the floor itself.

## 7. Consent capture model

(Refined from the Round-1 amendment.)

Two flags on the Offer struct (visible to lender at acceptance):

- `allowsPrepayListing` — pre-grace borrower-initiated listing is allowed. Default: `true` (most flexible for borrower).
- `allowsPostGraceAuction` — post-grace protocol-initiated auction is allowed. Default: `true` (better for the protocol's loan-recovery outcomes; lender prefers cash over a raw NFT).

Acceptance freezes both into the resulting Loan struct. The facet entry points check the corresponding flag:

- `postPrepayListing` reverts if `!loan.allowsPrepayListing`.
- `convertToPostGraceListing` reverts if `!loan.allowsPostGraceAuction`. (If false, grace expiry falls straight through to today's default flow.)

Backward compatibility: existing loans (pre-this-PR) default BOTH flags to `false` on the Loan struct (today's behavior preserved). New offers can opt in via the offer UI.

## 8. ERC721 vs ERC1155

ERC721 is the v1 target (simpler — one token per loan; Seaport's standard `offer` shape).

ERC1155 needs the Seaport `offer` to specify quantity. The vault's borrower-position NFT already tracks the collateralized 1155 balance per loan, so the offer is `(1155 contract, tokenId, vaulted-balance)`. Settlement releases the full vaulted balance atomically with payment.

For v1, **restrict ERC1155 sales to the full vaulted balance** (no partial sales). Partial-balance support adds complexity (which units to release, what happens to the partial residual on default) that doesn't justify the v1 lift.

## 9. Open questions for ratification

1. **Liquidator-vs-treasury for the liquidation fee.** Existing default flow has no fee. Scenario B's `liquidation_fee_bps × principal / 10000` — should it go to the keeper who called `convertToPostGraceListing` (incentive to trigger), to the treasury (revenue), or split? **Open.**
2. **Post-grace window default.** 7 days is my proposed default. Should it be borrower-configurable at offer time? Protocol-configurable via governance? Hard-coded? **Open.**
3. **Native ETH vs ERC20 sale price.** Seaport's `consideration` items are token-typed. Should askPrice be ETH-only (simpler order shape) or also accept stablecoin payment? Most NFT marketplaces use chain-native + WETH default; supporting both is engineering work. **Open.**
4. **The 2% buffer — protocol-configurable?** Hard-coded in the facet, governance-configurable, or borrower-controlled (with a min)? My default: governance-configurable, initialized to 2%. **Open.**

The Round-1 doc had five open questions; today three of them are resolved by the user-input pivot:
- ✅ Reserve formula: closed-form, debt-floored. (§6.4)
- ✅ Auction deadline default: 7 days. (Q2 above is the only remaining question — what mechanism sets it.)
- ✅ Sale eligibility: day-1 onward, no conditional gating beyond the consent flags.

## 10. Out of scope (deferred)

- Cross-chain NFT sales (NFT on chain X, buyer on chain Y). NFTs aren't bridgeable in the general case; sale happens on the chain the NFT lives on.
- Dutch / English / Vickrey auction mechanics beyond fixed-price.
- Bid aggregation across marketplaces (operator chooses one venue per listing in v1; multi-marketplace fan-out is the follow-up tracked separately).
- Partial-balance ERC1155 sales (§8).
- Renegotiation / refinancing during a live sale listing (mutually exclusive: a borrower with an active listing can't refinance, and vice versa).

## 11. Sequencing

1. **Ratify this Round-2 design** (this PR — `@codex review adversarial design-doc`; address findings; merge).
2. **Implement `LibCollateralSettlement`** — the shared waterfall library + the floor-formula functions (`preGraceFloor`, `postGraceFloor`). Comprehensive unit tests including the closed-form math.
3. **Extend Offer + Loan structs** — add `allowsPrepayListing` + `allowsPostGraceAuction` flags. **MUST land before step 4.**
4. **Implement vault ERC-1271** — `isValidSignature` that validates Seaport orders against the live floor at execution. Construct Seaport order helpers (encode offer + consideration). Cancellation helper.
5. **Implement `NFTPrepayListingFacet`** — Scenario A entries: `postPrepayListing`, `cancelPrepayListing`. ERC721 only. Borrower-position NFT transfer-lock (§6.3). Live-accrual recompute via ERC-1271 callback (§6.2). Gated on `loan.allowsPrepayListing == true`.
6. **Implement `NFTPostGraceAuctionFacet`** — Scenario B entries: `convertToPostGraceListing`, `fallThroughToDefault`. Accrual-freeze-at-grace-expiry (§6.2). Gated on `loan.allowsPostGraceAuction == true`. Post-grace window default 7 days.
7. **Wire OpenSea API integration** — frontend posts the listing to OpenSea via their API after the vault signs. Listing-discovery UX (borrower view).
8. **ERC1155 extension** — both facets, full-balance only.
9. **(Separate follow-up card — multi-marketplace expansion)** — extend to Blur / LooksRare / X2Y2 / Magic Eden, with the design questions (parallel-vs-sequential listings, cancel-on-match-elsewhere, marketplace-specific order shapes) addressed in a dedicated design doc. Tracked separately so v1 doesn't get blocked on multi-marketplace research.

Each step is a separate PR. Steps 1-2 foundational; step 3 is the consent-gate prerequisite; 4-7 deliver the OpenSea pre-grace + post-grace flow end-to-end; 8 extends ERC1155; 9 is the multi-marketplace expansion follow-up.
