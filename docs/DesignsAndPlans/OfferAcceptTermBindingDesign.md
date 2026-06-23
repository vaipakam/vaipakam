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

### 4a. `ExpectedTerms` integrity guard (primary — covers liquid + illiquid)

A new calldata struct the acceptor binds to; `_acceptOffer`
([`:517`](../../contracts/src/facets/OfferAcceptFacet.sol#L517), the single
chokepoint both public entry points funnel through) reverts
`OfferTermsMismatch` if any field diverges from the stored `Offer`:

**`ExpectedTerms` binds EVERY loan-affecting offer field** (Codex round-1 P1 —
omitting any field that is snapshotted into the loan or changes the acceptor's
obligations reopens the vector with a partial swap):

```solidity
struct ExpectedTerms {
    address lendingAsset;
    address collateralAsset;
    uint256 amount;             // EQUALITY vs the offer endpoint used on direct accept
    uint256 collateralAmount;   // EQUALITY
    uint256 interestRateBps;    // EQUALITY (exact) — protects BOTH sides; see below
    uint256 durationDays;
    // Asset discriminators — NFT/1155 identity AND units:
    uint256 tokenId;
    uint256 collateralTokenId;
    uint256 quantity;           // 1155 units lent
    uint256 collateralQuantity; // 1155 units locked
    LibVaipakam.AssetType assetType;
    LibVaipakam.AssetType collateralAssetType;
    address prepayAsset;        // NFT-rental fee asset
    // Obligation-shaping flags snapshotted into the loan:
    bool useFullTermInterest;
    bool allowsPartialRepay;
    LibVaipakam.PeriodicInterestCadence periodicInterestCadence;
}
```

- This is **not a consent** — it's an assertion the on-chain offer equals what
  the acceptor was shown. Closes Scenarios A & B for **all** offer types,
  because the victim's wallet now signs calldata that *contains the real terms*
  and the contract enforces the match in `acceptOfferInternal` before any value
  moves.
- **Direct accept binds by EQUALITY against the offer endpoints, not a slice**
  (Codex round-1 P1 — corrected). Confirmed in code: direct accept consumes the
  offer's endpoint values (`offer.amount`, `offer.interestRateBps`, …); only the
  **keeper matcher** consumes an in-band slice, and it does so via the per-tx
  `matchOverride` slot ([`LoanFacet.sol:759-762`](../../contracts/src/facets/LoanFacet.sol#L759)),
  not through `acceptOffer`. So for the acceptor-facing paths there is no slice —
  every `ExpectedTerms` field is an exact equality check against the stored
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
  `acceptOfferInternal` still requires it `true`.
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

### 4c. EIP-712 / wallet rendering (honest scope)

- **Direct accept** (acceptor = `msg.sender`): there is no off-chain signature,
  so EIP-712 *typed-data* does not apply. The anti-phishing protection is the
  `ExpectedTerms` struct **in the transaction calldata**, which the wallet
  decodes field-by-field — the victim sees the real terms. Defining an
  `AcceptTerms` typehash with no verifying entry point would **not** make a
  direct accept "EIP-712 typed" (Codex round-1 P1) — so we do not claim that.
- **Signed-offer fill path** ([`SignedOfferFacet.acceptSignedOffer*`](../../contracts/src/facets/SignedOfferFacet.sol#L79)):
  this path already involves EIP-712 (the creator's signed offer). The
  `ExpectedTerms` binding is threaded through it the same way (see §5) so the
  fill is bound to terms; the existing signed-offer digest is where typed
  rendering already happens.
- **Relayed/gasless signed *accept*** does not exist today (no `acceptOfferBySig`).
  Recommendation: **defer** it (no product demand) and drop the "EIP-712 typed
  acceptance" acceptance-criterion in favour of "the acceptor's expected terms
  are bound on-chain and wallet-visible." **Open question O1.**

### 4d. Creator-side symmetry (lower priority)

`creatorRiskAndTermsConsent` is set by the creator on *their own* offer, so the
phishing vector is acceptor-side. For symmetry, `createOffer` can bind the
creator consent to the created terms too, but this is **not** required to close
#662 and can be a follow-up. **Open question O2.**

## 5. Surface delta (reuse posture)

- **Reused as-is:** `OracleFacet.checkLiquidity` for per-leg liquidity;
  `Loan.riskAndTermsConsentFromBoth` storage; the single-consent UX.
- **The true chokepoint is `acceptOfferInternal`**
  ([`OfferAcceptFacet.sol:284`](../../contracts/src/facets/OfferAcceptFacet.sol#L284)),
  through which **all** accept paths route — `acceptOffer`,
  `acceptOfferWithPermit`, `SignedOfferFacet.acceptSignedOffer` /
  `acceptSignedOfferWithPermit` (Codex round-1 P1 — the signed path was missed
  in the first draft), and the keeper `OfferMatchFacet`. The `ExpectedTerms`
  guard + acknowledged-asset binding live in `acceptOfferInternal`; each public
  entry threads the new params in.
- **Modified (additive):** `acceptOffer` / `acceptOfferWithPermit` /
  `acceptSignedOffer*` signatures (+`ExpectedTerms`, +acknowledged-asset params;
  the single `riskAndTermsConsent` bool is **kept**); `acceptOfferInternal`
  (guard + bind); `_maybeRunInitialRiskGates` (asset-match in addition to the
  bool).
- **New:** `struct ExpectedTerms`; errors `OfferTermsMismatch`,
  `IlliquidAssetNotAcknowledged`.
- **Match path — bound by construction, not exempt:** the keeper matcher routes
  through the same `acceptOfferInternal`. Because the matcher is not a phished
  victim and the creators' offers are self-authored, the matcher passes an
  `ExpectedTerms` derived from the offers it is matching (or a sentinel that the
  guard treats as "matcher-internal"); **Open question O4** — confirm whether
  the matcher supplies real expected terms or is explicitly exempted at the
  `acceptOfferInternal` boundary (keeper-only modifier already gates it).

## 6. ABI / consumer / spec impact

- **ABI re-export + deploy-sanity:** `acceptOffer`/`acceptOfferWithPermit`
  selectors change → `exportFrontendAbis.sh`, `DeployDiamond` selector lists,
  `SelectorCoverageTest`, `HelperTest`.
- **Frontend:** `OfferBook` accept call + `AcceptReviewModal`
  ([`apps/defi/src/pages/OfferBook.tsx`](../../apps/defi/src/pages/OfferBook.tsx))
  pass `ExpectedTerms` (the modal already shows these exact terms) + the
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
- Happy path: correct `ExpectedTerms` + correct acknowledged asset → loan
  initiates; `riskAndTermsConsentFromBoth == true`.
- Per-field mismatch (every `ExpectedTerms` field, incl. `quantity` /
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

Still open:
- **O1 — EIP-712 typed *acceptance*:** recommend **dropping** the "EIP-712 typed
  acceptance" criterion for the direct path (the calldata `ExpectedTerms` struct
  is the wallet-visible binding) and **deferring** any relayed/gasless
  `acceptOfferBySig` until there's product demand. Confirm?
- **O2 — creator-side term binding:** fold `createOffer` creator-consent→terms
  binding into this PR, or follow-up? (Acceptor-side is the live vector.)
- **O4 — match path at the `acceptOfferInternal` boundary:** matcher supplies
  real `ExpectedTerms` derived from the matched offers, **or** an explicit
  keeper-only exemption (the matcher is gated keeper-only and not a phished
  victim)? Recommend the explicit exemption — simpler, and the matcher's inputs
  are the creators' self-authored offers.

## 9. Relationship to #671

#671 (progressive risk tiers) layers **on top** of this: #662 binds terms so a
clone can't swap them within a tier the user trusts; #671 adds the structural
floor (default blue-chip-only, user opt-in to broader/illiquid). #662 first
(broader — also covers liquid term-swaps), per the #671 card.
