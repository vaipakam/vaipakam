## Thread — The lender's discount takes the lower of entry and settlement (PR #3585)

A lender's yield-fee hold discount used to be their discount at the moment
the fee was charged. The minimum holding period is 3 days by default, and the
look-back that guards against a quick top-up only covers the current holding.
So a lender could stake about 3 days before a year-long loan settled and get
the discount on the whole year's interest. The cost was a small loss to the
treasury, with no risk to users.

The discount is now the lower of two figures: the holder's discount when they
took the lender position, and their discount when the fee is charged. A
holder takes the position when the loan opens, when a sale of the position
completes, and when the position NFT is transferred to them. Opening and a
sale record the new holder's discount for that loan, replacing the previous
holder's record; a sale splits the interest, so the buyer's figure reaches
only interest from the sale on. A plain transfer splits no interest, so it
records the lower of the figure already there and the receiver's discount.
A transfer can keep or lower the figure but never raise it, so moving the
position to yourself, or away and back, cannot lift a stake taken late. A
lender token that a sale has retired records nothing when moved. A holder
with no record gets no hold discount. The entry
figure is the discount the holder qualified for then, so a later raise of the
tier table does not lift it, while a later cut does lower the figure at
settlement.

A seller's interest claim is unchanged: it already pays the loan's own fee,
without any holder's discount. The Full tariff's extra discount and the
consent gate are unchanged. Only the treasury's share of interest changes, and
it can only go up.

The record has one writer, beside the rule that reads it, and every way a
lender token gets a holder passes through it. Apps can read a lender's entry
figure, their figure now and the one that applies for any loan, so the
expected discount can be shown with the reason when the entry figure is lower.

On a chain other than the canonical VPFI chain, the discount is the tier the
canonical chain last pushed for the holder; where that is missing or stale
when they take the position, the entry figure for that loan is zero.

A Diamond refreshed in place has no records for loans already open, so their
lenders get no hold discount from then on. The position NFT facet and the
discount facet must be refreshed together. Testnets get this at the next
fresh deploy.

Closes #3562.

> Caveat: loans open before a facet refresh carry no entry record and pay the full yield fee from then on.
