# Research findings — #398: Standardized-yield wrapper — and the ERC-4626 *outward* adapter

**Card:** #398 (master sweep #401, Cluster C, but the aggregator-integration angle ties it to
Cluster A). **Status:** findings + verdict.
**Verdict — two distinct questions, two answers:**
- **Inward** (a standardized-yield wrapper for yield-bearing *collateral*): **SKIP as a core
  abstraction; thin per-asset adapter only if/when we onboard many yield-bearing collateral
  types.** (Confirms the card's hypothesis.)
- **Outward** (expose a standards-compliant **ERC-4626 lender surface** so external aggregators
  route idle capital into us): **ADOPT — this is Layer 3 of #393 and the concrete answer to
  "how does a yield aggregator use our platform."**

> No third-party product names per the sweep rule.

---

## 1. The card asked one question; T-093 surfaced a second

The card as filed asks the **inward** question: do we need a standardized-yield wrapper to
handle yield-bearing *collateral* uniformly? The T-093 driver ("how do aggregators use us?")
surfaces the **outward** question: what interface must *we* expose so an external yield
aggregator's strategy can deposit lender capital into us? They share the ERC-4626 standard but
are opposite directions of integration. Both are answered here.

## 2. Inward — yield-bearing collateral wrapper: SKIP (thin-adapter-only)

- **What we are:** a P2P collateralized-lending + NFT-rental platform, not a yield-tokenization
  protocol. Asset handling assumes plain ERC-20/721/1155 collateral (`OracleFacet` pricing/
  classification ≈:132; `VaipakamVaultImplementation` custody). No yield-accounting wrapper.
- **Do we need it?** No, not as a core abstraction. A standardized-yield wrapper standard earns
  its keep when a protocol must treat *many heterogeneous yield sources uniformly* downstream —
  which is a yield-tokenization use case, not ours. For us, yield-bearing collateral is an *edge*
  case, not the core flow.
- **If yield-bearing collateral accrues while escrowed**, the question is *who gets the yield*
  (borrower / lender / protocol). That's a **policy** decision, not a wrapper-standard problem; a
  thin per-asset adapter that routes accrued yield per policy is sufficient and far less audit
  surface than adopting a whole wrapper standard.
- **Verdict:** **don't need it.** Revisit only if we onboard a *class* of yield-bearing
  collateral broad enough that per-asset adapters become unmanageable — then a thin internal
  adapter interface, not a full external standard. Pairs with #397 (fixed-maturity principal
  tokens as collateral): if #397 adopts, it may justify the thin adapter; on its own it does not.

## 3. Outward — ERC-4626 lender surface: ADOPT (Layer 3 of #393)

This is the direct, concrete mechanism by which an external aggregator "uses" us.

- **How external aggregators integrate (researched, generic):** a yield aggregator pools retail
  capital into an ERC-4626 "allocator vault" and routes it across child "strategies," each
  itself an **ERC-4626 vault on the same asset**, allocated via a per-strategy debt/cap a keeper
  rebalances. **ERC-4626 is the canonical integration surface *upward*** (vault ↔ strategy). A
  strategy targeting an external venue adapts to whatever that venue exposes — so **the lowest-
  friction thing we can offer is a standards-compliant ERC-4626 surface** an aggregator's
  strategy deposits into with zero bespoke integration. The clean `deployFunds` / `freeFunds` /
  `harvestAndReport` separation is worth borrowing as our deposit / withdraw / mark split.
- **The recommended shape — a per-aggregator `LenderIntentVault` with a 4626 face:**
  - An aggregator deploys (or is assigned) a **single Vaipakam vault** that exposes ERC-4626
    `deposit/withdraw/redeem/totalAssets`. The aggregator's strategy treats it as a yield venue.
  - Internally, the adapter takes deposited principal and **programmatically posts signed offers**
    (#396) on the aggregator's behalf, **auto-rolls** returned principal on terminal close
    (#393 Layer 1), and marks `totalAssets` = idle + outstanding-principal + accrued-interest.
  - **`harvestAndReport`-equivalent**: surfaces accrued interest so the aggregator's share price
    reflects yield, matching the standard the aggregator already speaks.
- **Why this preserves E1 (the load-bearing point):** from Vaipakam's view the aggregator is a
  **single "user" = one vault proxy**. All commingling of the aggregator's retail depositors
  happens **inside the aggregator, off-Vaipakam**. We never hold two Vaipakam-users' principal in
  one balance. We adopt the aggregator's *interface*, never its pooled-share *custody behavior* —
  the documented anti-pattern (every external aggregator/allocator commingles depositors into one
  share pool; we must not).
- **E2:** each offer the adapter posts binds a fixed rate, snapshotted immutably at loan init.
  The aggregator's 4626 share price floats with realized interest, but **no live loan's rate ever
  floats** — the float is in the aggregator's bookkeeping, not in our loan terms.

## 4. Relationship + sequencing

- Depends on **#396** (signed offers) — the adapter posts signed offers — and the **auto-roll
  LenderIntentVault** (#393 Layer 1). So sequence: #396 → auto-roll vault → **#398 outward
  adapter**.
- EIP-1271 (from #396 §5) is required so the adapter contract can *sign* offers; design it in
  from day one.
- The inward thin-adapter is independent and deferred (revisit with #397).

## 5. Spin-off implementation issues

1. **(Outward) ERC-4626 LenderIntent adapter:** a 4626 face over a per-aggregator
   LenderIntentVault that posts signed offers + auto-rolls + marks `totalAssets`. = item #4 of
   #393's spin-off list. Gated on #396 + auto-roll vault.
2. **(Inward) Deferred** — no issue spun off now; revisit only if #397 adopts or a broad
   yield-bearing-collateral class lands.

## 6. Sources

Official docs/repos of the yield-aggregator tokenized-strategy standard and ERC-4626 (URLs in
working notes; omitted per the deliverable rule).
