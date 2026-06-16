# v0.6 — Keeper-matcher for signed offers (partial fills) — implementation design

**Stage 4, phase v0.6** of the #401 hybrid-intent program (after v0.5 #615; see
[`HybridIntentLayer.md`](HybridIntentLayer.md) + [`SignedOfferBookV05Design.md`](SignedOfferBookV05Design.md)).
**Goal:** let a keeper/solver fill a **signed off-chain offer** by matching it against an
**existing on-chain counterparty offer**, including **partial fills** — earning the 1% LIF
matcher kickback. v0.5 built the `signedOfferFilled[orderHash]` ledger forward-compatibly for
exactly this.

This is the partial-fill capability v0.5 deferred. It is fund-moving and intricate (interacts
with the partial-fill match machinery + matcher attribution) — treat like v0.5: incremental,
targeted-tested, Codex-reviewed.

---

## 1. Scope (v0.6)

**In:**
- `OfferMatchFacet.matchSignedOffer(SignedOffer o, bytes sig, uint256 counterpartyOfferId,
  uint256 fillAmount)` — a keeper matches a **vault-backed** signed offer against an on-chain
  counterparty offer; `fillAmount` is the slice this match fills (≤ the signed offer's remaining).
  Full or partial. The keeper (`msg.sender`) earns the LIF.
- Off-chain partial-fill accounting via `signedOfferFilled[orderHash]` (decrement per slice; close
  at the dust floor / when remaining hits 0).
- `LibSignedOffer.toCreateOfferParams(o)` — the `SignedOffer → CreateOfferParams` mapping moved
  from `SignedOfferFacet` into the library so both the fill facet and the matcher reuse it.

**Out (deferred):**
- **Wallet-backed partial matching** — a wallet-backed signed offer's single Permit2 witness
  signature authorizes ONE pull, so it stays **AON-only** (v0.5). The matcher fills wallet-backed
  offers only in full (one slice == the whole offer), if at all; recommend vault-backed-only for
  the matcher in v0.6 and revisit wallet-backed-full-match as a follow-up.
- **Signed × signed** matching (both sides off-chain) — v0.6 is signed × on-chain only.
- Refinance-tagged signed offers (already rejected by the v0.5 shape guard + the matchOffers
  refinance-tagged guard).

## 2. The core mechanic — materialize the SLICE, not the offer

`matchOffers`' partial-fill machinery (`amountFilled` decrement, dust-close, offer-principal lien
draw-down) operates on a **persistent** on-chain offer. A signed offer must stay **off-chain**
between fills — so we must NOT materialize the full offer and let matchOffers partially fill it
(that would leave a dangling, partially-filled on-chain offer after the call).

Instead, each `matchSignedOffer` call **materializes exactly the slice it fills** — an on-chain
offer of size `fillAmount`, single-value (so it is fully consumed by this one match, no dangling
remainder) — matches it in full against the counterparty, and records the slice against the
**off-chain** ledger:

```
matchSignedOffer(o, sig, counterpartyOfferId, fillAmount):
  _assertNotSanctioned(msg.sender)                       // matcher (LIF recipient) — like matchOffers
  require partialFillEnabled                              // same master kill-switch as matchOffers
  orderHash = LibSignedOffer.hashStruct(o)
  vet(o): deadline / expiresAt / nonceUsed / not-cancelled (signedOfferFilled[orderHash] < ceiling)
  require sig verifies (LibSignedOffer.verify) — vault-backed only in v0.6 (wallet = AON, full only)
  remaining = ceiling(o) - signedOfferFilled[orderHash]
  require 0 < fillAmount <= remaining
  require fillAmount >= dust floor  (and remaining - fillAmount == 0 || remaining - fillAmount >= dust)
  // materialize the slice as a single-value on-chain offer (creator = o.signer), funded
  // vault-backed (free-balance assert + lien) — reuse OfferCreateFacet.createSignedOfferVault with
  // slice params (amount = amountMax = fillAmount-derived; collateral scaled pro-rata).
  sliceOfferId = createSignedOfferVault(o.signer, LibSignedOffer.toCreateOfferParams(o, fillAmount))
  signedOfferFilled[orderHash] += fillAmount            // CEI: record BEFORE the match's external calls
  // run the match: materialized slice (one side) × counterpartyOfferId (other side), matcher = msg.sender
  loanId = _executeMatch(lenderId, borrowerId)          // see §3
  emit SignedOfferMatched(orderHash, o.signer, msg.sender /*matcher*/, sliceOfferId, counterpartyOfferId, loanId, fillAmount)
```

The slice is single-value (`amount == amountMax`), so matchOffers' partial-fill/dust-close logic
sees a full consume — no dangling on-chain offer, and no double-counting against the ledger. The
**off-chain** signed offer is what gets partially filled, tracked solely by `signedOfferFilled`.

## 3. Matcher attribution — reuse `matchOverride`, NOT the v0.5 acceptor injection

