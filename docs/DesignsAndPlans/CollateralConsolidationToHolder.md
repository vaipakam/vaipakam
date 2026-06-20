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
>
> **And everything else that keys off the anchor must follow in the same
> frame** — the interaction-reward entries, any lender-intent exposure, the
> unique-user metrics, and the appended (never removed) user-loan index — so
> that after consolidation the position is attributed *entirely* to the holder
> with no residue charged to the departed owner. See §2 steps 7–8.

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

Steps (ordering is load-bearing — see §4 atomicity). **The lien re-key
precedes the asset move** (the §4 invariant; corrects an earlier draft that
moved first):

1. **Load + status-gate FIRST, before any `ownerOf`.** Read the loan and
   classify it into one of three outcomes (`ConsolidationResult`), **never
   reverting** on state alone — and **distinguish a terminal no-op from a
   disallowed skip** (load-bearing for the standalone wrapper, §5):
   - **`NoOp`** — terminal (`Repaid`/`Settled`/`Defaulted`/`InternalMatched`).
     Nothing live to consolidate; the position NFT may already be burned, so
     this is gated **before** any `ownerOf` (which would revert on a burned
     token). The standalone wrapper treats `NoOp` as **success** (an explicit
     consolidation of an already-closed loan is a benign no-op, per test 17),
     *not* `ConsolidationNotAllowed`.
   - **`Skipped`** — an excluded *live* state (D-3: `FallbackPending`; an Active
     loan with a live `PrepayCollateralListing`; an Active loan carrying an
     offer-keyed parallel-sale listing `s.offerPrepayListingOrderHash[offerId]`;
     an Active loan with a live swap-to-repay intent `s.intentCommits[loanId]`;
     an NFT-rental loan on the lender side — see D-3). Return `Skipped`
     **without reverting** so the eager path (§5) never blocks a legitimate host
     op (e.g. `addCollateral`'s `FallbackPending` *cure*); the standalone
     wrapper surfaces `Skipped` as `ConsolidationNotAllowed`.
2. **Resolve.** `current = ownerOf(side == Lender ? loan.lenderTokenId :
   loan.borrowerTokenId)`; `stored = side == Lender ? loan.lender :
   loan.borrower`. If `current == stored` → return **`AlreadyConsolidated`**
   (no-op; the common case — one `ownerOf` + compare).
3. **Guard.** Sanctions-check `current` (Tier-1, `_assertNotSanctioned`).
4. **Create destination.** `getOrCreateUserVault(current)`
   (`VaultFactoryFacet.sol:197`).
5. **Re-key the side-specific lien FIRST**, *if one exists* (new
   `LibEncumbrance` function, §5). **The lien differs by side, and on the lender
   side is usually absent:**
   - **Borrower side:** re-key the per-loan `loanCollateralLien[loanId]` — it is
     keyed under `loan.borrower` (`createCollateralLien` stores
     `user: loan.borrower` and bumps `encumbered[loan.borrower]`).
   - **Lender side:** there is *no* collateral lien to touch (re-keying
     `loanCollateralLien` here would underflow the lender's empty `encumbered`
     bucket — explicitly forbidden). The only lender lien is the
     `lenderProceedsEncumbered` reservation, and for the **common active
     transfer it does not exist yet** (principal already disbursed, no terminal
     proceeds deposited) — so the lender re-key is **conditional**: re-key the
     reservation *only when present*, and **must not assert a lien exists**
     (asserting would revert the common case). Most lender consolidations are
     therefore anchor + reward + intent only (§3.2), with no lien step.
   Whichever lien applies: decrement `encumbered[stored][asset][id]`, increment
   `encumbered[current][asset][id]`, rewrite `lien.user = current`, aggregate
   conserved. Doing this *before* the transfer means even an ERC-721/1155
   `onReceived` callback during the move (§4) can never observe the asset in the
   destination vault while the lien still points at the old one.
6. **Move the asset** original-vault (`stored`) → holder-vault (`current`),
   for the side's backing asset (borrower: the collateral; lender: a
   physically-held balance if present — see §3). ERC-20 moves directly
   source-proxy → dest-proxy. **NFTs require a Diamond-mediated two-leg move
   with two reverts designed out:**
   - **Leg 1 (source vault → Diamond):** the source proxy `safeTransferFrom`s
     the NFT to the Diamond. The Diamond exposes **no** receiver hook today (its
     fallback reverts on the unknown selector), so this needs the new
     **`ReceiverFacet`** (§5). That facet's hook is **gated by a transient
     "consolidation-in-progress" flag** (§5 / D-6) — the Diamond does *not*
     accept arbitrary NFTs, only the one in-flight move — since there is no
     Diamond-level NFT sweep/recovery path.
   - **Leg 2 (Diamond → dest vault):** the vault's `depositERC721`/`…1155` is
     **pull-based** (the dest proxy calls `safeTransferFrom(from, proxy)`, making
     the *proxy* the operator), so "deposit from the Diamond" would require the
     Diamond to first `approve` the dest proxy. Instead, leg 2 is a **direct
     push**: the Diamond `safeTransferFrom`s the NFT to the dest proxy (operator
     `== Diamond`, which the dest vault's `onReceived` gate accepts). No
     `protocolTrackedVaultBalance` bump (NFTs aren't in that ERC-20 counter, §5);
     the NFT's tracking is its lien, already re-keyed in step 5.
   A *direct* vault→vault `safeTransferFrom` is never used (the source vault
   would be the operator → dest gate rejects). Never a withdraw-to-wallet (the
   guard would block it).
7. **Mutate the loan anchor.** `loan.borrower = current` (or
   `loan.lender = current`). This is the first place in the protocol that
   re-writes these fields (today only the NFT migrates, never the vault anchor
   — `LibLoan.migrateBorrowerPosition`/`migrateLenderPosition` leave the
   anchor put). **`userLoanIds` is append-only** (a lifetime log;
   dashboard/read methods filter by the live `loan.borrower`/`loan.lender` at
   read time): **append** the loan to `current`'s set (with duplicate
   protection) and **do NOT remove** it from `stored`'s set — removing would
   erase the departed owner's historical discoverability and break the
   append-only invariant.
8. **Reassign open reward + intent + metrics state to the new owner.** Changing
   the anchor alone leaves protocol accounting keyed to the departed owner:
   - **Interaction rewards:** `RewardEntry.user` / `userRewardEntryIds[user]`
     are allocated at loan registration and walked by claim/sweep paths on
     the *stored* key. Lender sales already close/reopen via
     `LibInteractionRewards.transferLenderEntry`; consolidation must do the
     same — `transferLenderEntry` for the lender side and the borrower-entry
     equivalent for the borrower side.
   - **Lender-intent exposure (lender side):** if the position originated from
     a `LenderIntentVault`, rewriting `loan.lender` alone leaves
     `intentOrigin[loanId]` / `lenderIntentLivePrincipal[origin]` charged to
     the departed lender until claim. A passive transfer + consolidation has
     the same economic effect as a lender sale, so call the same
     `releaseIntentExposure(...)` path the sale uses.
   - **Unique-user metrics:** mark `current` `userSeen` / bump
     `uniqueUserCount` (as `LibMetricsHooks.onLoanInitiated` does for both
     counterparties) — otherwise a holder with no prior offers/loans becomes
     loan-attributable while still excluded from the unique-user count.
9. **Re-stamp VPFI tiers.** Call `LibVPFIDiscount.rollupUserDiscount(stored,
   postBalance(stored))` and `…(current, postBalance(current))` with post-move
   balances so both vaults' time-weighted accumulators are correct
   immediately (D-4: unconditional).
10. **Emit** `CollateralConsolidated(loanId, side, stored, current, asset, amount)`.

After the final step, `loan.{borrower|lender} == ownerOf(positionTokenId) ==
vault owner`, the reward/intent/metrics state is attributed to the holder, and
the loan is indistinguishable from one that never transferred.

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
For an **active ERC-20 loan** the principal already left the lender's vault (it
was disbursed to the borrower at init), so there is usually nothing to *move* —
lender-side consolidation is **anchor + (conditional) reservation + exposure**
only: re-point `loan.lender`; re-key the held-for-lender reservation
(`lenderProceedsEncumbered` / `lenderProceedsEncumberedAsset`,
`LibVaipakam.sol:4141/4151`, the #585 reservation) from `stored` to `current`
**only if it exists** (it usually does not on an active transfer — the re-key
must not assert, §2 step 5); and — when the position originated from a
`LenderIntentVault` — release the lender-intent exposure (`intentOrigin[loanId]`
/ `lenderIntentLivePrincipal[origin]`) off the departed lender via the same path
a lender sale uses, since a passive transfer + consolidation is economically a
lender exit (§2 step 8). When a held-for-lender balance physically sits in the
stored lender's vault (matched proceeds awaiting claim), that balance moves too,
by the same §2 step-6 mechanism (Diamond-mediated for NFTs).

**NFT-rental lender positions are excluded (D-3, Codex round-3).** For a rental
the lent ERC-721/1155 *stays* in `loan.lender`'s vault (with borrower
user-rights) for the whole term, and close/default paths reset/withdraw it via
the live `loan.lender` key — so the "principal already left the vault" premise
above does **not** hold. A naive anchor re-point would orphan the still-vaulted
rented NFT, so rental lender consolidation returns `Skipped` until a
rental-aware design (move the NFT *and* preserve user-rights) is built.

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
  transfer (§2 step 5 precedes step 6) so even a hostile token can't observe an
  unlien'd balance in the destination vault. For NFTs the move is
  Diamond-mediated (§2 step 6) so the destination vault's receiver gate accepts
  it; the lien-first ordering still holds across that two-leg move.
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

