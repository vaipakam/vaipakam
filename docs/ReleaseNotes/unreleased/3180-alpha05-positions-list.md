# The next app lists your loan positions

The next app now has a Positions page. It lists the loans the connected wallet lent or borrowed in on its network, read from the position tokens the wallet holds, so a position that was transferred away leaves the list. Payouts ready to collect come first and point at Claims, then live loans with the most urgent deadline first (side, terms, due date, what happens if it is missed, and the health factor), then ended loans with their status in words: repaid, defaulted, settled or closed by a match.

A choice of All, Lent or Borrowed narrows the three lists at once. The page says "nothing yet" only when every read completed, and says so when a list could not be read in full. Each row opens its loan; the page itself signs nothing and offers no action, since whether an action is open is decided on the loan's own page from the protocol's verdict.

Home and Positions now read the same inventory through one shared reader, so the two pages never disagree about what the wallet holds.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITIONS-LIST. Epic #3180.