In the match path `matchOverride.active == true`, so `_acceptOffer` resolves both the **acceptor**
(`matchOverride.counterparty`) and the **matcher** (`matchOverride.matcher`) from the override —
NOT from `msg.sender` and NOT from the v0.5 `signedOfferAcceptor` injection. So `matchSignedOffer`
must run the match with `matchOverride.matcher = msg.sender` (the keeper), exactly as `matchOffers`
does. **`matchSignedOffer` therefore lives in `OfferMatchFacet`** and runs the match core with
`msg.sender` = the keeper preserved (no cross-facet hop for the match itself; the only cross-facet
call is the slice materialize, where `creator` is passed explicitly).

**`_executeMatch` (the §274–352 core of matchOffers, factored):** the cleanest, lowest-risk way to
avoid duplicating the ~80-line execution core is to extract matchOffers' execution body
(previewMatch → set `matchOverride{counterparty, matcher: msg.sender, amount/rate/collateral}` →
decrement lender offer-principal lien → `acceptOfferInternal(borrowerOfferId)` → decrement borrower
lien → clear override → refunds) into an internal `_executeMatch(lenderOfferId, borrowerOfferId)`
that BOTH `matchOffers` and `matchSignedOffer` call. This is a **no-behaviour-change refactor** of
matchOffers verified by the existing matcher tests, then reused. The slice is single-value so the
dust-close/partial-remainder branches are no-ops for it (it fully consumes).

> If factoring the core proves too invasive in one PR, the fallback is a contained replication of
> just the override+acceptOfferInternal+lien lines for the slice case (smaller than matchOffers
> because no partial-remainder/dust-close on the AON slice) — but the factor is preferred (DRY,
> single audited core).

## 4. Slice sizing + collateral (the careful part)

- **Lender signed offer × on-chain borrower offer:** the slice is a lender offer of principal
  `fillAmount`. The borrower offer provides collateral; `LibOfferMatch.previewMatch` computes the
  midpoint amount/rate + required collateral for the (slice, borrower) pair exactly as for two
  on-chain offers. `fillAmount` must lie within the borrower offer's matchable amount band.
- **Borrower signed offer × on-chain lender offer:** the slice is a borrower offer pledging
  collateral pro-rata to `fillAmount`; vault-backed free-balance assert covers the sliced
  collateral. The on-chain lender offer is the injected side.
- `toCreateOfferParams(o, fillAmount)` derives the slice's single-value `amount`/`collateralAmount`
  by scaling the signed offer's terms to the slice (principal = fillAmount; collateral = pro-rata
  of the signed offer's collateral band). Range bounds collapse to the slice (single-value).
- **Rounding / dust:** ensure the slice + the post-fill remainder both clear the dust floor (no
  un-fillable dust stranded off-chain), mirroring matchOffers' dust-close guard.

## 5. Invariants
- **E1:** the slice's funds come from the signer's own vault free balance (vault-backed assert +
  lien); no pooled custody. The off-chain remainder is never on-chain custody.
- **E2:** the materialized slice snapshots the midpoint rate immutably at init, like any match.
- **Replay / no over-fill:** `signedOfferFilled[orderHash]` is monotonic and bounded by the
  ceiling; `fillAmount <= remaining` enforced; cancel/nonce-burn (v0.5) still block. CEI: record
  the slice in the ledger BEFORE `_executeMatch`'s external calls.
- **Matcher attribution:** LIF + `loan.matcher` = `matchOverride.matcher` = the keeper, never the
  diamond (the v0.5 P1 lesson — here it's correct by construction via matchOverride).

## 6. Tests (`test/SignedOfferMatcher.t.sol`)
1. Full match: keeper matches a vault-backed signed lender offer against an on-chain borrower
   offer → loan; `loan.matcher == keeper`; LIF paid to keeper; `signedOfferFilled == ceiling`.
2. Partial then partial then close: two slices of one signed offer → two loans; remaining
   decrements; third slice for the residual closes it; over-fill (fillAmount > remaining) reverts.
3. Borrower signed offer × on-chain lender offer (the mirror direction).
4. Dust guard: a slice leaving sub-dust remainder reverts (or forces full).
5. Cancelled / nonce-burned signed offer can't be matched.
6. matchOffers regression: the factored `_executeMatch` leaves existing matcher behaviour
   byte-identical (run the existing matcher tests).
7. partialFillEnabled kill-switch gates matchSignedOffer too.

## 7. Wiring + sequencing
- `matchSignedOffer` is a NEW selector on the EXISTING `OfferMatchFacet` (add to its selector lists
  in SelectorCoverage / DeployDiamond / HelperTest; re-export ABIs). `LibSignedOffer.toCreateOffer
  Params` is a library move (no new facet). Watch `OfferMatchFacet` EIP-170 headroom — if tight,
  the slice-params build / `_executeMatch` factoring can live in a `LibSignedOfferMatch` library.
- Build order: (1) move `_paramsFromSigned` → `LibSignedOffer.toCreateOfferParams` (refactor,
  v0.5 tests stay green) → (2) factor `matchOffers` core into `_executeMatch` (refactor, matcher
  tests stay green) → (3) `matchSignedOffer` + slice sizing + ledger → (4) tests → (5) ABIs + PR +
  Codex. Local: quick build + targeted tests only; cifast/regression on CI / pre-testnet.
