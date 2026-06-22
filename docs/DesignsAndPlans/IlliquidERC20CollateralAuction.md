# Illiquid ERC20 Collateral Auction via CoW Protocol (#686)

**Status:** Design — pending ratification. Implementation deferred to follow-up
PR(s) once this doc is approved.
**Card:** #686 (`enhancement, security, audit`) · part of the broader
collateral-disposal family alongside
[`NFTCollateralSaleAndAuction.md`](NFTCollateralSaleAndAuction.md).
**Author:** Vaipakam Developer Team · 2026-06-22.

---

## 1. Goal

Close the one collateral class that today falls off a cliff on default:
**illiquid ERC20 collateral** — tokens with no Chainlink feed / no AMM depth, the
class the 0x/1inch aggregator path structurally cannot route. Instead of dumping
the raw tokens on the lender, auction them via **CoW Protocol** with a guaranteed
reserve floor (= outstanding debt) and surplus returned to the borrower — exactly
the value-return guarantee the liquid-ERC20 and NFT paths already give.

The lender is **never worse off than today**: if no solver fills within a bounded
window, disposal falls back to the current raw-transfer-to-lender behaviour.

---

## 2. Current behaviour — the illiquid cliff

`DefaultedFacet.triggerDefault` disposes of collateral three ways
([`DefaultedFacet.sol`](../../contracts/src/facets/DefaultedFacet.sol)):

| Collateral | Default disposal | Surplus to borrower? |
| --- | --- | --- |
| Liquid ERC20 | 0x/1inch swap (`LibSwap.swapWithFailover`) → proceeds split via waterfall (L393–473) | ✅ yes |
| NFT (ERC721/1155) | Seaport pre-default listing (`NFTPrepayListingFacet` + executor) | ✅ yes |
| **Illiquid ERC20** | **raw tokens `safeTransfer`'d to the lender's vault** (illiquid branch, L483–507) | ❌ **nothing** |

The illiquid branch (L483–507) fires when
`liquidity == Illiquid && loan.riskAndTermsConsentFromBoth` (or a liquid token
whose value has collapsed). It withdraws the collateral from the borrower's vault
and `safeTransfer`s it straight to the lender's vault — the lender is force-fed a
long-tail token they must offload themselves, and the borrower forfeits **all**
value above the debt.

Why the existing machinery doesn't already cover it:

- **Aggregator swap path** — an illiquid token has, by definition, no DEX route to
  aggregate; `LibSwap.swapWithFailover` would fail every adapter.
- **Seaport NFT path** — blocks ERC20 offer items at three layers
  (`NFTPrepayListingFacet` guard, `LibPrepayOrder._componentsAtMemory` offer
  builder, `CollateralListingExecutor.validateOrder` →
  `UnsupportedCollateralAssetType`).

---

## 3. Venue choice — why CoW (condensed)

Full survey in the #686 card. Summary of why each alternative was rejected and
CoW chosen:

- **OpenSea** — auctions are NFT-only; ERC20 is swap-only via DEX aggregators →
  structurally fails on illiquid tokens. Dead end.
- **Uniswap token auctions (CCA)** — token-launch / liquidity-bootstrap primitive,
  no reserve price, auto-creates a v4 LP at clearing price (we want repayment
  cash, not an LP). Rejected.
- **Bounce Finance** — right auction types but launchpad-oriented + own
  platform/governance-token trust surface. Disproportionate. Rejected.
- **Seaport (already integrated)** — asset-agnostic, Dutch mode works for ERC20,
  symmetric with the NFT path — but **passive** (no buyer discovery; we'd source
  buyers ourselves). Viable fallback, not primary.
- **CoW Protocol — chosen.** Intent-based settlement with a solver network that
  actively hunts fills across DEXs + private MM inventory + Coincidence-of-Wants +
  ring trades. Native surplus capture, MEV protection, ERC-1271 / ComposableCoW
  composability. Battle-tested by Aave/ENS treasuries.

