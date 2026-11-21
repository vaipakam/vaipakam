## Thread — alpha05 says no holding discount applies while no platform token is installed (PR #3870)

The platform token arrives with the rewards phase, on every network together, so at launch no network has it and no wallet has a holding discount. alpha05's fee screens now read whether the network reports a platform token. Where it does not, they say that no holding discount applies, instead of offering a discount setting or showing a tier. They do not say every fee is at its full rate, because other reductions, such as a referral's share, still apply and are already in the fee previews.

The fee-discount section on Home, Settings and Rewards shows that line and no toggle. The Rewards page's VPFI section says the token is not installed yet, that it arrives with the rewards phase, and that no holding discount applies to anyone. The lender's discount on a loan, the acceptance review and the rewards widget show the same line in place of their discount figures. The borrow request receipt now says the fee is less any holding discount, which is true with or without the token.

Every screen reads the token through one shared hook, with one set of read options. So a network that has the token installed (a testnet that still carries it) keeps showing the discount, the setting and the tier as before. A read that failed, or whose last refresh failed, makes neither claim.
