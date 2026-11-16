# Collateral concentration: a graded response per asset — design

**Status:** owner approved this shape on 2026-11-15, before the feature freeze. Card #3685. Design for review before build.
**Related:** the liquidity tiers and the loan-opening loan-to-value cap, `ShortfallReserveDesign.md` (#3641), `RatePricedCollateralDesign.md` (#3683), `LoanSettingsSnapshotDesign.md` (#3437).

## 1. Why

Every loan is checked on its own when it opens: its collateral must be liquid, and its size is judged against the market's depth for a sale of that size. Nothing looks at the total. If a great deal of one asset is pledged across many loans and its price falls, many of those loans become unhealthy together and their collateral is sold into the same market at the same time. Each sale was fine alone; together they are larger than the depth each was judged against.

Scouting the code on 2026-11-15 found no platform-wide figure for the collateral pledged in an asset, and nothing that reads one.

Two things soften this risk here, and they shape the answer:

- A liquidator may pay the debt and take the collateral at a discount, which needs no market depth.
- If every sale fails, the lender receives the collateral itself. The loss lands on the one lender who agreed to that collateral, not on a shared fund.

The in-platform match of opposite loans does **not** soften it. That match pairs loans that are liquidatable at the same moment, and when an asset falls the loans on the opposite side become healthier, not liquidatable. So the amount of opposite-side lending is no measure of safety and is not used below.

For these reasons the response is graded and never refuses a loan.

## 2. The measure

For each collateral asset the platform keeps one running figure: **the amount of that asset pledged under open loans**, updated wherever a collateral lien is created, increased, reduced or released.

The **concentration ratio** of an asset is the value of that amount at the current price, divided by the asset's **depth reference**: the sale size its current liquidity tier is measured at (the size the market absorbs within the tier's slippage bound). Both parts already exist; no new market probe is added.

Two governed thresholds, bounded and changed only behind the Timelock delay:

| Threshold | Starting value | Bounds |
| --- | --- | --- |
| Caution | 5 times the depth reference | 2 to 20 |
| High | 10 times the depth reference | above caution, up to 50 |

Governance may set tighter multiples for a single asset, within the same bounds and behind the same delay; a rate-priced token (`RatePricedCollateralDesign.md`) starts one step tighter than the platform values. An asset with no override uses the platform values.

The multiples are above one because only part of the pledged collateral is ever sold in one fall: loans open at different prices with different cushions.

## 3. The response

All three apply to **new loans only**, judged when the loan opens. An open loan is never changed by a later rise in the ratio.

1. **At or above caution: the app warns.** Offers, matches and Auto-lend settings for that collateral show that an unusually large amount of it is already pledged on the platform, with the ratio. A view returns the pledged amount, the depth reference, the ratio and which threshold applies.
2. **At or above caution: no reserve eligibility.** A loan opened while its collateral asset is at or above caution is not eligible for the shortfall reserve, whatever its tiers. This is recorded on the loan at opening with the tiers the reserve design already records.
3. **At or above high: a lower loan-to-value cap.** The loan-opening cap for that collateral is the cap of the next lower liquidity tier. For an asset already in the lowest liquid tier, that tier's cap is reduced by a governed step. Borrowing against the asset stays possible with more cushion.

**How rule 3 applies in each loan-to-value regime (design decision 2026-11-16).** At High the cap is the lower of the regime's own cap and the lowered tier cap, in both regimes, and the health-factor floor is not changed:

