# Fee levels: interest share at 5%, initiation fee by term — design

**Status:** owner direction, 2026-11-15. Card #3649. Replaces the fee levels frozen in #1352 (0.2% flat initiation fee, 2% of interest). Reaches a chain by fresh deploy, before mainnet.
**Related:** `ShortfallReserveDesign.md` (#3641: the treasury floor and the reserve's part of these two fees), the fee-discount rules in the tokenomics spec.

## 1. Why

Two things changed. The shortfall reserve is filled from the part of each fee above a treasury floor, and at the #1352 levels that part is too small to build a useful reserve in any reasonable time. And the two fees fall on different people: the interest share is paid by the lender, the initiation fee by the borrower. Raising only the interest share would put the whole increase on lenders.

## 2. Levels

| Fee | Paid by | Today | New |
| --- | --- | --- | --- |
| Treasury share of interest | Lender, out of interest actually paid | 2% | **5%** |
| Loan initiation fee | Borrower, once, in the lending asset at acceptance | 0.2% of principal | **0.2% for a short loan, rising to 0.5% at one year and 0.5% per year of term after that** |

The interest share scales with time by itself: it is taken only from interest that was really paid, so early repayment, partial repayment and extension need no new rule.

## 3. The initiation fee by term

- A loan of **30 days or less** pays 0.2%.
- A loan of **365 days** pays 0.5%. Between 30 and 365 days the rate rises in a straight line with the agreed term in days.
- A loan **longer than 365 days** pays 0.5% for each year of its term, in proportion to its days (owner direction 2026-11-15): 0.75% for a year and a half, 1.0% for two years. The rate has no step at any point, and from one year onward it is never more than 0.5% per year of term.

On 10,000 units of principal: 20 for 30 days, about 25 for 90 days, about 33 for 180 days, 50 for a year, 100 for two years.

The four figures (base rate, base term, yearly rate, the one-year point) are bounded settings behind the Timelock delay. A loan's fee is fixed when it opens; a later change never reprices an open loan.

Why not a flat 0.5%: a flat fee is a large yearly cost on a short loan. 0.5% on a 7-day loan adds about 26 percentage points a year; 0.2% adds about 10. Why not purely proportional to time: a short loan would pay almost nothing, below the treasury floor of 0.1%.

Rules that follow:

- **The term is the agreed term** the loan opens with: the borrower offer's term on a match or an Auto-lend fill, the accepted offer's term on a direct accept.
- **Early repayment gives no refund**, on full-term and pro-rata loans alike. The review states this beside the amount. A borrower who wants flexibility takes a shorter term and extends.
- **An extension pays for the added time only:** the fee at the new total term minus the fee at the term already paid for, on the principal outstanding at the extension, paid by the borrower when the extension takes effect. An extension whose old and new terms are both at or under 30 days pays nothing more. Past one year every added day pays its proportional part of the yearly rate.
- **An extended loan never pays more than one loan of the same total term would have.** The difference rule makes the fee depend only on the total term, not on how it was reached. Extending is also cheaper than closing and borrowing again, which would pay a whole new fee.
- **An automatic extension** (a keeper acting inside limits both holders set) collects the added fee from the borrower's own vault balance of the lending asset. The borrower's extension limits show the largest added fee they allow. If the balance is not there the extension does not happen and the loan stays on its existing due date; the keeper's advance alert names the amount needed. The fee is never added to the debt: that would put a platform charge into every settlement and liquidation path beside the lender's due.
- **It cannot be avoided by chaining short loans:** twelve 30-day loans pay 2.4% in total against 0.5% for one year.
- **A refinance and a new loan after a roll are new loans** and pay their own fee on their own term, as today.
- **Discounts** apply to the whole fee as they do today, under the same ceiling.
- The fee stays in the lending asset. Nothing here touches the retired token-custody path.

## 4. How the levels compare

Stated generically; no platform is named in the repository.

- Pooled on-chain lenders commonly keep between a tenth and a quarter of the interest lenders earn, and charge no fee up front. 5% of interest is below that range.
- Marketplace lenders in traditional finance commonly charge borrowers an origination fee of one to several percent and lenders about 1% of every payment received. Home loans commonly carry 0.5% to 1%.
- A one-year loan at 10% interest here costs the lender 0.5 percentage points of their return and the borrower 0.5% once; a two-year loan costs the borrower 1.0% once. A 30-day loan costs the borrower 0.2% once.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Fee constants and settings | Interest share default 5%; initiation fee settings (base rate, base term, yearly rate, the one-year point) with bounds, replacing the single rate. |
| One library for the initiation fee rate | `rate(termDays)`; every charger and every preview reads it, so the amount shown is the amount charged. |
| The borrower fee charge at acceptance | Reads the rate for the loan's term. |
| Extension | Charges the difference for the added time through the same fee host, marked as an extension fee so no treasury floor is taken from it. |
| Loan record | The term the fee has been paid for, if the existing term field cannot serve. |
| Views and previews | The fee as an amount and a rate for a given principal and term; the extension's added fee. |
| Treasury fee host | The floor split of `ShortfallReserveDesign.md` section 8 (ships with the mainnet deploy). |

Per-loan stamping of the interest share stays as it is, so a later retune never reprices an open loan. Run the storage-layout guard's `write`; check facet sizes with the deploy-sanity suite and split along a seam if needed.

## 6. App and documents

- The review shows the initiation fee as an amount, its rate, and the sentence that early repayment does not return it. The term picker shows how the fee changes with the term.
- The lender's review shows the interest share as 5% of interest earned.
- The extension review shows the added fee before signing.
- The tokenomics spec's fee tables and every fee figure in the app, site and guides are updated in the same change as the contracts.

## 7. Tests

1. Rate at 1, 30, 31, 197, 365, 366, 548 and 730 days; no step at 30 or 365 days; rounding never undercharges the floor.
2. The charge at acceptance equals the preview, on a direct accept, a match and an Auto-lend fill.
3. Discounts apply to the term-scaled fee under the existing ceiling.
4. Extension: across the 30-day line, inside the slope, across the 365-day line, beyond one year, and within the first 30 days (no charge); partial principal outstanding; fees over any sequence of extensions sum to the fee of one loan of the total term; an automatic extension with the vault balance short is refused and changes nothing.
5. Early repayment returns no fee.
6. A settings change does not reprice an open loan or its later extension's already-paid part.
7. The interest share at 5% on every settlement path, stamped per loan.
8. With the reserve split: treasury receives the floor first; a discounted fee reduces only the reserve's part. The floor on the initiation fee is taken once, at acceptance; an extension's added fee goes to the reserve whole, so one extension from 30 to 365 days and the same extension made a day at a time send the same totals to treasury and reserve.

## 8. Alternatives considered

1. **Keep 0.2% and 2%.** Rejected: the reserve would take a decade or more to reach a useful size.
2. **Flat 0.5% and 5%** (the owner's first proposal). Rejected for the initiation fee: it overcharges short loans.
3. **5% of interest with a flat 0.2%.** Simplest, but puts the whole increase on lenders.
4. **Charge the borrower's part as it accrues, like interest.** Exact on early repayment, but adds a second running charge to every settlement path. Rejected as too much machinery for the gain.
5. **Refund the unused part on early repayment.** Rejected: the fee has already been split between treasury and reserve, and a refund would have to draw both back.

## 9. Recommendation

The levels in section 2 with the term rule in section 3.

## 10. Open items for the builder to raise, not decide silently

- Whether any charge derived from the initiation fee rate (a matcher's share, the paid tariff) should read the base rate or the loan's term rate.
- Whether an obligation handover, which installs a new borrower's term, charges the difference as an extension does.
- Confirm no path assumes the fee is one fixed rate, and that the bound on the fee setting still holds for the longest term the platform admits.
