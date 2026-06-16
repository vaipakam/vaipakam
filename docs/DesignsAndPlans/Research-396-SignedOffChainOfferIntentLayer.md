# Research findings — #396: EIP-712 signed off-chain offers + on-chain accept (intent substrate)

**Card:** #396 (master sweep #401, Cluster A). **Status:** findings + verdict.
**Verdict:** **ADOPT — this is the foundation of the whole liquidity cluster.** Build a
gasless EIP-712 signed-offer book with on-chain nonce cancellation and pull-at-accept
solvency, additive to (not replacing) the existing on-chain offer path.

> No third-party product names per the sweep rule.

---

## 1. Why this is the substrate

#393 (allocator/intent routing) and #399 (backstop) both *fill against a book*. Today the
book is shallow because **every offer is a full on-chain transaction** (`OfferCreateFacet
.createOffer`), so posting costs gas and the order book can never be deep. Making offer
*creation* gasless — sign off-chain, settle on-chain — is the single highest-leverage change
for the unmatched-offer problem, and it is the layer everything else routes against. Hence:
build this first.

## 2. What we have today

- On-chain offer creation: `OfferCreateFacet.createOffer` (≈:364) — mints + pulls assets into
  the creator's vault.
- **A signature-transfer pull already exists** but only authorizes the **token transfer**, not
  the offer intent: `createOfferWithPermit` (≈:429) uses an EIP-712 signature-transfer to pull
  the creator's ERC20. The offer terms (`CreateOfferParams`) are still on-chain data + a
  mandatory `creatorRiskAndTermsConsent` bool.
- Accept path: `OfferAcceptFacet.acceptOffer` (≈:242) → `LoanFacet.initiateLoan` (≈:170), rate
  snapshotted immutably.
- Per-user vaults: `VaultFactoryFacet.getOrCreateUserVault` (≈:197) — funds in the creator's
  own vault, Diamond-moved only.

