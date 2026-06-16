# Research findings — #399: Protocol/community backstop-liquidity vault

**Card:** #399 (master sweep #401, Cluster A — third leg). **Status:** findings + verdict.
**Verdict:** **ADOPT — adapted, and sequence LAST in the cluster.** Build an opt-in,
**segregated, per-asset bounded** backstop vault as counterparty-of-last-resort + liquidator-
of-last-resort. This is the highest-E1-risk card; the segregation discipline is non-negotiable.

> No third-party product names per the sweep rule.

---

## 1. The two gaps it closes

- **(a) Unmatched offers** still wait even with a deep signed-offer book (#396) and a matcher
  (#393) — when there is genuinely no natural counterparty, nothing fills.
- **(b) Liquidation fragility** — HF-based liquidation relies on external keepers/DEX swaps that
  can fail in thin markets; today we fall back to a record-and-defer path (`RiskFacet` ≈:505 +
  fallback record on swap failure).

A backstop vault can **auto-fill** an unmatched offer within curated risk bounds and **absorb
collateral / provide exit liquidity** when a keeper swap fails — so positions still close.

## 2. Our anchors

- Unmatched offers: `OfferMatchFacet.matchOffers` (≈:145).
- Liquidation + fallback record: `RiskFacet` (≈:505) + the FallbackPending custody-split path
  (the encumbrance arc, #585/#591) — the diamond already holds liquidated collateral in custody
  on swap failure, which is exactly where a liquidator-of-last-resort would step in.
- Per-user vault model to preserve: `VaipakamVaultImplementation` — the segregation primitive
  we reuse for the backstop vault itself.

## 3. External precedent (generic descriptors) — segregation is a spectrum

Three backstop archetypes, ranked by how well they fit our no-commingling invariant:

1. **Pooled "house" model (perps venue).** A single commingled LP pool is the universal
   counterparty to every position; LPs collectively are the house and pay trader profits. Risk
   bounded by borrow/impact/funding fees keyed to open-interest skew. **AVOID** — structurally
   commingles every depositor into one trader-facing book; turns a fixed-rate P2P lender into a
   leveraged market-maker. Violates E1 outright.

2. **Shared lending pool funding isolated credit branches (leveraged-credit venue).** Passive
   LPs deposit into one ERC-4626 pool that allocates to isolated "credit suites" bounded by a
   per-branch **debt ceiling** + per-asset **quotas/gauges** + an **automated first-loss buffer**
   (retained protocol revenue protects passive lenders before they take loss). **AVOID the
   shared pool**, but **STEAL** the debt-ceiling + quota + first-loss-buffer *bounding*
   machinery.

3. **Opt-in, segregated, asset-specific backstop vaults (money-market insurance module).** The
   best fit. Backstop stakers deposit into **separate per-asset ERC-4626 `StakeToken` vaults,
   distinct from ordinary suppliers**; on a pool deficit, only the matching staked vault is
   **auto-burned (slashed)** to cover the shortfall — ordinary suppliers are never the first-loss
   layer. Bounded by a **per-asset offset / first-loss threshold the DAO covers first** (e.g. a
   fixed offset before any staker is touched), capped above by the offset + total stake.
   Stakers earn the underlying yield + a safety incentive for taking **bounded** slashing risk.
   **STEAL wholesale.**

## 4. Recommended design (money-market-insurance-module shape)

A **segregated backstop vault**, never commingled with ordinary lender/borrower deposits:

- **Funding:** a treasury seed (v0) and/or, in v1, opt-in LP deposits into a **dedicated backstop
  vault**. **Reconciling the LP tranche with E1 (important):** E1 forbids commingling ordinary
  *lending* users' principal. A backstop-LP tranche, by its nature, **does pool backstop capital
  among its own opt-in participants** — this is a **distinct, consented product** (the insurance/
  umbrella-module shape), categorically separate from the per-user lending vaults, and the
  participants knowingly accept first-loss pooling for an incentive. That is **the one explicitly-
  walled-off exception**, not a violation: ordinary lending principal is never in this pool and is
  **never slashed**. To keep even this exception out of v0, **v0 is treasury-seed-only** (no LP
  pooling at all); the consented LP tranche is a deliberate v1 decision with its own disclosure +
  audit. The tranche must be a separate contract/vault, never the lending vaults.
- **As counterparty-of-last-resort:** the backstop may auto-fill an unmatched offer within
  **curated risk bounds** — a per-asset **capacity cap** (debt-ceiling analog) + a **posted
  backstop rate** (so the backstop's participation is priced, not free) + the existing
  HF/depth-tiered-LTV gate. Settlement is **backstop-vault → borrower**, never out of a commingled
  user pool. **⚠️ The trigger must be ON-CHAIN-PROVABLE, not "the off-chain book had no match."**
  With a signed *off-chain* order book (#396), the protocol cannot prove on-chain that no
  counterparty existed — keying auto-fill on off-chain absence is unverifiable and gameable (a
  solver could suppress matches to force backstop fills at the posted rate). The trigger must be an
  on-chain fact: e.g. an **on-chain offer** (or an on-chain-recorded signed offer) that has sat
  **past an on-chain deadline** (`expiresAt`-style) with `amountFilled == 0`, or a borrower
  explicitly requesting backstop fill of their own on-chain offer. The backstop fills *on-chain
  state*, never an off-chain "we didn't find anyone" claim.
- **As liquidator-of-last-resort:** when a keeper swap fails (the FallbackPending path), the
  backstop can absorb the custodied collateral at an oracle-bounded price and make the lender
  whole, closing the position. **It MUST preserve the borrower cure window**: today a
  FallbackPending loan leaves the borrower able to `repayLoan` / `addCollateral` until the lender
  claims. The backstop is a last resort that may act only **after** that cure window has elapsed
  (or the lender has chosen to claim) — it does **not** short-circuit the borrower's right to
  cure. This plugs into the existing fallback-custody machinery from the encumbrance arc without
  altering its cure semantics.
- **Risk bounding (stolen from §3.2 + §3.3):** per-asset **offset / first-loss threshold**
  (protocol/treasury covers the first slice before backstop LPs), per-asset **capacity cap**,
  a **posted rate** that prices the risk, and an **automated first-loss buffer** fed by retained
  protocol revenue. Governed by the role-separated, timelock-asymmetric pattern (#393 §4): raise
  a cap = timelocked + guardian-revocable; lower a cap / pause = instant.
- **Tokenomics fit:** backstop incentives + the first-loss buffer route through the existing
  treasury/VPFI surfaces (`TreasuryBuyback`, fee accrual) — backstop LPs earn a share of fees +
  a safety incentive; the buffer is retained protocol revenue.

**Ethos — this is the card that most stresses E1, so the rules are hard:**
- The backstop vault **MUST NOT** hold ordinary user lending principal. Fund only from
  protocol/treasury capital or an **explicitly opt-in, clearly-segregated** backstop tranche.
- Auto-fill / last-resort actions settle as **protocol→borrower** or **backstop-vault→borrower**,
  never from a commingled user-principal pool.
- Per-loan collateral traceability survives (the lender still sees the exact collateral backing
  their loan).
- E2: backstop-originated loans carry a fixed rate snapshotted at init like any other.

## 5. Why sequence it LAST

It depends on the signed-offer book (#396) + matcher (#393) — but, per §4, the backstop triggers
on an **on-chain-provable** unmatched condition (an on-chain offer/recorded order past an on-chain
deadline with no fill), **not** on an off-chain "the book found no match" signal, which is
unverifiable and gameable. So the dependency is "the book + matcher exist and most flow settles
through them, leaving the backstop a genuine last resort on on-chain state" — not "the backstop
reads off-chain absence." It also carries the largest new audit surface (a new funded vault +
slashing/first-loss accounting + auto-counterparty origination). Ship the substrate + matcher +
aggregator first; add the backstop once the book exists to
backstop.

## 6. Open questions

1. **Treasury-seed-only v1 vs. opt-in-LP v1.** A treasury-funded backstop (no external LPs)
   sidesteps the first-loss/slashing accounting entirely for v1 and is the lowest-E1-risk start.
   Recommend **treasury-seed-only v0**, opt-in-LP tranche as v1.
2. **Pricing the posted backstop rate** — needs a credible reference rate (depends on the
   market-rate widget / depth-tiered LTV being live; ties to #392/#400).
3. **Auto-fill trigger policy** — time-since-post threshold? only within curated asset set? MEV
   on backstop fills.
4. **Slashing/first-loss accounting** (only if opt-in-LP) — per-asset offset, cap, and the
   auto-burn mechanism; large audit surface.

## 7. Spin-off implementation issues

1. **Backstop vault v0 (treasury-seeded):** segregated vault + per-asset capacity cap + posted
   rate + auto-counterparty origination (backstop→borrower) triggered on an **on-chain-provable
   unmatched condition** — an on-chain offer/order that has gone unfilled past a **dedicated
   `backstopEligibleAfter` deadline that is SEPARATE from the offer's `expiresAt`** (and strictly
   earlier): if the trigger reused `expiresAt`, the offer would already be **dead/unfillable** when
   the backstop tried to fill it. The backstop fills a *still-valid but unmatched-for-duration*
   offer, never an expired one; and **never** off-chain "no match found" (unverifiable/gameable) +
   liquidator-of-last-resort hook
   into the FallbackPending custody path that **preserves the borrower cure window** (acts only
   after the cure window elapses or the lender claims; never short-circuits repay/addCollateral).
   No external LPs, no slashing.
2. **Backstop LP tranche v1:** opt-in deposits + first-loss offset/cap + safety incentive +
   auto-burn slashing accounting. Gated on a v0 verdict + its own design doc + audit-scope
   estimate.

## 8. Sources

Official docs of the perps-venue liquidity pools, the leveraged-credit shared-pool venue, and
the money-market insurance/umbrella module (URLs in working notes; omitted per the deliverable
rule).
