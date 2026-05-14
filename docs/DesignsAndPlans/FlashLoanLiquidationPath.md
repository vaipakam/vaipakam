# Flash-Loan Liquidation Path — Design

**Status**: design ratified 2026-05-14. Implementation across 3 phases
on branch `feat/market-rate-widget-and-tiered-ltv` (or a successor).
The third item from the liquidator-hardening list (alongside the
already-shipped split-route swaps and partial liquidations).

## 1. Goal

Vaipakam's existing liquidation path (`RiskFacet.triggerLiquidation`,
`triggerLiquidationSplit`, `triggerPartialLiquidation`) is
**atomic-swap-by-protocol**: the diamond withdraws collateral from
the borrower's escrow, swaps via a registered adapter (0x / 1inch /
Uniswap V3 / Balancer), pays the dynamic incentive bonus from
proceeds, and distributes the rest. The liquidator supplies a
ranked adapter try-list + gas; they need no working capital.

This design adds a second, *optional*, parallel liquidation path
that follows the **liquidator-buys-at-discount** model used by Aave
V3, Compound V3, and Morpho-Blue. A new entry point
`RiskFacet.triggerLiquidationDiscounted(loanId, ...)` lets an
external liquidator (or our keeper bot, with flash-loan integration):

1. Repay the borrower's outstanding debt from the liquidator's own
   funds (or from a flash-loan they execute around the
   `triggerLiquidationDiscounted` call).
2. Receive the borrower's full collateral, at a per-tier discount,
   directly to the liquidator's address — bypassing the protocol's
   swap path entirely.
3. Sell the seized collateral on their own terms (DEX of choice, MEV
   strategy of choice, slippage tolerance of choice) to repay the
   flash-loan if used and capture the profit.

The protocol gets a clean settlement at oracle-priced
debt-plus-discount value; the liquidator bears all
swap-execution risk; the borrower gets the surplus (collateral
worth minus debt-plus-discount-equivalent value).

## 2. Why this matters — vs the existing atomic-swap path

| Concern | Atomic-swap path (existing) | Discount path (new) |
|---|---|---|
| Who bears swap-execution risk? | Protocol. A bad swap means the dynamic bonus shrinks (slippage penalty) or the swap reverts entirely (full-collateral fallback). | Liquidator. The protocol gets exactly debt-plus-discount-equivalent; the liquidator's profit is whatever they net on their own sale of the seized collateral. |
| Liquidator working capital? | Zero. Just gas. | Either real capital OR flash-loan capability (Aave V3 `flashLoanSimple`, Balancer V2 `flashLoan`). |
| Liquidator profit predictability? | Capped at the dynamic bonus (≤ 3% of proceeds, slippage-haircut). | Capped at the per-tier discount (e.g. 7.7% Tier 1) minus the liquidator's actual swap cost. Higher upside, higher risk. |
| Borrower position when collateral is illiquid in DEX terms? | Falls through to `LibFallback`'s oracle-priced settlement if oracle quorum fresh; full-collateral-to-lender otherwise. Both pin distressed loans in a `FallbackPending` state. | Liquidator either takes the collateral and finds their own buyer, or doesn't call. The loan stays Active until either path or a time-based default closes it. |
| Industry-standard pattern? | Vaipakam-specific. | Aave / Compound / Morpho. Audits know it. |
| Higher-init-LTV regime (depth-tiered-LTV @ Tier 3 = 73%)? | Thinner cushion at liquidation → atomic swap more likely to exceed the 6% slippage ceiling. | Liquidator absorbs the slippage; the protocol-side gate becomes the per-tier discount, which is governance-bounded. |

The hybrid model is the right answer for the depth-tiered-LTV
regime — atomic-swap stays for the small, fast, no-capital
liquidations; discount path opens the field for MEV-style external
liquidators that can attack thinner cushions.

## 3. Industry comparison

