## Thread — alpha05 shows a lender the fee discount on each loan

A lender's loan page in the new app now has a section on the holding discount that applies to the protocol's share of that loan's interest. It shows the figure the protocol itself reports for this loan and this wallet. The app works nothing out on its own.

Since the contract change #3562, a lender's discount on a loan is the lower of two figures: the discount they held when they took the lender position, and the discount they hold when the share is charged. The page explains which of the two applies now. If the figure from when they took the position is the lower one, the page says the discount is capped and that VPFI added since does not raise it on this loan. If the discount now is the lower one, it says a later fall in tier would lower the discount at that settlement. If the protocol recorded no figure for this wallet, the page says no holding discount applies.

The holding discount only applies while the wallet's fee-discount setting is on. When the setting is off, the page says so and links to it. When the setting could not be read, the page says that too. The Advanced view also shows both figures and their tiers, when the first one was recorded, how this network delivers the discount, and whether a Full fee tariff paid for the loan adds to it. Each of these says it is unknown when it could not be read, and never shows a guess. The borrower sees no lender discount.

The testnets' current contracts do not report the per-loan figure yet. Until the next fresh deploy, the page says the figure is not reported by this network, never that the discount is zero. The fee-discount setting's own explanation now describes the lower-of-two rule as well. Advances #3180 and closes #3586.
