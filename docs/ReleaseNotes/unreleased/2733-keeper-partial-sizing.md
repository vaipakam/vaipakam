## Keeper — partial liquidations sized from the loan's own threshold (PR #TBD)

The keeper's partial-liquidation sizer was reading the wrong number. It took the
liquidation threshold from the oracle's asset risk profile by position, but that
profile stopped carrying a per-asset threshold when thresholds moved to per-tier
values, so the position it read had become the liquidation bonus — a few hundred
basis points where the sizer expected a threshold near 80%. Partials came out
mis-sized, the contract refused them, and the keeper moved on towards a full
liquidation, selling more of the borrower's collateral than the lender needed.

The keeper now reads the threshold from the loan itself: the per-tier threshold
stamped on the loan when it opened, which is the exact figure the contract
computes the loan's health factor with. It arrives on the loan read the keeper
already makes, so the separate oracle read is gone. Every loan field the keeper
uses is read by name and checked against the compiled contract interface in a
test, so a future change to the loan's shape fails that test instead of quietly
shifting what the keeper is fed. A loan whose fields do not decode as expected is
left alone rather than acted on.

The re-sizing loop also gave up too early, and in one case never at all. It
allowed three submissions, so a slice refused as over-liquidating could be shrunk
once more and then escalated to a full liquidation without the smaller size ever
being sent. And a slice refused as too small to restore the health factor was
simply left for the next tick, which recomputed the same size and was refused the
same way, so such a loan was never liquidated. The keeper now searches: every
refusal says which side of the allowed band the slice fell on, the keeper keeps
the largest size known too small and the smallest known too big, and it tries
sizes between them. It falls back to a full liquidation only when no partial size
within bounds is left, which is when a full liquidation is the lender's way out.

Closes #2733.