| Protocol | Discount range | Model |
|---|---|---|
| **Aave V3** | 5–10% per asset (e.g. WBTC ~7%, WETH ~6.5%, USDC ~4%, long-tail 10%). Stored as `liquidationBonus = 10000 + bonusBps` (e.g. 10770 = 7.7% bonus). | Pure liquidator-buys-at-discount. No protocol-executed swap. |
| **Compound V3 (Comet)** | Per-collateral via `liquidationFactor` (e.g. 0.93 for WBTC, 0.95 for WETH). | Liquidator pays in the base asset, receives collateral × `liquidationFactor` value. |
| **Morpho-Blue** | Per-market; immutable at market creation. Typical 5–10%. | Same flat-discount shape. |
| **Liquity (v1)** | Stability Pool absorbs first; if not enough, redistributed to other troves. No discount in the traditional sense. | Different model entirely — Stability-Pool-based. |

**Vaipakam's chosen discount** (admin-configurable, governance-
bounded later):
- Tier 1: 7.7% (matches Aave's WBTC bonus encoding 10770)
- Tier 2: 6.0%
- Tier 3: 5.0%

Higher discount for lower tiers (thinner liquidity → more
liquidator slippage risk → more incentive needed to attract
liquidators). Inverse correlation with the per-tier max-init-LTV
caps (lower-tier assets have *both* tighter init-LTV AND wider
liquidation discount — defense in depth).

## 4. Per-tier safety bounds for the discount

Same pattern as Phase 7 of `AutonomousLtvAndOracleFallback.md`
(per-tier LTV bounds): the discount is *configurable* but
*bounded per tier*. Governance can adjust within the box; outside
the box, the setter reverts.

Proposed bounds:

| Tier | Floor (BPS) | Ceiling (BPS) | Library default (BPS) |
|---|---|---|---|
| Tier 1 | 300 (3.0%) | 1500 (15.0%) | 770 (7.7%) |
| Tier 2 | 300 (3.0%) | 1000 (10.0%) | 600 (6.0%) |
| Tier 3 | 200 (2.0%) | 800 (8.0%) | 500 (5.0%) |

Properties:
- Floors are wide-enough to keep liquidator participation viable
  even after governance tightening.
- Ceilings prevent governance from setting absurd discounts that
  would drain borrower surplus (e.g. a hostile-governance 50%
  discount).
- Library defaults match the user's ratified figures.
- The cross-tier ordering (higher tier = lower discount) is
  enforced at the setter, same atomic-setter pattern as Phase 7.

## 5. The `triggerLiquidationDiscounted` entry point

Signature:

```solidity
function triggerLiquidationDiscounted(
    uint256 loanId,
    address recipient,
    bytes calldata extraData
) external nonReentrant whenNotPaused;
```

Parameters:
- `loanId` — the loan to liquidate.
- `recipient` — where the seized collateral lands. Usually
  `msg.sender`; passing a different address enables MEV-bot
  patterns where the bot calls from a relay address but routes
  proceeds elsewhere.
- `extraData` — opaque; passed through to a post-seizure callback
  if the caller is using flash-loan + same-tx unwind. The caller
  encodes whatever they need.

Pre-checks (identical to `triggerLiquidation` for parity):
- Sanctions Tier-1 (`LibVaipakam._assertNotSanctioned(msg.sender)`).
- Loan is `Active`.
- Sequencer healthy (L2 circuit-breaker).
- HF < 1.0e18 (or, if `depthTieredLtvEnabled`, HF < the per-tier
  liquidation threshold). HF gate is identical to the atomic path
  — no new HF semantic.
- Liquidity status of collateral. *Note*: unlike `triggerLiquidation`,
  the discount path can operate on Illiquid assets too — the
  liquidator brings their own buyer. So this check is *relaxed*:
  the liquidator can liquidate even Illiquid loans via the
  discount path. (This is a borrower-protection upgrade: today's
  Illiquid loans default via the time-based route only;
  discount-path liquidation lets them resolve at HF<1 too.)

Per-tier discount lookup:
```solidity
uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(loan.collateralAsset);
uint256 discountBps = LibVaipakam.tierLiqDiscountBps(tier);
```

Settlement math:
- `totalDebt = principal + accrued interest + late fee` (same as
  `triggerLiquidation`).
- `collateralValueAtOracle = collateralAmount × oraclePriceCollateral`
- `debtPlusDiscountValue = totalDebt × oraclePricePrincipal × (1 + discountBps/10000)`
- `collateralToSeize = min(collateralAmount,
    debtPlusDiscountValue / oraclePriceCollateral)`
- `borrowerSurplus = collateralAmount - collateralToSeize`

If oracle quorum is unavailable for either leg: revert (no
fair-value math possible). The liquidator can retry when oracle
clears, or fall back to the atomic-swap path which has its own
oracle-stale fallback.

Execution:
1. Pull `totalDebt` of principal-asset from `msg.sender` via
   `safeTransferFrom` (the liquidator must have approved the
   diamond, OR have just received the funds via a flash-loan
   that calls `triggerLiquidationDiscounted` in the same tx).
2. Route the principal-asset to the lender's escrow + treasury per
   the existing fee split.
3. Withdraw `collateralToSeize` from the borrower's escrow.
4. Transfer to `recipient`.
5. Borrower's `collateralAmount` reduced to `borrowerSurplus`;
   surplus stays in the borrower's escrow (no claim queued — the
   borrower withdraws it themselves later).
