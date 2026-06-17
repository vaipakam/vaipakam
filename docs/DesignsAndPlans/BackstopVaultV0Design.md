# Backstop Liquidity Vault — v0 (treasury-seed) design (#399 / #401 phase v2.5)

**Scope:** treasury-seeded **v0 only** — no external LPs, no slashing / first-loss
accounting (that is v1/v3, deliberately deferred; it is the largest audit
surface). ERC20-on-ERC20. Two roles in one cohesive design, shipped as **two
sequential PRs**:

- **Role A — counterparty-of-last-resort:** auto-fill a still-valid-but-unmatched
  on-chain borrower offer past a dedicated on-chain deadline, within
  governance-curated bounds.
- **Role B — liquidator-of-last-resort:** on a `FallbackPending` loan (keeper swap
  failed), after the borrower cure window, absorb the custodied collateral at an
  oracle-bounded price and make the lender whole — closing the position without a
  DEX swap.

**Verdict basis:** [`Research-399-BackstopLiquidityVault.md`](Research-399-BackstopLiquidityVault.md)
(ADOPT-adapted, money-market-insurance-module shape, segregation non-negotiable)
+ [`HybridIntentLayer.md`](HybridIntentLayer.md) §3.4 / §5 (sequenced as v2.5).

**Highest-E1-risk card.** The segregation discipline below is non-negotiable: the
backstop holds **only protocol/treasury capital**, never ordinary user lending
principal.

## 1. Why v0 is treasury-seed-only (no shares, no LPs)

