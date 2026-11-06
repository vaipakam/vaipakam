# The next app lets a borrower opt a request into the Full fee tariff

In Advanced mode, the borrow request on the next app's Borrow page gains the Full fee tariff. It is a VPFI fee, paid from the borrower's vault when each loan opens, that adds ten points to the discount on the loan fee, up to the protocol's cap. The loan fee itself is still charged in the lending asset. The form offers the choice only while the protocol has the tariff switched on, and says so when it is off.

The form shows today's tariff as the protocol quotes it for the amount and term typed. The borrower sets the most VPFI one loan may take, which defaults to today's tariff for the largest loan, and chooses what happens to a loan that cannot take the tariff when it opens: it is refused, or it opens without the tariff.

The review states the choice, whether the tariff is switched on now, today's tariff (at both ends of a range), the ceiling, the rule, and the free VPFI in the vault, read the way the protocol's charge reads it. In Basic too, it warns that each loan pays its own tariff and it is not refunded, and that the tariff is set by a second transaction after the request posts, so a lender who takes the request before that transaction confirms opens a loan without it. Each condition that fails now is stated as what it does to a loan under the chosen rule. A choice under which every loan would be refused stops the review until it is changed.

After the request posts, the tariff opens as its own step under the finish card. It reads the request again before the wallet opens, refusing in place if a lender has already taken it, and confirms the result by reading the request back.

The form also states that backstop lending for requests nobody takes is not offered in this app yet. The user guide's Basic and Advanced editions describe the tariff in every language.

A single-amount request's review no longer lists the default fill mode as "one or more matches" beside the line that says one lender takes all of it; it names the fill mode only when the request has a range or uses a mode that changes how it fills.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-TARIFF, RB-MODE, RB-SWITCH. Epic #3180.
