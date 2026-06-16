# v0.5 — Signed off-chain offer book (#396) — implementation design

**Stage 4, phase v0.5** of the #401 hybrid-intent program (see
[`HybridIntentLayer.md`](HybridIntentLayer.md) + the [#396 findings](Research-396-SignedOffChainOfferIntentLayer.md)).
**Goal:** make offer *creation* gasless — sign an offer off-chain (EIP-712), settle it on-chain —
so the order book can be deep. This is the dependency root of the whole cluster and the **lowest
new-custody-surface** phase (funds never leave the existing per-user vaults).

This doc is the implementation spec. It marks the **load-bearing decisions** (D1–D3) with my
recommendation; everything else follows from the scout.

---

## 1. Scope (v0.5 — deliberately minimal)

**In:**
- A new `SignedOfferFacet` exposing (final shipped signatures):
  - `acceptSignedOffer(SignedOffer, sig, acceptorConsent)` — **vault-backed** fill (signer's
    principal/collateral already in their Vaipakam vault); `sig` is the signer's EIP-712
    signature. **Full-accept only in v0.5** (direct counterparty accept = AON semantics; partial
    fills arrive with the matcher phase — see "Out" below).
  - `acceptSignedOfferWithPermit(SignedOffer, permit, permitSig, acceptorConsent)` —
    **wallet-backed** fill. **No separate offer signature**: the single Permit2 witness signature
    (`permitSig`, over `permitWitnessTransferFrom` with the offer hash as the witness) binds BOTH
    the token pull AND the offer terms. **AON-only**.
  - `cancelSignedOffer(SignedOffer)` / `invalidateSignedOfferNonce(nonce)` — on-chain cancellation.
  - `hashSignedOffer(SignedOffer) view returns (bytes32)` — the full EIP-712 digest the signer
    signs (off-chain + tests consume it); `signedOfferOrderHash(SignedOffer) view` — the struct
    hash (the ledger key).
  - `signedOfferFilledAmount(bytes32 orderHash) view` / `isSignedOfferNonceUsed(signer, nonce)
    view` — reads.
- A Vaipakam EIP-712 domain for signed offers + the `SignedOffer` typed-data struct.
- An on-chain nonce / per-order-hash remaining-amount ledger + replay/expiry/chainId guards.
- EOA **and** EIP-1271 signers (OZ `SignatureChecker`).

**Out (later phases, noted so scope is honest):**
- **Signed-offer-aware MATCH entry** (matcher filling two signed offers / a signed vs on-chain
  offer) — part of the matcher upgrade (#393 L2), not v0.5. v0.5 is *direct counterparty accept*.
- **LenderIntentVault / auto-roll / `beneficialOwner`** — v1 (#393 L1). In v0.5 the signer IS the
  offer creator, so loan attribution is to the signer directly; no beneficial-owner indirection.
- **Aggregator ERC-4626 adapter** — v1.5 (#398).
- **Indexer signed-offer book + under-funded auto-promote** — off-chain (apps/indexer), separate
  PR; the on-chain surface here is what it indexes.
- **Rate-model quote-at-sign** (#400) — orthogonal; a signed offer carries a concrete rate.

## 2. The three load-bearing decisions

### D1 — Two solvency modes, vault-backed is the default. **(recommended: ship both, vault-backed primary)**
- **Vault-backed** (primary): the signer's principal (lender) / collateral (borrower) is already
  in their Vaipakam vault. The signed offer authorizes the Diamond to move *vault* funds at
  accept; **no Permit2, no per-fill signature** → supports **partial fills** (the Diamond debits
  the vault per the remaining-amount ledger). This is the common case and the only mode that can
  be partial-fillable (per #396: a single signature-transfer is single-use).
- **Wallet-backed** (secondary): funds in the signer's wallet; `permitWitnessTransferFrom` with
  the offer as the EIP-712 witness binds token + terms in one signature. **AON-only** (one
  signature = one pull). Useful for "I haven't pre-funded a vault" UX.

> *Why both:* vault-backed unlocks partial fills + the deep auto-roll future; wallet-backed is the
> zero-pre-deposit on-ramp. They share the same `SignedOffer` digest; only the pull differs.

### D2 — Materialize-into-storage-then-reuse the existing accept→init path. **(recommended)**
The scout confirms `_acceptOffer(offerId)` and `initiateLoan(offerId)` are tightly coupled to a
**stored** `s.offers[offerId]`, and that `createOfferInternal(creator, params)` already exists as a
self-gated cross-facet entry doing the full setup→pull→finish (used by `PrecloseFacet`).
`acceptSignedOffer` will, after signature + solvency verification:
1. Call a **new self-gated cross-facet entry on `OfferCreateFacet`** —
   `createSignedOfferMaterialized(creator, params, fundingMode, permit, permitSig)` — that reuses
   `_createOfferSetup` + `_createOfferFinish` verbatim (all the validation: duration, sanctions,
   self-collateral, asset-pause, refinance, range, periodic-cadence, liquidity, NFT mint) and swaps
   only the **pull step** by `fundingMode` (see D2a). Returns the fresh `offerId`.
2. Immediately call `acceptOfferInternal(offerId, ...)` against it.

So a signed offer becomes a normal on-chain offer at the instant of fill, and **every downstream
lifecycle (loan init, NFTs, claims, VPFI, sanctions, range/partial accounting) works unchanged**.
The only new contract code is signature-verify + nonce/remaining + the one new funding mode.

### D2a — The pull step, by funding mode (the one genuinely-new mechanic)
`createOffer` today **always** pulls the creator's funds wallet→vault (`_pullCreatorAssetsClassic`
or the Permit2 path), then at accept the principal moves vault→borrower. The signed-offer modes
diverge only at the pull:
- **Vault-backed:** the signer **pre-deposited** into their Vaipakam vault, so funds are already
  there as free balance. Materialize **SKIPS the wallet pull** and instead asserts the creator's
  **free vault balance ≥ fillAmount** (`free = protocolTrackedVaultBalance − getEncumbered`). No
  new persistent lock is required for *direct* fill: the offer is created+accepted in one tx, so
  the existing vault→borrower move at `initiateLoan` consumes the balance immediately; a concurrent
  second fill against the same free balance simply reverts on the free-balance assert (the
  "under-funded → revert at accept" solvency guarantee — like NFTfi under-funded offers). This new
  *fund-from-existing-vault-balance* mode is also the foundation the v1 LenderIntentVault reuses.
- **Wallet-backed:** funds in the signer's wallet. Materialize pulls via Permit2
  `permitWitnessTransferFrom` with the SignedOffer hash as the EIP-712 **witness** — so the single
  Permit2 signature binds **both** the token pull AND the offer terms (no separate SignedOffer
  signature in this mode). AON-only (one signature = one pull). Needs a `pullWithWitness` added to
  `LibPermit2` (today it only has plain `pull`).

> *Alternative considered:* reconstruct-and-route without storing (pass the struct down a
> parallel path). Rejected — it duplicates the settlement surface and doubles the audit/maintenance
> cost for no benefit, since the offer must be recorded anyway for partial-fill remaining tracking
> + indexer visibility.

### D3 — Nonce model: per-order-hash remaining ledger + a per-signer cancel-nonce. **(recommended)**
- **Replay / consume tracking:** keyed by the **order hash = `LibSignedOffer.hashStruct(o)`** (the
  domain-independent EIP-712 *struct* hash, NOT the full digest — so both funding modes key the
  same ledger; chain/domain binding lives in the signature check). `s.signedOfferFilled[orderHash]`
  (cumulative filled amount). In **v0.5 a direct accept consumes the offer fully** (set to the
  ceiling); the cumulative-amount shape is forward-compatible with the matcher phase's partial
  decrement (AON close vs partial decrement to a dust floor). Analog of `Offer.amountFilled`.
- **Cancellation:** `cancelSignedOffer(offer)` sets `signedOfferFilled[hash] = ceiling` (fully
  consumed → unfillable). Plus a coarse `invalidateSignedOfferNonce(nonce)` (per-signer) for "cancel a batch"
  — `s.signedOfferNonceUsed[signer][nonce]`, checked at accept. A signed offer carries both an
  `orderHash` identity and a `nonce` the signer can mass-invalidate.

> *Why order-hash, not a single incrementing nonce:* a deep gasless book has many simultaneous
> live offers from one signer; a strictly-incrementing nonce would force cancel-one = cancel-all.
> Order-hash keying + an optional batch-nonce gives both granular and bulk cancel.

## 3. Storage additions (`LibVaipakam.Storage`, append-only)

```
// signed-offer book (v0.5 / #396)
mapping(bytes32 => uint256) signedOfferFilled;        // orderHash → cumulative filled (amount units)
mapping(address => mapping(uint256 => bool)) signedOfferNonceUsed; // signer → nonce → invalidated
```

No new struct in storage — the materialized offer reuses the existing `Offer` slot. The
`SignedOffer` typed-data struct lives in calldata/memory only.

## 4. The EIP-712 `SignedOffer` typed data

A new Vaipakam domain (the diamond has none for offers today):
`EIP712Domain(name="Vaipakam SignedOffer", version="1", chainId, verifyingContract=diamond)`.

`SignedOffer` mirrors the **economically-binding** subset of `CreateOfferParams` (from the scout)
+ signer/nonce/deadline:
```
SignedOffer(
  uint8 offerType, address lendingAsset, uint256 amount, uint256 amountMax,
  uint256 interestRateBps, uint256 interestRateBpsMax,
  address collateralAsset, uint256 collateralAmount, uint256 collateralAmountMax,
  uint256 durationDays, uint8 assetType, uint8 collateralAssetType,
  uint256 tokenId, uint256 quantity, uint256 collateralTokenId, uint256 collateralQuantity,
  address prepayAsset, bool allowsPartialRepay, bool allowsPrepayListing,
  bool allowsParallelSale, uint64 expiresAt, uint8 fillMode,
  uint8 periodicInterestCadence, uint256 refinanceTargetLoanId, bool useFullTermInterest,
  address signer, uint256 nonce, uint256 deadline
)
```
- `creatorRiskAndTermsConsent` is **implied true** by the act of signing (the signature IS the
  consent) — documented in the user-facing copy; not a separate bool in the digest.
- The digest binds **all** terms → the matcher/acceptor can never alter them.
- `signer` is bound so the recovered/1271-validated signer must equal it.

## 5. `acceptSignedOffer` control flow (vault-backed)

```
acceptSignedOffer(SignedOffer o, bytes sig, bool acceptorConsent):
  _assertNotSanctioned(msg.sender)                       // Tier-1 gate (LibVaipakam)
  require block.timestamp <= o.deadline                  // signed-offer deadline
  require o.expiresAt == 0 || block.timestamp <= o.expiresAt
  hash = _hashTypedDataV4(o)
  require !signedOfferNonceUsed[o.signer][o.nonce]       // batch-cancel guard
  require SignatureChecker.isValidSignatureNow(o.signer, hash, sig)   // EOA + EIP-1271
  filled = signedOfferFilled[hash]
  remaining = o.amount(Max) - filled; require remaining > dustFloor
  // size this fill (AON => full remaining; partial => min(remaining, counterparty size))
  // materialize: mint offerId, write s.offers[offerId] from o (creator=o.signer), lock signer
  //   vault funds for THIS fill (lien), createdAt=now
  signedOfferFilled[hash] += fillAmount; close (mark nonce / set filled=amount) if AON or dust
  loanId = _acceptMaterializedOffer(offerId, msg.sender, acceptorConsent)  // existing plumbing
  emit SignedOfferFilled(hash, o.signer, msg.sender, offerId, loanId, fillAmount)
```

Wallet-backed `acceptSignedOfferWithPermit` is identical except the materialize step pulls the
signer's wallet ERC-20 via `permitWitnessTransferFrom(... witness=hash ...)` instead of moving
vault funds, and `fillMode` MUST be AON (revert otherwise).

**Sanctions:** both the acceptor (`msg.sender`, Tier-1 at entry) and the materialized creator
(`o.signer`) are screened on the same paths `createOffer`/`acceptOffer` screen today — the
materialize + reuse approach inherits those gates for free.

## 6. Invariants to preserve
- **E1:** funds stay in the signer's own vault (vault-backed) or wallet (wallet-backed) until the
  fill instant; the materialized offer locks them into the signer's *own* vault exactly as
  `createOffer` does. No pooled custody.
- **E2:** the signed rate is in the digest; the materialized offer + `initiateLoan` snapshot it
  immutably. (If a rate model is later used, the concrete rate is bound at sign-time — #400.)
- **Solvency:** vault-backed verifies the signer's vault balance covers `fillAmount` at accept and
  reverts otherwise; wallet-backed reverts in Permit2 if the wallet is under-funded — a counterparty
  can never fill an insolvent offer.
- **No double-fill / replay:** `signedOfferFilled[hash]` monotonic; AON closes on first fill;
  cancel sets it to `amount`; expired/`deadline`-passed offers revert; `chainId` + diamond address
  in the domain bind the signature to this deployment.

## 7. Tests (`test/SignedOfferBook.t.sol`)
1. Vault-backed AON lender offer → borrower accepts → loan initiated, terms match the digest.
2. Vault-backed partial-fillable offer → two partial accepts → remaining decrements → closes at
   dust; each fill a distinct loan.
3. Wallet-backed AON via Permit2 witness → pulls wallet funds → loan; partial wallet-backed reverts.
4. EIP-1271: a smart-contract wallet (a vault) signs → `isValidSignatureNow` accepts.
5. Replay: re-submitting a filled AON offer reverts; double-fill beyond remaining reverts.
6. Cancel: `cancelSignedOffer` then accept reverts; `invalidateNonce` batch-cancels.
7. Expiry: past `deadline` and past `expiresAt` both revert.
8. Wrong-chain / wrong-verifyingContract signature reverts (domain binding).
9. Tampered terms (any digest field changed post-sign) → signature recovery fails → revert.
10. Sanctions: sanctioned `msg.sender` reverts (Tier-1); sanctioned `signer` reverts at materialize.
11. Range + midpoint: a ranged signed offer materializes with range fields intact; a subsequent
    on-chain match against it works (regression that materialize preserves range semantics).

## 8. Facet-addition checklist (from the scout — 9 sites)
`DiamondFacetNames.cutFacetNames` · `SelectorCoverageTest._populateRoutedSet` +
`_getSignedOfferFacetSelectors` · `FacetSizeLimitTest` (auto) · `DeployDiamondIntegrationTest`
(auto) · `DeployDiamond.s.sol` (import + deploy + cut + `_getSignedOfferFacetSelectors`) ·
`SetupTest` · `HelperTest` · `exportFrontendAbis.sh FACETS` · `packages/contracts/src/abis/index.ts`.
Re-export ABIs (new facet + new errors/events) and run the consumer typechecks.

## 9. EIP-170 watch
`SignedOfferFacet` is self-contained (verify + materialize + 2 entry points). The materialize
logic should call a shared internal `_writeOffer*` helper rather than duplicate `OfferCreateFacet`'s
body — if inlining pushes the facet near 24,576 B, factor the materialize into a `LibSignedOffer`
library (the `VPFIDiscountAccumulatorFacet` precedent). Measure with `forge build` before the cut.