- *Depth-tiered regime:* the regime's cap is the lower of the asset's own ceiling and its tier's cap. At High the next lower tier's cap replaces the tier cap.
- *Untiered regime:* the loan-opening check enforces the asset's own ceiling and the health-factor floor. The loan-to-value that floor allows is the tier's liquidation loan-to-value divided by the floor. The lowered tier cap applies on top; where it is not below what the floor already allows (for example a tier-3 asset: the next tier's 60% against 90% / 1.5 = 60%), it lowers nothing.
- *The lowest liquid tier:* its cap less the step, 10 percentage points to start, bounded 5 to 25.
- *Tier 0* is not lowered: the tiered regime already caps it at 0.

The per-asset view and the loan-opening cap read both say whether the lowered cap actually binds. The app's High warning must not claim a lower cap where it does not bind; at High with no binding cap it says only that much of the asset is pledged.

**Rule 2's record.** The shortfall reserve (#3641) is not built yet, so each loan records the concentration level (normal, caution, high) its collateral had when the loan opened. The reserve reads that record; caution or high means not eligible.

**Thresholds are stored in hundredths of a multiple** (500 = 5x), so a per-asset override can be set between whole multiples.

Nothing here refuses an offer, an intent or a loan. A hard limit remains possible later as one more threshold on the same measure, if the numbers ever call for it.

Auto-lend and matches need no special rule: the cap in 3 is applied by the one loan-opening check every route already passes, and the previews read the same rule, so a fill that would exceed the lowered cap is refused by the existing check with the existing reason.

## 4. Details

- **Extensions, refinances and rolls.** An in-place extension is not a new loan and is unaffected. A refinance and a roll open new loans and are judged then.
- **Price and tier at the moment of opening.** The ratio uses the price and tier the loan-opening check already reads, under the loan's settings (#3437). The thresholds are platform settings read live for new loans; they are not part of a loan's stamped settings because they never apply to a loan after it opens.
- **Pushing the ratio.** A borrower cannot lower the ratio except by removing real collateral. Someone could raise it by opening large loans against the asset, which costs them the initiation fee and only makes later borrowers post more cushion; it moves no funds.
- **Fallback custody.** Collateral held under a failed sale's fallback still counts as pledged until it is claimed or sold.
- **Illiquid collateral** has no tier and no ratio; it is already lent against only by explicit consent.
- **Disclosure.** The asset page shows the pledged amount, the ratio and the thresholds for every collateral asset, at all times, not only when a threshold is crossed.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Collateral lien bookkeeping | One per-asset pledged total, written by the one library that already writes liens. |
| Loan-opening risk bounds | The lowered cap of rule 3, in the one host every match and accept already asks. |
| Loan record | Reserve eligibility at opening reflects rule 2. |
| Settings | The two thresholds and the lowest-tier step, with bounds. |
| Views | Per asset: pledged amount, depth reference, ratio, threshold state. |

Run the storage-layout guard's `write`; check facet sizes with the deploy-sanity suite.

As built: the cap rule and the views live on one new facet that every loan-opening path and preview self-calls. The four collateral-lien entries moved off the encumbrance facet to their own facet, because the pledged-total write pushed it over the size limit. A lien from before this change is not in the total, so the change reaches a chain by fresh deploy; the in-place refreshes refuse to cross it while a loan is open.

## 6. Tests

1. The pledged total follows every lien change: open, add, partial withdrawal, repayment, liquidation, default, fallback entry and exit, consolidation, obligation handover.
2. Ratio and threshold state at each boundary; a tier change moves the depth reference.
3. Below caution nothing changes. At caution a new loan is recorded as not reserve-eligible. At high the cap is the next tier's; the lowest tier uses the step.
4. Open loans are unchanged when the ratio rises past either threshold.
5. Accept, match, Auto-lend fill, refinance and roll all apply the lowered cap; previews agree with execution.
6. Threshold bounds and the Timelock delay.

## 7. Alternatives considered

1. **A hard limit that refuses new loans.** The usual answer on pooled venues, where a failed sale is a shared loss. Here the loss is one lender's and is taken in collateral, so a refusal is heavier than the risk, and it surprises a user at the moment of borrowing.
2. **Offset the pledged total by opposite-side loans.** Rejected: the opposite side is healthy exactly when this side fails (section 1).
3. **Warning only.** Cheapest, but leaves the reserve exposed to the one correlated event most likely to drain it.
4. **A new depth probe sized to the pledged total.** More exact, but adds a market read to every loan opening. The tier's own measured size is already there.
5. **Do nothing.** Acceptable while volumes are small; cheaper to build the counter before the storage layout is frozen than after.

## 8. Recommendation

The graded response of section 3: a per-asset pledged total, a warning and reserve exclusion at the caution multiple, a one-tier-lower cap at the high multiple, and no refusal.

## 9. Open items for the builder to raise, not decide silently

Decided with the design thread on 2026-11-16 (recorded in section 3):

- At High the cap is min(the regime's cap, the lowered tier cap) in both regimes, with no change to the health-factor floor; the views say whether it binds.
- The lowest-tier step starts at 10 percentage points, bounded 5 to 25.
- Thresholds are stored in hundredths of a multiple.
- The level is recorded per loan at opening, for the reserve to read.

Built later, not here: a rate-priced token's one-step-tighter start (#3683) and the reserve itself (#3641). Until #3437 stamps loan settings, the check reads the live price and tier the loan-opening check already reads.

A refinance's carried-over collateral is still in the pledged total when the replacement loan is judged, because the old lien moves to the new loan inside the same transaction. The replacement therefore sees its own collateral counted once. This is conservative and is left as is.

Still open:

- The starting multiples, once testnet figures for pledged totals and tier sizes can be read.
- Whether the lending asset needs a matching measure. This design covers collateral only.
