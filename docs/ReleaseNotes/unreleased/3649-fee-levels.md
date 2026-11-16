## Fee levels: 5% of interest, initiation fee by term (#3649)

The treasury's share of the interest lenders earn is now 5% by default, up from 2%. It is fixed on each loan when the loan opens, as before, so a later change never reprices an open loan.

The borrower's loan initiation fee now depends on the loan's agreed term. A term of 30 days or less pays 0.2%. Between 30 days and one year the rate rises in a straight line to 0.5%. Beyond one year it is 0.5% for each year of term, in proportion to the days, so two years pay 1.0%. There is no step anywhere on the curve, so a day more of term never costs more than a day's share of the yearly rate. Early repayment returns no part of the fee.

Every figure derived from the fee reads the same term rate: the acceptance charge, every preview, the matcher's share, the refinance payoff sizing and the fee discount. A signed order's cap on the fee is compared with the rate for that order's own term, rounded up. The one exception is the paid fee tariff, which already scales with the term and keeps the base rate. The loan record stores the term rate it opened at.

A new settings facet holds the base term, the yearly rate and the one-year point, all bounded: the base term is 1 to 90 days, the one-year point 180 to 730 days, the yearly rate may not be below the base rate, and the fee at the longest term the platform admits may not exceed the 50% fee ceiling. The base-rate setter now refuses a base rate above the yearly rate. The facet also quotes the fee and rate for any principal and term, which the app's term picker can read.

Still to come in this issue: an extension, and an obligation handover that lengthens the term, pay the fee for the added time only; and the treasury floor split from `ShortfallReserveDesign.md`. Design: `docs/DesignsAndPlans/FeeLevelsDesign.md` section 11.

> Caveat: until the extension stage lands, an extension or a lengthening handover charges no added fee.
