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
4. `block.timestamp <= offer.expiresAt` (still a **valid, fillable** offer — the
   backstop fills a live offer, never an expired one);
5. `offer.amountFilled == 0` (genuinely unmatched — no natural counterparty took it).

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

### 4.2 Fill path (reuses `matchIntent`)

`BackstopVault.backstopFill(offerId)` — **permissionless** (every gate is an
on-chain fact, so no keeper trust / censorship surface): validates the §4 trigger,
then calls the existing `matchIntent` plumbing as the intent owner, originating a
loan **backstop-vault → borrower** within:
- **per-asset capacity cap** = the intent `maxExposure` (governance-set, NOT
  self-set as the adapter does);
- **posted backstop rate** = the intent `minRateBps` (governance-set) — the offer's
  rate must clear it, so the backstop's participation is **priced, never free**;
- **LTV ceiling** = the intent `maxInitLtvBps`;
- the existing **HF ≥ 1.5e18 + depth-tiered-LTV gate** inside `initiateLoan`.

`loan.lender = BackstopVault`; fixed rate snapshotted at init (E2). Proceeds are
swept to treasury via `withdrawBackstopToTreasury` (no auto-roll in v0 — the
backstop is a last resort, not a yield engine).

## 5. Role B — liquidator-of-last-resort (PR 2)

When an HF-liquidation's keeper swap fails, the loan goes `FallbackPending` and the
Diamond holds the collateral with a `FallbackSnapshot` split (lender / treasury /
borrower shares + oracle-priced `lenderPrincipalDue`). Scout confirms the borrower
**cure window** stays open on `FallbackPending`: `repayLoan` (RepayFacet.sol:207-211,
within grace) and `addCollateral` (AddCollateralFacet.sol:104-107, cures if HF
recovers). The backstop must **never short-circuit that** — it acts only **after**
the cure deadline elapses (or the lender has chosen to claim).

`BackstopVault.backstopAbsorb(loanId)`:
- gate: loan is `FallbackPending`, `FallbackSnapshot.active`, and the cure window
  has elapsed (the same grace deadline `repayLoan` enforces — exact expression
  confirmed against `RepayFacet` at impl time);
- pays the lender `FallbackSnapshot.lenderPrincipalDue` in the **principal asset**
  from backstop capital (makes the lender whole in cash, better than illiquid
  collateral);
- takes the custodied collateral into the backstop vault at an **oracle-bounded
  price** (oracle value minus a governance safety margin — bounds the backstop's
  basis risk; the backstop holds the collateral to sell later);
- finalizes the loan (`FallbackPending` → `Defaulted`/`Settled`) via a new
  `RiskFacet`/`ClaimFacet` hook that consumes the snapshot, preserving per-loan
  traceability and the treasury/borrower shares.

Bounded by the same per-asset capacity cap; gated by `backstopEnabled`.

## 6. Governance — timelock-asymmetric (#393 §4)

- `backstopEnabled` — master kill-switch, **default OFF**; both roles gated. (Same
  shape as the existing `lenderIntentEnabled` / range-order flags in `ProtocolConfig`.)
- Per-asset: capacity cap, posted min rate, init-LTV ceiling, absorb safety margin.
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

- **NEW:** `BackstopVaultImplementation` (adapter-shaped, no ERC-4626); the backstop
  admin/governance surface (seed/withdraw + caps + posted rate + `backstopEnabled`);
  `backstopFill` + `backstopAbsorb`; `Offer.backstopEligibleAfter` + its validation;
  one `RiskFacet`/`ClaimFacet` hook for the absorb settlement.
- **REUSED:** `VaultFactoryFacet` (vault), `LenderIntentFacet` (intents),
  `OfferMatchFacet.matchIntent` (origination), `FallbackSnapshot` + `ClaimFacet`
  (liquidator), the governance pattern, treasury balances, deploy-sanity wiring.

## 9. PR split (two sequential PRs)

- **PR 1 — auto-counterparty:** `BackstopVaultImplementation` + provisioning/governance
  (seed, caps, posted rate, `backstopEnabled`) + `Offer.backstopEligibleAfter` field +
  validation + `backstopFill` + deploy-sanity + ABI + tests. Codex full
  security-critical (fund-holding, HIGH).
- **PR 2 — liquidator-of-last-resort:** `backstopAbsorb` + the FallbackPending
  settlement hook + cure-window gate + oracle-bounded absorb + tests. Codex full
  security-critical.

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

## 11. Open questions / alternatives

1. **`backstopFill` permissionless vs keeper-gated** — recommend **permissionless**
   (every gate is on-chain-provable; removes a keeper-trust/censorship surface).
   Alternative: gate behind a dedicated keeper-action bit if a future reason emerges.
2. **Posted-rate reference** — v0 uses a **governance-set per-asset min rate**
   (intent `minRateBps`). A market-derived reference rate (#392/#400) is a later
   enhancement; v0 deliberately needs no oracle for rate.
3. **Absorb price bound** — oracle price minus a **governance safety margin**
   (haircut) so the backstop never overpays for collateral; the margin bounds its
   basis risk.
4. **Auto-roll vs sweep** — v0 **sweeps** idle proceeds to treasury (no auto-roll);
   the backstop is a last resort, not a yield engine. (Auto-roll is an adapter
   behaviour, not a backstop one.)
5. **Single backstop vault vs per-asset vaults** — v0 uses a **single** vault with
   per-asset intents (nothing to segregate among, single principal). Per-asset
   segregated vaults arrive with the v1 LP tranche (slashing isolation).
