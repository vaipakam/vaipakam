# LenderIntentVault + auto-roll — v1 implementation design (#393 L1 / #401 Stage-4)

**Card:** #393 L1 (the LenderIntentVault layer of the [Hybrid Intent Layer](HybridIntentLayer.md)).
**Builds on:** v0.5 signed-offer book (PR #615) + v0.6 keeper-matcher (PR #616).
**Scope:** ERC-20-on-ERC-20 lending only (NFT-collateral stays pure P2P, per the synthesis).
**Status:** design — **the §1 architectural decision needs maintainer ratification before coding**
(fund-adjacent phase; architecture-iteration norm + HybridIntentLayer §8 checkpoint rule).

---

## 1. The load-bearing decision — lender-of-record stays the USER, not the vault

The [synthesis §3.2](HybridIntentLayer.md) flagged this as "an explicit v1 design item": if the
*vault contract* is the offerer, `loan.lender` can't naively become the vault — claims, keeper-auth,
VPFI discount, and sanctions all key off the lender identity, so they must resolve to the vault's
**beneficial owner**. It offered two options: **(a)** thread a `beneficialOwner` through loan
attribution, or **(b)** mint the lender NFT to the vault and route the vault's claim logic to its
owner.

**A code scout (this session) showed both (a) and (b) are the expensive paths**, and a third is
clearly better:

- `loan.lender` is read at **~30+ sites** — every lender-side vault deposit/withdraw, the VPFI
  discount snapshot + settlement (`LibVPFIDiscount` keys off `loan.lender`'s VPFI balance), the
  KYC check, and every `lenderClaims` record. Option (a) rewrites all of them; option (b) makes the
  vault re-implement claim routing. Both are large, audit-heavy, and error-prone.
- The NFT-holder-gated sites — `claimAsLender` authorization (`LibAuth.requireLenderNftOwner`,
  ClaimFacet:233) and keeper authorization (`LibAuth.requireKeeperFor`) — **already** resolve to
  `ownerOf(loan.lenderTokenId)` at call time, **not** `loan.lender`. They are already correct for a
  transferable lender position.

**Decision (recommended): `loan.lender = the depositing user` (the beneficial owner), and the
LenderIntentVault is NOT a new contract that holds principal as "the lender."** The user's principal
stays in their **existing per-user vault** (`VaultFactoryFacet.getOrCreateUserVault`); v1 adds a
*standing-intent* record + a *permissioned-solver* fill path on top. The vault contract is never the
lender-of-record, so **zero of the 30+ `loan.lender` sites change**, there is **no new
fund-custody contract** (the synthesis's "new per-user vault" custody surface collapses to "reuse
the existing vault"), and the v1 audit surface drops from *moderate-high* to *moderate*.

This is faithful to the synthesis's intent (the lender-of-record is the beneficial owner) — it just
reaches it by **keeping the user as the on-chain lender** rather than introducing a vault-as-lender
indirection. It also means v1 = a thin layer over the already-audited v0.6 `_executeMatch`.

> **Trade-off surfaced (the reason this needs ratification):** the L3 ERC-4626 aggregator (v1.5)
> wants *one vault = one aggregator*, where the "beneficial owner" is the aggregator contract, not an
> EOA. Keeping `loan.lender = the depositing identity` still works there — the aggregator IS a single
> Vaipakam identity (an address that deposits into its own per-user vault and sets a standing intent);
> `loan.lender = aggregator address` and the aggregator's own ERC-4626 share-accounting sits *off to
> the side* (it never needs the Diamond to know about its retail depositors — E1). So the
> user-as-lender model composes with v1.5 without a vault-as-lender contract. Confirmed against
> [#398](Research-398-StandardizedYieldWrapperAndOutwardAdapter.md) §single-principal restriction.

---

## 2. What v1 adds over v0.6 (the actual delta)

v0.6 already lets a user sign an offer and a keeper fill it (full/partial) via `matchSignedOffer`.
Two things are missing for the "always-fillable, no-idle-gap" UX:

1. **Set-and-forget standing terms.** In v0.6 the user signs *each* offer (a fixed cumulative
   ceiling, consumed once). v1 lets the user register a **standing intent** once — asset + bounds
   (max principal exposure, min APR, max LTV, max term, accepted-collateral set) — and a permissioned
   solver materializes concrete offers within those bounds without a fresh per-offer signature.
2. **Auto-roll (balance-bounded, refilling).** A v0.6 signed offer's `signedOfferFilled[hash]` ledger
   is **monotonic** — once filled to its ceiling it's spent, even after the loan repays and principal
   returns. A standing intent is instead bounded by the user's **live free vault balance**: as loans
   close and principal flows back, that balance refills and the intent is immediately re-fillable —
   collapsing the between-loans idle window without any new signature or transaction from the lender.

Everything else (EIP-712 verify, slice materialize, `_executeMatch`, 1% LIF, constant-ratio
collateral, dust/floor/cap guards) is **reused unchanged** from v0.6.

---

## 3. Architecture

### 3.1 Standing intent record (new Diamond storage)

```
struct LenderIntent {
    bool    active;
    uint256 maxExposure;         // hard cap on aggregate live principal from this intent
    uint256 minRateBps;          // APR floor — a fill below this is rejected (<= MAX_INTEREST_BPS)
    uint16  maxInitLtvBps;       // the lender's own LTV ceiling (protocol gate still enforced on top)
    uint32  maxDurationDays;
    uint256 minFillAmount;       // smallest slice a solver may fill (> 0, <= maxExposure)
    bool    requiresKeeperAuth;  // true = only an opted-in solver may fill (the §3.3 gate)
}
// keyed by the FULL intent (owner, lendingAsset, collateralAsset) — one intent per pair (Q1)
mapping(address => mapping(address => mapping(address => LenderIntent))) lenderIntent;
```

`lendingAsset` / `collateralAsset` are the mapping keys, not struct fields. The intent is set by
`setLenderIntent(lendingAsset, collateralAsset, …, riskAndTermsConsent)` (the user, direct tx — no
contract deploy; mandatory risk/terms consent, same gate as offer-create) and torn down by
`cancelLenderIntent(lendingAsset, collateralAsset)` (`active=false`). A live-read each fill makes a
nonce unnecessary (raising `minRateBps` mid-flight just reverts a stale solver tx). **Reservation
uses the existing encumbrance sub-ledger (#407)** — the principal a solver is about to consume is
locked via `createOfferPrincipalLien` on the materialized slice offer exactly as v0.6 does, so a
concurrent withdraw can't pull principal out from under an in-flight fill.

**Exposure accounting lands with the v1-b fill path, NOT here (v1-a).** The `maxExposure`-enforcing
live-principal counter MUST be keyed by the full `(owner, lendingAsset, collateralAsset)` intent (two
intents sharing a lending asset but different collateral must not share a counter), and the per-loan
origin marker must store the **originating intent owner**, not be read from `loan.lender` at close —
`loan.lender` is mutated when a lender position is **sold** mid-loan (`migrateLenderPosition` via
`EarlyWithdrawalFacet.completeLoanSale`), so a close-time decrement keyed off the current
`loan.lender` would hit the buyer's counter (or none) and strand the original owner's capacity.
Because both the keying and the loan-sale handling are tied to the code that *writes* them, the
counter + per-loan marker are defined in v1-b (with tests for the loan-sale path), not scaffolded as
inert v1-a storage.

### 3.2 `matchIntent` — the permissioned fill entry (new `OfferMatchFacet` selector)

```
function matchIntent(
    address lender,                 // the standing-intent owner (= beneficial owner = loan.lender)
    ConcreteTerms calldata terms,   // the solver's chosen point within the intent's bounds
    uint256 counterpartyOfferId,
    uint256 fillAmount
) external nonReentrant whenNotPaused returns (uint256 loanId)
```

Flow (mirrors `matchSignedOffer`, swapping signature-verify for intent-bounds-check):
1. `_assertNotSanctioned(msg.sender)` (the solver) **and** `_assertNotSanctioned(lender)`.
2. `partialFillEnabled` kill-switch (reuse) + a new `lenderIntentEnabled` master kill-switch.
3. **Solver authorization** (§3.3): if `intent.requiresKeeperAuth`, require the solver is an opted-in
   keeper of `lender` for `KEEPER_ACTION_SIGNED_FILL`.
4. **Bounds check**: `terms ⊆ intent` — `terms.rateBps >= intent.minRateBps`, `terms.ltv <=
   intent.maxInitLtvBps`, `terms.durationDays <= intent.maxDurationDays`, the pair is the intent's
   `(lendingAsset, collateralAsset)` key, `fillAmount >= intent.minFillAmount`, and the
   full-intent-keyed `lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset] + fillAmount
   <= intent.maxExposure` (the counter introduced in this step — keyed by the full intent, never
   lender-only).
5. **Free-balance check**: `LibEncumbrance.freeBalance(lender, lendingAsset, 0, rawBalance) >=
   fillAmount` (the auto-roll "refill" is implicit here — returned principal is free balance again).
6. **Materialize a slice offer with `creator = lender`** (NOT a vault contract) via the v0.6
   `createSignedOfferVault` path generalized to "intent-backed" (same vault-backed pull-from-free-
   balance, same `createOfferPrincipalLien`).
7. `_executeMatch(...)` (v0.6, unchanged) → `loan.lender = lender` → **all 30+ downstream sites work
   unchanged**. `lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset] += fillAmount`, and
   record the **originating** intent key per loan (so the close-time decrement survives a
   lender-position sale that mutates `loan.lender` — §3.1).
8. On the loan's terminal close, the standard claim path returns principal to `lender`'s vault and we
   decrement `lenderIntentLivePrincipal` (§3.4).

`ConcreteTerms` is the solver's pick within the band; the constant-ratio collateral rule from v0.6
applies (the intent's collateral:principal ratio is fixed, so slices stay additive/capped).

### 3.3 Permissioned-solver gate (new keeper action bit)

- Add `KEEPER_ACTION_SIGNED_FILL = 1 << 6` (`0x40`) in `LibVaipakam` (2 spare bits today; bump
  `KEEPER_ACTION_ALL` 0x3F → 0x7F).
- `LibAuth.requireKeeperFor` is **loan-keyed** (post-origination); a signed-fill happens *before* the
  loan exists. Add a **signer-keyed** sibling `LibAuth.requireKeeperForPrincipal(action, principal)`
  that runs the same three-gate check (`keeperAccessEnabled[principal]` + a new
  `principalKeeperEnabled[principal][keeper]` OR reuse `approvedKeeperActions[principal][keeper]` &
  action) without a loan. v1 reuses `approvedKeeperActions` (the per-(user,keeper) bitmask already
  exists) — no per-loan enable needed pre-loan.
- An intent with `requiresKeeperAuth == false` stays openly fillable by the legacy path; only
  `true` intents require the bit. This also retro-applies to v0.6 `matchSignedOffer`: add the same
  optional `requiresKeeperAuth` flag to the `SignedOffer` struct so a signed offer can opt into
  permissioned-only filling (the synthesis §4.1 requirement). **Struct/typehash change → ABI
  re-export + a new EIP-712 field** (sequence carefully; this touches the v0.6 signed-offer hash).

### 3.4 Auto-roll — two layers, both respecting lender-NFT ownership

**Layer 1 (implicit, ships with §3.1–3.2): balance-bounded re-offer.** Once a loan repays, principal
returns to `lender`'s vault via the normal claim path → it is free balance again → the next
`matchIntent` consumes it. No new mechanism: the intent is *defined* against live free balance, so it
"refills" automatically. This alone closes most of the idle gap and is the v1 MVP.

**Layer 2 (optional, zero-gap): keeper claim-on-behalf.** The proceeds only return to the vault once
someone calls `claimAsLender`. Per the scout, the lender-NFT holder is known **only at claim time**
(`ClaimFacet:233`), and proceeds **must** go to the current holder — if the lender position was sold
mid-loan, the buyer claims and the original lender's intent must NOT capture those proceeds. So
zero-gap auto-roll = let an opted-in keeper call `claimAsLender` on the lender's behalf (gated by a
keeper bit), which deposits to whoever currently holds the NFT. When that holder is still the intent
owner, the deposit refills their vault and Layer 1 re-offers it; when it isn't, the keeper-claim
simply pays the new holder and the intent owner gets nothing (correct). **Auto-roll is layered on the
existing claim semantics, never a bypass** — exactly the synthesis §3.2 ⚠️ invariant. Layer 2 reuses
the internal-match-auto-dispatch precedent (a cross-facet helper invoked inside the claim flow after
NFT-ownership is verified).

`lenderIntentLivePrincipal[owner][lend][coll]` is decremented when the loan reaches a terminal state
— wired at the single `LibLifecycle.transition` chokepoint (which fires `onLoanStatusChanged` on
every close). This **terminal release ships in v1-b together with the increment** (a counter that
only goes up would permanently consume `maxExposure`, breaking the repay→re-offer cycle): the close
hook reads the per-loan **originating intent key** recorded at §3.2 step 7 — `(owner, lend, coll)`,
NOT the current `loan.lender` (which a lender-position sale mutates) — and decrements that owner's
counter exactly once. v1-d adds only the optional keeper claim-on-behalf on top.

---

## 4. Increments (each its own PR + Codex + the facet-addition checklist)

| Inc | Deliverable | Depends on |
| --- | --- | --- |
| **v1-a** | Standing-intent storage (`LenderIntent` record + mandatory consent + bounds validation) + `setLenderIntent`/`cancelLenderIntent` + views + `lenderIntentEnabled` kill-switch. No fill path, no exposure counter yet. | — |
| **v1-b** | `matchIntent` fill entry (bounds-check + materialize-with-`creator=lender` + `_executeMatch`) + the full-`(owner,lend,coll)`-keyed `lenderIntentLivePrincipal` counter, per-loan originating-intent marker (loan-sale-safe), AND the terminal-close decrement at the `LibLifecycle.transition` chokepoint — increment + release ship together so exposure is never permanently consumed. Open (no solver gate yet). | v1-a |
| **v1-c** | `KEEPER_ACTION_SIGNED_FILL` bit + `requireKeeperForPrincipal` + wire into `matchIntent` (and the `requiresKeeperAuth` opt-in on `SignedOffer` for v0.6's `matchSignedOffer`). ABI re-export. | v1-b |
| **v1-d** | Auto-roll Layer 2 (keeper claim-on-behalf — the zero-gap optimization; the terminal decrement itself already ships in v1-b). | v1-b |

v1-a/b are the MVP (standing terms + auto-roll Layer 1). v1-c/d harden + close the gap.

## 5. Test plan (per increment)

- v1-a: set/cancel intent round-trip + overwrite, mandatory-consent revert, all bounds-validation
  reverts (zero asset / self-collateralized / zero exposure / min-fill > exposure / rate > ceiling /
  zero or >100% LTV / zero term), keeper-gate-flag reject (until the gate ships), kill-switch
  view + admin-only, per-pair independence.
- v1-b: full+partial intent fill → `loan.lender == lender` + all claim/VPFI/KYC machinery unchanged
  (regression against existing loan-lifecycle suites); below-min-APR / above-LTV / over-exposure /
  wrong-collateral reverts; full-intent-keyed exposure-cap arithmetic; the loan-sale case (origin
  marker decrements the original owner's counter, not the buyer's); free-balance refill across a
  repay→re-offer cycle; constant-ratio cap.
- v1-c: un-opted intent fillable by anyone; opted intent rejects an unauthorized solver, accepts an
  opted-in keeper; `requiresKeeperAuth` on a v0.6 `SignedOffer` gates `matchSignedOffer`.
- v1-d: keeper claim-on-behalf deposits to current NFT holder; transferred-position case pays the
  buyer + intent owner captures nothing; live-principal decrements exactly once on every close path.

## 6. Open questions for the checkpoint

- **Q1 — one intent per (user, asset-pair) or per user?** v1 proposes one `LenderIntent` per user
  (single asset-pair). Multiple concurrent intents (different pairs/terms) → a `mapping(user =>
  LenderIntent[])` or an intent-id keyed map. Recommend **single per (user, lendingAsset,
  collateralAsset)** for v1, generalize later.
- **Q2 — does v1-c's `requiresKeeperAuth` field change the v0.6 `SignedOffer` hash now, or defer?**
  Adding it to the struct is an EIP-712 + ABI change to freshly-merged v0.6. Could ship v1-c's intent
  gate first and retrofit `matchSignedOffer` opt-in in a dedicated follow-up to avoid churning the
  v0.6 hash twice.
- **Q3 — is auto-roll Layer 2 (keeper claim-on-behalf) in v1 scope, or is Layer 1 (balance-bounded
  re-offer) enough for the v1 milestone?** Layer 1 alone already removes the per-offer-signing gap;
  Layer 2 removes the manual-claim gap. Recommend Layer 1 in v1, Layer 2 as v1-d if telemetry shows
  the claim gap matters.
- **Q4 — rate model.** v1 uses the user-set `minRateBps` floor (identity rate model). The pluggable
  `IRateModel` (#400) is v2 and prices *new* offers only — out of v1 scope.
