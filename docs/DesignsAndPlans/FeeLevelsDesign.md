# Fee levels: interest share at 10%, initiation fee by term — design

**Status:** owner direction, 2026-11-15. Card #3649. Replaces the fee levels frozen in #1352 (0.2% flat initiation fee, 2% of interest). Reaches a chain by fresh deploy, before mainnet.
**Related:** `ShortfallReserveDesign.md` (#3641: the treasury floor and the reserve's part of these two fees), `IntegratorFeeShareDesign.md` (#3682) and `ReferralFeeShareDesign.md` (#3722) for the amounts taken from the initiation fee's above-floor part, the fee-discount rules in the tokenomics spec.
**Reviewed 2026-11-17:** the open items of section 10 are settled, and the referral cut and the per-loan ceiling are named where the fee is divided.
**Levels raised 2026-11-17 (owner decision):** the interest share is 10% and the initiation fee reaches 1% at one year and 1% per year after that. The 30-day minimum stays 0.2% and the treasury floors are unchanged. The first levels of 2026-11-15 (5%, and 0.2% rising to 0.5%) are recorded in section 8.

## 1. Why

Two things changed. The shortfall reserve is filled from the part of each fee above a treasury floor, and at the #1352 levels that part is too small to build a useful reserve in any reasonable time. And the two fees fall on different people: the interest share is paid by the lender, the initiation fee by the borrower. Raising only the interest share would put the whole increase on lenders.

The levels were raised once more on 2026-11-17, before anything was built on the first set. The owner wanted the reserve to fill faster and the shares paid out of the initiation fee to be a smaller part of a larger amount (`IntegratorFeeShareDesign.md`, `ReferralFeeShareDesign.md`: each 10% of the above-floor part in place of 20%). The treasury's floors stay where they were, so the whole increase goes to the reserve and to those shares.

## 2. Levels

| Fee | Paid by | Today | New |
| --- | --- | --- | --- |
| Treasury share of interest | Lender, out of interest actually paid | 2% | **10%** |
| Loan initiation fee | Borrower, once, in the lending asset at acceptance | 0.2% of principal | **0.2% for a short loan, rising to 1% at one year and 1% per year of term after that** |

The interest share scales with time by itself: it is taken only from interest that was really paid, so early repayment, partial repayment and extension need no new rule.

## 3. The initiation fee by term

- A loan of **30 days or less** pays 0.2%.
- A loan of **365 days** pays 1%. Between 30 and 365 days the rate rises in a straight line with the agreed term in days.
- A loan **longer than 365 days** pays 1% for each year of its term, in proportion to its days (the shape is the owner's direction of 2026-11-15, the level that of 2026-11-17): 1.5% for a year and a half, 2% for two years. The rate has no step at any point, and from one year onward it is never more than 1% per year of term.

On 10,000 units of principal: 20 for 30 days, about 34 for 90 days, about 56 for 180 days, 100 for a year, 200 for two years.

The four figures (base rate, base term, yearly rate, the one-year point) are bounded settings behind the Timelock delay. A loan's fee is fixed when it opens; a later change never reprices an open loan.

Why not a flat 1%, or a 0.5% minimum: a flat fee is a large yearly cost on a short loan. On a 7-day loan 1% adds about 52 percentage points a year and 0.5% about 26; 0.2% adds about 10. Why not purely proportional to time: a short loan would pay almost nothing, below the treasury floor of 0.1%.

Rules that follow:

- **The term is the agreed term** the loan opens with: the borrower offer's term on a match or an Auto-lend fill, the accepted offer's term on a direct accept.
- **Early repayment gives no refund**, on full-term and pro-rata loans alike. The review states this beside the amount. A borrower who wants flexibility takes a shorter term and extends.
- **An extension pays for the added time only:** the fee at the new total term minus the fee at the term already paid for, on the principal outstanding at the extension, paid by the borrower when the extension takes effect. An extension whose old and new terms are both at or under 30 days pays nothing more. Past one year every added day pays its proportional part of the yearly rate.
- **An extended loan never pays more than one loan of the same total term would have.** The difference rule makes the fee depend only on the total term, not on how it was reached. Extending is also cheaper than closing and borrowing again, which would pay a whole new fee.
- **An automatic extension** (a keeper acting inside limits both holders set) collects the added fee from the borrower's own vault balance of the lending asset. The borrower's extension limits show the largest added fee they allow. If the balance is not there the extension does not happen and the loan stays on its existing due date; the keeper's advance alert names the amount needed. The fee is never added to the debt: that would put a platform charge into every settlement and liquidation path beside the lender's due.
- **It cannot be avoided by chaining short loans:** twelve 30-day loans pay 2.4% in total against 1% for one year. The fee per day of term falls as the term grows up to one year and is the same for every day after it, so no split of a term into shorter loans pays less than the one loan.
- **A refinance and a new loan after a roll are new loans** and pay their own fee on their own term, as today.
- **Discounts** apply to the whole fee as they do today, under the same ceiling. A new user's referral cut (`ReferralFeeShareDesign.md`) counts under that ceiling together with the hold discount: the two can never take more than half off the full fee.
- The fee stays in the lending asset. Nothing here touches the retired token-custody path.

## 4. How the levels compare

Stated generically; no platform is named in the repository.

- Pooled on-chain lenders commonly keep between a tenth and a quarter of the interest lenders earn, and charge no fee up front. 10% of interest is at the bottom of that range.
- Marketplace lenders in traditional finance commonly charge borrowers an origination fee of one to several percent and lenders about 1% of every payment received. Home loans commonly carry 0.5% to 1%, once, for a loan of many years. An up-front fee of 1% for each year of term is therefore ordinary beside marketplace lending and high beside pooled on-chain lending, which is why the short end stays at 0.2%.
- A one-year loan at 10% interest here costs the lender 1 percentage point of their return and the borrower 1% once; a two-year loan costs the borrower 2% once. A 30-day loan costs the borrower 0.2% once.
- On 10,000 units lent for a year at 8% interest the platform's two fees come to 180 (80 from the interest, 100 up front). A pooled lender keeping a tenth to a quarter of the same interest takes 80 to 200. On a 30-day loan the two fees come to about 27 against about 7 to 16.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Fee constants and settings | Interest share default 10%; initiation fee settings (base rate, base term, yearly rate, the one-year point) with bounds, replacing the single rate. |
| One library for the initiation fee rate | `rate(termDays)`; every charger and every preview reads it, so the amount shown is the amount charged. |
| The borrower fee charge at acceptance | Reads the rate for the loan's term. |
| Extension | Charges the difference for the added time through the same fee host, marked as an extension fee so no treasury floor is taken from it. |
| Loan record | The term the fee has been paid for, if the existing term field cannot serve. |
| Views and previews | The fee as an amount and a rate for a given principal and term; the extension's added fee. |
| Treasury fee host | The floor split of `ShortfallReserveDesign.md` section 8 (ships with the mainnet deploy). The above-floor part of the initiation fee then carries the matcher's, the integrator's and the inviter's shares under one per-loan ceiling, and the rest goes to the reserve (`ReferralFeeShareDesign.md` 2.1). |

Per-loan stamping of the interest share stays as it is, so a later retune never reprices an open loan. Run the storage-layout guard's `write`; check facet sizes with the deploy-sanity suite and split along a seam if needed.

## 6. App and documents

- The review shows the initiation fee as an amount, its rate, and the sentence that early repayment does not return it. The term picker shows how the fee changes with the term.
- The lender's review shows the interest share as 10% of interest earned.
- The one-line statement of the initiation fee: "0.2% for loans up to 30 days, rising with the loan's length to 1% for a one-year loan. Longer loans pay 1% per year." In the app the amount is shown beside it.
- The extension review shows the added fee before signing.
- The tokenomics spec's fee tables and every fee figure in the app, site and guides are updated in the same change as the contracts.

## 7. Tests

1. Rate at 1, 30, 31, 197, 365, 366, 548 and 730 days; no step at 30 or 365 days; rounding never undercharges the floor.
2. The charge at acceptance equals the preview, on a direct accept, a match and an Auto-lend fill.
3. Discounts apply to the term-scaled fee under the existing ceiling.
4. Extension: across the 30-day line, inside the slope, across the 365-day line, beyond one year, and within the first 30 days (no charge); partial principal outstanding; fees over any sequence of extensions sum to the fee of one loan of the total term; an automatic extension with the vault balance short is refused and changes nothing.
5. Early repayment returns no fee.
6. A settings change does not reprice an open loan or its later extension's already-paid part.
7. The interest share at 10% on every settlement path, stamped per loan.
8. With the reserve split: treasury receives the floor first; a discounted fee reduces only the reserve's part. The floor on the initiation fee is taken once, at acceptance; an extension's added fee goes to the reserve whole, so one extension from 30 to 365 days and the same extension made a day at a time send the same totals to treasury and reserve.

## 8. Alternatives considered

1. **Keep 0.2% and 2%.** Rejected: the reserve would take a decade or more to reach a useful size.
2. **Flat 0.5% and 5%** (the owner's first proposal). Rejected for the initiation fee: it overcharges short loans.
3. **5% of interest with a flat 0.2%.** Simplest, but puts the whole increase on lenders.
4. **Charge the borrower's part as it accrues, like interest.** Exact on early repayment, but adds a second running charge to every settlement path. Rejected as too much machinery for the gain.
5. **Refund the unused part on early repayment.** Rejected: the fee has already been split between treasury and reserve, and a refund would have to draw both back.
6. **5% of interest, and 0.2% rising to 0.5% at one year** (the levels set on 2026-11-15). Replaced on 2026-11-17 before any build used them: the reserve filled too slowly, and the shares paid from the initiation fee were a fifth each of a small amount.
7. **10% of interest with a 0.5% minimum rising to 1%** (the owner's proposal of 2026-11-17). Not chosen for the minimum: it adds about 26 percentage points a year to a 7-day loan and about 6 to a 30-day loan, where pooled lenders charge nothing up front, and short loans are what the instant market writes.
8. **10% of interest with a 0.1% minimum rising to 1%.** Not chosen: 0.1% is the treasury's floor, so a loan of up to 30 days would leave nothing above it. The reserve, the integrator, the inviter and a new user's cut would receive nothing from such a loan, a holder's discount would have nothing to reduce, and a book of short loans would fund the reserve at well under half the speed, to save the borrower 10 on 10,000.

## 9. Recommendation

The levels in section 2 with the term rule in section 3: 10% of interest, and an initiation fee of 0.2% up to 30 days rising to 1% at one year and 1% per year after that.

## 10. Open items

Settled with the builder on 2026-11-16:

- A charge taken from the fee that was collected (the matcher's share, and later the integrator's and the inviter's) follows the loan's term rate, because it is a part of the above-floor amount of the fee actually charged. The paid tariff, which is not a part of the collected fee, keeps the base rate.
- An obligation handover charges nothing more. It cannot lengthen the term: a replacement whose maturity falls after the loan's current maturity is refused (the lender-protection rule), and the fee counts the total term from the loan's start. If that rule is ever relaxed, the added time is charged through the same function an extension uses.

Still for the builder to raise, not decide silently:

- Confirm no path assumes the fee is one fixed rate, and that the bound on the fee setting still holds for the longest term the platform admits.

## 11. Answers to section 10, and what is built (2026-11-16)

The design thread answered section 10 on 2026-11-16:

- **Everything priced from the initiation fee reads the loan's term rate**: the borrower charge at acceptance, every preview of it, the matcher's share (a cut of the amount charged, so it follows), the refinance payoff sizing, and the VPFI discount, which applies to the term-scaled fee. A signed offer's cap on the initiation fee is compared with the term rate for that offer's own term, rounded up, so a cap is never read as met by a rounded-down figure.
- **One exception: the Full tariff's C\* keeps the base rate.** C\* already multiplies by the loan's term, so reading the term rate there would charge the term twice.
- **An obligation handover that lengthens the agreed term** charges the incoming borrower the difference, as an extension does. A shorter or equal term charges nothing and refunds nothing.
- **The bound on the fee settings** is checked against the longest term any path admits: the yearly rate times that longest term may not exceed the 50% fee ceiling times the one-year point.
- **The treasury floor split is built now**, in the treasury fee host, because it ships in the audited code. Until a registry names a reserve, the reserve's part goes to the treasury, and this is stated: the fee event gives the floor part and the reserve part separately, and a per-asset counter records the reserve part the treasury holds. An extension's added fee takes no floor.

Built in stage 1 (term rate):

- One library computes the rate for a term and the fee for a principal and term. Every charger and preview reads it.
- A small facet holds the three term settings (base term, yearly rate, one-year point; the base rate stays the existing initiation fee setting), their getter, and a quote of the fee and rate for a principal and term. The setter refuses a base term outside 1 to 90 days, a one-year point outside 180 to 730 days, a yearly rate below the base rate, and a yearly rate whose longest-term fee would pass the 50% ceiling. The base-rate setter now refuses a base rate above the yearly rate.
- The loan stamps its term rate (rounded down) as its initiation fee rate when it opens.
- The interest share default is 10%, and the yearly rate 1% (owner decision 2026-11-17, replacing 5% and 0.5%).

Built in stage 2 (extension):

- The loan records the start its total term is counted from and the term the fee is paid for. An extension pays the fee at the new total term less the fee at the term paid for, on the principal outstanding, under the settings in force when it takes effect. The total term is counted in whole days, rounded up, from the origination start to the new end, without paused time, so any sequence of extensions pays in sum what one loan of the same total term pays.
- The hold-tier discount applies to the added fee as at acceptance. The Full bonus does not, because an extension pays no fresh tariff and the extension already downgrades the lender's Full stamp.
- The fee is drawn from the borrower-position holder's vault the same way as the extension's interest charge: their extension reserve for the loan first, then their other free balance. It carries no matcher share, and stage 3 marks it as an extension fee, so no floor is taken from it.
- The borrower's extension limits gain the largest added fee they allow. An extension whose fee is above it is refused, and nothing changes. The settings facet quotes the added fee for an extension made now to a given end, after the holder's discount, and the app's auto-extend card shows that figure and saves it as the limit.
- A loan that paid no initiation fee (a rental, a sale vehicle) records no term and pays none on extension.
- **An obligation handover never lengthens the term.** Its replacement maturity may not fall after the loan's current maturity (an existing lender-protection rule), so the total term counted from the origination start cannot grow, and the handover charges nothing. If that rule is ever relaxed, the handover would charge through the same computation.
- Not yet done: the keeper's funding check reads the extension's interest charge only. It should add the quoted fee before it sends an extension, or the extension is refused for want of funds. That change belongs to the keeper app.

Built in stage 3 (the floor split):

- Each fee leg into the treasury names what the fee is: an initiation fee, the treasury's share of an ERC-20 loan's interest, an extension's added fee, or any other fee. With the first two it passes the floor's base: the principal, or the interest the share was taken from. The treasury fee host splits what arrived, once: the treasury's part up to the floor, the reserve's part above it. Floors round up.
- Defaults: 0.1% of the principal for the initiation fee, 1% of the interest for the interest share. They are bounded settings on the fee settings facet, under the half rule: a floor may never exceed half of the rate it is taken from (the base initiation rate, the interest share), checked when either is set, so the part above the floor never closes. The floor setter refuses a floor above half the rate in force, and the fee setter refuses a rate below twice the floor in force; 0.2% and 5% stay as outer limits. The default initiation floor sits exactly at its limit, so raising it needs the base rate raised first. A change applies to fees collected after it.
- The half rule also holds per loan, in the fee host. A loan keeps the interest share it opened with, so the setter checks alone would not hold for an older loan: one opened at a 2% share would send its whole interest fee to the treasury once the share is 10% and the floor 5%. When an interest fee is collected, the treasury's floor part is the lesser of the interest times the floor in force (rounded up) and half of the interest times the share that loan opened with (rounded down), before any discount. Every interest call site passes the loan's own share with the interest base; the setter checks stay, so a setting is never silently capped on new loans. The initiation fee needs nothing more, since it is charged once at acceptance under the settings in force.
- An extension's added fee is the reserve's whole. Every other fee is the treasury's whole and is not split: NFT rental shares (a rental pays no interest and no initiation fee), liquidation handling fees, the fallback split's treasury share and rental buffers. Where a liquidation used to send the handling fee and the interest share in one transfer, it now sends them as two legs, so the split never mixes the two.
- The matcher's share of the initiation fee is sized on the part above the floor, so it comes out of the reserve's part. With the default matcher rate of 1%, that share is small on short loans; #3682 sets the shares on the same base.
- No reserve is named yet, so both parts go to the treasury. Each split fee emits its two parts, and a per-asset counter records the reserve's part the treasury holds, readable from the fee host.
- The fee legs changed shape, so the two curated refresh scripts refuse a Diamond whose fee host predates the split: they refresh the host and only some of the facets that charge fees. The crossing is a fresh deploy or the all-facets refresh.
