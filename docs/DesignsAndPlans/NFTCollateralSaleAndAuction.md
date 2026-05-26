# NFT Collateral Pre-Grace Sale (T-086 design)

**Status:** Design exploration · Round 3 (post-pivot, Scenario B dropped) · Not ratified · Tracking Issue [#279](https://github.com/vaipakam/vaipakam/issues/279)

> **History:**
> - **Round 1** explored four approaches and recommended a Vaipakam-native marketplace (Approach 4.3).
> - **Codex adversarial review** on PR #280 surfaced four P1s + two P2s — addressed in commit `ee4453d1`.
> - **Round 2** (commit `125beccc`) pivoted from Vaipakam-native marketplace to third-party-marketplaces-only via Seaport ERC-1271 (Approach 4.2). The protocol became seller-of-record; pre-grace borrower-controlled price; **post-grace protocol-controlled auction**.
> - **Round 3** (this commit) drops the post-grace protocol-controlled auction entirely. **Grace expiry = cancel any active Seaport listing + fall through to today's `DefaultedFacet.markDefaulted` (NFT → lender).** Lender's existing default-flow expectation is preserved unchanged.
>
> This is the Round 3 simplification reflecting the user's direction to keep the post-grace flow exactly as today.

## 1. Problem statement

Today a borrower whose NFT (ERC721 or ERC1155) sits as collateral in a Vaipakam Vault has only two exits:

1. **Repay in full** — settle the loan from their own wallet, vault releases the NFT back.
2. **Default** — let grace expire, NFT goes to the lender (`DefaultedFacet.markDefaulted` for illiquid; `RiskFacet.triggerLiquidation` for liquid).

There's no path to **realize the NFT's market equity** while the loan is live. A borrower with an NFT worth substantially more than the loan can't unlock the difference except by paying off the loan first (which is the thing they couldn't do) or defaulting (which forfeits the equity).

The "Auction to prepay loan" UX captures this: a single button on the borrower's loan card that posts the collateral NFT for sale on a third-party marketplace (OpenSea v1; multi-marketplace expansion deferred), with proceeds flowing into the vault's settlement waterfall instead of to the borrower directly.

**Scope of this v1: pre-grace only.** The borrower has from loan-init through grace-period-start to find a buyer. At grace expiry, any active Seaport listing is cancelled and today's `DefaultedFacet.markDefaulted` flow runs (NFT → lender), exactly as today. Post-grace protocol-controlled auctions are explicitly NOT in this design (Round 2 had them; Round 3 drops them by user direction). The lender's existing default-flow expectation is preserved unchanged: if the borrower defaults, the lender gets the NFT.

ERC721 + ERC1155 both supported in v1 (full-balance only for ERC1155; partial sales deferred).

## 2. Threat model

What MUST be preserved:

- **Collateral lock invariant.** While a loan is active and not in a sale-settling state, the vault MUST NOT release the NFT to anyone except (a) the borrower on full repayment, (b) the lender on default, or (c) a marketplace-contract pulling the NFT atomically with a Seaport-routed payment that lands in the vault's settlement waterfall.
- **Marketplace-approval invariant.** The vault MAY grant `setApprovalForAll(seaportConduit, true)` (or per-token `approve`) to a known, audited Seaport conduit contract. The vault MUST NEVER grant operator approval to any EOA (in particular, NEVER to the borrower or the `loan.borrower` address). This is the rule that makes the third-party-marketplace path safe — the marketplace's contract code controls atomicity, not a human.
- **Settlement waterfall ordering.** Lender debt (principal + accrued interest) is paid before treasury fee. Treasury fee before borrower remainder. No path skips ahead. The waterfall is enforced by Seaport's `consideration` items, not by a separate post-sale distribution transaction.
- **No equity dilution.** A successful Seaport match must not produce a state where the lender is short-paid OR the buyer ends up without the NFT after paying. Lender-debt-coverage is a HARD revert condition; partial lender settlement is forbidden.
- **Lender default-flow expectation preserved.** If the loan defaults (grace expires with no settled sale), the lender receives the NFT directly — the existing `DefaultedFacet.markDefaulted` flow runs unchanged. The pre-grace sale path is OPT-IN at offer creation and OPT-OUT-able at offer acceptance; it cannot change the post-grace lender outcome.
- **Consent capture.** The lender at offer-acceptance time MUST know whether the loan allows pre-grace borrower-initiated sale. A lender who refuses the path (because they specifically want the chance to receive the NFT directly on default, with no third-party sale interfering) MUST be able to decline at offer acceptance.