**Key architectural insight:** CoW integrates like the **existing 0x/1inch
liquidation path** (sell collateral → receive principal proceeds → split via the
waterfall), **not** like the Seaport atomic-consideration path. It is the natural
*successor* to the aggregator swap path for tokens aggregators can't route — the
new surface is order-placement + lifecycle; value-routing is reused verbatim.

---

## 4. Ratified decisions (2026-06-22)

1. **Chain coverage — uniform CoW, no gating.** CoW's core contracts
   (`GPv2Settlement` `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`,
   `GPv2VaultRelayer` `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`) are deployed
   at **deterministic addresses on every Vaipakam Phase-1 chain** — Ethereum,
   Base, Arbitrum, **Optimism, BNB Chain** — plus Polygon/Avalanche/Gnosis/others.
   So CoW applies uniformly; there is no per-chain alternate venue.
   *(An earlier draft believed CoW was absent on OP/BNB — corrected against CoW's
   official contract-deployments page on 2026-06-22.)*
2. **Raw-transfer-to-lender is the no-fill terminal fallback** (Tier-3), not a
   per-chain branch — it fires only when no solver fills within the disposal
   window. This preserves the "lender never worse off than today" guarantee
   everywhere.
3. **Consent reuses the existing `loan.riskAndTermsConsentFromBoth`** flag — the
   illiquid default branch already requires both-sides consent. No new offer flag;
   CoW becomes the **default** illiquid-disposal engine for consenting loans.
   Because the no-fill fallback is the existing raw-transfer, an already-consenting
   lender is strictly better off (auction-with-surplus, or the same outcome on
   no-fill) — so reusing the flag does not degrade what they signed up for.
4. **Design doc first**, implementation in follow-up PR(s).

---

## 5. Architecture — async disposal lifecycle

CoW is **asynchronous**: a solver fills the order later, off the default-trigger
transaction. So CoW **cannot** be a synchronous `LibSwap` adapter (those execute
inline inside `triggerDefault`). Disposal shifts from "raw-transfer immediately"
to a **place → settle-later → expire-to-fallback** lifecycle that mirrors the
Seaport prepay-listing flow
([`NFTPrepayListingFacet.cancelExpiredPrepayListing`](../../contracts/src/facets/NFTPrepayListingFacet.sol)).

```
                         default eligible (post-grace)
                                    │
              consent + illiquid + CoW-capable chain?
                    │ yes                         │ no  (or no consent)
                    ▼                             ▼
        ┌───────────────────────────┐   ┌──────────────────────────┐
        │ PLACE CoW limit order      │   │ Tier-3: raw-transfer      │
        │ sell=collateral            │   │ collateral → lender vault │
        │ buy=principalAsset         │   │ (today's behaviour)       │
        │ minOut=outstanding debt    │   └──────────────────────────┘
        │ receiver=Diamond           │
        │ valid until window expiry  │
        │ loan → AwaitingCoWFill     │
        └───────────────────────────┘
                    │
        ┌───────────┴────────────────────────────┐
        │ solver fills                            │ window expires, no fill
        ▼                                         ▼
 ┌──────────────────────────┐         ┌───────────────────────────────┐
 │ principalAsset → Diamond  │         │ permissionless cleanup:        │
 │ run REUSED waterfall:     │         │  - cancel/expire CoW order     │
 │  debt → lender            │         │  - Tier-3 raw-transfer to      │
 │  fee  → treasury          │         │    lender (no-fill fallback)   │
 │  surplus → borrower       │         │ loan → Defaulted (in-kind)     │
 │  + VPFI encumbrance       │         └───────────────────────────────┘
 │ loan → Defaulted/Settled  │
 └──────────────────────────┘
```

### 5.1 Disposal tiers (revised for uniform CoW)

