## Thread — One rule for the initiation risk gate (PR #2976)

The range-match preview now decides whether a matched pair carries the
initiation risk gate (the loan-to-value cap and the health-factor floor) by
the same rule the binding accept uses: only a loan whose two legs are both
liquid carries it. Before, the preview ran its loan-to-value check on every
ERC-20 pair, so with depth-tiered loan-to-value switched on it refused a
consented pair with an illiquid leg (its collateral measures at tier 0) that
the accept would have admitted. A matching bot filtering on the preview would
never submit such a pair, so it could not be matched at all.

The rule now lives in one place and every path reads it: the binding accept,
the refinance re-check, the create-time offer bounds, the range-match preview
and the lender-intent slice check. Both parties' consent to illiquid terms is
mandatory on every loan, so it is not part of the rule. A rental never
carries the gate. A both-liquid pair is gated exactly as before.

Closes #2956.