1. **`ReceiverFacet`** — adds `onERC721Received` / `onERC1155Received` /
   `onERC1155BatchReceived` to the **Diamond**. Required because the Diamond has
   no receiver hook today, so leg-1 of the NFT move (NFT → Diamond) would revert.
   **Gated AND pinned, not open:** the hooks return the magic value only when the
   transient flag is set **and** `msg.sender` + `tokenId`/`amount` match the
   exact expected in-flight token (`s.consolidationExpectedToken` etc.) — see
   D-6. A bare boolean flag is insufficient because the token is an untrusted
   call target during leg 1; the pin stops a malicious token slipping an extra
   NFT into the Diamond (which has no NFT sweep path). Selectors cut in like any
   facet (deploy-sanity: `DiamondFacetNames` + `SelectorCoverageTest`).
2. **`VaultFactoryFacet._moveBetweenVaults(from, to, asset, type, amount, id)`**
   — internal, `onlyDiamondInternal`. Physically moves the asset and adjusts
   accounting **per type**:
   - **ERC-20:** direct `from`-proxy → `to`-proxy transfer, **and** decrement
     `protocolTrackedVaultBalance[from][asset]` / increment `[to][asset]` — that
     counter is **ERC-20-only** (a fungible-amount ledger).
   - **ERC-721 / ERC-1155: do NOT touch `protocolTrackedVaultBalance`** (Codex
     round-4) — the NFT deposit paths (`vaultDepositERC721`/`…1155`) never seed
     that ERC-20 counter, so an NFT move debiting/crediting it would corrupt an
     unrelated fungible balance. An NFT's "tracking" is its **lien** (re-keyed in
     §2 step 5); the physical move (below) is all step 6 does for NFTs.
   - **ERC-721 / ERC-1155:** the Diamond-mediated two-leg move of §2 step 6 —
     **leg 1** source-proxy `safeTransferFrom` → Diamond (accepted via the gated
     `ReceiverFacet`); **leg 2** the Diamond pushes directly to the dest proxy
     (`safeTransferFrom(Diamond, destProxy, id)` — operator `== Diamond`, which
     the dest gate accepts) and then a **record-only** balance bump. Leg 2 is a
     *direct push*, **not** the pull-based `depositERC721` (whose proxy-as-operator
     `safeTransferFrom` would require the Diamond to pre-`approve` the dest proxy).
     A direct vault→vault transfer is never used (source vault would be the
     operator → reject). (Alternative considered: widen the dest receiver gate to
     accept any protocol vault — rejected as a larger trust-surface change.)
   Never routes through a wallet (the withdraw guard would block that).
