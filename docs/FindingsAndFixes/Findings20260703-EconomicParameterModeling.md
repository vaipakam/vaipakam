# Economic / Parameter Modeling — Tokenomics & Liquidation Mechanics

**Date:** 2026-07-03 · Analysis deliverable (no compiler run). Every constant cited to `file:line`.
**Related:** wash/self-dealing (#895/#913), Phase-5 TWA discount defense, liquidation tier-manipulation (#910), and the round-2 audit note on the cap fail-open (`docs/FindingsAndFixes/Findings20260702-SmartContractSecurityAudit.md`).

## 0. Grounded constants

| Constant | Value | Source |
| --- | --- | --- |
| `TREASURY_FEE_BPS` (yield fee) | 100 = 1% of interest | `LibVaipakam.sol:77` |
| `LOAN_INITIATION_FEE_BPS` (LIF) | 10 = 0.1% of principal | `LibVaipakam.sol:363` |
| `MAX_INTEREST_BPS` | 10000 = 100%/yr | `LibVaipakam.sol:469` |
| capRatio default `INTERACTION_CAP_DEFAULT_VPFI_PER_ETH` | 500 VPFI/ETH | `LibVaipakam.sol:622` |
| capRatio min/max | 1 / 1,000,000 | `LibVaipakam.sol:4957-4958` |
| `VPFI_INITIAL_MINT` / pool cap | 23M / 69M | `LibVaipakam.sol:611,608` |
| emission schedule | 3200→…→500 bps | `LibInteractionRewards.sol:79-88` |
| half-pool/day/side | `bps·mint/(10000·365·2)` | `LibInteractionRewards.sol:93-99` |
| per-user cap; **`uint256.max` if `ethPriceRaw==0` OR `capRatio==max`** | `interestUSD18·10^dec·capRatio/ethPx` | `LibInteractionRewards.sol:1092-1102` |
| discount tiers | T1 100→10%, T2 1k→15%, T3 5k→20%, T4 >20k→24% | `LibVaipakam.sol:592-599` |
| TWA window/recent/weight/min-staked defaults | 30/7/3/3 | `LibVaipakam.sol:6948-6951` |
| TWA setter bounds | window 14–30, recent 1–14, weight 1–10, min-staked **2–14** | `ConfigFacet.sol:2202,2190,2214,2228` |
| `MAX_DISCOUNT_BPS` | 9000 = 90% | `ConfigFacet.sol:123` |
| liq incentive `= maxSlip − realizedSlip`, cap `MAX_LIQUIDATOR_INCENTIVE_BPS` 3% | | `RiskFacet.sol:792-802`; `LibVaipakam.sol:222` |
| `MAX_LIQUIDATION_SLIPPAGE_BPS` / handling fee | 6% / 2% | `LibVaipakam.sol:221,229` |
| Config ceilings fee/slip/incentive | 50% / 25% / 20% | `ConfigFacet.sol:120-122` |
| per-tier seizure discount default/floor–ceil | T1 7.7%(3–15) T2 6%(3–10) T3 5%(2–8) | `LibVaipakam.sol:290-305` |

Spec anchor (§4): 0.5 VPFI per 0.001 ETH = 500 VPFI/ETH/side (`docs/FunctionalSpecs/TokenomicsTechSpec.md:184`); applied independently per side (`LibInteractionRewards.sol:843-857`).

**Market assumptions:** ETH=$2,500 (band $1,500–$4,000); VPFI has no protocol-anchored floor (fixed-rate sale removed, #687-A — `TokenomicsTechSpec.md:491`), swept $0.001→$1.00; L2 gas ~$2–8/cycle.

## 1. Wash / self-dealing interaction rewards

**Mechanism.** A sybil runs both lender `L` and borrower `B` (no beneficial `lender≠borrower` check). `B` borrows `P` at rate `r` for `D` days; interest `I=P·r·D/365` flows `B→L` = **net-zero** to the operator. Clean in-grace repay pays **both** reward halves (`LibInteractionRewards.closeLoan(borrowerClean=true,...)`, `:249-283`; borrower earns only on clean repay `:274-278`). Real friction: LIF `0.001·P` + yield fee `0.01·I` + gas.

**Extraction ceiling (cap enabled):** `≤ 2·500·I_ETH = 1000 VPFI per ETH of self-paid interest` (`:843-857`). Maximise `I/P` with `r=100%` (`MAX_INTEREST_BPS`) and `D=365` → `I=P`, so cost `= 0.01·I + 0.001·P = 0.011 ETH per ETH interest`.

**Break-even:** `1000·p_VPFI(ETH) = 0.011 ETH` → **p_VPFI* ≈ $0.0275** at ETH=$2,500 (scales: $0.0165 @ ETH=$1,500; $0.044 @ ETH=$4,000).

| VPFI price | Reward (both halves, cap-bound) | Real cost | Net / ETH interest | Profit? |
| ---: | ---: | ---: | ---: | :---: |
| $0.001 | $1.00 | $27.50 | −$26.50 | no |
| $0.01 | $10.00 | $27.50 | −$17.50 | no |
| **$0.0275** | **$27.50** | **$27.50** | $0 | break-even |
| $0.05 | $50 | $27.50 | +$22.50 | yes |
| $0.10 | $100 | $27.50 | +$72.50 | yes |
| $0.50 | $500 | $27.50 | +$472.50 | yes |
| $1.00 | $1,000 | $27.50 | +$972.50 | yes |

**The pool, not the cap, is the real prize.** Early half-pool/side `= 0.32·23M/365/2 ≈ 10,082 VPFI/day/side` (≈20,164/day both sides); late-schedule ≈1,575/side (`:80,93-99`). A sybil dominating the global-interest denominator sweeps ~the whole half-pool; they become pool-bound (not cap-bound) once `perDayInterest ≥ 10,082/500 ≈ 20.2 ETH/day` (~$50k/day self-paid interest, trivial since principal round-trips). At $0.10 that is **~$2,000/day** drained for ~1.1% friction.

**Fail-open (§1.4).** `_capVpfiForInterestUsd` returns `uint256.max` when `ethPriceRaw==0` (unset/reverting/zero feed) or `capRatio==uint256.max` (disable sentinel) (`:1098-1099`). The ETH read `_ethUsdPriceRawAndDec` zeroes only on missing/reverting/`answer<=0` feed — **no staleness check**, so a frozen-nonzero feed stays priced; the dangerous branch is a *missing/zero* feed. With the cap off, `reward ≈ (myInterest/globalInterest)·halfPool → halfPool` as the sybil dominates — so **0.001 ETH (~$2.50 at ETH=$2,500) of wash interest can capture ~10,082 VPFI/day/side** (≈$1,008 at VPFI=$0.10); extraction per unit cost is effectively unbounded (only the 69M pool cap limits it). This is the audit's cap-fail-open finding.

**Recommendations:** (1) fail-**closed** on a zero ETH feed — fall back to a fixed cap, not `uint256.max`; (2) add a minimum-interest (numeraire) eligibility floor so dust loans can't dominate the denominator; (3) treat `capVpfiPerEth` as a launch-gating control set low (100–500), with the `uint256.max` sentinel behind the 48h timelock.

## 2. Discount-tier gaming — DEFEATED

Three stacked filters in `effectiveTierAndBps` (`VPFIDiscountAccumulatorFacet.sol:148-175`): (1) **min-staked-days gate** — `now < startSec + minWindow` returns `(0,0)`, default 3d, bound 2–14 (`:159-161`); (2) **TWA** → rawTier (`:163-164,299-329`); (3) **min-over-history clamp** — `effTier = min(rawTier, minOverHistory)` scanning each day's `dayMin` back to stake-start (`:166-172,375-411`), and same-day rollups **keep the minimum** (`_advanceRingBuffer:266-269`) so a dust-morning/bulk-evening top-up can't erase the dust. Balance re-stamped **post-mutation** (`LibVPFIDiscount.rollupUserDiscount:169-235`, called post-withdraw `:578,:782`).

**Flash stake → 0 discount:** a fresh stake sets `currentStakeStartSec=now`; at settlement `now−startSec=0 < 3d` → returns `(0,0)`. **Sub-window bulk-up:** if the attacker funds tier-4 for only the last `k<30` days but held tier-1 the rest, a tier-1 `dayMin` exists in-window so `minOverHistory=1` → **effective discount ≤ 10%, never the funded 24%**. To hold tier-4 they must keep `dayMin ≥ 20,001 VPFI` every in-window day — genuine 30-day holding. **The clamp collapses the flash edge to zero.**

**Capital-time cost (real, aligned):** hold ≥100/1k/5k/20,001 VPFI every in-window day for 10/15/20/24% (~$10/$100/$500/$2,000 locked @ $0.10), min 3 days before any discount. **Residual edge = none from flash/partial-unstake** (unstake lowers that day's `dayMin` and the restamp captures it). Only exposure is a governance mis-set; the setter *refuses* `minStakedDays=1` (`ConfigFacet.sol:2222-2228`) precisely because `=1` reopens same-day gaming. Matches the 2026-07-02 audit "discount tier-gaming defeated" negative result.

## 3. Liquidation-bonus MEV

**Path A (atomic, `triggerLiquidation`):** `incentiveBps = min(maxSlip − realizedSlip, maxIncentive[3%], assetCap)`; `bonus = proceeds·incentiveBps/10000` (`RiskFacet.sol:793-802`), plus 2% handling to treasury (`:824`). The diamond swaps and hands the liquidator the bonus (diamond bears swap risk). Clean execution → 3% of proceeds. $100k liquidation → **~$3,000 bonus**, gas ~$8 → ~$2,992 risk-free profit. Healthy, competitive.

**Path B (`triggerLiquidationDiscounted`, off by default):** liquidator delivers `totalDebt`, seizes `collForDebt·(10000+discountBps)/10000` (`:1541-1542`); profit ≈ `discountBps·totalDebt` minus flash-loan fee + real slippage.

**#910 tier-manipulation.** `discountBps` reads the **live** tier (`:1479-1483`); per audit L10 the AMM guards *exclude* a tripped pool → **lowers** measured tier → thin ⇒ tier1 ⇒ widest discount. Borrower surplus `= collateralAmount − collateralSeized` (`:1550`), so extra seizure `= totalDebt_coll·(discount_T1 − discount_T3)/10000`.

| Scenario | Honest | Manipulated | Extra borrower-surplus seized / $100k debt |
| --- | ---: | ---: | ---: |
| Default T3→T1 | 5.0% | 7.7% | **$2,700** (+54%) |
| Ceiling T3-floor→T1-ceil (`:291,294`) | 2.0% | 15.0% | **$13,000** (+650%) |

Mitigants: path OFF by default (`cfgDiscountPathEnabled` false, `:6300-6302`), keeper tier defaults to 1 (`:216`). L10 fix (snapshot tier at init OR floor to keeper-attested tier) must land before enabling.

**Griefing/extraction danger zones:** `maxIncentive 20%` + `maxSlip 25%` → 22% skimmed before lender made whole (extraction); `maxSlip 25%` alone → `minOut=75%` admits sandwich MEV on the diamond's swap (griefing); discount path ON without tier snapshot → $2.7k–$13k/$100k extractable (extraction). **Safe envelope = defaults:** incentive ≤3% + slip ≤6% + handling 2% (`:826-832` proves `bonus+fee ≤ proceeds`).

## 4. Parameter-safety table

| Knob | Bound cite | min | max | default | Safe range | Flag |
| --- | --- | ---: | ---: | ---: | --- | :---: |
| Liquidator incentive | `ConfigFacet.sol:830,122` | 0 | **20%** | 3% | 2–4% | ⚠ over-rewards keepers |
| Liq. slippage | `ConfigFacet.sol:829,121` | 0 | **25%** | 6% | 4–8% | ⚠ admits MEV slippage |
| Handling fee | `ConfigFacet.sol:828` (`MAX_FEE_BPS`) | 0 | **50%** | 2% | 1–3% | ⚠ guts lender recovery |
| Treasury/yield fee | `ConfigFacet.sol:166` | 0 | **50%** | 1% | 0.5–3% | ⚠ destroys lender yield |
| LIF | `ConfigFacet.sol:167` | 0 | **50%** | 0.1% | 0.05–0.5% | ⚠ confiscatory |
| **capVpfiPerEth** | `InteractionRewardsFacet.sol:279-285`; `LibVaipakam.sol:4957-4958` | 1 | **1e6** (+`uint256.max` sentinel) | 500 | 100–500 launch | ⚠⚠ **1e6=2000×default; sentinel + zero-feed fail-open = unbounded mint-drain** |
| Discount-tier BPS | `ConfigFacet.sol:940-960,123` | 0 | **90%** | 10/15/20/24% | ≤30%, monotone | ⚠ 90% ≈ free usage for whales |
| Per-tier liq discount | `ConfigFacet.sol:1241-1261`; `LibVaipakam.sol:290-295` | 3/3/2% | **15/10/8%** | 7.7/6/5% | keep defaults; path OFF until #910 fix | ⚠ 15%+live-tier = extraction |
| Partial close factor | `ConfigFacet.sol:501-509` | 0 | 100% | 100% | 25–50% for long-tail | OK |
| Tier liq LTV | `ConfigFacet.sol:1462-1479`; `LibVaipakam.sol:169-170` | 50% | 95% | 90/85/80% | keep, monotone | OK |
| TWA min-staked-days | `ConfigFacet.sol:2228` | **2** | 14 | 3 | 3–7 | OK (blocks =1) |
| TWA window days | `ConfigFacet.sol:2202` | 14 | 30 | 30 | 30 | OK |
| Rental buffer | `ConfigFacet.sol:131` | 0 | 20% | 5% | 2–8% | OK |
| Fallback split per/combined | `ConfigFacet.sol:138-139` | 0 | 10%/15% | 3%/(3+2)% | keep | OK |

**Catastrophic maxes:** (1) **capVpfiPerEth** — the `uint256.max` sentinel + zero-feed fail-open (`LibInteractionRewards.sol:1098-1099`) both disable the cap → unbounded-rate mint-drain; 1e6 in-range max is 2000× default. (2) **Fee knobs sharing 50%** — need dedicated tighter ceilings (yield ≤10%, LIF ≤2%, handling ≤5%) mirroring the rental-buffer precedent (`ConfigFacet.sol:126-131`). (3) **incentive 20% + slippage 25%** stacked → 22% skim + sandwich risk. (4) **15% liq-discount ceiling + live-tier read** — don't enable path until tier-snapshot fix.

## 5. Executive summary

1. **Wash-farming is structurally profitable at any credible VPFI price.** Extraction ceiling = 1000 VPFI/ETH of self-paid interest vs ~1.1% friction; break-even VPFI ≈ **$0.028** (ETH=$2,500). The cap limits the *rate*, not profitability; a capitalised sybil sweeps a large slice of ~20,164 VPFI/day early pool (~$2,000/day @ $0.10).
2. **The cap fails OPEN** — a missing/zero ETH feed or the `uint256.max` sentinel makes per-unit extraction unbounded (~$0.03 of wash interest can drain a whole daily half-pool). Highest-severity economic finding.
3. **Discount-tier gaming is soundly defeated** (post-mutation restamp + min-over-history clamp + 3-day gate). Flash stake = 0 discount; sub-window bulk-up clamped to the minimum tier held in-window. Residual = honest capital-time cost only.
4. **Liquidation is healthy at defaults** (≤5% of proceeds) but every knob's max permits extraction. The discounted-seizure path (#910/L10) lets a liquidator nudge tier 3→1 to extract **$2,700/$100k** (defaults) up to **$13,000/$100k** (ceiling) from borrower surplus — keep OFF until tier snapshotted at init.

**Specific recommendations (numbers):** set launch `capVpfiPerEth`=100–500 (not 1e6); replace zero-feed fail-open with a fixed fallback cap; timelock the `uint256.max` disable; add a minimum-interest reward-eligibility floor; tighten fee ceilings (yield ≤10%, LIF ≤2%, handling ≤5%); cap liquidator incentive ≤5% and slippage ≤10% at the setter; do not enable `discountPathEnabled` until L10/#910 tier-snapshot fix; keep `twaMinStakedDays ≥ 3` and `twaWindowDays = 30`.
