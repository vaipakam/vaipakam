# Collateral Lien Lifecycle — custody map & drain-closure design

**Status:** design / under review (no code derived yet)
**Relates to:** #565 (vault-encumbrance enforcement), #574 (NFT-position vault
keying), #577 (internal-match residual), #570 (`withdrawVPFIFromVault` bypass)
**Companion:** [`EncumbranceLifecycleMap.md`](EncumbranceLifecycleMap.md) — the
original #565 blueprint, which mapped the **withdraw-guard** sites. This doc
extends that to the **full collateral-custody & claim lifecycle** across the
loan state machine — the angle that was missing and that let a long P1 tail
accumulate (Codex #572 rounds 4→5→6).

> **Why this doc exists.** The drain-closure was attacked release-site by
> release-site, reactively, and each Codex round surfaced *more* sites
> (1 → 2 → 4 P1s). The bug class is **"missing a path"** — which is only
> visible against a *complete* model of where collateral physically lives at
> every loan state and every place it returns to the borrower's vault. This
> document is that model. Code is derived from it, not the other way round.

---

## 1. The invariant (sourced from the spec, not the code)

`docs/FunctionalSpecs/ProjectDetailsREADME.md` states the target invariant
verbatim and platform-wide:

> **§2207 — Collateral-protection invariant (binding):** collateral that backs
> a live ERC-20 loan must NOT be withdrawable from the borrower's vault through
> ANY path other than a protocol flow that first accounts for the reduction. A
> borrower must never leave a loan under-collateralized by routing pledged
> collateral out a side door.

> **§895 / §491 — Current NFT Holder Claim Authority:** every borrower-side
> claim path must authorize the **current holder of the borrower position
> NFT**, not the original wallet recorded at loan creation. Claim rights follow
> the NFT.

Combining these, the **lien invariant** this doc enforces is:

> **At every instant, for every loan, the collateral lien on `loan.borrower`'s
> vault equals the amount of that loan's collateral currently sitting in
> `loan.borrower`'s vault that is still owed to the borrower-position holder.**

The drain it closes: `loan.borrower` is fixed at loan-init and is **never
re-keyed** when the borrower-position NFT is sold. So collateral physically
lives in the *original* borrower's vault for the life of the loan. If a terminal
releases the lien while the collateral still sits there owed to a *transferred*
holder, the original `loan.borrower` can drain it (most concretely VPFI via
`withdrawVPFIFromVault`, the one borrower-callable vault-drain path) in the
window before the rightful holder claims.

---

## 2. The mechanism and its reachability constraint

The enforcement primitive (already built in #565):

- Collateral is liened at loan-init (`LibEncumbrance.createCollateralLien`,
  ERC-20 only — **NFT rentals are never liened**, D-1 / spec §2209).
- A terminal that leaves collateral in the vault as a `borrowerClaims` row
  **keeps the lien** (does not release at the terminal).
- `ClaimFacet.claimAsBorrower` **releases the lien atomically immediately
  before** withdrawing the claim to the verified NFT holder
  (`ClaimFacet.sol:492-498`).
- A terminal that *seizes* part of the collateral **decrements** the lien by
  exactly the seized amount (clears the guard for the seizure withdraw) and
  leaves the residual liened.
- Collateral that is pulled to Diamond custody and later **pushed back** to the
  vault must be **re-liened** at the push-back point.

**Reachability constraint (load-bearing):** `claimAsBorrower` accepts **only
`Repaid` and `Defaulted`** (`ClaimFacet.sol:453-456`). Therefore lien-until-claim
is reachable for collateral that ends up in those states, **but not for
`InternalMatched`** (no borrower claim path at all — §5) and **not while
`FallbackPending`** (borrower claim is blocked during the cure window;
collateral becomes claimable only once it resolves to `Repaid`/`Defaulted`).

---

## 3. Complete collateral-custody census

Every site where a loan's **collateral asset** ends up in `loan.borrower`'s
vault owed to the borrower-position holder. ✅ = lien protects it until claim;
⚠️ = collateral lands/stays **un-liened** (drain-exposed for VPFI + transferred
position). Surplus paid in the **principal** asset (HF-liq / time-default swap
success) is excluded — it is a different, freshly-deposited asset, never under
the collateral lien.

### STAYS-IN-VAULT (collateral never moves; recorded as a claim)

| # | Site | Flow | Terminal | Current lien op | Status |
|---|------|------|----------|-----------------|--------|
| SV1 | `RiskFacet.sol:1646` `_settleDiscountedLiquidation` | discounted-liq surplus | Defaulted | **decrement(seized)** → surplus liened *(Fix 1, b5d97af9)* | ✅ |
| SV2 | `SwapToRepayFacet.sol:415` `swapToRepayFull` | swap residual | Repaid | net `unconsumed` held *(143aa68d)* | ✅ |
| SV3 | `RepayFacet.sol:384` `repayLoan` (ERC20 full) | full repay | Repaid | held until claim *(143aa68d)* | ✅ |
| SV4 | `LibSwapToRepayIntentSettlement.sol:229` | intent-fill residual | Repaid | **release-tombstone — residual un-liened** | ⚠️ |
| SV5 | `PrecloseFacet.sol:245` `precloseDirect` | direct preclose | Repaid | held until claim *(143aa68d)* | ✅ |
| SV6 | `PrecloseFacet.sol:1146` `completeOffset` | offset close | Repaid | no explicit release; relies on claim | ✅¹ |
| SV7 | `RiskMatchLiquidationFacet.sol:444` | internal-match Active **partial** residual | Active | decrement(moved); residual liened under live loan | ✅ |

### BACK-TO-VAULT (collateral pushed from Diamond custody back to the vault)

| # | Site | Flow | Terminal | Current lien op | Status |
|---|------|------|----------|-----------------|--------|
| BV1 | `ClaimFacet.sol:862-865` `_distributeFallbackCollateral` | fallback borrower residual → vault | Defaulted | **NONE — lands un-liened** | ⚠️ |
| BV2 | `RepayFacet.sol:598` full-repay-cures-FallbackPending | snapshot collateral → vault | Repaid | **increment(held)** *(Fix 4, b5d97af9)* | ✅ |
| BV3 | `AddCollateralFacet.sol:233` `_cureFallback` | snapshot → vault, loan reactivates | Active | increment(held) | ✅ |
| BV4 | `LibSwapToRepayIntentSettlement.sol:146` | intent residual → vault | Repaid | **NONE re-applied (pairs with SV4)** | ⚠️ |
| BV5 | `RiskMatchLiquidationFacet.sol:612` | FallbackPending full-rescue residual → vault | InternalMatched | **NONE; claims deleted** | ⚠️² |
| BV6 | `SwapToRepayFacet.sol:393` `swapToRepayFull` | partial-fill refund → vault | Repaid | increment(refund) | ✅ |
| BV7 | `SwapToRepayFacet.sol:601` `swapToRepayPartial` | partial-fill refund → vault | Active | increment(refund) | ✅ |
| BV8 | `SwapToRepayIntentFacet.sol:912` `_teardownCommit` | intent cancel → vault | Active | increment(custodial) | ✅ |

¹ SV6 relies entirely on `claimAsBorrower` (no terminal release) — verify a test
asserts it is in fact covered.
² BV5 lands un-liened but the loan is terminal (`InternalMatched`) with claims
deleted — see §5; this is the InternalMatched residual problem, not a
lien-timing tweak.

### Already-SAFE seizure / exit paths (full collateral leaves → release correct)

`triggerLiquidation` / `triggerLiquidationSplit` (full swap), time-default
liquid/illiquid (full seizure to lender), obligation-transfer & refinance
(withdrawn to the rightful holder via the vault-source fixes), partial-liq &
periodic-auto-liq & partial-withdrawal (decrement-by-seized). No change needed.

---

## 4. The gaps and their fixes

Only **three** ⚠️ classes remain. Two are reachable by `claimAsBorrower`
(→ mechanical re-lien); one is the InternalMatched problem (→ §5 / #577).

### Gap A — fallback distribution `_distributeFallbackCollateral` (BV1)
The fallback borrower-residual claim row is written at fallback-**entry**
(`Active→FallbackPending`), the lien is released at liquidation/default-entry,
and `_distributeFallbackCollateral` later pushes `snap.borrowerCollateral` back
into the vault **un-liened**. The loan is then `Defaulted` → `claimAsBorrower`
*is* reachable. **Fix:** re-lien `snap.borrowerCollateral` at the push-back
(`increment`) so the lien protects it until the NFT holder claims. This is the
single chokepoint behind **Codex round-6 P1s on RiskFacet:554 + DefaultedFacet:284**
(both route through here).

### Gap B — swap-to-repay-intent residual (SV4 / BV4)
The intent commit decrements the lien to zero (collateral → custody); on fill
with `makingAmount < custodialCollateral` the residual is pushed back to the
vault and the loan goes `Repaid`, but the residual is **not re-liened** (the
`:270` release is a tombstone). `claimAsBorrower` is reachable (Repaid).
**Fix:** re-lien the residual (`increment`) before the Repaid transition, paired
with the existing claim row. Closes **Codex round-6 P1 on
LibSwapToRepayIntentSettlement:270**.

### Gap C — fallback top-up claim clobber (the bug in the current Fix 3)
The current Fix 3 (b5d97af9) **overwrites** `s.borrowerClaims[loanId]` with only
the top-up — but `_distributeFallbackCollateral` may already have left the
borrower's snapshot-collateral residual as that claim. **Fix:** **add** the
top-up to the existing claim amount instead of replacing it, keeping the
combined amount liened. Closes **Codex round-6 P1 on ClaimFacet:273**.

> With the census complete, Gaps A–C are the **entire** remaining lien-timing
> surface for the `Repaid`/`Defaulted`-reachable paths. There is no further
> hidden site — every direction (out/back/stays) has been enumerated.

---

## 5. InternalMatched residual — spec-mandated, separate (#577)

The internal-match **full**-match (Active→InternalMatched) and
FallbackPending-rescue (→InternalMatched) leave an over-collateralized loan's
residual in the vault, claims deleted, **un-liened**, and `InternalMatched` is
**not** accepted by `claimAsBorrower`. Today the residual is treated as "ordinary
vault balance" (retrievable only for VPFI via `withdrawVPFIFromVault`) — which is
both the drain (transferred position) **and** a no-retrieval-path gap for
non-VPFI even in the common case.

**The spec says this should be a claim:** §938 — "the internally-matched
terminal state must be treated as **claim-eligible** for the same claim-center
and NFT-rights purposes as other terminal loan states"; §937/§939 — "residual
borrower collateral … remains claimable through the **ordinary borrower claim
path**." So closing this is **fixing a code-vs-spec divergence**, and it needs a
real change (make `InternalMatched` claimable in `claimAsBorrower` + record a
residual `borrowerClaims` + keep it liened), across both branches — a feature,
not a lien tweak. Tracked as **#577**, to land with the #574 holistic work.

---

## 6. Spec divergences requiring a human decision

| # | Spec says | Code / proposed | Decision needed |
|---|-----------|-----------------|-----------------|
| D-α | §942: discounted-liq surplus stays as "**ordinary withdrawable balance**" | Fix 1 made it **claim-gated** (lien until `claimAsBorrower`) to satisfy §895/§2207 | §942 (specific, predates the transferred-position concern) conflicts with §895/§2207 (governing). Recommend **claim-gated wins** and update §942 to "claimable by the current borrower-NFT holder." Confirm. |
| D-β | §938: InternalMatched is **claim-eligible** | Code deposits residual to vault directly; `InternalMatched` not claimable | Confirm we make `InternalMatched` claimable (#577) rather than the direct-vault-deposit model. |
| D-γ | Spec is **silent** on an un-curing FallbackPending top-up's disposition (Agent finding) | Fix 3 routes it to the NFT holder as a refunded failed-cure | Confirm intent (refund the top-up to the borrower-NFT holder) + add a spec line. |

These are logged for `docs/FunctionalSpecs/_CodeVsDocsAudit.md` once decided.

---

## 7. Plan derived from the map

**Good news from the complete census:** the drain-closure for the
`Repaid`/`Defaulted`-reachable paths is only **3 mechanical fixes** (Gaps A–C),
not an open-ended tail. The one genuinely-large piece (InternalMatched, #577) is
spec-mandated and naturally separate.

Two viable shapes — **for the user to choose** (§6 decisions feed this):

- **Option 1 — finish the drain-closure in #565.** Land Gaps A–C (re-lien at
  `_distributeFallbackCollateral`, re-lien the intent residual, fix the Fix-3
  clobber). Defer InternalMatched (#577). #565 then closes the drain on every
  path except the spec-mandated InternalMatched feature. Bounded + convergent
  now that the map is complete.
- **Option 2 — scope #565 to the core, do drain-closure as a dedicated PR.**
  Keep #565 = guard + lien-at-init + vault-source fixes + the already-✅ proper-
  close paths; revert the discounted-liq / repay-cure / top-up edits; do Gaps
  A–C + #577 together in a dedicated PR built from this doc.

The map makes Option 1 viable (it isn't the open-ended tail we feared). Either
way, no further code until §6 is decided and this doc is reviewed.

## 8. Tests derived from the invariant

One regression per ⚠️ gap, all using the `getEncumberedRaw` reader + the
transferred-position scenario:

- **Gap A:** liquid loan → swap fails → FallbackPending → lender finalizes →
  assert `snap.borrowerCollateral` is liened after `_distributeFallbackCollateral`
  and zeroes only at `claimAsBorrower`; a transferred-away `loan.borrower`'s
  `withdrawVPFIFromVault` reverts in the gap.
- **Gap B:** swap-to-repay-intent partial fill → assert residual liened after
  fill, released at claim.
- **Gap C:** FallbackPending top-up **plus** a snapshot residual claim → assert
  the claim amount is the **sum**, fully liened, fully delivered to the NFT
  holder.
- **#577:** over-collateralized internal match (2-way + 3-way) → residual liened
  + claimable by the NFT holder; not drainable by a transferred-away borrower.
- **Guard (existing pattern):** `test_collateralLienHeldUntilClaim_*` extended
  per gap.