3. **`LibEncumbrance.rekeyLienToHolder(loanId, newUser, side)`** — moves the
   **side-specific** lien across users (§2 step 5): borrower → the
   `loanCollateralLien[loanId]` (keyed under `loan.borrower`). **Lender → the
   `lenderProceedsEncumbered` reservation, conditionally**: it is usually absent
   on an active transfer (principal already disbursed, no terminal proceeds), so
   the helper **must not assert a lien exists** on the lender side — it re-keys
   *only when present* and is a no-op otherwise (asserting would revert the
   common case). When a lien applies: `encumbered[old] -= amount`,
   `encumbered[new] += amount`, `lien.user = newUser`; **never** touches the
   borrower collateral lien on a lender consolidation (underflow).
4. **Reward / intent / metrics reassignment helpers.** Reuse where they exist:
   `LibInteractionRewards.transferLenderEntry` (lender side) + a borrower-entry
   equivalent (add if absent); the `LenderIntentVault` exposure-release path the
   lender sale already calls (`releaseIntentExposure`-style, off
   `intentOrigin`/`lenderIntentLivePrincipal`); and the `userSeen` /
   `uniqueUserCount` mark from `LibMetricsHooks`.
5. **`LibConsolidation`** — the orchestrator (§2 steps), returning a
   `ConsolidationResult` enum (`Consolidated` / `AlreadyConsolidated` /
   `Skipped`); plus the `CollateralConsolidated` event and the
   `ConsolidationNotAllowed` error (used only by the standalone wrapper, §6 D-5).
