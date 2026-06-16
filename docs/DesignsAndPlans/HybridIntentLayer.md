# Hybrid Intent Layer — synthesis design (#301)

**Card:** #301 (synthesis of master-sweep #401 Cluster A + the aggregator/rate cards).
**Status:** design (Stage 2 of the #401 program). **Scope:** ERC-20-on-ERC-20 lending only —
**NFT-collateral lending stays pure P2P** (structurally correct for unique, oracle-less,
non-fungible collateral; see `NFTCollateralSaleAndAuction.md`).

This doc folds the five Stage-1 findings notes into one buildable, phased, audit-scoped design.
It is **additive**: a new path that coexists with the current on-chain P2P offer book and never
replaces it. Inputs:
[#393](Research-393-SharedLiquidityAllocatorAndIntentRouting.md),
[#396](Research-396-SignedOffChainOfferIntentLayer.md),
[#398](Research-398-StandardizedYieldWrapperAndOutwardAdapter.md),
[#399](Research-399-BackstopLiquidityVault.md),
[#400](Research-400-PluggableRateModel.md).

> No third-party product names per the #401 sweep rule.

---

## 1. Problem & thesis

**Problem.** Offer-driven P2P matching means a posted lend/borrow offer **waits** for a
counterparty; lender capital earns 0 until matched. That idle-capital window, plus the
new-chain/new-pair bootstrap problem and the "I want to borrow *now*" borrower-UX gap, is our
one structural disadvantage vs. pooled money-markets.

**Thesis.** We can get pool-like "always fillable" UX **without** a custody pool by making the
pool **virtual**: capital stays in per-user (or per-aggregator) vaults, and a competitive
matcher moves it vault→borrower **only at the instant of a bilateral match**. Depth comes from
(a) a gasless signed-offer book (many cheap offers), (b) auto-roll (no idle gap between loans),
and (c) an optional segregated backstop as counterparty-of-last-resort. Every layer honors the
platform ethos.

**Ethos invariants (verified in #401; binding on every layer here):**
- **E1 — no commingling.** No layer holds two Vaipakam-users' principal in one balance. The
  "pool" is virtual / just-in-time vault→borrower routing. The backstop is treasury-funded or an
  explicitly-segregated opt-in tranche, never ordinary user principal.
- **E2 — fixed rate.** A loan's rate is bound at origination and snapshotted immutably; no layer
  floats a live loan. We reject uniform-clearing-price batch settlement for exactly this reason —
  settlement is **bilateral, per-offer**.
- **E3 — committed interest.** Threaded through accept-time settlement once the floor-model
  default (#408) is decided; the intent path must carry `useFullTermInterest`.

## 2. What already exists (reuse inventory)

The intent layer is mostly *assembly of existing parts*, not green-field:

- **Range offers + matcher.** `OfferMatchFacet.previewMatch`/`matchOffers` + `LibOfferMatch`
  already do permissionless midpoint matching with a **1% LIF matcher kickback**
  (`cfgLifMatcherFeeBps`). This IS the solver-competition primitive.
- **Autonomous matcher.** The **sibling reference repo** `vaipakam-keeper-bot`
  (`src/detectors/offerMatcher.ts`, not in this tree) already scans, buckets by continuity,
  previews, and submits matches. The off-chain solver loop exists.
- **Signature-transfer pull.** `OfferCreateFacet.createOfferWithPermit` already pulls via an
  EIP-712 signature — we extend it so one signature also binds the *offer terms* (#396).
- **Per-user vaults.** `VaultFactoryFacet.getOrCreateUserVault` + `VaipakamVaultImplementation`
  give us the isolation primitive the LenderIntentVault and backstop reuse.
- **Keeper authorization.** `ProfileFacet` keeper surface (per-user opt-in + per-keeper
  per-action bitmask) already gates third-party execution.
- **Intent seed.** `SwapToRepayIntentFacet` (skeleton) + the agent's intent-swap settlement route
  prove the signed-order + off-chain-solver + on-chain-settlement pattern in-house.
- **Encumbrance sub-ledger (#407).** Per-loan liens already exist — the LenderIntentVault's
  "reserved for offer X" accounting reuses this rather than inventing a new lock.

## 3. Architecture (the four virtual-pool layers + two cross-cutting)

```
 L3  External aggregator ──ERC-4626 deposit/withdraw──► per-aggregator LenderIntentVault   [#398]
       (aggregator = ONE Vaipakam user; its depositors commingle inside the aggregator, off-Vaipakam)
            │ adapter posts signed offers + auto-rolls on the aggregator's behalf
            ▼
 L1  LenderIntentVault ── lender deposits + standing terms (asset, max LTV, min APR, max term,
       accepted collateral/KYC/country) ── the vault is the OFFERER; a solver builds concrete
       signed offers consuming its balance+terms; principal auto-rolls back on terminal close.
            │
            ▼
 L0  Signed-intent order book ── EIP-712 signed offers (lender OR borrower side), nonce-      [#396]
       cancellable, pull-at-accept solvency. Funds stay in the signer's vault until fill.
            │  competitive matcher/solver fills (reuses matchOffers + 1% LIF kickback);
            │  BILATERAL per-offer settlement → existing acceptOffer/initiateLoan (rate snapshot, E2)
            ▼
 LR  (optional) Segregated backstop ── auto-counterparty + liquidator-of-last-resort when no    [#399]
       natural counterparty exists. Treasury-seeded v0; never ordinary user principal.

 Cross-cutting:
   • Pluggable rate model (IRateModel) ── quote-time only; prices NEW offers, never live loans  [#400]
   • Governance ── role-separated, timelock-ASYMMETRIC: risk-up = timelocked+guardian-revocable;
     risk-down (lower cap / pause) = instant.
```

### 3.1 L0 — Signed-intent order book (the substrate, #396)

The dependency root. EIP-712 `SignedOffer` carrying full economic terms + `signer`/`nonce`/
`deadline`; `acceptSignedOffer(offer, sig, consent)` verifies (EOA + **EIP-1271** for contract
signers), checks nonce-live + not-expired, pulls funds (vault-backed or wallet-backed
signature-transfer with the order as witness), and routes into the existing
`acceptOffer`→`initiateLoan` path. Cancellation = on-chain nonce/order-hash invalidation + free
off-chain delete. Solvency = pull-at-accept, revert-on-insolvency, with an indexer-side
"under-funded → hidden, auto-promote when funded" filter. Range fields preserved → the matcher
and 1% kickback apply unchanged.

### 3.2 L1 — LenderIntentVault + auto-roll

A per-user (UUPS, factory-deployed, mirroring the existing vault pattern) vault holding lender
principal + **standing terms**. A solver/keeper constructs concrete signed offers consuming the
vault's balance+terms; the vault (via EIP-1271) is the signer. On a loan's terminal close
(`RepayFacet`/`PrecloseFacet`/etc.), principal flows back, immediately re-consumable — closing the
idle-capital window from weeks to seconds for active vaults. The "reserved for an open signed
offer" amount is tracked via the **encumbrance sub-ledger (#407)**, not a new lock.

**⚠️ Auto-roll must respect lender-NFT ownership.** Repayment proceeds belong to **whoever holds
the lender-position NFT at close**, not unconditionally to the original LenderIntentVault — the
lender position can be sold/transferred mid-loan (claim rights travel with the NFT, today's
invariant). So auto-roll routes into the vault **only when the vault (or its beneficial owner) is
still the current lender-NFT holder**; if the position was transferred, proceeds go to the current
holder via the normal claim path and the auto-roll is skipped for that loan. Auto-roll is an
optimization layered on top of the existing claim semantics, never a bypass of them.

**Loan-attribution constraint (design-critical).** Today `LoanFacet` attributes the loan to the
offer **creator** and mints the lender-position NFT to them; downstream claim, keeper-auth, VPFI
discount, and sanctions checks all key off that identity. If the *vault contract* is the offerer,
the lender-of-record cannot naively become the vault — claims/keeper-auth/VPFI must still resolve
to the **vault's beneficial owner** (the depositing user, or the aggregator for L3). The design
must therefore carry a `beneficialOwner` through from the signed offer into loan attribution (or
mint the lender NFT to the vault and route the vault's own claim logic to its owner). This is an
explicit v1 design item, not a free consequence of "the vault is the offerer."

### 3.3 L3 — ERC-4626 aggregator adapter (#398)

A standards-compliant ERC-4626 face over a per-aggregator LenderIntentVault: the aggregator
`deposit`/`withdraw`/`redeem`s; `totalAssets` reflects idle + **risk-adjusted** outstanding-
principal (active-loan principal marked at a haircut / written down on default, **not full face**,
and **unrealized interest excluded** — full detail + the withdrawable-vs-marked split in
[#398](Research-398-StandardizedYieldWrapperAndOutwardAdapter.md)); `maxWithdraw` reflects **idle
only**.

**Single-principal restriction (E1-critical).** The 4626 adapter must **NOT** be an open vault —
an open 4626 face would let *multiple* Vaipakam principals share one vault, the commingling E1
forbids. Each adapter is bound to **one authorized principal**: both **`deposit`/`mint` are caller-
restricted** AND the **shares are non-transferable / transfer-allowlisted** (4626 shares are
ERC-20-transferable, so gating only deposits would let the principal transfer shares and re-create
multi-principal exposure). So the ERC-4626 *interface* is exposed, but the adapter holds exactly
one beneficial principal at both the deposit and share layers. The aggregator's retail depositors
commingle *inside the aggregator*, off-Vaipakam. We adopt the interface, never the pooled-share
custody.

### 3.4 LR — Segregated backstop (#399), sequenced last

Treasury-seeded v0 (no external LPs, no slashing): a segregated vault that may auto-fill a
genuinely-unmatched offer within curated risk bounds (per-asset capacity cap + posted backstop
rate + existing HF/LTV gate) and act as liquidator-of-last-resort via the existing
FallbackPending custody path. v1 adds an opt-in, first-loss-bounded LP tranche. Never ordinary
user principal.

### 3.5 Cross-cutting — rate model (#400) & governance

`IRateModel.quoteRateBps(...)` optionally prices a new signed offer at creation; the accepted
loan snapshots the rate immutably (E2). Identity default = today's user-supplied rate.
Governance for all curated parameters (flow-cap-style auto-fill bounds, model registry, backstop
caps) uses the timelock-asymmetric pattern.

## 4. The seven #301 open questions — resolved

1. **MEV on solver competition.** v0/v1: **protocol-permissioned solvers only**, but this must be
   **a real on-chain gate, not an assumption** — note that the *legacy* `matchOffers` is
   permissionless today, so the new **`acceptSignedOffer` / signed-offer fill path must itself
   carry a solver-authorization check**. The `ProfileFacet` keeper bitmask has **no signed-fill
   action today**, so this needs a **new dedicated keeper action bit** (e.g. `KEEPER_ACTION_
   SIGNED_FILL`) the signer authorizes, OR a per-signed-offer "permissioned-fill" allowlist the
   signer sets — not a reuse of an existing action. The signed offer opts into permissioned-only
   filling; an un-opted offer can still be filled by the open legacy path. With
   permissioned fills there is no open solver market yet, so no MEV game. v2 (open solvers):
   bilateral per-offer fills with the signed rate as a hard floor mean a filler can never give the
   user worse than signed; competition drives toward the user-favorable end (Dutch-decay style on
   the *quoted offer rate*, not on a live loan). No batch, no reorder-MEV surface.
2. **Borrower-intent expiry.** Reuse the existing `expiresAt` GTT + `fillMode` (AON/IOC)
   machinery on the signed offer — order-book-style limit by default; optional rate-decay
   (Dutch) on the *new-offer quote* is a v2 enhancement via the rate model, never a live-loan
   re-price.
3. **VPFI alignment.** The intent path routes through `acceptOffer`→`initiateLoan`, so the Phase-5
   LIF/VPFI *machinery* (`LibVPFIDiscount`) is reused — BUT it is **not automatically unchanged for
   vault-backed offers**: the VPFI discount snapshot keys off the lender identity, and if the
   *vault contract* is the offerer the discount would resolve against the vault's (likely zero)
   VPFI balance, not the **beneficial owner's**. So the same `beneficialOwner` threading required
   for loan attribution (§3.2) must also drive the VPFI discount resolution — the discount accrues
   to the depositing user / aggregator, not the vault. This is an explicit v1 design item, not a
   free consequence.
4. **Failed-match gas.** Pull-at-accept + the under-funded auto-hide filter (#396) means the
   matcher only submits offers that pass `previewMatch` and are funded; a failed match reverts
   cheaply and the **solver eats its own gas** (it chose the pair) — same incentive as today's
   matcher. No user pays for a solver's bad pick.
5. **Composability with range orders.** The LenderIntentVault is essentially an **on-vault
   wrapper around the existing `Offer` struct + range fields** (Q5's first option), NOT a fresh
   model. The vault's standing terms map onto offer ranges; the solver materializes a concrete
   signed offer within them. Maximum reuse, minimum new surface.
6. **Pricing-oracle dependency.** v0 works with **user-set rates** (identity rate model) — no
   oracle needed; the signed-offer book + auto-roll alone close most of the idle-capital gap. The
   rate-model (#400) + market-rate widget enrich *quoting* later; the backstop's posted rate
   (#399) is the only piece that *needs* a credible reference rate, which is why it sequences
   last.
7. **Audit scope.** Quantified in §6.

## 5. Phased rollout

| Phase | Deliverable | New custody surface | Gated on |
| --- | --- | --- | --- |
| **v0.5** | **Signed-offer book (#396)** — EIP-712 schema, nonce registry, `acceptSignedOffer` (EOA+1271), vault/wallet solvency, indexer book | none (funds stay in existing vaults) | — |
| **v1** | **LenderIntentVault + auto-roll** — per-user intent vault, standing terms, encumbrance-tracked reservation, auto-roll on close; permissioned-solver matching | new per-user vault (reuses existing vault pattern) | v0.5 |
| **v1.5** | **ERC-4626 aggregator adapter (#398)** — outward 4626 over the LenderIntentVault | adapter only (1 vault = 1 aggregator) | v1 |
| **v2** | **Rate model (#400) + open-solver competition** — `IRateModel`, registry, Dutch-quote; opt-in open solver market | none new (pure functions) | v1.5; co-design #394 |
| **v2.5** | **Backstop (#399)** — treasury-seed v0 auto-counterparty + liquidator-of-last-resort | segregated treasury vault | v1 + reference rate |
| **v3** | **Backstop LP tranche** — opt-in first-loss-bounded LPs + slashing accounting | segregated opt-in tranche | v2.5 verdict + audit |

Each phase ships independently and degrades gracefully (turn it off → the prior phase still
works; turn the whole stack off → the current on-chain P2P book is untouched).

## 6. TVL-uplift reasoning & audit scope

**TVL-uplift (structural, not a quantified forecast).** The idle-capital window is the gap
between *offer posted* and *offer matched*; today that earns the lender 0 and shows as
non-productive TVL. The three depth mechanisms attack it directly: (a) gasless signed offers
remove the per-offer gas cost, so the book can be orders-of-magnitude deeper (more standing
supply); (b) auto-roll collapses the *between-loans* idle window from days/weeks to seconds for
active vaults — the single biggest realizable uplift, since it compounds over a vault's lifetime;
(c) the aggregator adapter taps **external** aggregated capital that won't integrate a bespoke
P2P book but will route into a standard ERC-4626 surface. A real quantified model needs live
match-latency + offer-lifetime telemetry from the indexer's loan/offer tables — an operator-data
task flagged as a follow-up, not blocking the design.

**Audit-scope estimate (new attack surface, by phase):**
- **v0.5** — *moderate*: EIP-712 domain/replay/nonce correctness, EIP-1271 signature-confusion,
  pull-at-accept solvency races, under-funded auto-promote. Self-contained, well-precedented.
- **v1** — *moderate-high*: a new fund-holding vault contract + factory; auto-roll reentrancy +
  the encumbrance-reservation accounting (reuses #407, lowering risk); solver-impersonation gated
  by a **new dedicated signed-fill keeper action bit** (the existing keeper bitmask has no
  signed-fill action — see §4.1).
- **v1.5** — *moderate*: ERC-4626 share-accounting correctness; `totalAssets` mark integrity
  (no inflation/donation attack); the 1-vault-per-aggregator isolation boundary.
- **v2.5/v3** — *high*: the backstop is the largest surface — auto-counterparty origination,
  liquidator-of-last-resort custody handoff, and (v3) first-loss/slashing accounting. This is why
  it sequences last and starts treasury-seed-only.

## 7. Consolidated spin-off implementation issues (dependency-ordered)

1. **Signed-offer book v0.5** (#396 impl) — *foundation, do first.* Includes the **signed-offer-
   aware match entry** (verify-then-materialize, reusing `LibOfferMatch` math — NOT `matchOffers`
   unchanged, which reads on-chain `s.offers` only) + the per-order-hash remaining-amount ledger
   (wallet-backed single-signature = AON-only).
2. **LenderIntentVault + auto-roll** (#393 L1). Must thread **`beneficialOwner`** into loan
   attribution / VPFI / keeper-auth (the vault is the offerer but the lender-of-record is the
   depositing user), and **auto-roll only when the vault is still the current lender-NFT holder**
   (skip + fall to the normal claim path if the position was transferred).
3. **Competitive matcher upgrade** — fill signed offers via the **signed-offer-aware match entry**
   (item 1) + 1% LIF; flow-cap bounds; gated by the **new signed-fill keeper action bit** (#393 L2).
4. **ERC-4626 aggregator adapter** (#398 outward) — single authorized depositor **+ non-
   transferable shares**; `totalAssets` risk-adjusted; `maxWithdraw` = idle only.
5. **Pluggable rate model** `IRateModel` (#400) — evaluated at **create/sign only, never at
   match/accept**; co-designed with #394.
6. **Backstop v0 (treasury-seed)** then **v1 (LP tranche)** (#399) — **on-chain-provable** unmatched
   trigger (never off-chain absence); preserve the **FallbackPending borrower cure window** before
   any backstop close.

Each carries its own focused design doc + tests + the facet-addition checklist before contracts.

## 8. Recommendation

Adopt the phased plan. **Start at v0.5 (the signed-offer book)** — it is the dependency root,
the lowest new-custody-surface phase (funds never leave existing vaults), and on its own it
already deepens the book and is the substrate everything else fills against. Checkpoint with the
maintainer before each fund-holding phase (v1 vault, v2.5 backstop) per the architecture-iteration
norm.