| Tier | Token state | Engine | Surplus to borrower |
| --- | --- | --- | --- |
| 1 | Liquid (oracle + AMM depth) | 0x/1inch synchronous swap (existing, unchanged) | ✅ |
| 2 | Illiquid + both-sides consent | **CoW limit order** (min = debt; receiver = Diamond → reused waterfall) | ✅ (on fill) |
| 3 | No fill within window, **or** no consent | raw-transfer collateral → lender (today's behaviour) | ❌ (lender takes the token) |

Liquidity tier is decided by the existing
[`OracleFacet.checkLiquidity`](../../contracts/src/facets/OracleFacet.sol)
(`Liquid` / `Illiquid` binary, fail-closed). Tier 1 = `Liquid`; Tier 2/3 =
`Illiquid`. No new classification is required — Tier-2-vs-3 is decided by
*fill outcome*, not by a finer depth tier.

---

## 6. Integration primitives (what to reuse vs. build)

### 6.1 Reuse verbatim

- **Reserve floor = outstanding debt** — `principal + accruedInterest + lateFee`,
  computed exactly as the liquid branch does (`DefaultedFacet` L393–397). This is
  the CoW order's `minOut` (`buyAmount`).
- **Proceeds waterfall** — the liquid branch's split (L408–473): debt → lender,
  `LibEntitlement.splitTreasury` 1% interest cut + 2% handling fee → treasury,
  remainder surplus → borrower.
- **VPFI reservation hooks** — `LibEncumbrance.encumberLenderProceeds` (#592) and
  `encumberBorrowerProceeds` (#661) on the respective legs when the principal
  asset is VPFI, identical to the liquid branch (L456–473).
- **Vault custody + ERC-1271 binding pattern** — the per-user vault already
  implements `isValidSignature` delegating to a pinned executor via an
  `orderHash → executor` mapping (`registerListingOrderHash`,
  [`VaipakamVaultImplementation.sol`](../../contracts/src/VaipakamVaultImplementation.sol)
  L392–455). CoW order authorization uses the same shape.
- **Async window + permissionless fallback** — the grace-expiry cleanup pattern
  (`cancelExpiredPrepayListing`, no-fund-movement, runs even while paused) is the
  template for the CoW no-fill fallback.

### 6.2 New surface to build

- **`CoWAuctionExecutor`** — a CoW analog of `CollateralListingExecutor`. Records
  the CoW `GPv2Order` digest for a loan, exposes `isOrderValid(digest)` (valid iff
  recorded + loan still in `AwaitingCoWFill` + window not expired), and is the
  contract the vault's `isValidSignature` delegates to for CoW order digests.
  ComposableCoW reads this through the vault's ERC-1271.
- **CoW order construction** — a plain fixed-minimum limit order (NOT Milkman's
  oracle price-checker: a no-feed token has nothing to check against). `sellToken =
  collateral`, `buyToken = principalAsset`, `sellAmount = collateralAmount`,
  `buyAmount = reserveFloor (= debt)`, `receiver = Diamond`, `validTo = window
  end`, `kind = sell`, `partiallyFillable = false` (v1 — see §7), `appData`
  pinned. Optionally TWAP-sliced for large lots via ComposableCoW (deferred to
  v1.1; see §10).
- **`DefaultedFacet` illiquid-branch rewrite** — replace the immediate
  raw-transfer (for the consent + CoW-capable case) with: withdraw collateral into
  Diamond custody (or grant the relayer allowance from the vault), place the CoW
  order, set `loan.status = AwaitingCoWFill`, store the order digest + window end.
- **Settlement entry** — a `settleCoWFill(loanId)` (or post-fill claim) that runs
  once the Diamond has received `principalAsset` from the relayer: assert receipt
  ≥ reserve floor, run the reused waterfall, transition the loan terminal.
- **No-fill fallback entry** — a permissionless `cancelExpiredCoWAuction(loanId)`
  that, after `validTo`, revokes the relayer allowance / clears the binding and
  executes the Tier-3 raw-transfer, transitioning the loan to `Defaulted` in-kind.
- **CoW address config** — `GPv2Settlement` + `GPv2VaultRelayer` addresses
  (deterministic, same on every chain) set via `AdminFacet`, with a per-chain
  presence check (defense-in-depth, even though deterministic).

---

## 7. Lifecycle, state, and storage

- **New loan status `AwaitingCoWFill`** (append to the `LoanStatus` enum — enum
  append is layout-safe and doesn't trip the selector-coverage guard). Distinguishes
  "default triggered, collateral out for auction" from `Defaulted` (terminal).
- **Per-loan auction record** (new `LibVaipakam.Storage` mapping, appended):
  `{ bytes32 cowOrderDigest; uint64 validTo; uint256 reserveFloor; address principalAsset; }`
  keyed by `loanId`. `reserveFloor` is **snapshotted at placement** (see §8).
- **Reentrancy + pause** — placement runs inside the `nonReentrant` default
  trigger. The no-fill fallback follows the prepay precedent: **no `whenNotPaused`**
  (it's a no-fund-movement-or-safe-recovery path so a paused diamond can't trap
  collateral). The settlement entry **is** `nonReentrant` and gated to a live
  `AwaitingCoWFill` loan.
- **Exclusion from other paths** — while `AwaitingCoWFill`, the loan must be
  excluded from re-default / re-liquidation / consolidation (mirror the
  `FallbackPending` exclusion in `LibConsolidation._isExcludedLive`).

---

## 8. Reserve floor & interest accrual during the window

**Decision to ratify:** snapshot the reserve floor (= debt incl. accrued interest
+ late fee) **at order-placement time** and hold it fixed for the window.

Rationale: if the floor kept growing with interest during the disposal window, the
CoW `buyAmount` would rise, lowering fill odds the longer it sits unfilled — the
opposite of what we want for a token that's already hard to sell. Pinning the
floor at placement gives the solver a stable target and a clean surplus split
(`received − pinnedFloor` → borrower). Interest/late-fee accrual stops at
placement (the loan is already defaulted; the collateral is committed to disposal).

This matches the liquid path's behaviour, which also computes the debt once at
disposal time and splits against that snapshot.

---

## 9. No-fill fallback — preserving the current guarantee

If `validTo` passes with no fill, `cancelExpiredCoWAuction(loanId)` (permissionless,
mirrors `cancelExpiredPrepayListing`):

1. Revokes the `GPv2VaultRelayer` allowance and clears the executor binding so the
   order can no longer settle.
2. Executes the **existing Tier-3 raw-transfer**: collateral → lender's vault,
   `recordVaultDeposit`, plus the #592 in-kind VPFI reservation when the collateral
   is VPFI (`DefaultedFacet` L542–556).
3. Transitions the loan to `Defaulted` (in-kind), identical to today.

Because step 2 is byte-for-byte today's behaviour, the lender is never worse off.

---

## 10. Open decisions still to resolve (for the design-review round)

- **Window length** — a new `cfgCoWAuctionWindowSec` knob, or derive from the
  grace-bucket schedule? Proposal: dedicated knob, default 24–72h (long enough for
  solvers to source a thin-liquidity fill, short enough to bound lender wait).
- **Partial fills** — v1 `partiallyFillable = false` (all-or-nothing keeps the
  waterfall single-shot). v1.1 could allow partial fills + TWAP slicing for large
  lots, but that complicates the surplus/fallback accounting (residual unsold
  collateral on a partial fill). Recommend deferring partial/TWAP to v1.1.
- **Who pays CoW's solver fee** — CoW takes its fee from the order; confirm the
  `buyAmount` floor is net-of-fee so the lender's debt is still fully covered (set
  `minOut = debt` and let surplus absorb the fee, or gross the floor up). Pin in
  implementation.
- **Settlement trigger** — does the Diamond detect the fill via a CoW post-hook /
  `ComposableCoW` callback, or a permissionless `settleCoWFill(loanId)` poll that
  checks the Diamond's `principalAsset` balance delta? Proposal: permissionless
  poll (no trusted keeper required; anyone can finalize), with the keeper bot
  driving it in practice.
- **Audit surface** — CoW (`GPv2Settlement` + `ComposableCoW`) is a new external
  dependency. It's well-audited and widely used, and the integration mirrors the
  existing swap-path shape, but it is new attack surface to weigh against the
  frozen-submodule discipline. Since implementation is a separate PR, the
  audit-timing call (before vs. after the pre-audit security sweep #670) can be
  made at implementation kickoff.
- **`appData` / order-replay** — pin a Vaipakam-specific `appData` hash and ensure
  each loan's order digest is unique (loan-id + nonce in the salt) so a stale
  digest can't be re-bound.

---

## 11. Test plan (for the implementation PR)

- Happy path: illiquid ERC20 default with consent → CoW order placed → simulated
  fill delivers `principalAsset` ≥ floor → waterfall splits debt/fee/surplus →
  borrower surplus encumbered → loan terminal.
- Reserve-floor enforcement: a fill below the pinned floor cannot settle.
- No-fill → fallback: window expires → `cancelExpiredCoWAuction` → raw-transfer to
  lender, loan `Defaulted` in-kind (regression-equals today's behaviour).
- Consent gating: illiquid default WITHOUT `riskAndTermsConsentFromBoth` → straight
  to Tier-3 raw-transfer (no order placed).
- VPFI parity: VPFI principal → `encumberLenderProceeds`/`encumberBorrowerProceeds`
  fire on the right legs; VPFI collateral no-fill → #592 in-kind reservation.
- Exclusion: an `AwaitingCoWFill` loan is rejected by re-default / re-liquidation /
  consolidation.
- Pause: settlement blocked while paused; no-fill fallback still runnable while
  paused.
- Unit `MockCoWSettlement` (analogous to the `MockSeaport` / `MockListingExecutor`
  stubs) records the placed order + simulates a fill delivering `buyToken` to the
  receiver, so the place→settle→fallback lifecycle is CI-runnable without a fork.
  A fork test against real `GPv2Settlement` is a follow-up (mirrors
  `SeaportAtomicMatchForkTest`).

---

## 12. Acceptance criteria (from #686, mapped)

- [ ] Illiquid ERC20 default routes to a CoW limit order (min = debt) within a
  bounded window instead of immediate raw-transfer — §5, §6.
- [ ] Surplus above debt returned to the borrower via the reused waterfall + VPFI
  encumbrance — §6.1, §8.
- [ ] No-fill at expiry → fallback to raw-transfer-to-lender — §9.
- [ ] Tier-2 is consent-gated (reuses `riskAndTermsConsentFromBoth`) — §4.3.
- [ ] Reserve floor (= debt incl. interest + fees) enforced; order can't fill below
  it — §8.
- [ ] Tests cover happy fill, reserve enforcement, no-fill → fallback, consent
  gating, VPFI parity, pause — §11.
- [ ] This design doc lands with the venue comparison + tiered architecture — this
  document.

---

## 13. References

- #686 card (venue research, 2026-06-22).
- CoW: [Core contract deployments](https://docs.cow.fi/cow-protocol/reference/contracts/core)
  (`GPv2Settlement` / `GPv2VaultRelayer`, deterministic, all Phase-1 chains) ·
  [Programmatic orders](https://docs.cow.fi/cow-protocol/concepts/order-types/programmatic-orders) ·
  [ComposableCoW](https://github.com/cowprotocol/composable-cow) ·
  [EIP-1271](https://cow.fi/learn/eip-1271-explained) ·
  [Milkman](https://docs.cow.fi/cow-protocol/concepts/order-types/milkman-orders)
  (oracle mode — for the *liquid* tier, NOT used here).
- Existing code: [`DefaultedFacet.sol`](../../contracts/src/facets/DefaultedFacet.sol)
  (illiquid branch L483–507 + liquid waterfall L393–473),
  [`LibSwap.sol`](../../contracts/src/libraries/LibSwap.sol),
  [`LibEncumbrance.sol`](../../contracts/src/libraries/LibEncumbrance.sol),
  [`VaipakamVaultImplementation.sol`](../../contracts/src/VaipakamVaultImplementation.sol)
  (ERC-1271 L392–455),
  [`OracleFacet.sol`](../../contracts/src/facets/OracleFacet.sol)
  (`checkLiquidity`),
  [`NFTPrepayListingFacet.sol`](../../contracts/src/facets/NFTPrepayListingFacet.sol)
  (async-window + grace-expiry fallback precedent),
  [`NFTCollateralSaleAndAuction.md`](NFTCollateralSaleAndAuction.md).
