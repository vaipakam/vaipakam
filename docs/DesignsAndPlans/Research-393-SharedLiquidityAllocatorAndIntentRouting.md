# Research findings — #393: Shared-liquidity allocator + aggregator / intent routing

**Card:** #393 (part of master sweep #401, Cluster A). **Status:** findings + verdict.
**Verdict:** **ADOPT — adapted.** Solve the unmatched-offer problem with a *virtual /
just-in-time* allocator + a signed-intent order book + a competitive matcher, never a
pooled-custody vault. Spin-off implementation issues proposed in §7.

> Per the sweep's neutrality rule, no third-party product names appear below — each
> external system is referenced by a generic-but-identifiable descriptor.

---

## 1. The problem (why this card exists)

Matching today is offer-driven P2P: a borrower or lender posts an **on-chain** offer and
**waits** for a counterparty / range match. Unlike a pooled money-market there is no
always-available counterparty, so offers sit unmatched and lender capital earns 0 until a
match lands. This is the platform's single biggest structural disadvantage vs. pooled
markets. #393 asks whether an allocator / aggregator / intent-routing layer can turn
"post then wait" into "post then auto-fill" **without** breaking the per-user-vault
isolation guarantee (ethos E1).

## 2. What we already have (scouted 2026-06-16, anchors verified)

The substrate for an intent/allocator layer is already substantially built:

| Surface | Anchor | What it gives us |
| --- | --- | --- |
| Offer model w/ range + fill-mode + GTT | `LibVaipakam.sol` `Offer` (≈:1253) + `offers` map (≈:2157) | `amountMax`/`interestRateBpsMax`/`collateralAmountMax` ranges, `amountFilled` partial tracking, `fillMode` (Partial/AON/IOC), `expiresAt` GTT, `useFullTermInterest`/`allowsPartialRepay` |
| On-chain offer creation | `OfferCreateFacet.createOffer` (≈:364) | mints offer, pulls assets into the **creator's own vault** |
| Signature-transfer pull | `OfferCreateFacet.createOfferWithPermit` (≈:429) | EIP-712 signature covers **the token transfer only**, NOT the offer terms — the intent itself is still a full on-chain tx |
| Range matcher (view + exec) | `OfferMatchFacet.previewMatch` (≈:115) / `matchOffers` (≈:145); `LibOfferMatch` (≈:191) | permissionless midpoint matching; **1% LIF matcher kickback** (`cfgLifMatcherFeeBps`); kill-switched on `partialFillEnabled` |
| Accept → loan init | `OfferAcceptFacet.acceptOffer` (≈:242) → `LoanFacet.initiateLoan` (≈:170) | rate written **immutably** at init; funds move lender-vault → borrower; mandatory on-chain consent |
| Per-user vault custody | `VaultFactoryFacet.getOrCreateUserVault` (≈:197); `VaipakamVaultImplementation` | one ERC1967 proxy per user; only the Diamond moves funds; **no pooled balance anywhere**; encumbrance sub-ledger (#407) guards withdrawals |
| Autonomous matcher | `vaipakam-keeper-bot/src/detectors/offerMatcher.ts` | already scans → buckets by continuity → `previewMatch` → submits `matchOffers`; caps 2000 previews / 25 matches / 90 s per tick |
| Keeper authorization | `ProfileFacet` keeper surface (≈:315–501) | per-user opt-in + per-keeper per-action bitmask + per-offer/per-loan enable |
| Intent seed (swaps) | `SwapToRepayIntentFacet` (skeleton) + the agent's intent-swap settlement route | signed-order swap-to-repay path exists in skeleton; **no EIP-712 signed-intent on the OFFER layer yet** |

**Key gap:** there is (a) no gasless signed-offer book — every offer is an on-chain tx, so
the book can't be deep; (b) no auto-roll of returned principal into a fresh offer; (c) no
standard surface for an external aggregator to route idle capital in.

## 3. External patterns researched (generic descriptors)

### 3.1 Leading isolated-lending money-market's *public allocator*
A permissionless `reallocate` router moves a curator-managed vault's idle capital between
isolated markets **just-in-time** so a borrow always finds depth; bounded by per-market
**flow caps** (`maxIn`/`maxOut`) the curator sets; caller pays a small anti-grief fee.
Governance is **role-separated with timelock asymmetry**: risk-*increasing* changes (enable
a market, raise a cap) are timelocked and guardian-revocable; risk-*reducing* changes
(lower a cap, reallocate within the approved set) are instant. **Custody is POOLED** — one
share pool, isolation only at the *market* layer.

- **STEAL:** the role-separated, timelock-asymmetric governance pattern (curator / allocator /
  guardian / owner) and the per-market **flow-cap** bound on any automated routing.
- **AVOID:** the pooled depositor share-pool — it commingles, violating E1.

### 3.2 Yield-aggregator's tokenized-strategy standard
Retail capital is aggregated into an ERC-4626 "allocator vault" that routes across child
"strategies," each itself an ERC-4626 vault on the same asset, allocated by a per-strategy
**debt / max_debt** cap a keeper rebalances. The canonical integration surface *upward* is
**ERC-4626**; the venue interface *downward* is unspecified (the strategy adapts to it).

- **STEAL:** expose a **standards-compliant ERC-4626 surface on our lender-supply side** so
  external aggregators route idle capital in/out with zero bespoke integration (this is the
  concrete answer to "how does a yield aggregator use us" — see #398). Borrow the clean
  deploy/free/harvest separation.
- **AVOID:** the pooled, commingled share accounting behind it. Adopt the *interface*, not
  the pooled-vault behavior.

### 3.3 Intent / solver settlement systems (signed intent → competitive fill)
User signs an intent off-chain (EIP-712, gasless); off-chain solvers compete; a **thin
on-chain settlement contract** validates the signature, pulls funds (signature-transfer with
the order as witness), executes, and **reverts unless every signed constraint holds**. Two
ordering-protection styles: batch with a **uniform clearing price**, or a **Dutch-decay
auction** where the signed minimum is a hard floor and competition drives the fill toward
the user-favorable end.

- **STEAL:** the **signed-intent + competitive-matcher + thin-enforce-or-revert settlement**
  split. It maps directly onto our `matchOffers` + 1% kickback + per-user-vault isolation
  (the vault acts as the "relayer" boundary the matcher never crosses).
- **AVOID:** **uniform-clearing-price batching** — pooling many offers and clearing at one
  price re-commingles risk and erases the bilateral, per-counterparty fixed terms a
  no-commingling P2P lender exists to preserve. Keep settlement **bilateral, per-offer**.

### 3.4 Signed off-chain offer books for P2P (NFT/asset) lending
The closest precedent to us: lender/borrower **signs loan terms off-chain (EIP-712)**, the
counterparty accepts **on-chain**, origination atomically pulls the lender's ERC20 and
escrows collateral in one tx. Cancellation = **on-chain nonce / order-hash invalidation**
(gas, secure) with a free off-chain delete as UX sugar. Solvency is **pull-at-accept**:
`transferFrom` against a standing allowance, and the whole origination **reverts if the
lender is under-funded** — so a borrower can never accept an insolvent offer. One venue adds
"under-funded offer stays hidden, auto-promotes to active when the wallet is funded."

- **STEAL (most directly applicable):** the full triad — (1) EIP-712 signed off-chain offers
  as the order book (zero gas to post, gas only on fill), (2) on-chain nonce/order-hash
  cancellation + free off-chain delete, (3) **pull-at-accept solvency** with revert-on-
  insolvency, plus the "under-funded → auto-promote when funded" filter. This preserves E1:
  funds stay in the signer's own vault/wallet until the exact origination instant. **This is
  card #396** — and it is the *substrate* this whole card routes against.
- **AVOID:** the perpetual / no-expiry / no-oracle + rate-auction-unwind model some venues
  use — it removes fixed duration and oracle-priced health, fighting our fixed-rate,
  HF-gated design.

## 4. Recommended architecture (adapted — honors E1/E2/E3)

A **three-layer, opt-in, additive** stack that sits *on top of* the existing P2P offer book
and never replaces it. Each layer is independently shippable and degrades gracefully.

```
 Layer 3  External aggregator  ──ERC-4626 deposit/withdraw──►  per-aggregator LenderIntentVault
          (one vault = one "user"; commingling lives INSIDE the aggregator, never in Vaipakam)   [#398]
              │ posts/*auto-rolls* signed offers on the aggregator's behalf
              ▼
 Layer 2  Signed-intent order book  ── EIP-712 offers, nonce-cancellable, pull-at-accept ──      [#396]
          Competitive matcher/solver competes to fill; bilateral per-offer settlement;
          reuses matchOffers + 1% LIF kickback; funds stay in signer's vault until fill.
              │ on a match → existing acceptOffer/initiateLoan path (rate snapshotted, E2)
              ▼
 Layer 1  Auto-roll on settlement  ── returned principal flows back into a re-offerable        [this card]
          LenderIntentVault, immediately consumable for the next signed offer.
              │ when no natural counterparty exists →
              ▼
          (optional) protocol/treasury-funded BACKSTOP as auto-counterparty of last resort    [#399]
          — segregated, NOT user principal.
```

**Why this shape and not a pool:** every external system that achieves "always-available
liquidity" does it by **commingling depositor capital into a share pool** (§3.1, §3.2). We
cannot — E1 forbids it. The adaptation is to make the "pool" **virtual**: capital stays in
per-user (or per-aggregator) vaults, and a *router/matcher* moves it vault→borrower **only at
the instant of a bilateral match**. The deepness comes from a **gasless signed-offer book**
(many cheap offers) + **auto-roll** (no idle gap between loans), not from a custody pool.

**Ethos compliance:**
- **E1 (no commingling):** no layer holds two users' principal in one balance. The aggregator
  adapter is a single Vaipakam "user"; its internal pooling is the aggregator's own concern,
  off-Vaipakam. The matcher is a relayer that never custodies funds. The backstop (#399) is
  protocol/treasury-funded or an explicitly-segregated tranche.
- **E2 (fixed rate):** the rate is bound in the signed offer and snapshotted immutably at
  `initiateLoan`; no layer floats a live loan's rate. We **reject** uniform-clearing-price
  batching precisely because it would erase per-loan fixed rates.
- **E3 (committed interest):** carried through accept-time settlement once the floor-model
  default (#408) is decided; the intent layer must thread `useFullTermInterest`.

**Governance:** adopt the role-separated, timelock-asymmetric pattern from §3.1 for any
curated allocator parameters (flow-cap-style bounds on auto-fill, per-asset risk curation):
risk-increasing = timelocked + guardian-revocable; risk-reducing = instant. This reuses our
existing `GovernanceConfigDesign` + timelock without touching custody.

## 5. What to take / decide (the card's explicit ask)

- **Introduce an allocator/intent layer?** **Yes — but as the three additive layers above,
  on TOP of the P2P book, never replacing it.**
- **Does it sit on top of the offer book?** Yes; the signed-offer book (#396) IS the book the
  router fills, and the existing on-chain `Offer` path remains the fallback substrate.
- **Risk-curation/parameterization:** map onto existing per-asset risk params (HF gate /
  depth-tiered LTV) + new flow-cap-style bounds on automated fill, governed by the timelock-
  asymmetric pattern.
- **Custody/trust:** preserved by keeping the "pool" virtual (just-in-time vault→borrower
  routing) — the load-bearing adaptation that lets us get pool-like UX without pool custody.

## 6. Relationship to the rest of the cluster

- **#396** (signed off-chain offers) is the **substrate** — it should be researched/built
  *first*; everything here routes against it. (Findings next.)
- **#399** (backstop vault) is the **liquidity-of-last-resort leg** — the auto-counterparty
  when no natural one exists; highest E1 risk, must be segregated. (Findings pending the
  backstop research.)
- **#398** (ERC-4626 outward) is **Layer 3** — the concrete aggregator plug-in.
- **#400** (pluggable rate model) is the **quote side** of a keeper-"AMM" — a rate curve that
  prices new offers, never re-pricing a live loan.
- **#301** (hybrid intent investigation) is the **synthesis** that folds these into one
  buildable, phased, audit-scoped design (`HybridIntentLayer.md`).

## 7. Proposed spin-off implementation issues (after cluster verdict)

1. **Signed-offer book** (the #396 implementation): EIP-712 `Offer` intent schema + on-chain
   nonce registry **+ a per-order-hash remaining-amount ledger for partial fills** (a boolean
   nonce-used flag is AON-only) + cancel + pull-at-accept solvency where **wallet-backed
   (signature-transfer) is AON-only and partial fills require the vault-backed path** + under-
   funded auto-promote. *Foundation — do first.* (Full constraint list in #396.)
2. **Auto-roll LenderIntentVault**: per-user (and per-aggregator) intent vault that re-posts a
   signed offer when principal returns on terminal close — **but only when the vault is still the
   current lender-NFT holder** (positions transfer mid-loan; if transferred, proceeds go to the
   current holder via the normal claim path and auto-roll is skipped). Thread `beneficialOwner`
   into attribution/VPFI/keeper-auth.
3. **Competitive matcher upgrade**: a **signed-offer-aware match entry** (verify-then-materialize,
   reusing `LibOfferMatch` math — `matchOffers` itself reads on-chain `s.offers` only, so it can't
   fill a signed off-chain offer unchanged) with the existing 1% LIF kickback; bilateral per-offer
   settlement; flow-cap-bounded auto-fill; gated by a new signed-fill keeper action bit.
4. **ERC-4626 aggregator adapter** (the #398 implementation): outward 4626 surface over a
   LenderIntentVault so external aggregators route idle capital in/out.
5. **(Gated on #399 verdict) Segregated backstop** as auto-counterparty of last resort.

Acceptance for each: a design doc + tests + the usual facet-addition checklist; built in the
dependency order above (substrate → auto-roll → matcher → aggregator → backstop).

## 8. Sources

Official docs/repos of: the isolated-lending public-allocator + meta-vault system; the
yield-aggregator tokenized-strategy standard; the intent/solver swap-settlement systems; the
signed-offer P2P lending venues. (URLs retained in the research working notes; omitted here
per the no-third-party-names deliverable rule.)