What can be relaxed (vs. today):

- The "NFT only ever leaves the vault to repayer-or-lender" invariant — the pre-grace sale path adds a third class of authorized recipient (the Seaport-routed buyer). The relaxation is OK because the buyer's atomic payment IS the borrower's repayment, with Seaport's `consideration` distribution as the conduit.

What the threat model explicitly does NOT defend against (out of scope here):

- Seaport itself being malicious or compromised. Treated as a trust root.
- Borrower listing at a price below market and leaving equity on the table — borrower's choice; not a protocol failure.
- A Seaport-side reneging (order signed, never filled) — Seaport's order lifecycle handles this; we trust the protocol's signature/cancellation semantics.

## 3. Why operator delegation to the borrower fails

**Operator delegation to the borrower** is the first thing that comes to mind: have the vault call `setApprovalForAll(borrower, true)` or `approve(borrower, tokenId)` on the held NFT, then the borrower lists on OpenSea normally.

This breaks the collateral lock invariant. Once the borrower has operator rights, they can call `safeTransferFrom(vault, anyAddress, tokenId)` and walk the NFT out of the vault to anywhere — no marketplace needed, no settlement needed. Marketplaces require seller approval; once granted, the seller controls the NFT's destination.

**Operator delegation to the marketplace conduit** is the safe pattern. The vault approves the Seaport conduit contract (OpenSea's audited code). The conduit can pull the NFT iff a matching buy order has paid the consideration into the vault's settlement-waterfall recipients. The conduit cannot route the NFT elsewhere; it cannot pull without a matching paid buy.

So: approval-to-EOA = NO; approval-to-audited-marketplace-contract = YES.

## 4. Approaches considered (and rejected)

Round 1 of this doc weighed four approaches: claim-NFT redemption gate (4.1), Seaport ERC-1271 protocol-as-seller (4.2), Vaipakam-native marketplace (4.3), hybrid (4.4). User direction narrowed the design to **4.2 only**. The rejected approaches:

- **4.1 Claim-NFT redemption gate** — buyer-reneging risk (buyer pays equity on OpenSea, never redeems). Adding a redemption deadline mitigates but doesn't eliminate. Buyer mental model is also confusing: they list a "rights-to-claim" NFT, not the actual collateral.
- **4.3 Vaipakam-native marketplace** — no external liquidity. Borrowers and buyers would have to come find Vaipakam-native listings on the Vaipakam frontend. Fails the "go where the buyers are" goal.
- **4.4 Hybrid (4.3 default + 4.1 optional)** — two paths to maintain, two consent flags to gate. If we're going third-party, go third-party fully.

Round 2 considered a post-grace protocol-controlled auction layered on top of 4.2. **User direction in Round 3 dropped that layer entirely.** Post-grace = today's default flow, no auction.

The remainder of this doc is the Round-3 design for 4.2-pre-grace-only.

## 5. Recommendation (Round 3)

**Approach 4.2 (Seaport ERC-1271), pre-grace only, protocol-as-seller.** The vault implements ERC-1271 `isValidSignature(orderHash, encodedConditions)` returning valid only for Seaport orders whose `consideration` items route the proceeds correctly (lender, treasury, borrower remainder). The vault signs the order; OpenSea sees a vault-listed NFT; buyers match normally.

**Borrower's only on-chain actions** are calling Vaipakam's facet entries:
- `postPrepayListing(loanId, askPrice)` — pre-grace; validates `askPrice ≥ preGraceFloor` and the +2% buffer; vault constructs + signs the Seaport order; emits an event for the off-chain relay to publish on OpenSea via OpenSea's listing API.
- `updatePrepayListing(loanId, newAskPrice)` — pre-grace re-pricing; same floor validation; cancels old Seaport order + signs new one.
- `cancelPrepayListing(loanId)` — pre-grace cancellation; vault cancels the Seaport order, releases the borrower-NFT transfer-lock.

**Grace expiry handling:** when `block.timestamp ≥ loan.gracePeriodEnd`, the vault's ERC-1271 callback returns invalid for any in-flight match attempt on this loan's listing. So a buyer who tries to match at grace expiry's exact block (or later) gets the Seaport match rejected. Either at the same time or shortly thereafter, anyone can call `cancelExpiredPrepayListing(loanId)`, which:
1. Asserts `block.timestamp ≥ loan.gracePeriodEnd` AND a listing exists for this loan.
2. Cancels the Seaport order.
3. Releases the borrower-NFT transfer-lock.

The loan is now in its existing "grace expired, default flow applicable" state. The existing `DefaultedFacet.markDefaulted` (or `RiskFacet.triggerLiquidation` on liquid collateral) flow runs unchanged. **No new code path runs here.** The pre-grace sale path is entirely defined; post-grace is unmodified.

The borrower never touches Seaport directly. Seaport sees only the vault's signed order.

## 6. Settlement semantics

### 6.1 Sale authority binds to current borrower-position NFT holder, not stored borrower address

The codebase issues a borrower-position ERC721 at loan initiation (see `VaipakamNFTFacet.mintNFT`). Transferring that NFT transfers all borrower-side rights. Sale authority MUST follow the same rule:

- `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` are authorized iff `msg.sender == borrowerNFT.ownerOf(loan.borrowerNftId)` at call time.
- A snapshot of `loan.borrower` (the original EOA) is NOT used for authorization. After a borrower-NFT transfer, the new holder is the sale authority.
- `cancelExpiredPrepayListing` is permissionless — any address can call it once grace has expired and a listing exists. It's a protocol-level state transition that any keeper or external party can trigger.

### 6.2 Live-accrual recompute via ERC-1271 callback

Pre-grace interest accrues per-block on active loans. A borrower lists at `askPrice = floor + buffer`; some hours later, accrued interest has moved the floor up. If the move ate through the buffer, the askPrice no longer covers the live debt.

**Resolution:** ERC-1271's `isValidSignature` callback is called by Seaport at match-execution time. The callback recomputes the live floor (using `block.timestamp` accrual) and validates the order's `consideration` items against the live floor. If `askPrice < liveFloor`, the callback returns invalid; Seaport rejects the match. The borrower must `updatePrepayListing` to a higher price (or `cancelPrepayListing` and re-list).

**Grace expiry** is checked in the same callback: if `block.timestamp ≥ loan.gracePeriodEnd`, callback returns invalid regardless of price. So an in-flight buyer who matches one block after grace expiry gets the match rejected — the protocol forfeits the equity opportunity to the lender's default-flow expectation.

The 2% buffer at listing time gives the borrower hours-to-days of fillability headroom depending on APR. UX shows "listing expires when floor crosses askPrice (~N hours at current APR)" so the borrower isn't surprised.

### 6.3 Borrower-position NFT transfer-lock during active listing

While a Seaport listing is active for `loanId`, the loan's borrower-position NFT is transfer-locked: `safeTransferFrom` on the borrower-NFT contract reverts with `BorrowerNftLockedDuringSale(loanId)`. The lock is set on `postPrepayListing` and released on `cancelPrepayListing` / successful Seaport match / `cancelExpiredPrepayListing`.

Without this lock, two race conditions exist:
- Borrower A lists. Buyer matches. Borrower A transfers borrower-position NFT to Borrower B mid-execution. Who receives the borrower-remainder? With the lock, the question can't arise: transfer reverts while listing is active.
- Borrower A lists. Borrower A transfers borrower-position NFT to Borrower B. Buyer matches. Borrower B receives the proceeds (per §6.1). But Borrower B may not know about the active listing they inherited — surprise sale. The lock surfaces the listing to Borrower B BEFORE the transfer (they have to wait for cancel or settlement).

### 6.4 Settlement waterfall — Seaport `consideration` items

The waterfall is enforced by Seaport's `consideration` array. When the vault signs a Seaport order:

```
Seaport order:
  offer:
    [collateral NFT (ERC721 or ERC1155 with quantity)]
  consideration:
    [lender:    principal + accruedInterest      → loan.lender address]
    [treasury:  treasuryFeeBps × interest / 10000 → s.treasury]
    [borrower:  remainder                         → borrowerNFT.ownerOf(loan.borrowerNftId)]
```

On a successful match, Seaport atomically:
1. Pulls payment from the buyer.
2. Splits payment per the consideration array (each recipient is paid in order).
3. Pulls the NFT from the vault.
4. Delivers the NFT to the buyer.

If any consideration item can't be paid (insufficient buyer payment for the full sum), Seaport reverts the entire match. So the lender-debt-coverage HARD requirement is enforced by Seaport's own protocol semantics — we don't need a separate revert path in our code, just need to construct the consideration items correctly at order-signing time.

**Closed-form floor (no circular dependency):**

```
preGraceFloor(loanId)
    = principal + accruedInterest
    + preclose_fee_bps × accruedInterest / 10000
```

Debt-based, computable at any block. The 2% buffer sits ON TOP of this floor at askPrice/listing-price computation time; it's not part of the floor itself.

The borrower's minimum askPrice = `preGraceFloor × (1 + 200 / 10000)`. The 2% buffer is what gives the listing fillability headroom as interest accrues.

**No liquidation fee, no late fee.** Round 2 had these as Scenario B's consideration items. Round 3 has no Scenario B → no liquidation/late fees in the consideration. The waterfall stays simple: lender → treasury → borrower-remainder.

## 7. Consent capture model

ONE flag on the Offer struct (visible to lender at acceptance):

- `allowsPrepayListing` — pre-grace borrower-initiated listing is allowed. Default: `true` (most flexible for borrower).

Acceptance freezes the flag into the resulting Loan struct. The facet entry points check the flag:

- `postPrepayListing` / `updatePrepayListing` revert if `!loan.allowsPrepayListing`.
- `cancelPrepayListing` / `cancelExpiredPrepayListing` are always allowed (they only ever release the lock + cancel orders, never open new ones).

Backward compatibility: existing loans (pre-this-PR) default `allowsPrepayListing` to `false` on the Loan struct (today's behavior preserved). New offers can opt in via the offer UI.

A lender who specifically wants the chance to receive the NFT directly on default (and doesn't want a third-party sale interfering with that expectation) declines offers where `allowsPrepayListing == true`. The flag is visible at offer-acceptance time.

## 8. ERC721 vs ERC1155

ERC721 is the v1 target (simpler — one token per loan; Seaport's standard `offer` shape).

ERC1155 v1 also works with one extension: the vault's borrower-position NFT already tracks the collateralized 1155 balance per loan, so the offer is `(1155 contract, tokenId, vaulted-balance)`. Settlement releases the full vaulted balance atomically with payment.

For v1, **restrict ERC1155 sales to the full vaulted balance** (no partial sales). Partial-balance support adds complexity (which units to release, what happens to the partial residual on default) that doesn't justify the v1 lift.

## 9. Open questions for ratification

1. **Native ETH vs ERC20 sale price.** Seaport's `consideration` items are token-typed. Should askPrice be ETH-only (simpler order shape) or also accept stablecoin payment? Most NFT marketplaces use chain-native + WETH default; supporting both is engineering work. **Open.**
2. **The 2% buffer — protocol-configurable?** Hard-coded in the facet, governance-configurable, or borrower-controlled (with a min)? My default: governance-configurable, initialized to 200 bps. **Open.**
3. **OpenSea listing API integration boundary.** The vault signs the Seaport order on-chain; the order then needs to be **published** to OpenSea's order book (off-chain API). Where does that happen? A Vaipakam off-chain relayer (we run it), a frontend-side call (borrower's wallet posts to OpenSea API after the on-chain sign), or both? Each option has different operator-trust implications. **Open.**
4. **Frontend "protocol-controlled listing" banner concept.** v2 will add the lender-tail-window state (Out of Scope §10). Beyond that, future protocol-mediated listings (refinance-to-sale, multi-marketplace, etc.) will all share the same UX pattern: a Vaipakam-frontend banner annotating the listing card with protocol-side context ("Auction to prepay loan", "Grace tail window — 24h", "Listed via Vaipakam"). Worth a small front-end design pass to standardize the banner shape NOW so v1's "Auction to prepay loan" banner and v2's tail-window banner are visually consistent. **Open — frontend-only, no contract impact.**

Round 2 had four open questions; three carried over from Round 1. Round 3 has four open questions; one (liquidator vs treasury for the liquidation fee) is no longer relevant since Scenario B was dropped, and one new (protocol-controlled banner) replaces it.

## 10. Out of scope (deferred)

- Cross-chain NFT sales (NFT on chain X, buyer on chain Y). NFTs aren't bridgeable in the general case; sale happens on the chain the NFT lives on.
- Dutch / English / Vickrey auction mechanics beyond fixed-price.
- Bid aggregation across marketplaces (operator chooses one venue per listing in v1; multi-marketplace fan-out is the follow-up tracked separately).
- Partial-balance ERC1155 sales (§8).
- Renegotiation / refinancing during a live sale listing (mutually exclusive: a borrower with an active listing can't refinance, and vice versa).
- **Post-grace protocol-controlled auction** (Round 2 had this; Round 3 dropped it). Lender's existing default-flow expectation is preserved unchanged.
- **Lender-side tail-window optionality at grace expiry** (a v2 enhancement; not v1). At grace expiry, give the lender a one-time choice: accept the NFT now (today's flow) OR elect an extra tail window (default 24h, governance-configurable) to see if the active listing closes. Mechanics (when v2 is designed):
  - Lender calls `lenderElectTailWindow(loanId)` within a short post-grace election period (e.g., 1h). Default if unelected = accept NFT now.
  - On election, the vault cancels the pre-grace Seaport order (endTime tied to grace expiry) and signs a fresh order with `endTime = electedAt + 23h` (NOT `+ 24h` — see below).
  - `fallThroughToDefault(loanId)` becomes callable at `electedAt + 24h`.
  - The 1h **cool-down zone** between Seaport `endTime` (T+23h) and the default-trigger time (T+24h) guarantees no race between buyer-match and lender-default: after T+23h Seaport rejects new matches; before T+24h `fallThroughToDefault` is not callable; so no transaction can land that mixes the two outcomes in the same block.
  - If a buyer matches within T → T+23h: settlement waterfall runs (lender + treasury + borrower-remainder).
  - If unmatched by T+24h: `fallThroughToDefault` fires; NFT → lender.
  - Buffer is governance-configurable (initialized to 1h = 3600 seconds). 1h is a clean default to communicate ("lender gets 24h, OpenSea visible for 23h, 1h cool-down before default"); smaller buffers (15-30 min) would also be safe on most chains but the round number is easier UX.
  - OpenSea displays "Expires in X" naturally via the Seaport `endTime` field — no custom listing-text annotation needed.

## 11. Sequencing

1. **Ratify this Round-3 design** (this PR — `@codex review adversarial design-doc`; address findings; merge).
2. **Implement `LibCollateralSettlement`** — the shared waterfall library + the floor-formula function (`preGraceFloor`). Comprehensive unit tests including the closed-form math.
3. **Extend Offer + Loan structs** — add `allowsPrepayListing` flag. **MUST land before step 4.**
4. **Implement vault ERC-1271** — `isValidSignature` that validates Seaport orders against the live floor at execution AND checks `block.timestamp < loan.gracePeriodEnd`. Construct Seaport order helpers (encode offer + consideration). Cancellation helper.
5. **Implement `NFTPrepayListingFacet`** — `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing`. ERC721 first; ERC1155 follow-up. Borrower-position NFT transfer-lock (§6.3). Gated on `loan.allowsPrepayListing == true`.
6. **Wire OpenSea API integration** — frontend (or Vaipakam off-chain relayer) posts the listing to OpenSea via their API after the vault signs. Listing-discovery UX (borrower view).
7. **ERC1155 extension** — facet, full-balance only.
8. **(Separate follow-up card — multi-marketplace expansion)** — extend to Blur / LooksRare / X2Y2 / Magic Eden, with the design questions (parallel-vs-sequential listings, cancel-on-match-elsewhere, marketplace-specific order shapes) addressed in a dedicated design doc.

Each step is a separate PR. Steps 1-2 foundational; step 3 is the consent-gate prerequisite; 4-6 deliver the OpenSea pre-grace flow end-to-end; 7 extends ERC1155; 8 is the multi-marketplace expansion follow-up.

**Smaller than Round 2.** Dropping Scenario B removed: the post-grace state machine, the accrual freeze logic, the liquidation-fee consideration item, and the `allowsPostGraceAuction` flag. About one-third less surface to implement + audit.
