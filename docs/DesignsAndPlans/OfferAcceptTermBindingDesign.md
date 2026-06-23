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

```solidity
struct ExpectedTerms {
    address lendingAsset;
    address collateralAsset;
    uint256 amount;            // exact fill for single-value; chosen slice for range
    uint256 collateralAmount;  // chosen slice for range
    uint256 maxInterestRateBps; // acceptor's CEILING — stored rate must be <=
    uint256 durationDays;
    // NFT discriminators (bind to avoid token-id / type swaps):
    uint256 tokenId;
    uint256 collateralTokenId;
}
```

- This is **not a consent** — it's an assertion the on-chain offer equals what
  the acceptor was shown. Closes Scenarios A & B for **all** offer types,
  liquid or illiquid, because the victim's wallet now signs calldata that
  *contains the real terms* and the contract enforces the match.
- **Range offers** (Offer carries `amount`/`amountMax`,
  `interestRateBps`/`interestRateBpsMax`,
  `collateralAmount`/`collateralAmountMax`): the acceptor passes the **chosen
  slice**; the guard checks the slice is within the offer's `[min,max]` bands
  (and `maxInterestRateBps` ceiling) rather than equality. Equality for
  single-value offers is the `min==max` special case.
- `maxInterestRateBps` is a **ceiling** (not equality) so a borrower-acceptor is
  protected against a higher-than-shown rate while still matching within a
  range.

### 4b. Terms/asset-bound single consent (replaces the unbound bool)

The blanket `bool acceptorRiskAndTermsConsent` becomes a binding the contract
can verify, **without** a second UX acknowledgement:

- The acceptor supplies the **illiquid asset identity** they are acknowledging
  (`acknowledgedIlliquidLendingAsset` / `acknowledgedIlliquidCollateralAsset`,
  or zero where the leg is liquid). `_maybeRunInitialRiskGates` treats consent
  as satisfied **only** when, for each leg the on-chain check classifies
  **Illiquid**, the acknowledged asset == the actual asset. A clone that
  hardcodes can no longer satisfy it, because it must name the exact illiquid
  asset (which is the thing the victim is being tricked about).
- Still **one consent** at the UI (§250/§676 preserved): the frontend already
  knows which legs are illiquid and which assets they are; it passes those
  identities alongside the single acknowledgement the user ticks. No second
  checkbox.
- The loan continues to store the **combined** consent state
  (`Loan.riskAndTermsConsentFromBoth`, [`LibVaipakam.sol:1574`](../../contracts/src/libraries/LibVaipakam.sol#L1574))
  per §233 — now derived as "single consent given AND acknowledged-asset
  matched AND terms matched", so a `true` on the loan is meaningful.

### 4c. EIP-712 typed acceptance (wallet rendering)

For a **direct** `acceptOffer` (acceptor = `msg.sender`) the integrity guard
(4a) already puts the real terms in the calldata the wallet decodes. EIP-712
typing adds value specifically for a **relayed / signed** acceptance (none
exists today — confirmed no `acceptOfferBySig`). **Open question O1** (below):
add a relayed signed-accept path now (mirroring `LibSignedOffer`'s domain +
typehash), or rely on the calldata-struct for direct calls and defer the
relayed path. The acceptance-criteria line "EIP-712 typed so wallets render
terms" is satisfiable either way; recommendation: define the `AcceptTerms`
typehash + digest now (cheap, reuses `LibSignedOffer`), wire a relayed path
only if there's product demand.

### 4d. Creator-side symmetry (lower priority)

`creatorRiskAndTermsConsent` is set by the creator on *their own* offer, so the
phishing vector is acceptor-side. For symmetry and defense-in-depth, `createOffer`
can bind the creator consent to the created terms too, but this is **not**
required to close #662 and can be a follow-up. **Open question O2.**

## 5. Surface delta (reuse posture)

- **Reused as-is:** `LibSignedOffer` EIP-712 domain/typehash/digest pattern;
  `OracleFacet.checkLiquidity` for per-leg liquidity; the existing
  `_acceptOffer` chokepoint; `Loan.riskAndTermsConsentFromBoth` storage.
- **Modified (additive):** `acceptOffer` / `acceptOfferWithPermit` signatures
  (+`ExpectedTerms`, + acknowledged-asset params, − blanket bool);
  `_acceptOffer` (guard + bind); `_maybeRunInitialRiskGates`
  ([`LoanFacet.sol:474`](../../contracts/src/facets/LoanFacet.sol#L474))
  (asset-match instead of bare bool).
- **New:** `struct ExpectedTerms`; errors `OfferTermsMismatch`,
  `IlliquidAssetNotAcknowledged`; (optional) `AcceptTerms` EIP-712 typehash.
- **Out of scope this PR:** the keeper-driven match path
  ([`OfferMatchFacet`](../../contracts/src/facets/OfferMatchFacet.sol), consent
  captured at `setLenderIntent`) — the matcher is not a phished victim; the
  creators' signed offers already bind their terms. Documented, not changed.

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
- Range offer: in-band slice accepted; out-of-band amount / above-ceiling rate
  reverts `OfferTermsMismatch`.
- Liquid path unaffected: no acknowledged-asset needed; HF/LTV gate still runs.
- Clone hardcoding the old `true` cannot compile against the new signature
  (pre-live signature replacement).

## 8. Open questions for review

- **O1 — relayed signed-accept path:** define + wire `AcceptTerms` EIP-712 now,
  or define the typehash but defer the relayed entry point? (Recommendation:
  define typehash, defer relayed path unless product wants gasless accept.)
- **O2 — creator-side term binding:** fold into this PR or follow-up?
- **O3 — `ExpectedTerms` shape for NFT/1155 legs:** confirm `tokenId` +
  `collateralTokenId` (+ quantities?) are sufficient discriminators against the
  full `Offer` NFT field set (`quantity`, `collateralQuantity`).
- **O4 — match path:** confirm leaving `OfferMatchFacet` unbound is acceptable
  given matcher≠victim and creator offers are self-signed.

## 9. Relationship to #671

#671 (progressive risk tiers) layers **on top** of this: #662 binds terms so a
clone can't swap them within a tier the user trusts; #671 adds the structural
floor (default blue-chip-only, user opt-in to broader/illiquid). #662 first
(broader — also covers liquid term-swaps), per the #671 card.