**The reuse opportunity (card's Q4):** extend the *existing* signature-transfer integration so
**one signature authorizes both the token transfer AND the offer terms** — the order becomes
the EIP-712 *witness* on the transfer. We already pull via signature-transfer; we add the
offer digest as the witness. This is a small, well-precedented extension, not a new mechanism.

## 3. External precedent (generic descriptors)

Signed-offer P2P lending venues converge on a uniform triad:

1. **EIP-712 signed offers as the book.** Lender or borrower signs loan terms off-chain (free);
   the offer is "valid on-chain until it expires." A `side` enum (lend / borrow) lets either
   party be the signer.
2. **Cancellation = on-chain nonce / order-hash invalidation** (a gas tx, secure) with a free
   off-chain delete as UX sugar ("removes from the book now, but stays valid on-chain until
   expiry" — explicitly flagged "less secure"). A per-signer nonce / order-hash map gates
   validity; using or cancelling a nonce kills the order and prevents replay.
3. **Pull-at-accept solvency, no pre-escrow.** Funds stay in the signer's own wallet/vault;
   origination does `transferFrom` against a standing allowance and **the whole tx reverts if
   the signer is under-funded** — a counterparty can never accept an insolvent offer. One venue
   adds "under-funded offer stays hidden, auto-promotes to active when the wallet is funded."

Intent/solver swap systems add the on-chain settlement discipline: the contract's only job is
**validate signature → pull via signature-transfer (order as witness) → enforce every signed
constraint → revert otherwise.**

**AVOID:** perpetual/no-expiry/no-oracle + rate-auction-unwind models (break fixed term + HF);
uniform-clearing-price batch settlement (re-commingles, breaks per-loan fixed rate).

## 4. Recommended design

A new **signed-offer accept path** that coexists with the on-chain `Offer` path:

- **Schema:** EIP-712 typed `SignedOffer` carrying the full economic terms (offerType/side,
  lendingAsset, amount + range, rate + range, collateralAsset/amount + range, durationDays,
  fillMode, expiresAt, periodicCadence, `useFullTermInterest`, `allowsPartialRepay`, the
  consent flag) + `signer`, `nonce`, `deadline`. The digest binds **all** terms so the matcher
  can never alter them.
- **Acceptance:** `acceptSignedOffer(SignedOffer, signature, acceptorConsent)` — verify EIP-712
  signature (EOA + EIP-1271 for smart-wallet/aggregator signers), check nonce live + not
  expired, pull the signer's principal/collateral **into the existing accept→initiateLoan flow**,
  snapshot rate immutably.
- **Single-use signature vs partial fills (design-critical).** A signature-transfer
  authorization (Permit2 `SignatureTransfer` shape) is **single-use** — one signature authorizes
  exactly **one** pull of one amount. So "one signature binds transfer + terms" holds for a
  **full** (AON) fill, but a **partial-fillable** signed offer that is matched incrementally
  CANNOT be served by a single signature-transfer. Partial fills need one of: (a) a **vault-backed
  offer** (no per-fill signature — the Diamond moves vault funds internally, gated by the
  signed-offer nonce/remaining accounting), which is the recommended default for partial-fillable
  signed offers; or (b) an **allowance-based** pull (standing ERC-20 approval to the Diamond, the
  signature binding only the terms + a per-offer fill ledger); or (c) a **per-fill signature**
  scheme (a nonce-bitmap the signer tops up). Pick (a) for the common case; the wallet-backed
  single-signature path is **AON-only**.
- **Cancellation + fill-tracking:** `cancelSignedOffer(nonce)` / `incrementNonce()` on an on-chain
  nonce registry; free off-chain delete handled by the indexer/agent book. **⚠️ A boolean
  `signedOfferNonceUsed[signer][nonce]` is sufficient only for AON offers.** A partial-fillable
  signed offer needs a **per-offer-hash remaining-amount ledger** (`signedOfferFilled[offerHash]`
  → cumulative filled), NOT a one-shot used-flag — each partial fill decrements the remaining and
  the offer closes when remaining hits the dust floor (mirroring the existing on-chain
  `Offer.amountFilled` semantics). Cancellation then sets remaining to 0. So: boolean nonce-used
  for AON; remaining-amount ledger keyed by order-hash for partial-fillable.
- **Solvency:** pull-at-accept with revert-on-insolvency (already how our vault moves work);
  add the indexer-side "under-funded → hidden, auto-promote when funded" filter so the book
  surfaced to UIs is always fillable.
- **Range + matcher (needs a signed-offer-aware entry).** Today `OfferMatchFacet.matchOffers`
  reads two **on-chain** `s.offers` records by id; a signed off-chain offer is **not** in
  `s.offers`, so `matchOffers` cannot fill it verbatim. The fix is a **signed-offer-aware match
  entry** (`matchSignedOffer(signedOffer, sig, counterpartyOfferId)` / pairwise signed-vs-signed)
  that verifies the signature, **materializes** the offer just-in-time, then **reuses the existing
  `LibOfferMatch` midpoint logic + 1% LIF kickback** — the matching *math* is reused, the *entry
  point* is new. Settlement stays bilateral, per-offer (NOT batch-cleared). An on-chain offer can
  still be matched against a signed offer through this entry.

**Ethos:** E1 — funds stay in the signer's own vault/wallet until the origination instant; no
pooled custody. E2 — the signed rate is bound in the digest and snapshotted at init; immutable
for life. E3 — thread `useFullTermInterest` through accept-time settlement once #408's default
is decided.

## 5. Open questions to settle at design time

1. **Vault-funded vs wallet-funded signed offers.** Our principal normally sits in the user's
   *vault*, not their wallet. Decide: does a signed offer authorize a pull from the vault
   (Diamond-internal, no allowance needed) or from the wallet (signature-transfer)? Likely
   **both modes**: vault-backed (instant, already custodied) and wallet-backed (signature-
   transfer at accept). Vault-backed offers are trivially solvency-checkable on-chain.
2. **EIP-1271 for aggregator signers** — required so a contract (an aggregator's LenderIntent
   adapter, #398) can sign offers. Design the 1271 path from day one.
3. **Nonce model** — per-signer incrementing nonce vs. per-order-hash bitmap (the latter allows
   out-of-order cancellation of specific offers; preferred for a deep book).
4. **Replay/expiry/chainId** — bind `chainId` + verifying-contract into the domain separator;
   `deadline` hard-stop.

## 6. Spin-off implementation issue

**Signed-offer book v1:** EIP-712 `SignedOffer` schema + domain separator + on-chain nonce/
order-hash registry + `acceptSignedOffer` (EOA + EIP-1271) + `cancelSignedOffer` +
vault-backed and wallet-backed solvency modes + indexer book + under-funded auto-promote.
Reuses `OfferAcceptFacet`/`LoanFacet`/`OfferMatchFacet` unchanged downstream. This is item #1
of #393's spin-off list and the dependency root for the entire cluster.

## 7. Sources

Official docs/repos of the signed-offer P2P lending venues and the intent/solver swap systems
(URLs in working notes; omitted here per the deliverable rule).
