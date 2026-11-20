## Offers left open on a closed loan can be cleared by anyone (#3753)

A preclose offset offer or a refinance request is tied to one loan. If the loan then closed by another route (full repayment, default, liquidation or a forced sale), the offer stayed on the book. Tests confirmed that accepting it was always refused by name before any value moved, so no funds were at risk. But only its creator could cancel it, or anyone after its expiry, and an offset posted with no practical deadline never expires. Its escrow (the offset's new principal, or a request's fresh collateral) stayed held until then.

Such an offer now counts as a dead route, the same rule a moved position already used. Anyone may cancel it at once, and the existing keeper sweep of dead-route offers picks it up with no keeper change. The refund goes to the offer's creator, as every cancel's does. A loan waiting on the fallback is not treated as closed, because a cure can return it to open.

A lender sale listing on a closed loan keeps its own teardown, which clears more than a cancel does.

Closes #3753.
