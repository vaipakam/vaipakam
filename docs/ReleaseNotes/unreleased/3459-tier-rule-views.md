## Thread — VPFI tier rules are readable and explained (PR #<n>)

An app could not show the VPFI discount-tier holding rules as they are set on a chain, only the documented defaults, and could not tell a user why their tier was lower than their balance suggests. Two public reads now answer both.

The first returns the settings in force: the minimum holding period, the weighted average's window, its recent-day count and recent weight, and the look-back cap, each with the bounds governance may set it within. The setters and this read share one set of bound constants, so the read cannot drift from what the setters enforce.

The second explains one user's tier. It reports the counted balance and the tier that balance alone would reach, when the current holding started and when its minimum period ends, the weighted average and its tier, the lowest tier in the look-back, the effective tier and discount, and which rule holds the tier down: no current holding, the minimum period, the average after a recent top-up, or a dip in the look-back. On a mirror chain it says the rules run on Base and reports the cached tier.

The fee path and the explanation now resolve the tier through the same internal routine, so the explanation cannot disagree with the discount actually applied. The explanation leaves out the fee-discount consent, which is a separate gate an app shows on its own; with consent on, both give the same tier and discount.

Closes #3459.