6. Transition loan to `Defaulted`.
7. Trigger NFT status updates (same as the atomic path).
8. Trigger VPFI LIF forfeit (same as the atomic path).
9. Emit `LiquidationDiscounted(loanId, liquidator, recipient, tier, discountBps, totalDebt, collateralSeized, borrowerSurplus)`.

The function is `payable=false`; no native value flows through.

## 6. Master kill-switch + per-chain enablement

The discount path is **gated by a master flag**, separate from
`depthTieredLtvEnabled`:

```solidity
bool discountPathEnabled;   // ProtocolConfig field, defaults false
```

Governance sets via `ConfigFacet.setDiscountPathEnabled(bool)`.
When `false`, `triggerLiquidationDiscounted` reverts immediately
with `DiscountPathDisabled` — same kill-switch pattern as
`depthTieredLtvEnabled`.

Why a separate flag (vs piggy-backing on
`depthTieredLtvEnabled`):
- The two paths are independent. Discount path works in the
  HF≥1.5 regime too; it's just *more useful* in the higher-LTV
  regime.
- Lets governance enable each one separately per chain. E.g.
  Ethereum mainnet might have depth-tiered-LTV + discount path
  both on; a long-tail chain might keep both off; a new chain
  could enable just discount path while autonomous-LTV bakes.

## 7. Flash-loan integration in the keeper bot

Our reference keeper bot in `apps/keeper` will be extended with a
flash-loan branch. Strategy:

```
on HF < liquidation_threshold detected:
    compute optimal partial fraction (existing logic from
        AutonomousLtvAndOracleFallback Phase 5)

    if partial.optimalFractionBps < 0.7 * collateralAmount:
        # Small distressed slice — atomic-swap partial is cheaper
        submit triggerPartialLiquidation
    else:
        # Big slice OR Illiquid collateral — discount path may
        # be more profitable
        flashLoanProvider = pickFlashLoanProvider(chain, principalAsset)
        if flashLoanProvider != none:
            simulate(triggerLiquidationDiscounted via flashLoan):
                a. Aave/Balancer flashLoan principalAsset = totalDebt
                b. approve diamond for totalDebt
                c. diamond.triggerLiquidationDiscounted(loanId, bot, "")
                d. swap seized collateral → principal on best DEX
                e. repay flash-loan + fee from swap proceeds
                f. keep net profit
            if simulation profitable:
                submit
            else:
                fall back to triggerLiquidationSplit / Failover
        else:
            # No flash-loan provider on this chain
            submit triggerLiquidationSplit / Failover
```

Flash-loan providers per chain:
- Aave V3 `flashLoanSimple` — all 6 target chains.
- Balancer V2 `flashLoan` — fallback for non-Aave assets.

The bot's existing `liquidityConfidence.ts` + split-route +
partial-liq logic is unchanged; discount-path branch slots in
alongside.

## 8. Open-the-market — external liquidators

The discount path is permissionless (`msg.sender` is whoever
calls — no role gating). External MEV searchers + Chaos-Labs-style
bots can compete. Vaipakam publishes:
- The `triggerLiquidationDiscounted` ABI.
- Per-chain discount tables (from `ConfigFacet`).
- A "how to be a Vaipakam liquidator" doc covering the
  flash-loan-around-call pattern, recommended adapter contracts,
  the oracle freshness gates.