6. **A facet home for the standalone call** —
   `consolidateCollateralToHolder(uint256 loanId)` (borrower side) and
   `consolidatePrincipalToHolder(uint256 loanId)` (lender side), `whenNotPaused`,
   `nonReentrant`, Tier-1 sanctions-gated. **Status-gate the loan BEFORE the
   `ownerOf`-based holder auth** (a `require…NftOwner` first would revert on the
   burned-NFT terminal cases that must no-op): load → terminal/excluded check →
   then resolve+auth inside the primitive. A small new `ConsolidationFacet`
   (keeps `VaultFactoryFacet` under EIP-170; cf. the #647 NumeraireConfigFacet
   split). For the standalone path, a `Skipped` result surfaces as
   `ConsolidationNotAllowed` (explicit caller gets feedback); the eager hooks
   ignore the result and proceed.

Eager integration: call `LibConsolidation.consolidateToHolder(loanId, side)`
as the **very first step — before the host's own stored-anchor auth, not after
it** (Codex round-4) — of **every active mutation a current holder can drive on
a transferred position**, not just the refinance/preclose/sale paths. The
ordering matters: paths like `RepayFacet.repayPartial` call
`LibAuth.requireBorrower(loan)` (which checks the *stored* `loan.borrower`)
*before* their body, so a transferred holder would revert at that auth before
consolidation could fix the anchor. Running consolidation first re-points
`loan.borrower` to the current holder, so the host's `requireBorrower` then
passes **for the rightful holder** (and still rejects a non-holder caller —
consolidation sets the anchor from `ownerOf`, independent of `msg.sender`). If any active borrower path is left out, that
path still touches the *stored* `loan.borrower` vault and lien and re-creates
the exact borrower-pin special case this issue removes (a holder could top up,
withdraw a collateral slice, or mutate debt while the divergence persists).
The full set:
- **Borrower side:** `RefinanceFacet` (replaces the #576 borrower-pin),
  `PrecloseFacet` (`precloseDirect` / `offsetWithNewOffer` /
  `transferObligationViaOffer`), `AddCollateralFacet.addCollateral`,
  `RepayFacet` (full **and** `repayPartial`), `PartialWithdrawalFacet`, the
  **swap-to-repay** path, and the **prepay-listing creation** surfaces
  (`postPrepayListing` + the Dutch / atomic / autolist fresh-post paths) —
  these cache `s.userVaipakamVaults[loan.borrower]`, and because a *live*
  listing is then a D-3 exclusion that makes later consolidation `Skip`, the
  consolidation MUST run **before** the listing is opened (else a transferred
  holder posts a listing on the *old* vault and locks the position into a
  never-consolidatable state). Consolidate-first → the listing caches the new
  vault.
- **Both sides (consolidate borrower AND lender):**
  `RepayPeriodicFacet.settlePeriodicInterest` — its shortfall path decrements
  the active collateral lien + withdraws from `loan.borrower`'s vault, **and**
  its auto-liquidation branch pays `lenderProceeds` to the stored `loan.lender`
  (`_autoLiquidatePeriodShortfall`), so a transferred *lender* NFT would
  mis-route proceeds unless lender consolidation also runs;
  `AutoLifecycleFacet.extendLoanInPlace` — routes accrued interest between
  *both* current owners' vaults + re-registers rewards for both. These hooks
  consolidate **each side** whose NFT may have moved.
- **Lender side:** `EarlyWithdrawalFacet` (`createLoanSaleOffer` /
  `completeLoanSale`).

**Auth note (do not assume the host authenticated the holder).** Several of
these paths are *not* current-holder-gated: full `RepayFacet.repayLoan` is
intentionally permissionless (third-party payers), and `repayPartial` gates on
the *stored* `loan.borrower`, not the current NFT owner. The eager hook does
**not** rely on the host's auth — `consolidateToHolder` **self-resolves** the
current holder via `ownerOf` (§2 step 2) and only ever moves assets to that
rightful holder, so a third-party repayer triggering consolidation is benign
(it can only help the holder, never redirect funds). Running consolidation as
step 1 also means `repayPartial`'s subsequent `loan.borrower` gate sees the
*consolidated* holder — the intended owner — rather than the departed one.

**The eager hook must tolerate the excluded states as a SKIP, not a block.**
This is why §2 step 1 returns `Skipped` instead of reverting: `addCollateral`
explicitly accepts `FallbackPending` and is the *cure* path that transitions a
loan back to `Active` — if the eager consolidation reverted on
`FallbackPending`, it would break that cure. The hook calls the primitive,
ignores a `Skipped`/`AlreadyConsolidated` result, and lets the host operation
proceed; only a real `Consolidated` actually moved anything. (Note: a live
swap-to-repay intent (`s.intentCommits[loanId]`) is itself a D-3 exclusion —
the commit already pulled the collateral into Diamond custody and zeroed the
lien — so the swap-to-repay-*intent* paths consolidate to a `Skipped`; it is the
*direct* swap-to-repay path, with collateral still vaulted, that consolidates
for real.)

Each call site already authenticates the current holder (`requireKeeperFor` /
`requireLenderNftOwner` / `requireBorrowerNftOwner`), so the primitive's
resolve step is consistent with the gate that precedes it, and the no-op fast
path (§2 step 2) makes the added calls free on non-transferred loans. (A
defensive alternative — gate these paths to *require* prior consolidation
rather than auto-running it — was considered; auto-run is preferred so a holder
never has to pre-call, matching D-1.)

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
- **D-3 — Excluded states (REVISED 2026-06-20 after Codex round-1; supersedes
  the earlier "FallbackPending-without-top-up is allowed" resolution).**
  - **`FallbackPending` is excluded ENTIRELY** — not just the top-up case.
    Codex round-1 corrected the earlier scout assumption: on the path into
    fallback, `RiskFacet` / `DefaultedFacet` **already release the collateral
    lien** (`LibEncumbrance.releaseCollateralLien` marks it released + zeros the
    amount) and the collateral snapshot **sits in Diamond custody**, not in
    `loan.borrower`'s vault. So in the no-top-up case there is *no unreleased
    vault-held lien to re-key and no collateral in the borrower vault to move* —
    consolidation has nothing to do and would assert on a released lien; in the
    top-up case the #577/#585 custody split is mid-flight and the anchor must
    not move under it. Both → reject `FallbackPending`.
  - **Active loan with a live `PrepayCollateralListing`** on the position NFT
    is excluded — those listings cache and revoke Seaport order-authorisation
    against `s.userVaipakamVaults[loan.borrower]` (the *old* vault). Moving the
    collateral and rewriting `loan.borrower` while a listing is live would make
    later cancel/settle code target the new vault for an order approved from the
    old one, stranding the listing. Reject (or require the listing be
    cancelled/settled first) until consolidation-aware listing migration is
    designed — a follow-up if we want to allow it.
  - **Active loan carrying an offer-keyed parallel-sale listing**
    (`s.offerPrepayListingOrderHash[loan.offerId]`, Codex round-3) is excluded
    too — an accepted borrower offer can carry this listing *without* taking the
    loan-keyed borrower-position lock above, and its settlement path also
    authorises/settles against the old vault. The exclusion must check **both**
    the position-keyed and the offer-keyed listing.
  - **NFT-rental loans on the lender side are excluded** (Codex round-3). For a
    rental the lent ERC-721/1155 stays in `loan.lender`'s vault with borrower
    user-rights for the whole active term, and close/default paths reset/withdraw
    it via the live `loan.lender` key — so the §3.2 "principal already left the
    lender vault" premise is false here. Lender-side consolidation that just
    re-points the anchor would orphan the still-vaulted rented NFT. Until a
    rental-aware lender consolidation (which must move the rented NFT *and*
    preserve the borrower's user-rights) is designed, exclude it (`Skipped`).
    Borrower-side rental consolidation is already out of scope (D-1 there / §3.1).
  - **Active loan with a live swap-to-repay intent** (`s.intentCommits[loanId]`,
    Codex round-2) is excluded — `commitSwapToRepayIntent` already decremented
    the collateral lien to zero and pulled the full collateral into Diamond
    custody (`SwapToRepayIntentFacet`), and the cancel/fill paths restore residual
    collateral using the live `loan.borrower` key. Same shape as `FallbackPending`:
    nothing vault-held to move, and a live key the fill path depends on. Reject.
  - **Terminal states** (`Repaid` / `Settled` / `Defaulted` /
    `InternalMatched`) are **no-ops**, gated *before* `ownerOf` (§2 step 1)
    because their position NFTs may already be burned.
  - **Result-code split (Codex round-3):** *terminal* states return **`NoOp`**
    (standalone treats as benign success — an explicit consolidation of a closed
    loan is fine), while *excluded live* states return **`Skipped`** (standalone
    surfaces `ConsolidationNotAllowed`). Neither reverts inside the primitive, so
    an eager hook never blocks its host op (esp. `addCollateral`'s
    `FallbackPending` cure). Only the standalone wrapper maps `Skipped` →
    `ConsolidationNotAllowed`; `NoOp`/`AlreadyConsolidated`/`Consolidated` all
    return success (§5 / D-5).
- **D-4 — VPFI re-stamp scope (RESOLVED 2026-06-20, owner).** Call
  `rollupUserDiscount` for both vaults **unconditionally** with post-move
  balances — cheap, and correct even when the moved asset isn't VPFI (the
  rollup is a no-op when the balance is unchanged). Simplicity/correctness
  over saving two SLOADs.
- **D-5 — Authorization (REVISED 2026-06-20 after Codex round-2).** The
  **eager** path inherits the host event's existing auth + keeper action bit
  (no new permission needed). The **standalone** path is **current-holder-only**
  — *not* keeper-gated. Reason (Codex round-2): `requireKeeperFor` is action-bit
  based and the keeper mask is **already full** (`KEEPER_ACTION_*` occupy bits
  `0x01`–`0x80`, `KEEPER_ACTION_ALL = 0xFF`), so a new standalone-consolidation
  keeper permission can't be represented without widening the mask
  (`uint8`→`uint16`, a struct change) or over-authorising by reusing an
  existing bit. Rather than do either, keeper-driven consolidation rides the
  **eager hooks** (which run under each host event's own keeper bit), and the
  standalone call is holder-only. The stored (departed) owner has no claim and
  cannot call it. (If a dedicated keeper-callable standalone consolidation is
  later wanted, widening the keeper mask is the clean route — tracked as a
  follow-up, not built here.)
- **D-6 — Diamond NFT receiver is gated AND pinned, not open (Codex
  round-3/4).** During leg 1 the ERC-721/1155 contract is an **untrusted external
  call target**, so a boolean "in-flight" flag alone is insufficient — a
  malicious/non-standard token could deliver an *extra* token or batch to the
  Diamond while the flag is set and have it accepted (and stranded). The
  `ReceiverFacet` hooks therefore accept an inbound NFT only when **all** hold:
  (a) the transient `s.consolidationInFlight` flag is set; (b)
  `msg.sender == s.consolidationExpectedToken` (the exact collateral contract
  being moved); (c) the `tokenId` (and ERC-1155 `amount`) match the expected
  move. `LibConsolidation` writes the expected (token, id, amount) alongside the
  flag immediately before leg 1 and clears all of it immediately after; any
  other inbound NFT — including a second delivery from the same token — reverts.
  Rationale: there is **no** Diamond-level NFT sweep/recovery path, so a stray or
  forced NFT would strand. The window is single-move scoped (the primitive is
  `nonReentrant`).

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
   `loan.borrower == holder`; `current`'s user-loan index **appended**.
2. Eager path: transferred borrower position refinances → consolidation runs
   as step 1, refinance proceeds on the clean position; no borrower-pin.
3. No-op fast path: non-transferred loan's lifecycle event consolidates to a
   no-op (no asset move, no event), gas delta is one `ownerOf` + compare.
4. Withdraw guard holds mid-consolidation: the moved collateral is never
   free-withdrawable from either vault at any step (lien covers it throughout).
5. VPFI collateral moved → both vaults' discount tiers re-stamp to the
   post-move balances (old drops a tier, new gains one).
6. `FallbackPending` (with **and** without an active top-up) →
   `ConsolidationNotAllowed` — confirms the full exclusion (revised D-3); assert
   no attempt to re-key the already-released lien.
7. Lender side: transferred lender position, held-for-lender reservation
   re-keyed to the new holder; `loan.lender == holder`; #585 reservation
   follows.
8. Sanctioned current holder → Tier-1 revert before any move.
9. ERC-721 and ERC-1155 collateral variants move correctly via the
   **Diamond-mediated leg** (amount basis `1` / `collateralQuantity`); assert a
   *direct* vault→vault `safeTransferFrom` would have reverted on the receiver
   gate (justifies the two-leg design).
10. Double consolidation is idempotent (second call is a no-op).
11. Reentrancy: a hostile ERC-1155 collateral's `onReceived` cannot observe an
    unlien'd balance in the destination vault (lien re-keyed first, §2 step 5).
12. **Reward reassignment:** after borrower/lender consolidation, the open
    `RewardEntry` is keyed to `current` (claim/sweep credits the holder, not the
    departed owner); regression-guard the lender-sale parity.
13. **Append-only index:** `stored`'s `userLoanIds` still contains the loan
    after consolidation (historical discoverability preserved); `current`'s
    contains it exactly once (dup-protected).
14. **Metrics:** a holder with no prior protocol activity is marked
    `userSeen` / counted in `uniqueUserCount` on consolidation.
15. **Lender-intent exposure:** a lender position originated from a
    `LenderIntentVault` releases `intentOrigin` / `lenderIntentLivePrincipal`
    off the departed lender on consolidation (parity with a lender sale).
16. **Active prepay listing:** an Active loan with a live `PrepayCollateralListing`
    on the borrower NFT → `ConsolidationNotAllowed` (revised D-3).
17. **Terminal + burned NFT:** standalone call on a `Settled`/`Repaid` loan
    whose position NFT was burned takes the **no-op** path (status-gated before
    `ownerOf`), does NOT revert in `ownerOf`.
18. **Swap-to-repay intent exclusion:** Active loan with a live
    `s.intentCommits[loanId]` → standalone `ConsolidationNotAllowed`; eager hook
    returns `Skipped` and the host op proceeds (revised D-3).
19. **Cure not blocked:** `addCollateral` on a `FallbackPending` loan with a
    transferred borrower NFT runs the eager hook (returns `Skipped`, no revert)
    and the top-up cure still transitions the loan back to `Active`.
20. **Lender lien is side-specific:** `consolidatePrincipalToHolder` on a
    transferred lender NFT re-keys only the `lenderProceedsEncumbered`
    reservation and does **not** touch `loanCollateralLien` (no underflow of the
    lender's empty `encumbered` bucket).
21. **Standalone is holder-only:** a keeper calling `consolidate…ToHolder`
    directly reverts (not holder); the keeper-driven case instead succeeds via an
    eager hook under the host event's own keeper bit.
22. **ReceiverFacet gating (D-6):** the Diamond accepts an ERC-721/1155 *only*
    while `s.consolidationInFlight` is set (the NFT leg-1 succeeds); an NFT sent
    to the Diamond outside an in-flight move **reverts** (no open NFT sink).
23. **Lender side without a reservation (common case):** transferred active
    lender NFT with **no** `lenderProceedsEncumbered` row consolidates
    successfully (anchor + reward + intent), does **not** revert on the absent
    lien (§2 step 5 / f4f).
24. **Terminal → NoOp success:** standalone consolidation on a `Settled`/`Repaid`
    loan returns success (`NoOp`), **not** `ConsolidationNotAllowed` (result-code
    split, f4i).
25. **Consolidate-before-listing:** opening a prepay listing on a transferred
    borrower position consolidates first, so the listing caches the *new* vault
    (not the old one); the position is not locked out of consolidation (f4h).
26. **Offer-keyed parallel-sale listing:** an Active loan with a live
    `s.offerPrepayListingOrderHash[offerId]` → `Skipped` / `ConsolidationNotAllowed`
    (f4k).
27. **NFT leg-2 direct push:** the Diamond pushes the NFT to the dest proxy with
    no prior `approve` (operator `== Diamond`, accepted) and **no**
    `protocolTrackedVaultBalance` bump (f4n + iWB).
28. **NFT-rental lender exclusion:** a lender-side consolidation of an active
    NFT-rental position → `Skipped` (the rented NFT stays put), `loan.lender`
    unchanged (f4q).
29. **Periodic settlement, transferred lender:** `settlePeriodicInterest` on a
    transferred *lender* position consolidates the lender side too, so the
    auto-liquidation proceeds route to the current holder, not the departed
    lender (f4o).
30. **Permissionless repay:** a third-party full `repayLoan` on a transferred
    borrower position still consolidates to the rightful holder (self-resolved
    `ownerOf`), and `repayPartial`'s `loan.borrower` gate then sees the
    consolidated holder (f4l).
31. **NFT move leaves the ERC-20 counter untouched:** an ERC-721/1155
    consolidation does not change `protocolTrackedVaultBalance` for either vault
    (assert an unrelated ERC-20 balance in the same vaults is unmoved) — iWB.
32. **Receiver pin:** a malicious collateral token that tries to deliver a
    *second* NFT (or a different tokenId) to the Diamond during leg 1 reverts;
    only the exact expected (token, id/amount) is accepted — iWE / D-6.
33. **Auth ordering:** `repayPartial` on a transferred borrower position
    succeeds because consolidation runs **before** `requireBorrower` (the
    stored-anchor auth then sees the holder); a **non-holder** caller still
    reverts (anchor set from `ownerOf`, not `msg.sender`) — iWF.

---

## 9. Phasing / PR plan

One design doc (this), then implementation in dependency order:

1. **PR 1 — primitive + standalone borrower path.** `ReceiverFacet` (Diamond NFT
   hooks, **gated + pinned** to the expected in-flight token, D-6),
   `_moveBetweenVaults` (leg-2 direct-push; ERC-20-only `protocolTrackedVaultBalance`,
   no counter touch for NFTs — iWB), `LibEncumbrance.rekeyLienToHolder`
   (side-specific, lender-conditional), the borrower reward-entry reassignment +
   metrics mark, `LibConsolidation` (returns `ConsolidationResult`:
   `Consolidated`/`AlreadyConsolidated`/`NoOp`/`Skipped`), `ConsolidationFacet`
   (borrower side, holder-only standalone, status-gate before auth), with the D-3
   exclusions (FallbackPending + position-keyed **and** offer-keyed prepay
   listing + live swap-to-repay intent + terminal→NoOp-before-`ownerOf`). Tests
   1/3/4/5/6/8/9/10/11/12/13/14/16/17/18/21/22/24/26/27/31/32. ABI re-export (new
   facets + selectors + error/event) + deploy-sanity (`DiamondFacetNames` +
   `SelectorCoverageTest` for `ReceiverFacet` + `ConsolidationFacet`).
2. **PR 2 — eager borrower integration (ALL active borrower mutations).** Wire
   `RefinanceFacet` (remove the #576 borrower-pin), `PrecloseFacet`,
   `AddCollateralFacet` (skip-not-block on cure), `RepayFacet` (full + partial,
   self-resolved holder — f4l), `PartialWithdrawalFacet`, swap-to-repay, the
   **prepay-listing creation** surfaces (consolidate-before-listing, f4h), and the
   **both-side** hooks `RepayPeriodicFacet.settlePeriodicInterest` +
   `AutoLifecycleFacet.extendLoanInPlace`. Consolidation is inserted **before**
   each host's stored-anchor auth (iWF). Tests 2/19/25/29/30/33 (+ a per-path
   transferred-position regression so no active path preserves the pin).
3. **PR 3 — lender side.** `consolidatePrincipalToHolder` (conditional reservation
   re-key, NFT-rental exclusion) + lender reward-entry reassignment +
   `LenderIntentVault` exposure release + `EarlyWithdrawalFacet` eager wiring.
   Tests 7/15/20/23/28.

Each PR ships with its release-note fragment + the matching FunctionalSpec
update, per the per-PR docs discipline.
