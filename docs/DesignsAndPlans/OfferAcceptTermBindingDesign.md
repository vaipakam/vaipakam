# #662 — Bind `acceptOffer` to terms (anti-phishing, permissionless-preserving)

**Status:** Design — for Codex review. **Issue:** #662 (epic #670). **Sequenced
before** #671 (progressive risk tiers layer on top of this).

## 1. Problem

`acceptOffer(uint256 offerId, bool acceptorRiskAndTermsConsent)`
([`OfferAcceptFacet.sol:242`](../../contracts/src/facets/OfferAcceptFacet.sol#L242))
binds the acceptor's wallet signature to an **opaque offer id + a hardcodable
bool** — never to the economic terms the acceptor believes they're agreeing to.
A phishing clone (not our frontend — the contract is the only trust boundary)
can have a victim sign a valid `acceptOffer(maliciousId, true)` whose wallet
prompt reveals nothing human-readable.

The damage requires the illiquid LTV/HF bypass to fire — confirmed at
[`LoanFacet._maybeRunInitialRiskGates:474-487`](../../contracts/src/facets/LoanFacet.sol#L474):

```solidity
bool mutualIlliquidConsent = ctx.acceptorRiskAndTermsConsent && offer.creatorRiskAndTermsConsent;
if (!bothLiquid && mutualIlliquidConsent) return;   // skips _checkInitialLtvAndHf
```

The bypass is *intended* for illiquid assets (no oracle → no HF math). The bug
is that "consent" is an **unbound boolean**: a clone hardcodes `true`.

- **Scenario A** — attacker posts a worthless oracle-less token as collateral,
  requests real principal, `creatorRiskAndTermsConsent=true`; victim "accepts"
  as lender → real principal leaves, backed by a $0 token.
- **Scenario B** — mirror: worthless principal, valuable collateral requested;
  victim's collateral locks, reclaim needs repaying junk → default → full
  illiquid-collateral transfer to attacker.

With **liquid** assets the HF≥1.5 / LTV gate already blocks this; the vector is
specific to the illiquid + blanket-consent path.

## 2. What the FunctionalSpec already mandates (scout)

From [`docs/FunctionalSpecs/ProjectDetailsREADME.md`](../FunctionalSpecs/ProjectDetailsREADME.md):

- **§233 / §675** — a **single** combined mandatory Risk-Disclosures-and-Terms
  acknowledgement gates both create and accept; it may be stored as one
  *combined accepted-by-both-parties* consent state on the loan (not two
  per-party fields).
- **§241 / §250** — the illiquid path uses that **same single consent**, with
  **no second toggle and no second acknowledgement**. §676 allows an extra
  *informational* illiquid warning but explicitly forbids a second required
  consent.
- **§234** — on offer create/accept the contract performs an on-chain liquidity
  verification; **on-chain determination overrides the frontend**.
- **§282-288** — offers can already be created via an **EIP-712 signature**
  (signed-offer book, #396); that signature *is* the creator's risk-and-terms
  consent. Reusable EIP-712 machinery lives in
  [`LibSignedOffer.sol`](../../contracts/src/libraries/LibSignedOffer.sol)
  (`domainSeparator()`, `hashStruct()`, `digest()`, `verify()` with ERC-1271).

**Load-bearing constraint this places on the design:** the fix must **not**
introduce a second consent / second checkbox (that contradicts §250/§676). It
must instead (a) add an *on-chain integrity guard* that is not a "consent" at
all, and (b) make the *existing single consent* carry the specific terms/asset
it commits to, so a clone cannot hardcode it — while the user still sees exactly
one acknowledgement.

## 3. Design principles

- **Permissionless — no asset allowlist.** The fix is signature/term binding,
  never a curated token set (§ out-of-scope in #662; consistent with
  [[no-asset-gating decision]]).
- **Pre-live — replace signatures, don't overload.** No deployed callers, so we
  change the `acceptOffer` / `acceptOfferWithPermit` signatures directly (ABI
  break is a fresh-redeploy, not a migration). Cleaner than carrying a
  legacy bool overload.
- **Single-consent UX preserved.** Exactly one acknowledgement at the
  frontend (§233). The new on-chain inputs (expected terms + acknowledged
  illiquid asset identity) are values the frontend already has — passed as
  calldata, not surfaced as extra checkboxes.

## 4. Design

### 4a. `AcceptTerms` integrity guard (primary — covers liquid + illiquid)

The acceptor's EIP-712-signed `AcceptTerms` (§4c) is bound against the stored
`Offer` at `_acceptOffer`
([`:517`](../../contracts/src/facets/OfferAcceptFacet.sol#L517) — the single
chokepoint both `acceptOffer` and `acceptOfferInternal` funnel through), which
reverts `OfferTermsMismatch` if any field diverges from the stored `Offer`. The
signed struct (4c) is what the wallet renders; the guard here is what makes the
rendered prompt binding on execution.

**`AcceptTerms` binds EVERY loan-affecting offer field** (Codex round-1 P1 —
omitting any field that is snapshotted into the loan or changes the acceptor's
obligations reopens the vector with a partial swap):

```solidity
struct AcceptTerms {            // EIP-712-typed (see §4c) — every loan-affecting field
    uint256 offerId;
    LibVaipakam.OfferType offerType;   // borrower-vs-lender side selects which endpoints apply (Codex r2 P1)
    address lendingAsset;
    address collateralAsset;
    uint256 amount;             // EQUALITY vs the offer endpoint used on direct accept
    uint256 collateralAmount;   // EQUALITY
    uint256 interestRateBps;    // EQUALITY (exact) — protects BOTH sides
    uint256 durationDays;
    // Asset discriminators — NFT/1155 identity AND units:
    uint256 tokenId;
    uint256 collateralTokenId;
    uint256 quantity;           // 1155 units lent
    uint256 collateralQuantity; // 1155 units locked
    LibVaipakam.AssetType assetType;
    LibVaipakam.AssetType collateralAssetType;
    address prepayAsset;        // NFT-rental fee asset
    // Obligation-shaping flags snapshotted into the loan / gating accept side effects:
    bool useFullTermInterest;
    bool allowsPartialRepay;
    bool allowsPrepayListing;   // gates postPrepayListing on the loan (Codex r2 P2)
    bool allowsParallelSale;    // keeps a live Seaport listing across accept (Codex r2 P2)
    uint256 refinanceTargetLoanId; // != 0 chains into RefinanceFacet.refinanceLoanFromAccept (Codex r2 P2)
    LibVaipakam.PeriodicInterestCadence periodicInterestCadence;
    // EIP-712 anti-replay:
    uint256 nonce;
    uint256 deadline;
}
```

- This is **not a consent** — it's an assertion the on-chain offer equals what
  the acceptor was shown. Closes Scenarios A & B for **all** offer types,
  because the victim's wallet now signs calldata that *contains the real terms*
  and the contract enforces the match in `_acceptOffer` before any value
  moves.
- **Direct accept binds by EQUALITY against the offer endpoints, not a slice**
  (Codex round-1 P1 — corrected). Confirmed in code: direct accept consumes the
  offer's endpoint values (`offer.amount`, `offer.interestRateBps`, …); only the
  **keeper matcher** consumes an in-band slice, and it does so via the per-tx
  `matchOverride` slot ([`LoanFacet.sol:759-762`](../../contracts/src/facets/LoanFacet.sol#L759)),
  not through `acceptOffer`. So for the acceptor-facing paths there is no slice —
  every `AcceptTerms` field is an exact equality check against the stored
  offer's effective (post-collapse) value.
- **`interestRateBps` is bound by EQUALITY, not a one-sided ceiling** (Codex
  round-1 P1). A `maxInterestRateBps` ceiling only protects a borrower-acceptor
  (against a higher rate); a lender-acceptor needs protection against a *lower*
  rate. Since direct accept uses a determinate endpoint rate, exact equality
  protects both sides and is simplest.
- **Dynamic protocol terms are out of binding scope** (Codex round-1 P2): the
  Loan-Initiation-Fee and VPFI fee-discount are computed from protocol
  config + vault state at settlement, not set by the offer creator, so they are
  **not an acceptor-phishing vector via the offer**. The accept-review modal
  shows them as informational; they are protocol-determined, not bound.

### 4b. Terms/asset-bound single consent (keeps a contract-checked signal)

The single mandatory consent is **kept** (Codex round-1 P2 — removing it leaves
no contract-verifiable signal the acknowledgement was given on all-liquid
accepts, and §233 requires recording consent). It is made *sufficient-proof*
rather than *blindly-trusted*:

- The acceptor still passes the single `riskAndTermsConsent` bool (the §233/§250
  one acknowledgement, recorded on the loan as
  `Loan.riskAndTermsConsentFromBoth`, [`LibVaipakam.sol:1574`](../../contracts/src/libraries/LibVaipakam.sol#L1574)).
  `_acceptOffer` still requires it `true`.
- **The illiquid LTV/HF bypass additionally requires a named illiquid asset.**
  The acceptor supplies `acknowledgedIlliquidLendingAsset` /
  `acknowledgedIlliquidCollateralAsset` (zero where the leg is liquid).
  `_maybeRunInitialRiskGates` ([`LoanFacet.sol:474`](../../contracts/src/facets/LoanFacet.sol#L474))
  treats the bypass as authorised **only** when, for each leg the on-chain check
  classifies **Illiquid**, the acknowledged asset == the actual asset (else
  `IlliquidAssetNotAcknowledged`). A clone hardcoding `riskAndTermsConsent=true`
  cannot also name the exact illiquid asset it is hiding, so the bypass stays
  shut.
- Still **one consent** at the UI (§250/§676 preserved): the frontend already
  knows which legs are illiquid; it passes those identities alongside the single
  acknowledgement the user ticks. No second checkbox.

### 4c. EIP-712 typed acceptance is load-bearing (not deferrable) — Codex r2 P1

Round-1 proposed relying on the wallet decoding the raw `acceptOffer` calldata.
Codex round-2 (L169) correctly showed that is **insufficient**: the contract can
only prove `AcceptTerms == storedOffer`, but a phishing site controls *both* the
malicious offer *and* the struct it fills, so the equality is tautological for
the attacker's own offer. The guard prevents a term-swap *between what the
victim sees and what executes* — but it does nothing if the victim can't read
*what they're signing*. Raw calldata rendering is wallet-dependent and
unreliable.

**Therefore acceptance is EIP-712 typed** (the standard way to guarantee a
trusted, structured, domain-bound terms prompt every major wallet renders
uniformly):

- The acceptor signs an EIP-712 `AcceptTerms` typed message (reusing
  `LibSignedOffer`'s domain/typehash/digest machinery,
  [`LibSignedOffer.sol`](../../contracts/src/libraries/LibSignedOffer.sol)) — the
  wallet shows "Vaipakam — Accept: lend X of A against Y of B, rate r, …", so a
  victim sees the *real* terms (incl. the illiquid collateral) and can refuse.
- The accept entry point verifies the signature (ECDSA + ERC-1271 for smart
  accounts) over the `AcceptTerms` digest, checks `signer == the acceptor`, and
  the same digest's fields are bound against the stored offer (§4a) — so the
  prompt the user approved *is* what executes.
- `nonce` + `deadline` give replay protection + a signing-window bound (mirrors
  the Permit2 / stuck-recovery EIP-712 patterns already in the spec, §623/§1968).
- **Submission:** the acceptor can self-submit (sign + send) or a relayer can
  submit the signed `AcceptTerms` (gasless). Either way the *signing* step is
  the trusted prompt. (Self-submit is the default; relay is a future option, not
  required.)

This makes the calldata-decode fallback unnecessary and satisfies the
acceptance-criterion "EIP-712 typed so wallets render terms" for real.

### 4d. Creator-side symmetry (lower priority)

`creatorRiskAndTermsConsent` is set by the creator on *their own* offer, so the
phishing vector is acceptor-side. For symmetry, `createOffer` can bind the
creator consent to the created terms too, but this is **not** required to close
#662 and can be a follow-up. **Open question O2.**

## 5. Surface delta (reuse posture)

- **Reused as-is:** `OracleFacet.checkLiquidity` for per-leg liquidity;
  `Loan.riskAndTermsConsentFromBoth` storage; the single-consent UX;
  `LibSignedOffer` EIP-712 domain/typehash/digest machinery.
- **The true binding chokepoint is `_acceptOffer`**
  ([`OfferAcceptFacet.sol:517`](../../contracts/src/facets/OfferAcceptFacet.sol#L517))
  — confirmed both the direct `acceptOffer` ([`:242`](../../contracts/src/facets/OfferAcceptFacet.sol#L242))
  and the cross-facet `acceptOfferInternal` ([`:284`](../../contracts/src/facets/OfferAcceptFacet.sol#L284),
  called by `SignedOfferFacet.acceptSignedOffer*` and `OfferMatchFacet`) funnel
  into `_acceptOffer` (Codex r2 P1 — round-1 mis-stated the chokepoint as
  `acceptOfferInternal`). The term-binding + acknowledged-asset check live in
  `_acceptOffer`; the **signature verification** lives at each public entry
  (where `msg.sender`/the signed acceptor is known), threading the verified
  `AcceptTerms` down.
- **Modified (additive):** `acceptOffer` / `acceptOfferWithPermit` /
  `SignedOfferFacet.acceptSignedOffer*` signatures (+ signed `AcceptTerms` +
  signature + acknowledged-asset params; the single `riskAndTermsConsent` bool
  is **kept**); `_acceptOffer` (guard + bind); `_maybeRunInitialRiskGates`
  (asset-match in addition to the bool).
- **New:** `struct AcceptTerms` (EIP-712 typed) + its typehash; errors
  `OfferTermsMismatch`, `IlliquidAssetNotAcknowledged`, `AcceptSignatureInvalid`,
  `AcceptDeadlineExpired`; a per-acceptor nonce mapping.
- **Match path — safe via self-authored offers, NOT a keeper gate** (Codex r2 P2
  — corrected): `matchOffers` / `matchSignedOffer` are **permissionless**
  (gated only on the `partialFillEnabled` master flag, not keeper-only), so the
  exemption cannot rest on "keeper-only." It rests instead on: the matcher pairs
  **two already-authored offers**, each carrying its creator's own consent and
  range bounds; there is no acceptor-victim, and the per-tx `matchOverride`
  slice is already bounded by *both* offers' `[min,max]`. So the matcher path
  does not require an `AcceptTerms` signature; `_acceptOffer` recognises the
  match context (the `matchOverride` slot is set) and skips the
  signature/ack requirement while still honouring both offers' creator consent.
- **ABI / deploy-sanity (Codex r2 P2):** selector changes for `acceptOffer`,
  `acceptOfferWithPermit`, **and** `acceptSignedOffer` / `acceptSignedOfferWithPermit`
  → all four updated in `exportFrontendAbis.sh`, `DeployDiamond` selector lists,
  `SelectorCoverageTest`, `HelperTest`.

## 6. ABI / consumer / spec impact

- **ABI re-export + deploy-sanity:** `acceptOffer`/`acceptOfferWithPermit`
  selectors change → `exportFrontendAbis.sh`, `DeployDiamond` selector lists,
  `SelectorCoverageTest`, `HelperTest`.
- **Frontend:** `OfferBook` accept call + `AcceptReviewModal`
  ([`apps/defi/src/pages/OfferBook.tsx`](../../apps/defi/src/pages/OfferBook.tsx))
  pass `AcceptTerms` (the modal already shows these exact terms) + the
  illiquid-asset identities; the single consent checkbox is unchanged.
- **FunctionalSpec update (same PR as code, per convention):**
  `ProjectDetailsREADME.md` §234 gains an on-chain **expected-terms match**
  step; §233/§241/§250 clarified that the single consent is **bound to the
  specific terms + illiquid asset identity** (still one acknowledgement, no
  second consent). Add test refs (below) to the test inventory.

## 7. Test plan

- Scenario A (dummy illiquid collateral) reverts: forged `true` / wrong
  acknowledged asset → `IlliquidAssetNotAcknowledged`; mismatched terms →
  `OfferTermsMismatch`.
- Scenario B (dummy illiquid principal) symmetric revert.
- Happy path: correct `AcceptTerms` + correct acknowledged asset → loan
  initiates; `riskAndTermsConsentFromBoth == true`.
- Per-field mismatch (every `AcceptTerms` field, incl. `quantity` /
  `collateralQuantity` / `prepayAsset` / asset types / `useFullTermInterest` /
  `allowsPartialRepay` / `periodicInterestCadence`) reverts `OfferTermsMismatch`
  — one case per field so a partial swap can't slip through.
- 1155 same-collection / same-tokenId but wrong-`quantity` offer reverts.
- Lender-acceptor protected against a lower-than-shown rate; borrower-acceptor
  against a higher-than-shown rate (exact `interestRateBps` equality).
- Liquid path unaffected: no acknowledged-asset needed; HF/LTV gate still runs;
  `riskAndTermsConsent` still required + recorded.
- Signed-offer fill path (`acceptSignedOffer*`) enforces the same binding.
- Clone hardcoding the old `true` cannot compile against the new signature
  (pre-live signature replacement).

## 8. Open questions for review (post round-1)

**Resolved by the round-1 revisions** (no longer open): one-sided rate ceiling →
exact `interestRateBps` equality (was O on rates); NFT/1155 discriminators →
full `quantity`/`collateralQuantity`/asset-type binding (was O3); direct-accept
slice → endpoint equality; signed-offer path now threaded; consent signal kept.

**Resolved in round-2** (no longer open): O1 — EIP-712 typed acceptance is now
**adopted as load-bearing** (§4c), not deferred (Codex r2 L169 showed the
calldata-only guard is tautological against an attacker's own offer). O4 — the
match path needs **no** `AcceptTerms`: `_acceptOffer` recognises the
`matchOverride` context and skips the signature/ack requirement; safety rests on
both sides being self-authored offers (not on a keeper gate, which `matchOffers`
does not have).

Still open:
- **O2 — creator-side term binding:** fold `createOffer` creator-consent→terms
  binding into this PR, or follow-up? (Acceptor-side is the live vector;
  recommend follow-up to keep this PR focused.)
- **O5 (new) — relayer support:** ship self-submit-only (acceptor signs + sends)
  now and add gasless relay later, or wire a relayer entry point in this PR?
  (Recommend self-submit-only first.)

## 9. Relationship to #671

#671 (progressive risk tiers) layers **on top** of this: #662 binds terms so a
clone can't swap them within a tier the user trusts; #671 adds the structural
floor (default blue-chip-only, user opt-in to broader/illiquid). #662 first
(broader — also covers liquid term-swaps), per the #671 card.
