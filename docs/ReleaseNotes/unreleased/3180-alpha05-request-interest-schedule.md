# The next app lets a borrower choose an interest schedule, offering only what the protocol admits

In Advanced mode, the borrow request on the next app's Borrow page gains an interest schedule. Instead of paying all the interest at repayment, a borrower can choose to pay it every month, quarter, six months or year. The form asks the protocol which schedules the terms on screen allow. The protocol answers with the same rule it enforces when the request is posted, so the form offers exactly what posting will accept and the app never works the rule out for itself.

Under each closed schedule the form says why, using the protocol's own reason. Periodic interest may be switched off on the network. One of the assets may have no price. The loan may be worth less than the protocol's threshold, in which case both figures are named. Or the period may not be shorter than the loan. While that answer is loading, or could not be read, only interest at repayment is offered, and a schedule already chosen holds the review until the answer is known.

The review states the schedule and each period's interest, worked out as the protocol expects it. For a range, it gives both the figure a lender taking the request directly would charge and the figure on the largest loan a match can make. It also gives the grace a missed period gets, read from today's settings. In Basic too, it warns that a period left unpaid past its grace lets anyone sell part of the collateral to pay it, and that the schedule cannot be changed after posting. In Advanced, it adds who may settle a missed period: anyone may, and whether the keeper service does so on this network is stated as reported, or as not known.

A schedule is an Advanced choice. Switching to Basic keeps it, says so, and offers to clear it along with the other Advanced options.

The user guide's Basic and Advanced editions describe the interest schedule in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CADENCE, RB-MODE, RB-SWITCH. Epic #3180.