The protocol takes nothing additional from external liquidators
beyond what the discount math already cedes. No tip jar, no MEV
share. Standard permissionless DeFi pattern.

## 9. Failure modes + safety

Failure modes the new path introduces:

| Failure | Symptom | Mitigation |
|---|---|---|
| Liquidator front-runs honest liquidator's flash-loan tx | Standard MEV. Both pay gas; one wins. | No protocol mitigation; this IS the open-market design. |
| Liquidator pays the debt but seizure of collateral reverts | Tx reverts; liquidator loses gas only. | Atomic check-and-act pattern in the entry point; collateral transfer happens AFTER debt payment lands. |
| Stale oracle quorum at call time | The settlement math is debt-plus-discount-VALUE-at-oracle; stale oracle → can't compute. | Function reverts with `OracleStale` — liquidator retries with fresh oracle. |
| Liquidator brings malicious recipient (e.g. blacklisted contract) | Collateral lands at recipient. | Not a protocol concern — the recipient is the LIQUIDATOR's choice; protocol's responsibility ends at `safeTransfer`. |
| `discountBps` set too high by governance | Borrower surplus too small. | Per-tier ceiling bound at setter (8% on Tier 3, 15% on Tier 1). Hostile-governance attack is bounded. |
| `discountBps` set to zero by governance | Liquidator path unprofitable. | Per-tier floor bound at setter (2–3%). Hostile-governance can't strand. |

Master kill-switch:
- `ConfigFacet.setDiscountPathEnabled(false)` — emergency lever,
  TimelockController-gated post-handover.
- `AdminFacet.pauseAsset(asset)` — per-asset lever (existing).
- Borrower-friendliness preserved: if the discount path is
  disabled, loans on that chain default to the atomic-swap path
  + oracle-quorum fallback (no behavioural regression).

## 10. Implementation plan (3 phases)

| # | Phase | Surface | Effort | Status |
|---|---|---|---|---|
| 1 | **Design doc** (this) | `docs/DesignsAndPlans/FlashLoanLiquidationPath.md` | 1 hr | IN PROGRESS |
| 2 | **Contracts + tests** | `LibVaipakam` storage + constants + setter; `RiskFacet.triggerLiquidationDiscounted`; `ConfigFacet.setTierLiqDiscountBps` + master kill-switch; new events + errors; gate tests + happy-path test | day | next |
| 3 | **Keeper bot extension** | `apps/keeper` flash-loan branch; provider abstraction (Aave V3 + Balancer V2); simulate-then-submit flow; tests | day | |

External-liquidator-facing public docs ("how to be a Vaipakam
liquidator") land alongside Phase 3.

## 11. Open items not in this v1 design

- **Multi-collateral loans**: today's loans are single-collateral.
  If/when multi-collateral lands, the discount path needs to
  iterate collateral assets; design needs an extra round.
- **NFT collateral**: discount path is ERC-20-only in v1. NFT
  liquidations route via the existing `DefaultedFacet` time-based
  default path (which doesn't need discount semantics since NFT
  collateral is illiquid by definition).
- **Cross-chain flash-loan**: out of scope; v1 assumes
  same-chain liquidation only.
- **Liquidator-reward sharing**: e.g. percentage of discount goes
  to a Vaipakam treasury fee tier for external liquidators. Not
  in v1; can be added later as a fee.

## 12. Audit-package additions

The audit package now expands to cover:

1. The per-tier discount bound check at the setter (mirrors Phase
   7 of AutonomousLtvAndOracleFallback for tier-LTV bounds).
2. The settlement math — debt-plus-discount-VALUE computed at
   oracle, applied to seizure size.
3. The atomic check-and-act order (debt-in before
   collateral-out).
4. The reentrancy guards (`nonReentrant` + `whenNotPaused`).
5. The master kill-switch (`discountPathEnabled` defaults false).
6. Cross-path consistency: a loan can be liquidated via the
   atomic path OR the discount path, but never both — once
   `Defaulted` it's done.