The aggregator adapter (#398) is one-instance-**per-aggregator** + ERC-4626 because
many aggregators would otherwise commingle into one share token (E1). The backstop
v0 has a **single principal — the protocol treasury** — so:

- **No ERC-4626, no shares, no per-asset segregation needed yet.** A single
  `BackstopVault` holds multiple per-asset-pair intents; nothing is commingled
  (it is all protocol capital). Per-asset *slashing* segregation matters only once
  an opt-in LP tranche exists — that is **v1** (separate `StakeToken` vaults, own
  disclosure + audit), out of scope here.
- The v0 backstop is therefore **simpler than the adapter**: a treasury-owned
  lender contract with per-asset intents + governance caps, no share accounting.

## 2. Architecture — a standalone lender contract (reuses the adapter substrate)

The backstop is a **governance-controlled contract that IS a Vaipakam lender** —
the same proven pattern as `AggregatorAdapterImplementation`: it owns a per-user
vault (via the existing factory) and registers `LenderIntent`s. The single
behavioural difference from the adapter is **who funds it (treasury, not a
depositor) and how a fill is triggered (an on-chain-provable unmatched condition,
not keeper/depositor discretion).**

| Layer | Cardinality | Holds | Reuses |
| --- | --- | --- | --- |
| `BackstopAdminFacet` (or fold into `AdminFacet`) | one Diamond facet | seed/withdraw + per-asset caps + posted rate + `backstopEnabled` kill-switch + the backstop registry | governance pattern (#393 §4) |
| `BackstopVaultImplementation` | one shared logic (UUPS, owner = Diamond) | the code | adapter shape (minus ERC-4626) |
| Backstop `ERC1967Proxy` | **one** (single protocol principal) | treasury-seeded capital, transiently; per-asset-pair `LenderIntent`s | `VaultFactoryFacet` (its own vault), `LenderIntentFacet` |
| per-user vault | one for the backstop | the backstop's idle/proceeds custody | already UUPS |
| `LenderIntent` | one per asset-pair | the curated standing-supply bounds | Diamond storage |

Anchors confirmed by scout: `LenderIntentFacet.setLenderIntent` /
`fundLenderIntent` (LenderIntentFacet.sol:181/299), `OfferMatchFacet.matchIntent`
(OfferMatchFacet.sol:359+), `ClaimFacet.claimAsLender`, `FallbackSnapshot`
(LibVaipakam.sol:1687-1695), the `Offer` struct (LibVaipakam.sol:1285+).

## 3. Funding — treasury seed (governance only)

Treasury == Diamond today (`treasuryBalances[asset]`, `LibFacet.getTreasury`),
fees accrue into it (`LibFacet.recordTreasuryAccrual`). Seeding is a governance
move of treasury ERC20 into the backstop's intent:

- `seedBackstop(lend, coll, amount)` — ADMIN/timelock: moves `treasuryBalances[lend]`
  → BackstopVault → `fundLenderIntent(lend, coll, amount)`. The capital now sits in
  the **backstop's own vault**, liened as intent capital — segregated from every
  user vault.
- `withdrawBackstopToTreasury(lend, coll, amount)` — governance: pulls **idle**
  backstop capital back (`withdrawLenderIntentCapital` → treasury). Live capital
  (out on loans / absorbed collateral) returns to idle as loans resolve, then is
  withdrawable.

## 4. Role A — counterparty-of-last-resort (PR 1)

**On-chain-provable trigger (never an off-chain "no match found" claim — that is
unverifiable and gameable; Research-399 §4).** A borrower offer is backstop-eligible
iff ALL hold on-chain:

1. `offer.offerType == Borrower`;
2. `offer.backstopEligibleAfter != 0` (the borrower **opted in** — new field, §4.1);
3. `block.timestamp >= offer.backstopEligibleAfter` (sat unmatched long enough);
4. **`!isOfferExpired(offer)`** — reuse the shared expiry predicate (which treats
   `block.timestamp >= expiresAt` as expired), NOT a separate `<= expiresAt` check.
   A separate boundary would let the backstop gate pass at exactly `expiresAt` while
   the underlying accept/match path rejects it → a guaranteed revert (Codex #629 P3).
5. **an unfilled remainder exists** — `offer.amount + (range) − offer.amountFilled > 0`,
   NOT `amountFilled == 0`. A partial/ranged offer that took a tiny natural fill
   before `backstopEligibleAfter` would otherwise be **permanently** disqualified,
   letting a dust lender grief a borrower who opted into last-resort liquidity
   (Codex #629 P2). The backstop fills the **remaining** unfilled slice. (AON offers
   reduce to the same check — full amount or nothing.)

### 4.1 New opt-in Offer field `backstopEligibleAfter`

Add `uint64 backstopEligibleAfter` to the `Offer` struct (kept **flat** — no
sub-structing, per the viaIR stack lesson from the encumbrance arc / `reference_viair_stack_too_deep_lever`).
Set at offer creation in `OfferCreateFacet`:
- `0` ⇒ not backstop-eligible (default; the offer is filled only by natural
  counterparties / the open path).
- non-zero ⇒ validated `0 < backstopEligibleAfter < expiresAt` (so a backstop fill
  has a real window *before* the offer dies; `expiresAt` must therefore be set —
  a GTC offer with `expiresAt == 0` cannot be backstop-eligible). Pre-live, so the
  struct change is cheap; ABI re-export + deploy-sanity follow.

### 4.2 Fill path — the backstop intent MUST be self-only

**Load-bearing (Codex #629 P1): the backstop's `LenderIntent` must be registered
`requiresKeeperAuth = true` with NO external keeper approval** — exactly the
adapter's posture. `matchIntent` is **openly callable** for non-keeper-gated intents,
so a normal fillable backstop intent would let **any solver call
`matchIntent(BackstopVault, …)` directly, bypassing `backstopEligibleAfter`,
the unfilled-remainder check, and `backstopEnabled` entirely.** With the self-only
gate, the *only* caller that can invoke `matchIntent` for the backstop is
`BackstopVault.backstopFill` itself (the intent-owner self-branch in
`LibAuth.requireKeeperForPrincipal`). Every backstop fill therefore passes through
the §4 gates.

`BackstopVault.backstopFill(offerId)` — **permissionless to call** (every §4 gate is
an on-chain fact; the self-only intent means the gates can't be skipped): validates
the §4 trigger, then calls `matchIntent` as the intent owner, originating a loan
**backstop-vault → borrower** within:
- **per-asset capacity cap** = the intent `maxExposure` (governance-set, NOT
  self-set as the adapter does);
- **posted backstop rate** = the intent `minRateBps` (governance-set) — the offer's
  rate must clear it, so the backstop's participation is **priced, never free**;
- **LTV ceiling** = the intent `maxInitLtvBps`;
- the existing **HF ≥ 1.5e18 + depth-tiered-LTV gate** inside `initiateLoan`;
- the §5b collateral-quality gates.

`loan.lender = BackstopVault`; fixed rate snapshotted at init (E2).

### 4.3 Recovering proceeds (Codex #629 P1)

`withdrawBackstopToTreasury` only releases **idle** intent-capital lien — it does
**not** recover a resolved loan's principal/interest, which (like any lender) must
be claimed first. So the backstop needs the adapter's `claimAndCompound`-style path:
- `backstopClaim(loanId, retryCalls)` — keeper/governance: `claimAsLenderWithRetry`
  as the backstop (the backstop holds its own lender-position NFT, so it is the
  current owner), landing proceeds in the backstop vault, then re-funds idle (so the
  capital is withdrawable to treasury). **No auto-roll in v0** — the backstop is a
  last resort, not a yield engine; proceeds flow idle → `withdrawBackstopToTreasury`.
- A raw-balance `sweepToPrincipal(token)` (→ treasury) for any in-kind / non-underlying
  residue, mirroring the adapter.

## 5. Role B — liquidator-of-last-resort (PR 2)

When an HF-liquidation's keeper swap fails, the loan goes `FallbackPending` and the
Diamond holds the collateral with a `FallbackSnapshot` split (lender / treasury /
borrower collateral shares + oracle-priced `lenderPrincipalDue`). The borrower
**cure window** stays open: `repayLoan` (RepayFacet.sol:207-211, within grace) and
`addCollateral` (AddCollateralFacet.sol:104-107) can **reactivate** the loan until
the lender claim finalizes, and `LibVaipakam` documents that **the lender claim is
what terminates the state** (not a repay-grace deadline).

**Reframe (Codex #629 P1 ×2): Role B is LENDER-INITIATED, not a permissionless
"grace elapsed" trigger.** A permissionless absorb keyed on the repay grace deadline
would close a loan the borrower could still cure via `addCollateral`, and could pay
the *stale* `loan.lender` rather than the current lender-position NFT owner. Instead,
the backstop is a **standing cash bid** that only the **current lender-NFT owner**
can hit, *through the existing claim path*:

`claimAsLenderViaBackstop(loanId)` — a claim variant (current-NFT-owner-gated, reusing
`claimAsLender`'s ownership check) where, instead of receiving the `lenderCollateral`
**in kind**, the lender is paid **cash** from the backstop and the backstop takes that
collateral slice:
- **Gate:** loan `FallbackPending`, `FallbackSnapshot.active`, `msg.sender` is the
  current lender-position NFT owner (so it preserves the cure window exactly as the
  normal claim does — the borrower can still cure until the lender chooses to act).
- **Lender payout = the claim, in cash:** the backstop pays the lender
  `FallbackSnapshot.lenderPrincipalDue` in the **principal asset**; the lender's
  claim is satisfied. Better for the lender than holding illiquid collateral.
- **Explicit share settlement (Codex #629 P1):** the backstop takes **only the
  `lenderCollateral` slice**. `treasuryCollateral` and `borrowerCollateral` route
  through the **normal `ClaimFacet` split unchanged** — they are not swept into the
  backstop. Per-loan traceability + the treasury/borrower entitlements survive.
- **Top-up safety (Codex #629 / encumbrance arc #585/#591):** a `FallbackPending`
  loan that received a borrower `addCollateral` top-up (tracked by
  `LibVaipakam.hasActiveFallbackTopUp`) is **excluded** from `claimAsLenderViaBackstop`
  in v0 — the top-up custody split is unwind-sensitive; the lender uses the normal
  claim there. (Matches how the internal-match path excludes topped-up FallbackPending.)
- **Shortfall rule (Codex #629 P1):** let `cover = oracleValue(lenderCollateral) ×
  (1 − safetyMarginBps)`. If `cover < lenderPrincipalDue` (an **underwater** fallback),
  **revert** `BackstopUndercollateralized` — the backstop never overpays and treasury
  eats no shortfall in v0; the lender falls back to the normal in-kind claim. (A
  treasury-budgeted shortfall absorber is a deliberate later decision, not v0.)
- Finalizes the loan via the lender-claim path's existing terminal transition
  (`FallbackPending` → `Defaulted`/`Settled`), consuming only the lender slice.

### 5.1 Separate absorb-exposure accounting (Codex #629 P1)

Role B spends seeded **cash** to acquire **collateral** — it is **not** a loan
origination, so the intent's `maxExposure`/live-principal counter does not and must
not track it (there is no `intentOrigin` release path for an absorbed third-party
loan). A naive per-call check against the origination cap would let repeated absorbs
**drain all seeded cash**. So v0 adds a dedicated, per-(principal,collateral)
**`backstopAbsorbExposure` counter**:
- **incremented** by `lenderPrincipalDue` (cash out) on each `claimAsLenderViaBackstop`;
- **capped** by a governance per-asset `backstopAbsorbCap` (distinct from the Role-A
  origination `maxExposure`);
- **released** when the absorbed collateral is later liquidated/withdrawn to treasury
  (the cash comes back), mirroring how live-principal releases on loan close.

Both roles gated by `backstopEnabled`.

## 5b. Collateral-quality / adverse-selection defense (no human in the loop)

The defining risk of an **automated** counterparty: a malicious borrower posts an
offer backed by **dummy / illiquid / manipulable collateral** and walks away with
the lending asset — there is no human lender to eyeball the collateral. This is
defended in **four layers**, three of which the `matchIntent` substrate already
enforces (verified in code), plus one the backstop adds explicitly:

1. **The collateral asset is the backstop's curated choice, not the borrower's.**
   A `LenderIntent` is keyed `lenderIntent[lender][lendingAsset][collateralAsset]`
   (OfferMatchFacet.sol). `backstopFill` only fills an offer whose
   `collateralAsset` **equals the intent's vetted pair**. A borrower offering an
   arbitrary token has **no matching backstop intent** — nothing to fill. The
   borrower cannot substitute their own collateral asset.

2. **Illiquid / no-oracle / un-listed collateral is refused outright.**
   `matchIntent` derives `reqColl = LibRiskMath.minCollateralForLtvCap(...)` via the
   oracle (`_gatherUsd`). No resolvable price (illiquid / no feed) ⇒ `reqColl == 0`;
   no governance-set LTV (`capBps == 0`, not risk-listed) ⇒ `reqColl ==
   type(uint256).max`; **either reverts `LenderIntentCollateralUnresolvable`.** The
   "value illiquid collateral at $0, both parties **explicitly consent**" path is a
   **human-only** path; the backstop never reaches it — it refuses blind.

3. **Over-collateralization at the oracle price + HF ≥ 1.5e18 at init**, using the
   Phase-7b multi-venue oracle quorum + depth-tiered LTV + the liquidity
   classification ($1M volume + AMM depth) + the volatility-collapse threshold —
   which together defend the "looks liquid but is manipulable" vector.

**What the backstop adds (making the implicit defense first-class + conservative,
the listed-asset money-market posture):**

- **Governance-curated collateral allowlist.** The backstop registers intents
  **only** for vetted (lend, coll) pairs. Curation criteria: blue-chip liquid
  collateral with a robust multi-venue oracle + deep AMM + the existing risk
  params. This is the auto-fill admission gate; an un-curated asset is simply not
  a backstop pair.
- **Conservative LTV ceiling.** Backstop intents use a `maxInitLtvBps` **strictly
  below** a typical human lender's max — no discretion means a wider safety margin.
- **Re-assert liquidity at fill time.** `backstopFill` rejects if
  `checkLiquidity(collateralAsset) != Liquid` even for a once-vetted asset that has
  since lost depth (today the unresolvable-price revert covers the no-oracle case;
  an explicit live `checkLiquidity` gate also auto-refuses a *decayed/delisted*
  asset before originating).
- **Per-asset capacity cap** (the intent `maxExposure`) bounds concentration so no
  single manipulable asset can drain the backstop.

The same first three layers answer the identical question for the #398 aggregator
adapter: an aggregator only ever faces the single vetted collateral asset of its
adapter's pair, and `matchIntent` refuses unresolvable collateral for it too.

## 6. Governance — timelock-asymmetric (#393 §4)

- `backstopEnabled` — master kill-switch, **default OFF**; both roles gated. (Same
  shape as the existing `lenderIntentEnabled` / range-order flags in `ProtocolConfig`.)
- Per-asset, Role A (origination): capacity cap (= intent `maxExposure`), posted
  min rate (= `minRateBps`), conservative init-LTV ceiling (= `maxInitLtvBps`).
- Per-asset, Role B (absorb): `backstopAbsorbCap` (distinct from the origination
  cap; bounds the §5.1 `backstopAbsorbExposure` counter) + `absorbSafetyMarginBps`
  (the §5 haircut on collateral the backstop accepts).
- Asymmetric: **raise a cap = timelocked + guardian-revocable; lower a cap / pause =
  instant.** Seed / withdraw = ADMIN/timelock.

## 7. Ethos compliance

- **E1 (no commingling):** treasury-only capital; the backstop's vault is a
  *separate* per-user vault, isolated from every user vault; settles
  backstop→borrower; **no LP pooling at all in v0.**
- **E2 (fixed rate):** backstop-originated loans snapshot a fixed rate at init like
  any other loan; no live re-pricing.
- **Per-loan traceability:** the lender always sees the exact collateral backing
  their loan; on absorb, the backstop takes the custodied collateral and the loan
  closes with the snapshot consumed.

## 8. New vs. reused (minimise surface)

- **NEW:** `BackstopVaultImplementation` (adapter-shaped, no ERC-4626) with
  `backstopFill` + `backstopClaim` + `sweepToPrincipal`; the backstop admin/governance
  surface (seed/withdraw + origination caps + absorb cap/margin + posted rate +
  `backstopEnabled`); `Offer.backstopEligibleAfter` + its validation; the
  `claimAsLenderViaBackstop` claim variant in `ClaimFacet` (current-NFT-owner gated,
  cash-for-lender-slice, explicit share settlement, shortfall revert, top-up
  exclusion); the §5.1 `backstopAbsorbExposure` counter + cap.
- **REUSED:** `VaultFactoryFacet` (vault), `LenderIntentFacet` (intents,
  **self-only** for the backstop), `OfferMatchFacet.matchIntent` (origination via the
  self-branch), `FallbackSnapshot` + the `claimAsLender` ownership/terminal machinery,
  `LibVaipakam.hasActiveFallbackTopUp` (top-up exclusion), the governance pattern,
  treasury balances, deploy-sanity wiring.

## 9. PR split (two sequential PRs)

- **PR 1 — auto-counterparty:** `BackstopVaultImplementation` (self-only intent +
  `backstopFill` + `backstopClaim` + `sweepToPrincipal`) + provisioning/governance
  (seed, origination caps, posted rate, `backstopEnabled`) + `Offer.backstopEligibleAfter`
  field + validation + the unfilled-remainder/expiry trigger + deploy-sanity + ABI +
  tests. Codex full security-critical (fund-holding, HIGH).
- **PR 2 — liquidator-of-last-resort:** the `claimAsLenderViaBackstop` claim variant
  (current-NFT-owner gated, cash-for-lender-slice, explicit share settlement,
  shortfall revert, top-up exclusion) + the `backstopAbsorbExposure` counter + cap +
  `absorbSafetyMarginBps` + tests. Codex full security-critical.

Each is independently kill-switched and degrades gracefully (off ⇒ prior phase
unaffected).

## 10. Audit scope — HIGH (HybridIntentLayer §6)

Auto-counterparty origination from protocol capital; the on-chain trigger's
gameability (can a solver suppress matches to force a backstop fill? — mitigated:
the borrower opts in via `backstopEligibleAfter` and the backstop fills only its
*own* posted-rate terms, so a forced fill is still at a price the borrower
accepted); the absorb settlement's make-lender-whole correctness + cure-window
preservation; segregation (no user principal touched); governance caps. The v1 LP
tranche + slashing/first-loss accounting are a **separate doc + audit**.

## 11. Resolved decisions + remaining open questions

**Resolved (this design / Codex #629 round-1):**
- **`backstopFill` is permissionless to call, but the intent is self-only** — the
  caller is permissionless (gates are on-chain facts) while `requiresKeeperAuth =
  true` (no keeper grant) ensures only `backstopFill` can drive `matchIntent`,
  closing the open-`matchIntent` bypass.
- **Role B is lender-initiated** via `claimAsLenderViaBackstop` (not a permissionless
  grace trigger) — preserves the cure window + pays the current NFT owner.
- **Absorb shortfall = revert** (`BackstopUndercollateralized`); the backstop never
  overpays and treasury eats no shortfall in v0.
- **Separate `backstopAbsorbExposure` counter + cap** for Role B (origination
  `maxExposure` does not track cash-for-collateral absorbs).
- **No auto-roll** — v0 sweeps proceeds to treasury via `backstopClaim` → idle →
  `withdrawBackstopToTreasury`.
- **Single backstop vault** with per-asset intents (single principal — nothing to
  segregate among); per-asset segregated vaults arrive with the v1 LP tranche.

**Remaining open questions:**
1. **Posted-rate reference** — v0 uses a governance-set per-asset min rate (intent
   `minRateBps`); a market-derived rate (#392/#400) is a later enhancement (v0 needs
   no oracle for rate).
2. **`absorbSafetyMarginBps` default** — the conservative haircut on absorbed
   collateral; pick a starting value (e.g. 5–10%) at impl time, range-bounded.
3. **Treasury-budgeted shortfall absorber** — deliberately deferred past v0 (today an
   underwater fallback simply isn't backstop-absorbable); revisit with the v1 tranche.
