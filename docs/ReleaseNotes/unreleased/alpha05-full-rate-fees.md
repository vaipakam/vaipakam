## Thread — alpha05 says fees are at full rate while no platform token is installed (PR #3870)

The platform token arrives with the rewards phase, on every network together, so at launch no network has it and no wallet has a holding discount. alpha05's fee screens now read whether the network reports a platform token and, where it does not, say that every fee is charged at its full rate instead of offering a discount setting or showing a tier.

The fee-discount section on Home, Settings and Rewards shows the full-rate line and no toggle. The Rewards page's VPFI section says the token is not installed yet, that it arrives with the rewards phase, and that no discount applies to anyone. The lender's discount on a loan, the acceptance review and the rewards widget show the same full-rate line in place of their discount figures. The borrow request receipt now says the fee is less any holding discount, which is true with or without the token.

The read is one shared seam with the tier card's own token read, so a network that has the token installed (a testnet that still carries it) keeps showing the discount, the setting and the tier as before. A failed read claims neither answer.
