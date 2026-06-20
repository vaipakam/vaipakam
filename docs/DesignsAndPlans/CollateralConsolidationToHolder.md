# Collateral / Principal Consolidation to the Position-NFT Holder (#594)

**Status:** Design — implementation-ready once reviewed.
**Source of truth for intent:** `docs/FunctionalSpecs/ProjectDetailsREADME.md`
§§5–9 + the post-Phase-1 design docs (`PerLoanCollateralLien.md`,
`EncumbranceLifecycleMap.md` (T-407/#569), the #576 refinance carry-over
work). This doc is sourced from the **intended** lifecycle in those
documents and then matched to code call sites — never transcribed from the
code.
**Relation to siblings:** generalises the per-event "borrower-pin" handling
that #576 (refinance carry-over) shipped as a special case; consumes the
encumbrance ledger built by #407/#569; reconciles the #573/#574
"keep-collateral-in-the-original-vault" drain-protection choice (see §7).

---

## 0. The reframing — this is state hygiene, not a fund-loss fix

When a position NFT is transferred, an ERC-721 transfer cannot move the
ERC-20/721/1155 balances that back the loan, so the assets **stay in the
original vault** and a standing divergence opens:
`loan.borrower` / `loan.lender` (the custody vault) ≠ `ownerOf(positionTokenId)`
(the current holder).

**The funds are already safe today** (verified against code, not assumed):

- The current holder can always extract value at close — `ClaimFacet`
  gates every claim on the *current* NFT owner
  (`LibAuth.requireLenderNftOwner` / `requireBorrowerNftOwner`,
  `ClaimFacet.sol:659` / `:272`) and withdraws the proceeds from the
  *stored* vault to `msg.sender` (`ClaimFacet.sol:788–801`).
- The stored owner cannot drain the backing collateral out from under the
  current holder — the encumbrance lien
  (`encumbered[user][asset][tokenId]`, `LibVaipakam.sol:4110`) blocks it at
  the withdraw chokepoint (`VaultFactoryFacet._assertWithdrawAllowed`,
  `:468–474`).

So #594 does **not** fix a live fund-loss bug. What it fixes is the
*divergence* itself: while `loan.borrower != holder`, the position is a
special case — user-loan indexes, event attribution, reward/VPFI-tier
accounting, and the rebate paths all key off `loan.borrower`/`loan.lender`
and therefore mis-attribute to the original (departed) owner, and every
mutation path needs a "borrower-pin" hack (the #576 Codex round-1 P2s 2 & 5
that motivated this issue). **Consolidation makes the position an ordinary
loan again** (`loan.borrower == vault owner == NFT holder`), after which
none of those special cases are needed.

**Scope decision (owner, 2026-06-20):** build the **full consolidation
primitive** (vault→vault asset move + lien re-key + loan-anchor mutation +
VPFI-tier re-stamp), and expose it **both** eagerly (auto-consolidate as the
first step of the next active lifecycle event) **and** as a standalone
`consolidate…ToHolder(loanId)` call. See Decisions D-1/D-2.

---

## 1. The one invariant

> **Consolidation moves four things as a single atomic unit, and a lien must
> cover the backing asset at every intermediate step:** (1) the vaulted
> asset, original-vault → holder-vault; (2) the encumbrance lien, re-keyed
> from the old user to the new user; (3) the loan custody anchor
> (`loan.borrower` or `loan.lender`); (4) the VPFI discount tier stamp for
> both the old and new vault. There must be **no window** in which the asset
> sits in a vault that the lien does not point at, nor in which the lien
> aggregate double-counts (old + new both non-zero) or under-counts (neither).

This is the consolidation analogue of the #569 invariant ("collateral never
leaves a vault except through a flow that first adjusts the ledger"). The
move is vault→vault *inside the Diamond* — the asset never touches a wallet,
so the existing withdraw guard's `freeBalance` check must be satisfied at the
source and the destination lien written before/with the transfer.

---

## 2. The primitive

A single internal library entry point, two public-ish wrappers:

```
LibConsolidation.consolidateToHolder(loanId, side)   // side = Borrower | Lender
```

Steps (ordering is load-bearing — see §4 atomicity):

1. **Resolve.** `current = ownerOf(side == Lender ? loan.lenderTokenId : loan.borrowerTokenId)`.
   `stored = side == Lender ? loan.lender : loan.borrower`.
   If `current == stored` → **no-op return** (already consolidated; the common case).
2. **Guard.** Sanctions-check `current` (Tier-1, `_assertNotSanctioned`).
   Reject if the loan is in a status where the anchor must not move
   (see D-3: `FallbackPending` with an active top-up is excluded).
3. **Create destination.** `getOrCreateUserVault(current)`
   (`VaultFactoryFacet.sol:197`).
4. **Move the asset** original-vault (`stored`) → holder-vault (`current`),
   for the side's backing asset:
   - Borrower side: the collateral (`collateralAsset` + type/amount/tokenId).
   - Lender side: there is no standing principal in the lender's vault for an
     active loan (it was lent to the borrower at init) — the lender side's
     "asset to consolidate" is the **held-for-lender** balance / matched
     proceeds when present, and otherwise the consolidation is anchor-only
     (re-point `loan.lender`, re-key any `lenderProceedsEncumbered` /
     held reservation). See §3.2.
   The move uses a new **vault→vault** transfer (see §5) — *not* a withdraw to
   a wallet (which the guard would block) and *not* a Diamond round-trip.
5. **Re-key the lien** old-user → new-user (new `LibEncumbrance`
   function, §5): decrement `encumbered[stored][asset][id]`, increment
   `encumbered[current][asset][id]`, and rewrite `lien.user = current` on the
   per-loan `loanCollateralLien[loanId]` (`LibVaipakam.sol:4097`). The
   aggregate sum is conserved.
6. **Mutate the loan anchor.** `loan.borrower = current` (or
   `loan.lender = current`). This is the first place in the protocol that
   re-writes these fields (today only the NFT migrates, never the vault
   anchor — `LibLoan.migrateBorrowerPosition`/`migrateLenderPosition` leave
   the anchor put). Update the user-loan index sets (remove from `stored`'s
   set, add to `current`'s).
7. **Re-stamp VPFI tiers.** Call `LibVPFIDiscount.rollupUserDiscount(stored,
   postBalance(stored))` and `…(current, postBalance(current))` so both
   vaults' time-weighted discount accumulators reflect the moved VPFI
   immediately (only needed when the moved asset *is* VPFI, but cheap to call
   unconditionally with the post-move balances; see D-4).
8. **Emit** `CollateralConsolidated(loanId, side, stored, current, asset, amount)`.

After step 8, `loan.{borrower|lender} == ownerOf(positionTokenId) == vault
owner`, and the loan is indistinguishable from one that never transferred.

---

## 3. What moves, by side

### 3.1 Borrower side
The collateral identity per loan kind (mirrors `EncumbranceLifecycleMap.md`
§2): `(borrower, collateralAsset, 0)` for ERC-20, `(…, collateralTokenId)`
for 721/1155. The lien amount basis is `loan.collateralAmount` /
`collateralQuantity` / `1`. **NFT rentals are NOT liened (D-1 there) and are
out of scope here** — there is no ERC-20-on-ERC-20 collateral to move for a
rental, and the position model differs. Consolidation applies to the
**ERC-20-collateral and NFT-collateral loan kinds only**, consistent with
the rest of the encumbrance system.

### 3.2 Lender side
For an **active** loan the principal already left the lender's vault (it was
disbursed to the borrower at init), so there is usually nothing to *move* —
lender-side consolidation is **anchor + reservation** only: re-point
`loan.lender`, and re-key any held-for-lender reservation
(`lenderProceedsEncumbered` / `lenderProceedsEncumberedAsset`,
`LibVaipakam.sol:4141/4151`, the #585 reservation) from `stored` to
`current`. When a held-for-lender balance physically sits in the stored
lender's vault (rental-prepay drip, matched proceeds awaiting claim), that
balance moves too, by the same §2 step-4 mechanism.

---

## 4. Atomicity & reentrancy

The whole primitive runs inside one external call frame, guarded by the
caller's `nonReentrant` (every lifecycle entry point already carries it; the
standalone wrapper adds its own). Ordering rules:

- **Write the destination lien before/with the transfer**, and decrement the
  source lien in the same step, so the `encumbered` aggregate is never
  observably inconsistent (no double-count, no zero-window). Because the move
  is vault→vault inside the Diamond and the guard reads the aggregate, doing
  the re-key and the transfer in one library call with no external callback
  between them keeps the chokepoint correct throughout.
- **No untrusted external calls between steps.** Vault deposits/withdrawals
  are to the protocol's own UUPS vault proxies (trusted). The only token
  callbacks are ERC-721/1155 `onReceived` hooks on the destination vault,
  which is protocol code; still, sequence the lien re-key *before* the asset
  transfer so even a hostile token can't observe an unlien'd balance in the
  destination vault.
- **Idempotent / no-op fast path.** If `current == stored` the primitive
  returns immediately, so eager-consolidation at every lifecycle event costs
  one `ownerOf` + one compare in the overwhelmingly common
  already-consolidated case.

---

## 5. New code (what must be built — nothing reusable exists)

The scout confirmed **no vault→vault move + cross-user lien-rekey primitive
exists** (`rekeyCollateralLienOnRefinance` only retags the *loanId* key at the
same user; `migrate{Borrower,Lender}Position` move the NFT, not the anchor or
the assets; the only in-protocol vault-move is the Diamond→vault settlement in
`RiskMatchLiquidationFacet`). New pieces:

1. **`VaultFactoryFacet._moveBetweenVaults(from, to, asset, type, amount, id)`**
   — internal, `onlyDiamondInternal`. Pulls from `from`'s proxy and deposits
   into `to`'s proxy in one call, adjusting `protocolTrackedVaultBalance` for
   both (decrement `from`, increment `to`). Reuses the existing
   withdraw/deposit record helpers; does **not** route through a wallet.
2. **`LibEncumbrance.rekeyCollateralLienToHolder(loanId, newUser)`** — moves the
   lien across users: assert the per-loan lien exists and is unreleased,
   `encumbered[old][asset][id] -= amount`, `encumbered[new][asset][id] += amount`,
   `lien.user = newUser`. Mirrors the conservation discipline of the existing
   `decrement`/`increment` helpers.
3. **`LibConsolidation`** — the orchestrator (§2 steps), plus the
   `CollateralConsolidated` event and the `ConsolidationNotAllowed` /
   `NothingToConsolidate` errors.
4. **A facet home for the standalone call** —
   `consolidateCollateralToHolder(uint256 loanId)` (borrower side) and
   `consolidatePrincipalToHolder(uint256 loanId)` (lender side), `whenNotPaused`,
   `nonReentrant`, Tier-1 sanctions-gated, callable by the current holder
   (or an authorised keeper, mirroring `requireKeeperFor`). Likely a small new
   `ConsolidationFacet` (keeps `VaultFactoryFacet` from growing past EIP-170;
   see the #647 NumeraireConfigFacet split precedent).

Eager integration: call `LibConsolidation.consolidateToHolder(loanId, side)`
as the **first step** (after auth, before terms math) of: borrower side —
`RefinanceFacet` (replaces the #576 borrower-pin), `PrecloseFacet`
(`precloseDirect` / `offsetWithNewOffer` / `transferObligationViaOffer`);
lender side — `EarlyWithdrawalFacet` (`createLoanSaleOffer` /
`completeLoanSale`). Each call site already authenticates the current holder
(`requireKeeperFor` / `requireLenderNftOwner`), so the primitive's resolve
step is consistent with the gate that precedes it.

---

## 6. Decisions

- **D-1 — Trigger model: BOTH eager + standalone (RESOLVED 2026-06-20,
  owner).** Auto-consolidate at the active lifecycle events (so a transferred
  position is cleaned the moment its holder next acts) AND expose a standalone
  `consolidate…ToHolder(loanId)` (so a holder — or keeper — can clean a
  position proactively without waiting for a refinance/preclose/sale). The
  no-op fast path (§4) makes the eager calls free on already-consolidated
  loans.
- **D-2 — Scope: full primitive (RESOLVED 2026-06-20, owner).** Build the
  vault→vault move + lien re-key + anchor mutation + VPFI re-stamp, not a
  documentation-only de-scope.
- **D-3 — Excluded states.** Consolidation is rejected for
  `FallbackPending` loans that carry an active top-up
  (`LibVaipakam.hasActiveFallbackTopUp`) — the #577/#585 top-up custody split
  is mid-flight and the anchor must not move under it (same exclusion the
  internal-match retry path uses). Terminal states (`Repaid`/`Settled`/
  `Defaulted`/`InternalMatched`) are no-ops (nothing live to consolidate).
  **OPEN for review:** confirm `FallbackPending` *without* a top-up should be
  allowed (proposed: yes — it's an ordinary lien).
- **D-4 — VPFI re-stamp scope.** Call `rollupUserDiscount` for both vaults
  unconditionally with post-move balances (cheap, and correct even when the
  moved asset isn't VPFI because the rollup is a no-op when the balance is
  unchanged). **OPEN:** alternatively gate the calls on `asset == vpfiToken`
  to save two SLOADs — recommend unconditional for simplicity/correctness.
- **D-5 — Authorization.** Current holder OR an authorised keeper
  (`requireKeeperFor`), matching the lifecycle events' own gates. The stored
  (departed) owner has no claim and cannot call it. **OPEN:** should the
  *new* holder be the only direct caller, or also the keeper, for the
  standalone path? (Recommend keeper-allowed, parity with lifecycle events.)

---

## 7. Reconciliation with #573/#574 (keep-collateral-in-original-vault)

#573/#574 deliberately keep transferred-position collateral in the original
vault and pay the current holder at close. #594 does **not** revert that —
the two coexist:

- **Passive transfer** (NFT moves, holder does nothing) → collateral stays in
  place; the #573/#574 claim path remains the safety net. Nothing changes.
- **Active event OR explicit call** by the current holder → eager/standalone
  consolidation moves the collateral into their vault and the position
  becomes ordinary.

The close-path drain-protection (#573/#574) therefore still covers the
**never-consolidated** case — a position that transferred and then defaulted
or settled without any consolidating event. Consolidation is an *optimisation
toward clean state*, not a replacement for the claim-time protection. The
withdraw guard + lien continue to hold throughout, so a position is safe
whether or not it is ever consolidated.

---

## 8. Test plan (`test/CollateralConsolidation.t.sol`)

1. Borrower NFT transferred, then `consolidateCollateralToHolder` standalone:
   collateral physically moves original-vault → holder-vault; lien aggregate
   conserved (`encumbered[old]` zeroed, `encumbered[new]` == amount);
   `loan.borrower == holder`; user-loan index moved.
2. Eager path: transferred borrower position refinances → consolidation runs
   as step 1, refinance proceeds on the clean position; no borrower-pin.
3. No-op fast path: non-transferred loan's lifecycle event consolidates to a
   no-op (no asset move, no event), gas delta is one `ownerOf` + compare.
4. Withdraw guard holds mid-consolidation: the moved collateral is never
   free-withdrawable from either vault at any step (lien covers it throughout).
5. VPFI collateral moved → both vaults' discount tiers re-stamp to the
   post-move balances (old drops a tier, new gains one).
6. `FallbackPending` + active top-up → `ConsolidationNotAllowed` (D-3).
7. Lender side: transferred lender position, held-for-lender reservation
   re-keyed to the new holder; `loan.lender == holder`; #585 reservation
   follows.
8. Sanctioned current holder → Tier-1 revert before any move.
9. ERC-721 and ERC-1155 collateral variants move correctly (amount basis
   `1` / `collateralQuantity`).
10. Double consolidation is idempotent (second call is a no-op).
11. Reentrancy: a hostile ERC-1155 collateral's `onReceived` cannot observe an
    unlien'd balance in the destination vault (lien written first).

---

## 9. Phasing / PR plan

One design doc (this), then implementation in dependency order:

1. **PR 1 — primitive + standalone borrower path.** `_moveBetweenVaults`,
   `rekeyCollateralLienToHolder`, `LibConsolidation`, `ConsolidationFacet`
   (borrower side), tests 1/3/4/5/6/8/9/10/11. ABI re-export (new facet +
   selectors + error/event) per the deploy-sanity discipline.
2. **PR 2 — eager borrower integration.** Wire `RefinanceFacet` /
   `PrecloseFacet`, remove the #576 borrower-pin hack, tests 2.
3. **PR 3 — lender side.** `consolidatePrincipalToHolder` + `EarlyWithdrawalFacet`
   eager wiring + #585 reservation re-key, test 7.

Each PR ships with its release-note fragment + the matching FunctionalSpec
update, per the per-PR docs discipline.
