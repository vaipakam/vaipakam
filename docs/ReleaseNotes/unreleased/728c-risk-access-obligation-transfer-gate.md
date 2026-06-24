## Thread — Progressive risk access: obligation-transfer gate (PR #<n>)

Phase 2 of #671 (#728), PR-2c. The progressive-risk gate now also runs on the
**obligation-transfer** path (Preclose Option 2). When a borrower hands their
loan obligation to a new borrower by consuming that new borrower's standing
Borrower Offer, the protocol now checks the **incoming** borrower against the
loan's asset pair before the transfer settles.

This closes another gap the acceptor-side gate (PR-2a) left open. The transfer
rewrites the loan's borrower directly — it does not route through the
offer-accept → loan-initiation chokepoint where that gate lives, so the incoming
borrower was never re-validated. The incoming borrower is newly taking on the
loan's borrower-side risk, so the right check is against the **loan's** asset
pair (the exposure being assumed), evaluated against the **current** tier and
consent state. Their Borrower Offer may have been authored while the gate was
off, or their tier or per-pair consent may since have dropped or gone stale
after a risk-terms-version bump; re-checking at transfer time catches all of
those. The **exiting** borrower stays exempt — that risk was already accepted at
the original loan, exactly as the seller of a loan-sale is exempt while its buyer
is gated.

The incoming borrower is gated as a standing participant: this is not an
acceptance flow, so there is no anti-phishing acknowledgement to substitute for a
missing tier or per-pair consent. As with the rest of #671, the whole check is
behind the off-by-default `riskAccessGateEnabled` master switch and is a no-op
when it is off. Part of #671 / #728 (does not close them).
